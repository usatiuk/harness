#[cfg(feature = "custom-protocol")]
use harness_bootstrap::{Cache, FileUse};
use harness_desktop::{command, runtime};
#[cfg(feature = "custom-protocol")]
use std::{fs, path::PathBuf};
use std::{path::Path, time::Duration};
use tokio::{process::Command, sync::watch};

#[cfg(feature = "custom-protocol")]
fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn desktop(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness-desktop"));
    command.env("HARNESS_HOME", home);
    command
}
#[cfg(feature = "custom-protocol")]
fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            copy_tree(&entry.path(), &target);
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
#[cfg(feature = "custom-protocol")]
fn source_cache() -> Cache {
    Cache::new(
        &std::env::var_os("HARNESS_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace().join(".harness-dev")),
    )
    .unwrap()
}

#[cfg(not(feature = "custom-protocol"))]
#[tokio::test]
async fn source_development_runs_the_workspace_without_installing_a_runtime() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home with spaces");
    let (_cancel, canceled) = watch::channel(false);
    let prepared = runtime::prepare(desktop(&home), None, false, canceled)
        .await
        .unwrap();
    let mut process = prepared.command();
    process
        .arg("--connection-command")
        .arg(r#"{"type":"config.read"}"#);
    let (_cancel, canceled) = watch::channel(false);
    let result = command::execute(process, canceled, |_| Ok(()), Some(Duration::from_secs(30)))
        .await
        .unwrap();
    assert_eq!(result["selectedHostId"], "local");
    assert!(!home.join("runtime").exists());
    assert!(!home.join("server").exists());
}

#[cfg(feature = "custom-protocol")]
#[tokio::test]
async fn actual_preparation_and_command_retain_one_cache_lease_through_exit() {
    let root = tempfile::tempdir().unwrap();
    let source = source_cache();
    let node = source.prepare_node().unwrap();
    let cache = Cache::new(&root.path().join("home with spaces")).unwrap();
    let home = cache.home.clone();
    copy_tree(
        &node.directory,
        &home
            .join("runtime/node")
            .join(node.directory.file_name().unwrap()),
    );
    drop(cache);
    let (_cancel, canceled) = watch::channel(false);
    let prepared = runtime::prepare(
        desktop(&home),
        Some(workspace().join("packages/desktop/resources")),
        true,
        canceled,
    )
    .await
    .unwrap();
    assert!(
        FileUse::try_exclusive(&home, "cache-use")
            .unwrap()
            .is_none()
    );
    let mut process = prepared.command();
    process
        .arg("--connection-command")
        .arg(r#"{"type":"config.read"}"#);
    let (_cancel, canceled) = watch::channel(false);
    let result = command::execute(process, canceled, |_| Ok(()), Some(Duration::from_secs(30)))
        .await
        .unwrap();
    assert_eq!(result["selectedHostId"], "local");
    drop(prepared);
    assert!(
        FileUse::try_exclusive(&home, "cache-use")
            .unwrap()
            .is_some()
    );
}

#[cfg(feature = "custom-protocol")]
#[tokio::test]
async fn failed_preparation_leaves_no_window_or_cache_lease() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let (_cancel, canceled) = watch::channel(false);
    let result = runtime::prepare(
        desktop(&home),
        Some(root.path().join("missing payload")),
        true,
        canceled,
    )
    .await;
    assert!(result.err().unwrap().contains("Runtime preparation failed"));
    assert!(
        FileUse::try_exclusive(&home, "cache-use")
            .unwrap()
            .is_some()
    );
    assert!(!home.join("server/current.json").exists());
}

#[cfg(feature = "custom-protocol")]
#[tokio::test]
async fn cancellation_joins_a_blocked_helper_before_releasing_the_cache() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let marker = root.path().join("ready");
    let source = source_cache();
    let node = source.prepare_node().unwrap();
    let mut child = Command::new(node.entry);
    child.args(["--eval", "require('fs').writeFileSync(process.argv[1], 'ready'); process.stdin.resume(); process.stdin.on('end', () => process.exit(1));", "--"])
        .arg(&marker).env("HARNESS_HOME", &home);
    let (cancel, canceled) = watch::channel(false);
    let task = tokio::spawn(runtime::prepare(child, None, false, canceled));
    tokio::time::timeout(Duration::from_secs(20), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        FileUse::try_exclusive(&home, "cache-use")
            .unwrap()
            .is_none()
    );
    cancel.send(true).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert!(result.err().unwrap().contains("cancelled"));
    assert!(
        FileUse::try_exclusive(&home, "cache-use")
            .unwrap()
            .is_some()
    );
}
