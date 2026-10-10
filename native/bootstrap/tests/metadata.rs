use harness_bootstrap::{Artifact, Cache, FileUse, NodePin, host_target};
use std::fs;

#[test]
fn verifies_official_tauri_signature_before_parsing_release_metadata() {
    let bytes = include_bytes!("fixtures/release.json");
    let signature = include_str!("fixtures/release.json.sig");
    let key = include_str!("fixtures/verification-key.pub");
    let manifest = harness_bootstrap::verify_release(bytes, signature, key).unwrap();
    harness_bootstrap::verify_signature(bytes, signature, key).unwrap();
    assert_eq!(manifest.product_version, "0.1.0");
    let mut tampered = bytes.to_vec();
    tampered[0] ^= 1;
    assert!(harness_bootstrap::verify_release(&tampered, signature, key).is_err());
    assert!(harness_bootstrap::verify_signature(&tampered, signature, key).is_err());
    let other_key = include_str!("../../../release/verification-key.pub");
    assert!(harness_bootstrap::verify_release(bytes, signature, other_key).is_err());
}

#[test]
fn embedded_runtime_is_complete_and_pinned_for_all_supported_targets() {
    let pin = NodePin::bundled().unwrap();
    assert_eq!(pin.version, "22.23.3");
    assert_eq!(pin.targets.len(), 4);
    assert!(pin.targets.contains_key(host_target().unwrap()));
}

#[test]
fn rejects_executable_artifacts_with_unsafe_paths_or_addresses() {
    let pin = NodePin::bundled().unwrap();
    let original = pin.targets.get(host_target().unwrap()).unwrap();
    for path in [
        "../outside",
        "/absolute",
        "C:/outside",
        "a\\outside",
        "a//b",
        "a/./b",
    ] {
        let artifact = Artifact {
            entry: path.into(),
            ..original.clone()
        };
        assert!(artifact.validate().is_err(), "accepted {path}");
    }
    let artifact = Artifact {
        url: "http://example.invalid/runtime.zip".into(),
        ..original.clone()
    };
    assert!(artifact.validate().is_err());
}

#[test]
fn active_artifact_blocks_removal_without_blocking_an_unrelated_version() {
    let directory = tempfile::tempdir().unwrap();
    let cache = Cache::new(&directory.path().join("home")).unwrap();
    let active = FileUse::shared(&cache.home, "server-1.0.0-windows-x64").unwrap();
    assert!(
        FileUse::try_exclusive(&cache.home, "server-1.0.0-windows-x64")
            .unwrap()
            .is_none()
    );
    assert!(
        FileUse::try_exclusive(&cache.home, "server-0.9.0-windows-x64")
            .unwrap()
            .is_some()
    );
    drop(active);
    assert!(
        FileUse::try_exclusive(&cache.home, "server-1.0.0-windows-x64")
            .unwrap()
            .is_some()
    );
}

#[test]
fn cache_lock_child() {
    use std::io::{Read, Write};
    let Some(home) = std::env::var_os("BOOTSTRAP_LOCK_TEST") else {
        return;
    };
    let home = std::path::PathBuf::from(home);
    let _usage = FileUse::shared(&home, "node-child-lifetime").unwrap();
    println!("READY");
    std::io::stdout().flush().unwrap();
    let mut byte = [0u8];
    std::io::stdin().read_exact(&mut byte).unwrap();
}

#[test]
fn actual_child_exit_releases_its_os_owned_lock() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "cache_lock_child", "--nocapture"])
        .env("BOOTSTRAP_LOCK_TEST", &cache.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ready = false;
    for _ in 0..8 {
        let mut line = String::new();
        if output.read_line(&mut line).unwrap() == 0 {
            break;
        }
        if line.trim() == "READY" {
            ready = true;
            break;
        }
    }
    assert!(ready, "Child did not acquire its use lock");
    assert!(
        FileUse::try_exclusive(&cache.home, "node-child-lifetime")
            .unwrap()
            .is_none()
    );
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        FileUse::try_exclusive(&cache.home, "node-child-lifetime")
            .unwrap()
            .is_some()
    );
}

