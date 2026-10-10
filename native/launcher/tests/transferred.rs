use flate2::{Compression, write::GzEncoder};
use harness_bootstrap::{Cache, FileUse, NodePin, Receipt, host_target};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader},
    process::{Command, Stdio},
};

fn await_exit(child: &mut std::process::Child) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("Fixture helper did not physically retire");
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
fn build_info_reads_captured_identity_without_preparing_a_home() {
    let temporary = tempfile::tempdir().unwrap();
    let invalid_home = temporary.path().join("not a directory");
    fs::write(&invalid_home, b"untouched").unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
    command
        .args(["--build-info"])
        .env("HARNESS_HOME", &invalid_home);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().unwrap();
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

#[test]
fn actual_transfer_helper_retains_components_until_eof_without_selecting_server() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home with spaces")).unwrap();
    let pin = NodePin::bundled().unwrap();
    let target = host_target().unwrap();
    let artifact = pin.targets[target].clone();
    let node_root = cache
        .home
        .join("runtime/node")
        .join(format!("{}-{target}", pin.version));
    let entry = node_root.join(&artifact.entry);
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    // This scenario exercises helper publication/lifetime, never executes this
    // controlled runtime or claims native ABI qualification.
    fs::write(entry, b"controlled runtime").unwrap();
    fs::write(
        node_root.join("receipt.json"),
        serde_json::to_vec(&Receipt {
            format_version: 1,
            component: "node".into(),
            version: pin.version.clone(),
            target: target.into(),
            artifact,
            node_version: None,
        })
        .unwrap(),
    )
    .unwrap();
    let path = temporary.path().join("complete server.tar.gz");
    let mut archive = tar::Builder::new(GzEncoder::new(
        File::create(&path).unwrap(),
        Compression::fast(),
    ));
    let identity = serde_json::to_vec(&serde_json::json!({
        "mode":"development", "productVersion":"0.1.0", "sourceCommit":"a".repeat(40),
        "target":target,"nodeVersion":pin.version,"releaseManifestUrl":null,"releaseVerificationPublicKey":null,
    })).unwrap();
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
        header.set_mode(0o755);
        header.set_cksum();
        archive
            .append_data(&mut header, name, bytes.as_slice())
            .unwrap();
    }
    archive.into_inner().unwrap().finish().unwrap();
    let bytes = fs::read(&path).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let descriptor = serde_json::json!({
        "kind":"development","archive":path,"size":bytes.len(),"sha256":digest,
        "nodeArchive":temporary.path().join("not-required-for-warm-node"),
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
    command
        .args(["--install-transferred-server", &descriptor.to_string()])
        .env("HARNESS_HOME", &cache.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    if option_env!("HARNESS_RELEASE_BUILD") == Some("1") {
        let result = child.wait_with_output().unwrap();
        assert!(!result.status.success());
        assert!(
            String::from_utf8(result.stderr)
                .unwrap()
                .contains("does not accept source-build transfers")
        );
        assert!(line.is_empty());
        return;
    }
    let prepared: serde_json::Value = serde_json::from_str(&line).unwrap();
    let keys = prepared["keys"].as_array().unwrap();
    assert_eq!(keys.len(), 2);
    for key in keys {
        assert!(
            FileUse::try_exclusive(&cache.home, key.as_str().unwrap())
                .unwrap()
                .is_none()
        );
    }
    assert!(!cache.home.join("server/current.json").exists());
    assert!(!cache.home.join("cli").exists());
    assert!(child.try_wait().unwrap().is_none());
    child.stdin.take();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    for key in keys {
        assert!(
            FileUse::try_exclusive(&cache.home, key.as_str().unwrap())
                .unwrap()
                .is_some()
        );
    }
    fs::remove_file(path).unwrap();
    let mut inspection = Command::new(env!("CARGO_BIN_EXE_harness"));
    inspection
        .args(["--inspect-cached-server", &format!("dev-{target}-{digest}")])
        .env("HARNESS_HOME", &cache.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        inspection.creation_flags(0x08000000);
    }
    let mut child = inspection.spawn().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap(),
        prepared
    );
    for key in keys {
        assert!(
            FileUse::try_exclusive(&cache.home, key.as_str().unwrap())
                .unwrap()
                .is_none()
        );
    }
    child.stdin.take();
    assert!(child.wait_with_output().unwrap().status.success());
    for key in keys {
        assert!(
            FileUse::try_exclusive(&cache.home, key.as_str().unwrap())
                .unwrap()
                .is_some()
        );
    }
    assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
}

#[test]
fn actual_helper_rejects_unknown_descriptor_fields_without_installing_or_selecting() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("home");
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
    command.args(["--install-transferred-server", r#"{"kind":"development","archive":"missing","size":1,"sha256":"bad","nodeArchive":"missing","runtimeSource":"host"}"#])
        .env("HARNESS_HOME", &home).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(
        String::from_utf8(result.stderr)
            .unwrap()
            .contains("unknown field")
    );
    assert!(!home.join("runtime").exists());
    assert!(!home.join("server").exists());
}

#[test]
fn transfer_eof_retires_blocked_helper_and_cached_launches_do_not_wait_for_install() {
    if option_env!("HARNESS_RELEASE_BUILD") == Some("1") {
        return; // Source descriptors are rejected before preparation in release mode.
    }
    for mode in [
        "--install-transferred-server",
        "--inspect-cached-server",
        "--run-cached-server",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let pin = NodePin::bundled().unwrap();
        let target = host_target().unwrap();
        let key = format!("node-{}-{target}", pin.version);
        let gate = FileUse::try_exclusive(&cache.home, &format!("install-{key}"))
            .unwrap()
            .unwrap();
        let descriptor = serde_json::json!({
            "kind":"development","archive":"not-opened","size":1,"sha256":"a".repeat(64),
            "nodeArchive":"not-opened",
        });
        let argument = if mode == "--install-transferred-server" {
            descriptor.to_string()
        } else {
            format!("dev-{target}-{}", "a".repeat(64))
        };
        let mut command = Command::new(env!("CARGO_BIN_EXE_harness"));
        command
            .args([mode, &argument])
            .env("HARNESS_HOME", &cache.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if mode == "--run-cached-server" {
            command.arg("--attach-only");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        if mode == "--install-transferred-server" {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while FileUse::try_exclusive(&cache.home, &key).unwrap().is_some() {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "Helper exited before acquiring use"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "Helper never acquired use"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            // Keep the gate held: EOF must retire the blocked installer first.
            child.stdin.take();
        }
        // Cached readers fail immediately on absent components, without waiting
        // for either the gate or stdin EOF. Installation has a separate boundary.
        await_exit(&mut child);
        let result = child.wait_with_output().unwrap();
        let expected = if mode == "--install-transferred-server" {
            130
        } else {
            1
        };
        assert_eq!(result.status.code(), Some(expected));
        assert!(result.stdout.is_empty());
        let diagnostic = if mode == "--install-transferred-server" {
            "disconnected before readiness"
        } else {
            "Required cached component is missing"
        };
        assert!(String::from_utf8_lossy(&result.stderr).contains(diagnostic));
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_some());
        assert!(!cache.home.join("server/current.json").exists());
        assert!(
            !cache
                .home
                .join("runtime/node")
                .join(format!("{}-{target}", pin.version))
                .exists()
        );
        drop(gate);
    }
}
