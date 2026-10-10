use harness_bootstrap::{Cache, FileUse, NodePin, canonical_home, host_target};
use std::{
    fs,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}
fn await_exit(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Helper did not physically retire");
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn cache_pruning_previews_refuses_running_consumers_and_preserves_data() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let home = cache.home.clone();
    let directories = [
        "runtime/node/version",
        "server/version",
        "cli/version",
        "staging/abandoned",
    ];
    for directory in directories {
        fs::create_dir_all(home.join(directory)).unwrap();
        fs::write(home.join(directory).join("payload"), b"download").unwrap();
    }
    for file in [
        "conversations.db",
        "settings.json",
        "client.json",
        "credentials.json",
        "server/current.json",
        "server/identity.json",
    ] {
        fs::write(home.join(file), b"persistent").unwrap();
    }
    let prune = |apply: bool| {
        let mut process = command();
        process.args(["cache", "prune"]).env("HARNESS_HOME", &home);
        if apply {
            process.arg("--apply");
        }
        process.output().unwrap()
    };
    let blocked = prune(true);
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Cache is in use"));
    drop(cache);
    let preview = prune(false);
    assert!(preview.status.success(), "{:?}", preview);
    assert!(String::from_utf8_lossy(&preview.stdout).contains("Would remove 4"));
    for directory in directories {
        assert_eq!(
            fs::read(home.join(directory).join("payload")).unwrap(),
            b"download"
        );
    }
    let removed = prune(true);
    assert!(removed.status.success(), "{:?}", removed);
    assert!(String::from_utf8_lossy(&removed.stdout).contains("Removed 4"));
    for directory in directories {
        assert!(!home.join(directory).exists());
    }
    for file in [
        "conversations.db",
        "settings.json",
        "client.json",
        "credentials.json",
        "server/current.json",
        "server/identity.json",
    ] {
        assert_eq!(fs::read(home.join(file)).unwrap(), b"persistent");
    }
    assert!(prune(true).status.success());
}

#[test]
fn remote_eof_retires_unfinished_preparation() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let install = FileUse::try_exclusive(&cache.home, "install")
        .unwrap()
        .unwrap();
    let mut child = command()
        .arg("--install-development-server")
        .arg(temporary.path().join("server.tar.gz"))
        .arg("a".repeat(64))
        .arg("--remote")
        .env("HARNESS_HOME", &cache.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    assert_eq!(await_exit(&mut child).code(), Some(130));
    drop(install);
    assert!(!cache.home.join("server/current.json").exists());
}

#[test]
fn development_tar_is_immutable_and_helper_exits_without_stdin_handoff() {
    use flate2::{Compression, write::GzEncoder};
    use sha2::{Digest, Sha256};
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let pin = NodePin::bundled().unwrap();
    let target = host_target().unwrap();
    // Elevated Windows runners can default new directories to Administrators ownership.
    // Match the account-owned cache boundary instead of bypassing it in this fixture.
    let node = canonical_home(&cache.home.join("runtime/node"))
        .unwrap()
        .join(format!("{}-{target}", pin.version));
    let entry = node.join(&pin.targets[target].entry);
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    // This controlled cache fixture is never executed; the test exercises server installation.
    fs::write(entry, b"controlled runtime").unwrap();
    fs::write(node.join(".artifact-sha256"), &pin.targets[target].sha256).unwrap();
    let archive_path = temporary.path().join("server.tar.gz");
    let mut archive = tar::Builder::new(GzEncoder::new(
        fs::File::create(&archive_path).unwrap(),
        Compression::fast(),
    ));
    let identity = serde_json::to_vec(&serde_json::json!({
        "mode":"development","productVersion":"0.1.0",
        "target":target,"nodeVersion":pin.version
    }))
    .unwrap();
    for (name, bytes) in [
        ("server/server.mjs", b"server".to_vec()),
        ("server/worker.mjs", b"worker".to_vec()),
        (
            "server/node_modules/@harness/native/harness-native.node",
            b"addon".to_vec(),
        ),
        (
            if cfg!(windows) {
                "server/harness-bootstrap.exe"
            } else {
                "server/harness-bootstrap"
            },
            b"bootstrap".to_vec(),
        ),
        ("server/build.json", identity),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o700);
        header.set_cksum();
        archive
            .append_data(&mut header, name, bytes.as_slice())
            .unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap();
    let digest = format!("{:x}", Sha256::digest(fs::read(&archive_path).unwrap()));
    let mut child = command()
        .arg("--install-development-server")
        .arg(&archive_path)
        .arg(&digest)
        .arg("--remote")
        .env("HARNESS_HOME", &cache.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let status = await_exit(&mut child);
    let output = child.wait_with_output().unwrap();
    assert!(status.success(), "{output:?}");
    let prepared: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let payload = std::path::Path::new(prepared["payload"].as_str().unwrap());
    assert_eq!(fs::read(payload.join("server.mjs")).unwrap(), b"server");
    fs::write(&archive_path, b"rebuilt mutable source").unwrap();
    let cached = cache.prepare_cached_development_server(&digest).unwrap();
    assert_eq!(fs::read(cached.server.entry).unwrap(), b"server");
    assert!(!cache.home.join("server/current.json").exists());
}