#[test]
fn cached_release_uses_signed_runtime_without_network_or_selection() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let key = include_str!("fixtures/verification-key.pub");
    assert!(cache.prepare_cached_server_release("0.1.0", key).is_err());
    seed_release(
        &cache,
        include_bytes!("fixtures/release-next.json"),
        include_str!("fixtures/release-next.json.sig"),
        &["node", "server"],
    );
    let prepared = cache.prepare_cached_server_release("0.2.0", key).unwrap();
    assert_eq!(prepared.node.receipt.version, "22.23.4-fixture");
    assert!(!cache.home.join("server/current.json").exists());
    assert!(!cache.home.join("cli").exists());
    for key in [
        format!("node-22.23.4-fixture-{}", host_target().unwrap()),
        format!("server-0.2.0-{}", host_target().unwrap()),
    ] {
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_none());
    }
    fs::write(prepared.server.directory.join("release.json"), b"{}").unwrap();
    assert!(cache.prepare_cached_server_release("0.2.0", key).is_err());
}

fn seed_release(cache: &Cache, bytes: &[u8], signature: &str, components: &[&str]) {
    use harness_bootstrap::{Receipt, ReleaseManifest};
    let manifest: ReleaseManifest = serde_json::from_slice(bytes).unwrap();
    let target = host_target().unwrap();
    let metadata = manifest.targets.get(target).unwrap();
    for (component, version, artifact, node_version) in [
        (
            "node",
            metadata.node.version.as_str(),
            &metadata.node.artifact,
            None,
        ),
        (
            "server",
            manifest.product_version.as_str(),
            &metadata.server,
            Some(metadata.node.version.clone()),
        ),
        (
            "cli",
            manifest.product_version.as_str(),
            &metadata.cli,
            Some(metadata.node.version.clone()),
        ),
    ] {
        if !components.contains(&component) {
            continue;
        }
        let base = if component == "node" {
            "runtime/node"
        } else {
            component
        };
        let directory = cache.home.join(base).join(format!("{version}-{target}"));
        let entry = directory.join(&artifact.entry);
        fs::create_dir_all(entry.parent().unwrap()).unwrap();
        fs::write(entry, b"cached fixture entry").unwrap();
        if component == "server" {
            let helper = if cfg!(windows) {
                "harness-bootstrap.exe"
            } else {
                "harness-bootstrap"
            };
            for file in [
                "worker.mjs",
                "node_modules/@harness/native/harness-native.node",
                helper,
            ] {
                let path = directory.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"controlled server fixture").unwrap();
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(directory.join(helper), fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
            fs::write(directory.join("build.json"), serde_json::to_vec(&serde_json::json!({
                "mode":"release", "productVersion":manifest.product_version, "sourceCommit":manifest.source_commit,
                "target":target,"nodeVersion":metadata.node.version,"releaseManifestUrl":null,"releaseVerificationPublicKey":null,
            })).unwrap()).unwrap();
        }
        let receipt = Receipt {
            format_version: 1,
            component: component.into(),
            version: version.into(),
            target: target.into(),
            artifact: artifact.clone(),
            node_version,
        };
        fs::write(
            directory.join("receipt.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        if component != "node" {
            fs::write(directory.join("release.json"), bytes).unwrap();
            fs::write(directory.join("release.json.minisig"), signature).unwrap();
        }
    }
}

#[test]
fn transferred_release_reuses_signed_cache_without_network_or_cli_and_does_not_select() {
    use harness_bootstrap::ReleaseTransfer;
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let bytes = include_bytes!("fixtures/release.json");
    let signature = include_str!("fixtures/release.json.sig");
    let key = include_str!("fixtures/verification-key.pub");
    seed_release(&cache, bytes, signature, &["node", "server"]);
    let manifest = temporary.path().join("transfer.json");
    let signature_path = temporary.path().join("transfer.sig");
    fs::write(&manifest, bytes).unwrap();
    fs::write(&signature_path, signature).unwrap();
    let request = ReleaseTransfer {
        version: "0.1.0".into(),
        manifest,
        signature: signature_path,
        node_archive: temporary.path().join("not-transferred-node"),
        server_archive: temporary.path().join("not-transferred-server"),
    };
    let prepared = cache.install_transferred_release(&request, key).unwrap();
    assert!(!cache.home.join("cli").exists());
    assert!(!cache.home.join("server/current.json").exists());
    for artifact in [&prepared.node, &prepared.server] {
        let key = format!(
            "{}-{}-{}",
            artifact.receipt.component, artifact.receipt.version, artifact.receipt.target
        );
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_none());
    }
    drop(prepared);
    assert!(
        FileUse::try_exclusive(
            &cache.home,
            &format!("server-0.1.0-{}", host_target().unwrap())
        )
        .unwrap()
        .is_some()
    );
}

#[test]
fn transferred_release_rejects_tampering_version_and_oversized_metadata_before_installation() {
    use harness_bootstrap::ReleaseTransfer;
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let bytes = include_bytes!("fixtures/release.json");
    let manifest = temporary.path().join("transfer.json");
    let signature = temporary.path().join("transfer.sig");
    fs::write(&signature, include_str!("fixtures/release.json.sig")).unwrap();
    let mut request = ReleaseTransfer {
        version: "0.2.0".into(),
        manifest: manifest.clone(),
        signature,
        node_archive: temporary.path().join("absent-node"),
        server_archive: temporary.path().join("absent-server"),
    };
    fs::write(&manifest, bytes).unwrap();
    let key = include_str!("fixtures/verification-key.pub");
    assert!(
        cache
            .install_transferred_release(&request, key)
            .err()
            .unwrap()
            .to_string()
            .contains("captured server version")
    );
    request.version = "0.1.0".into();
    let mut changed = bytes.to_vec();
    changed[0] ^= 1;
    fs::write(&manifest, changed).unwrap();
    assert!(cache.install_transferred_release(&request, key).is_err());
    fs::write(&manifest, vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(
        cache
            .install_transferred_release(&request, key)
            .err()
            .unwrap()
            .to_string()
            .contains("size limit")
    );
    fs::write(&manifest, bytes).unwrap();
    fs::write(&request.signature, vec![b'x'; 16 * 1024 + 1]).unwrap();
    assert!(
        cache
            .install_transferred_release(&request, key)
            .err()
            .unwrap()
            .to_string()
            .contains("size limit")
    );
    assert!(!cache.home.join("runtime").exists());
    assert!(!cache.home.join("server").exists());
}

#[test]
fn cold_signed_server_archive_installs_offline_and_incomplete_signed_payload_never_publishes() {
    use harness_bootstrap::ReleaseTransfer;
    let target = host_target().unwrap();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    for (fixture, valid) in [("release", true), ("release-incomplete", false)] {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        seed_release(
            &cache,
            include_bytes!("fixtures/release.json"),
            include_str!("fixtures/release.json.sig"),
            &["node"],
        );
        let request = ReleaseTransfer {
            version: "0.1.0".into(),
            manifest: fixtures.join(format!("{fixture}.json")),
            signature: fixtures.join(format!("{fixture}.json.sig")),
            server_archive: fixtures.join(format!("{fixture}-server-{target}.tar.gz")),
            node_archive: temporary.path().join("unused-cached-node"),
        };
        let result = cache
            .install_transferred_release(&request, include_str!("fixtures/verification-key.pub"));
        let destination = cache.home.join("server").join(format!("0.1.0-{target}"));
        if valid {
            let prepared = result.unwrap();
            assert_eq!(prepared.server.directory, destination);
            assert_eq!(fs::read(prepared.server.entry).unwrap(), b"server fixture");
            assert!(destination.join("receipt.json").is_file());
            assert!(destination.join("release.json.minisig").is_file());
        } else {
            assert!(result.err().unwrap().to_string().contains("incomplete"));
            assert!(!destination.exists());
        }
        assert!(!cache.home.join("server/current.json").exists());
        assert!(!cache.home.join("cli").exists());
        assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
    }
}

#[test]
fn warm_signed_server_rejects_missing_files_and_mismatched_build_identity_without_mutation() {
    use harness_bootstrap::ReleaseTransfer;
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let target = host_target().unwrap();
    for field in [
        "productVersion",
        "sourceCommit",
        "target",
        "nodeVersion",
        "mode",
        "missing-worker",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        seed_release(
            &cache,
            include_bytes!("fixtures/release.json"),
            include_str!("fixtures/release.json.sig"),
            &["node", "server"],
        );
        let destination = cache.home.join("server").join(format!("0.1.0-{target}"));
        let build = destination.join("build.json");
        let mut identity: serde_json::Value =
            serde_json::from_slice(&fs::read(&build).unwrap()).unwrap();
        if field == "missing-worker" {
            fs::remove_file(destination.join("worker.mjs")).unwrap();
        } else {
            identity[field] = serde_json::json!(if field == "productVersion" {
                "0.2.0"
            } else {
                "mismatched"
            });
            fs::write(&build, serde_json::to_vec(&identity).unwrap()).unwrap();
        }
        let receipt_before = fs::read(destination.join("receipt.json")).unwrap();
        let request = ReleaseTransfer {
            version: "0.1.0".into(),
            manifest: fixtures.join("release.json"),
            signature: fixtures.join("release.json.sig"),
            node_archive: temporary.path().join("absent-node"),
            server_archive: temporary.path().join("absent-server"),
        };
        assert!(
            cache
                .install_transferred_release(
                    &request,
                    include_str!("fixtures/verification-key.pub")
                )
                .is_err(),
            "accepted {field}"
        );
        assert_eq!(
            fs::read(destination.join("receipt.json")).unwrap(),
            receipt_before
        );
        assert!(!cache.home.join("server/current.json").exists());
    }
}

#[test]
fn signed_cached_components_prepare_offline_with_their_requirements_protected() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("space and ünicode home")).unwrap();
    let bytes = include_bytes!("fixtures/release.json");
    let signature = include_str!("fixtures/release.json.sig");
    let key = include_str!("fixtures/verification-key.pub");
    seed_release(&cache, bytes, signature, &["node", "server", "cli"]);
    let target = host_target().unwrap();
    let manifest = harness_bootstrap::verify_release(bytes, signature, key).unwrap();
    let metadata = manifest.targets.get(target).unwrap();
    // An invalid URL proves cached preparation does not even consult transport.
    let prepared = cache
        .prepare_cli_release("0.1.0", "offline:no-network", key)
        .unwrap();
    let prepared_server = cache
        .prepare_server_release("0.1.0", "offline:no-network", key)
        .unwrap();
    for (component, version) in [
        ("node", metadata.node.version.as_str()),
        ("server", "0.1.0"),
        ("cli", "0.1.0"),
    ] {
        assert!(
            FileUse::try_exclusive(&cache.home, &format!("{component}-{version}-{target}"))
                .unwrap()
                .is_none()
        );
    }
    drop(prepared);
    drop(prepared_server);
    let cli_directory = cache.home.join("cli").join(format!("0.1.0-{target}"));
    assert_eq!(cli_directory.parent().unwrap(), cache.home.join("cli"));
    fs::remove_dir_all(&cli_directory).unwrap();
    let server_only = cache
        .prepare_server_release("0.1.0", "offline:no-network", key)
        .unwrap();
    assert!(
        !cli_directory.exists(),
        "Server preparation must not download a CLI payload"
    );
    for (component, version) in [
        ("node", metadata.node.version.as_str()),
        ("server", "0.1.0"),
    ] {
        assert!(
            FileUse::try_exclusive(&cache.home, &format!("{component}-{version}-{target}"))
                .unwrap()
                .is_none()
        );
    }
    drop(server_only);
    let metadata_path = cache
        .home
        .join("server")
        .join(format!("0.1.0-{target}"))
        .join("release.json");
    fs::write(metadata_path, b"tampered metadata").unwrap();
    assert!(
        cache
            .prepare_server_release("0.1.0", "offline:no-network", key)
            .is_err()
    );
}

