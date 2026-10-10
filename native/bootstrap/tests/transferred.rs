use flate2::{Compression, write::GzEncoder};
use harness_bootstrap::{Cache, FileUse, NodePin, Receipt, host_target};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};

// Receipt fixtures isolate archive/installation semantics; these bytes are not
// executed or claimed to establish real Node/native-addon ABI behavior.
fn seed_node(cache: &Cache) {
    let pin = NodePin::bundled().unwrap();
    let target = host_target().unwrap();
    let artifact = pin.targets[target].clone();
    let root = cache
        .home
        .join("runtime/node")
        .join(format!("{}-{target}", pin.version));
    let entry = root.join(&artifact.entry);
    fs::create_dir_all(entry.parent().unwrap()).unwrap();
    fs::write(entry, b"controlled Node fixture").unwrap();
    fs::write(
        root.join("receipt.json"),
        serde_json::to_vec(&Receipt {
            format_version: 1,
            component: "node".into(),
            version: pin.version,
            target: target.into(),
            artifact,
            node_version: None,
        })
        .unwrap(),
    )
    .unwrap();
}

fn archive(
    directory: &Path,
    target: &str,
    version: &str,
    bootstrap: bool,
) -> (PathBuf, u64, String) {
    let path = directory.join("source.tar.gz");
    let mut archive = tar::Builder::new(GzEncoder::new(
        File::create(&path).unwrap(),
        Compression::fast(),
    ));
    let identity = serde_json::to_vec(&serde_json::json!({
        "mode":"development","productVersion":"0.1.0", "sourceCommit":"a".repeat(40),
        "target":target,"nodeVersion":version,"releaseManifestUrl":null,"releaseVerificationPublicKey":null,
    })).unwrap();
    let mut entries = vec![
        ("server/server.mjs", b"server".to_vec()),
        ("server/worker.mjs", b"worker".to_vec()),
        (
            "server/node_modules/@harness/native/harness-native.node",
            b"native".to_vec(),
        ),
        ("server/build.json", identity),
    ];
    if bootstrap {
        entries.push((
            if cfg!(windows) {
                "server/harness-bootstrap.exe"
            } else {
                "server/harness-bootstrap"
            },
            b"bootstrap".to_vec(),
        ));
    }
    for (name, bytes) in entries {
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
    (
        path,
        bytes.len() as u64,
        format!("{:x}", Sha256::digest(bytes)),
    )
}

#[test]
fn installs_complete_transferred_source_immutably_and_retains_both_components() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    seed_node(&cache);
    let pin = NodePin::bundled().unwrap();
    let target = host_target().unwrap();
    let (path, size, digest) = archive(temporary.path(), target, &pin.version, true);
    let prepared = cache
        .install_transferred_development_server(
            &path,
            size,
            &digest,
            &temporary.path().join("absent-node-archive"),
        )
        .unwrap();
    assert_eq!(
        prepared.server.directory,
        cache
            .home
            .join("server")
            .join(format!("dev-{target}-{digest}"))
    );
    assert_eq!(fs::read(&prepared.server.entry).unwrap(), b"server");
    assert!(!cache.home.join("server/current.json").exists());
    assert!(!cache.home.join("cli").exists());
    for key in [
        format!("server-dev-{target}-{digest}"),
        format!("node-{}-{target}", pin.version),
    ] {
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_none());
    }
    fs::remove_file(&path).unwrap();
    let warm = cache
        .install_transferred_development_server(
            &path,
            size,
            &digest,
            &temporary.path().join("absent-node-archive"),
        )
        .unwrap();
    assert_eq!(prepared.server.directory, warm.server.directory);
    let cached = cache.prepare_cached_development_server(&digest).unwrap();
    assert_eq!(cached.server.directory, prepared.server.directory);
    assert_eq!(cached.node.entry, prepared.node.entry);
    drop(prepared);
    drop(warm);
    drop(cached);
    assert!(
        FileUse::try_exclusive(&cache.home, &format!("server-dev-{target}-{digest}"))
            .unwrap()
            .is_some()
    );
    assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
}

#[test]
fn cached_source_requires_both_complete_components_without_downloading_or_selecting() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    assert!(
        cache
            .prepare_cached_development_server(&"a".repeat(64))
            .is_err()
    );
    assert!(!cache.home.join("server/current.json").exists());
    assert!(
        !cache
            .home
            .join("runtime/node")
            .join(format!("22.23.3-{}", host_target().unwrap()))
            .exists()
    );
    seed_node(&cache);
    assert!(
        cache
            .prepare_cached_development_server("../outside")
            .is_err()
    );
    assert!(
        cache
            .prepare_cached_development_server(&"a".repeat(64))
            .is_err()
    );
    let pin = NodePin::bundled().unwrap();
    let (path, size, digest) =
        archive(temporary.path(), host_target().unwrap(), &pin.version, true);
    let prepared = cache
        .install_transferred_development_server(&path, size, &digest, &path)
        .unwrap();
    fs::remove_file(prepared.server.directory.join("worker.mjs")).unwrap();
    assert!(cache.prepare_cached_development_server(&digest).is_err());
    assert!(!cache.home.join("server/current.json").exists());
}

#[test]
fn rejects_incomplete_or_wrong_target_runtime_transfers_without_publishing_server() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    seed_node(&cache);
    let pin = NodePin::bundled().unwrap();
    let target = host_target().unwrap();
    for (build_target, version, bootstrap) in [
        ("wrong-target", pin.version.as_str(), true),
        (target, "22.0.0", true),
        (target, pin.version.as_str(), false),
    ] {
        let (path, size, digest) = archive(temporary.path(), build_target, version, bootstrap);
        assert!(
            cache
                .install_transferred_development_server(
                    &path,
                    size,
                    &digest,
                    &temporary.path().join("absent-node-archive")
                )
                .is_err()
        );
        assert!(!cache.home.join("server").exists());
        assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
    }
}

#[test]
fn rejects_changed_or_truncated_source_archive_before_extracting_or_publishing() {
    let temporary = tempfile::tempdir().unwrap();
    let cache = Cache::new(&temporary.path().join("home")).unwrap();
    seed_node(&cache);
    let pin = NodePin::bundled().unwrap();
    let (path, size, digest) =
        archive(temporary.path(), host_target().unwrap(), &pin.version, true);
    for (expected_size, expected_digest) in [
        (size + 1, digest.as_str()),
        (size - 1, digest.as_str()),
        (size, "invalid"),
    ] {
        assert!(
            cache
                .install_transferred_development_server(
                    &path,
                    expected_size,
                    expected_digest,
                    &temporary.path().join("absent-node-archive")
                )
                .is_err()
        );
        assert!(!cache.home.join("server").exists());
        assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
    }
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(&path, bytes).unwrap();
    assert!(
        cache
            .install_transferred_development_server(
                &path,
                size,
                &digest,
                &temporary.path().join("absent-node-archive")
            )
            .is_err()
    );
    assert!(!cache.home.join("server").exists());
}
