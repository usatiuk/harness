use harness_bootstrap::{Cache, FileUse, NodePin, host_target};
use harness_desktop::{command, runtime};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn desktop(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness-desktop"));
    command.env("HARNESS_HOME", home);
    command
}

#[tokio::test]
async fn build_info_returns_captured_identity_without_preparing_or_creating_a_window() {
    let temporary = tempfile::tempdir().unwrap();
    let invalid_home = temporary.path().join("not a directory");
    fs::write(&invalid_home, b"untouched").unwrap();
    let mut command = desktop(&invalid_home);
    command.arg("--build-info");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let identity: harness_bootstrap::BuildIdentity =
        serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(identity.product_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(identity.target, host_target().unwrap());
    assert_eq!(identity.node_version, NodePin::bundled().unwrap().version);
    assert_eq!(fs::read(invalid_home).unwrap(), b"untouched");
}

fn copy_node(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            copy_node(&entry.path(), &target);
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(entry.path()).unwrap(), target).unwrap();
            #[cfg(windows)]
            panic!("Unexpected Windows Node symlink");
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn warm_home(home: &Path) -> Cache {
    let source = Cache::new(&workspace().join(".harness-dev")).unwrap();
    let node = source.prepare_node().unwrap();
    let cache = Cache::new(home).unwrap();
    copy_node(
        &node.directory,
        &cache
            .home
            .join("runtime/node")
            .join(node.directory.file_name().unwrap()),
    );
    cache
}

#[tokio::test]
async fn cancel_interrupts_a_real_cold_install_lock_and_joins_the_hidden_helper() {
    let root = tempfile::tempdir().unwrap();
    let cache = Cache::new(&root.path().join("home")).unwrap();
    let pin = NodePin::bundled().unwrap();
    let key = format!("node-{}-{}", pin.version, host_target().unwrap());
    let _install = FileUse::try_exclusive(&cache.home, &format!("install-{key}"))
        .unwrap()
        .unwrap();
    let (cancel, canceled) = watch::channel(false);
    let task = tokio::spawn(runtime::prepare(
        desktop(&cache.home),
        Some(workspace().join("packages/desktop/resources")),
        true,
        canceled,
    ));
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if FileUse::try_exclusive(&cache.home, &key).unwrap().is_none() {
                break;
            }
            assert!(
                !task.is_finished(),
                "preparation must reach the contended install lock"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual blocked preparation");
    cancel.send(true).unwrap();
    let error = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("cancellation must not wait for the install lock")
        .unwrap()
        .err()
        .expect("canceled preparation");
    assert!(error.contains("cancelled"), "{error}");
    assert!(
        FileUse::try_exclusive(&cache.home, &key).unwrap().is_some(),
        "child use guard must already be released by physical exit"
    );
    assert!(!cache.home.join("server/current.json").exists());
    assert!(
        !cache
            .home
            .join("runtime/node")
            .join(format!("{}-{}", pin.version, host_target().unwrap()))
            .exists()
    );
}

#[tokio::test]
async fn actual_desktop_preparation_transfers_guards_before_helper_exit() {
    let root = tempfile::tempdir().unwrap();
    let cache = warm_home(&root.path().join("home with spaces"));
    let (_cancel, canceled) = watch::channel(false);
    let prepared = runtime::prepare(
        desktop(&cache.home),
        Some(workspace().join("packages/desktop/resources")),
        true,
        canceled,
    )
    .await
    .expect("actual desktop preparation process");
    let mut process = prepared.command();
    let environment: std::collections::HashMap<_, _> = process.as_std().get_envs().collect();
    let keys: [String; 2] = serde_json::from_str(
        environment[std::ffi::OsStr::new("HARNESS_SERVER_CACHE_KEYS")]
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    for key in &keys {
        assert!(
            FileUse::try_exclusive(&cache.home, key).unwrap().is_none(),
            "parent must retain {key}"
        );
    }
    process
        .arg("--connection-command")
        .arg(r#"{"type":"config.read"}"#);
    let (_cancel, canceled) = watch::channel(false);
    let result = command::execute(process, canceled, |_| Ok(()), Some(Duration::from_secs(30)))
        .await
        .unwrap();
    assert_eq!(result["selectedHostId"], "local");
    drop(prepared);
    for key in &keys {
        assert!(
            FileUse::try_exclusive(&cache.home, key).unwrap().is_some(),
            "helper must be physically gone, with no stranded guard for {key}"
        );
    }
}

#[tokio::test]
async fn failed_preparation_reports_the_child_error_without_opening_a_window() {
    let root = tempfile::tempdir().unwrap();
    let cache = warm_home(&root.path().join("home"));
    let (_cancel, canceled) = watch::channel(false);
    let error = runtime::prepare(
        desktop(&cache.home),
        Some(root.path().join("missing payload")),
        true,
        canceled,
    )
    .await
    .err()
    .expect("missing development payload must fail");
    assert!(error.contains("Runtime preparation failed"), "{error}");
    let pin = NodePin::bundled().unwrap();
    assert!(
        FileUse::try_exclusive(
            &cache.home,
            &format!("node-{}-{}", pin.version, host_target().unwrap())
        )
        .unwrap()
        .is_some()
    );
    assert!(!cache.home.join("server/current.json").exists());
}

#[tokio::test]
async fn eof_without_a_complete_frame_never_acquires_descriptor_guards() {
    let root = tempfile::tempdir().unwrap();
    let cache = Cache::new(&root.path().join("home")).unwrap();
    let source = Cache::new(&workspace().join(".harness-dev")).unwrap();
    let node = source.prepare_node().unwrap();
    let paths = serde_json::json!({
        "home": cache.home, "node": node.entry, "entry": "unused", "payload": "unused",
        "keys": ["missing-node", "missing-server"], "selection": null,
    });
    let mut child = Command::new(&node.entry);
    child
        .args(["--eval", "process.stdout.write(process.argv[1])", "--"])
        .arg(paths.to_string());
    let (_cancel, canceled) = watch::channel(false);
    let error = runtime::prepare(child, None, false, canceled)
        .await
        .err()
        .unwrap();
    assert!(error.contains("before completing its response"), "{error}");
    for key in ["missing-node", "missing-server"] {
        assert!(!cache.home.join(".cache-locks").join(key).exists());
    }
}