#[test]
fn older_cli_prepares_the_saved_server_with_its_independent_runtime_offline() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("space and ünicode home")).unwrap();
    let key = include_str!("fixtures/verification-key.pub");
    seed_release(
        &cache,
        include_bytes!("fixtures/release.json"),
        include_str!("fixtures/release.json.sig"),
        &["node", "cli"],
    );
    seed_release(
        &cache,
        include_bytes!("fixtures/release-next.json"),
        include_str!("fixtures/release-next.json.sig"),
        &["node", "server"],
    );
    let target = host_target().unwrap();
    let selection = serde_json::to_vec(&serde_json::json!({
        "formatVersion": 1, "directory": format!("0.2.0-{target}"),
    }))
    .unwrap();
    let path = cache.home.join("server/current.json");
    std::fs::write(&path, &selection).unwrap();
    let cli = cache
        .prepare_cli_release("0.1.0", "offline:no-network", key)
        .unwrap();
    let server = cache
        .prepare_selected_server("0.1.0", "offline:no-network", key)
        .unwrap();
    assert_eq!(cli.manifest.product_version, "0.1.0");
    assert_eq!(server.manifest.product_version, "0.2.0");
    assert_ne!(cli.manifest.source_commit, server.manifest.source_commit);
    assert_eq!(cli.node.receipt.version, "22.23.3");
    assert_eq!(server.node.receipt.version, "22.23.4-fixture");
    assert_eq!(
        server.server.directory,
        cache.home.join(format!("server/0.2.0-{target}"))
    );
    assert_ne!(cli.node.entry, server.node.entry);
    assert!(!cache.home.join(format!("server/0.1.0-{target}")).exists());
    assert!(!cache.home.join(format!("cli/0.2.0-{target}")).exists());
    assert_eq!(std::fs::read(&path).unwrap(), selection);
    for key in [
        format!("cli-0.1.0-{target}"),
        format!("server-0.2.0-{target}"),
        format!("node-22.23.3-{target}"),
        format!("node-22.23.4-fixture-{target}"),
    ] {
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_none());
    }
    drop(cli);
    assert!(
        FileUse::try_exclusive(&cache.home, &format!("node-22.23.3-{target}"))
            .unwrap()
            .is_some()
    );
    assert!(
        FileUse::try_exclusive(&cache.home, &format!("node-22.23.4-fixture-{target}"))
            .unwrap()
            .is_none()
    );
    drop(server);
    assert!(
        FileUse::try_exclusive(&cache.home, &format!("server-0.2.0-{target}"))
            .unwrap()
            .is_some()
    );
    assert!(
        FileUse::try_exclusive(&cache.home, &format!("node-22.23.4-fixture-{target}"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn records_the_first_prepared_server_without_downloading_a_cli() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let key = include_str!("fixtures/verification-key.pub");
    seed_release(
        &cache,
        include_bytes!("fixtures/release.json"),
        include_str!("fixtures/release.json.sig"),
        &["node", "server"],
    );
    let server = cache
        .prepare_selected_server("0.1.0", "offline:no-network", key)
        .unwrap();
    assert_eq!(
        cache.selected_server_version().unwrap().as_deref(),
        Some("0.1.0")
    );
    assert_eq!(server.server.receipt.version, "0.1.0");
    assert!(!cache.home.join("cli").exists());
}

#[test]
fn selection_changed_during_preparation_is_preserved_instead_of_starting_the_old_candidate() {
    use harness_bootstrap::ExclusiveLock;
    use std::time::{Duration, Instant};
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let key = include_str!("fixtures/verification-key.pub");
    seed_release(
        &cache,
        include_bytes!("fixtures/release-next.json"),
        include_str!("fixtures/release-next.json.sig"),
        &["node", "server"],
    );
    let mut gate = ExclusiveLock::new(&cache.home, "server-lifecycle").unwrap();
    assert!(gate.try_acquire().unwrap());
    let home = cache.home.clone();
    let candidate = std::thread::spawn(move || {
        Cache::new(&home)
            .unwrap()
            .prepare_selected_server("0.2.0", "offline:no-network", key)
    });
    // This use lock is acquired after reading the initial (absent) selection.
    let target = host_target().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if FileUse::try_exclusive(&cache.home, &format!("server-0.2.0-{target}"))
            .unwrap()
            .is_none()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Candidate did not begin preparation"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let path = cache.home.join("server/current.json");
    let selected = serde_json::to_vec(&serde_json::json!({
        "formatVersion": 1, "directory": format!("0.1.0-{target}"),
    }))
    .unwrap();
    fs::write(&path, &selected).unwrap();
    drop(gate);
    let error = candidate
        .join()
        .unwrap()
        .err()
        .expect("Stale candidate was admitted");
    assert!(error.to_string().contains("Selected server changed"));
    assert_eq!(fs::read(path).unwrap(), selected);
    assert!(
        FileUse::try_exclusive(&cache.home, &format!("server-0.2.0-{target}"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn invalid_or_untrusted_selection_never_falls_back_or_changes_the_record() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    let key = include_str!("fixtures/verification-key.pub");
    seed_release(
        &cache,
        include_bytes!("fixtures/release-next.json"),
        include_str!("fixtures/release-next.json.sig"),
        &["node", "server"],
    );
    let path = cache.home.join("server/current.json");
    let target = host_target().unwrap();
    let other_target = if target == "windows-x64" {
        "macos-arm64"
    } else {
        "windows-x64"
    };
    for selected in [
        serde_json::json!({"formatVersion": 2, "directory": format!("0.2.0-{target}")}),
        serde_json::json!({"formatVersion": 1, "directory": format!("0.2.0-{other_target}")}),
        serde_json::json!({"formatVersion": 1, "directory": format!("../0.2.0-{target}")}),
        serde_json::json!({"formatVersion": 1, "directory": format!("dev-{target}-{}", "a".repeat(64))}),
        serde_json::json!({"formatVersion": 1, "directory": format!("0.2.0-{target}"), "url": "https://unexpected.invalid"}),
    ] {
        let bytes = serde_json::to_vec(&selected).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(
            cache
                .prepare_selected_server("0.1.0", "offline:no-network", key)
                .is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    let bytes = serde_json::to_vec(&serde_json::json!({
        "formatVersion": 1, "directory": format!("0.2.0-{target}"),
    }))
    .unwrap();
    std::fs::write(&path, &bytes).unwrap();
    assert!(
        cache
            .prepare_selected_server(
                "0.1.0",
                "offline:no-network",
                include_str!("../../../release/verification-key.pub")
            )
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert!(!cache.home.join(format!("server/0.1.0-{target}")).exists());
}
