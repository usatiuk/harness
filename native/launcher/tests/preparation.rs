use harness_bootstrap::{Cache, FileUse, NodePin, host_target};
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
    let node = cache
        .home
        .join("runtime/node")
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
        "mode":"development","productVersion":"0.1.0","sourceCommit":"a".repeat(40),
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
    assert!(await_exit(&mut child).success());
    let output = child.wait_with_output().unwrap();
    let prepared: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let payload = std::path::Path::new(prepared["payload"].as_str().unwrap());
    assert_eq!(fs::read(payload.join("server.mjs")).unwrap(), b"server");
    fs::write(&archive_path, b"rebuilt mutable source").unwrap();
    let cached = cache.prepare_cached_development_server(&digest).unwrap();
    assert_eq!(fs::read(cached.server.entry).unwrap(), b"server");
    assert!(!cache.home.join("server/current.json").exists());
}
