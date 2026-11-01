use harness_bootstrap::verify_release;

#[test]
fn signatures_bind_original_metadata_bytes_and_key() {
    let bytes = include_bytes!("fixtures/release.json");
    let signature = include_str!("fixtures/release.json.sig");
    let key = include_str!("fixtures/verification-key.pub");
    assert_eq!(
        verify_release(bytes, signature, key)
            .unwrap()
            .product_version,
        "0.1.0"
    );
    let mut changed = bytes.to_vec();
    changed[0] ^= 1;
    assert!(verify_release(&changed, signature, key).is_err());
    assert!(
        verify_release(
            bytes,
            signature,
            include_str!("../../../release/verification-key.pub")
        )
        .is_err()
    );
}

#[test]
fn foreign_platform_names_still_require_valid_descriptors() {
    use harness_bootstrap::{NodePin, ReleaseManifest};
    use serde_json::json;

    let pin = NodePin::bundled().unwrap();
    let entry = json!({
        "node": { "version": pin.version, "artifact": pin.targets["linux-arm64-glibc"] },
        "server": {
            "url": "https://example.invalid/server.tar.gz",
            "size": 123,
            "sha256": "a".repeat(64),
            "format": "tarGz",
            "root": "server",
            "entry": "server.mjs"
        },
        "cli": {
            "url": "https://example.invalid/cli.tar.gz",
            "size": 123,
            "sha256": "a".repeat(64),
            "format": "tarGz",
            "root": "cli",
            "entry": "cli.mjs"
        },
        "launcher": {
            "url": "https://example.invalid/harness",
            "size": 123,
            "sha256": "a".repeat(64),
            "format": "file",
            "root": "harness",
            "entry": "harness"
        }
    });
    let mut wire = json!({
        "formatVersion": 1,
        "productVersion": "0.1.0",
        "targets": { "linux-arm64-glibc": entry }
    });
    let entry = wire["targets"]["linux-arm64-glibc"].clone();
    wire["targets"]["futureos-riscv128"] = entry.clone();
    serde_json::from_value::<ReleaseManifest>(wire.clone())
        .unwrap()
        .validate()
        .unwrap();

    let mut empty = wire.clone();
    empty["targets"] = json!({});
    assert!(
        serde_json::from_value::<ReleaseManifest>(empty)
            .unwrap()
            .validate()
            .is_err()
    );

    let mut invalid_version = entry.clone();
    invalid_version["node"]["version"] = json!("bad");
    let mut invalid_sha = entry.clone();
    invalid_sha["server"]["sha256"] = json!("invalid");
    let mut invalid_url = entry.clone();
    invalid_url["cli"]["url"] = json!("http://example.invalid/cli");
    let mut invalid_path = entry.clone();
    invalid_path["launcher"]["entry"] = json!("../escape");
    let mut invalid_format = entry;
    invalid_format["server"]["format"] = json!("futureArchive");
    for bad in [
        json!(null),
        json!({}),
        invalid_version,
        invalid_sha,
        invalid_url,
        invalid_path,
        invalid_format,
    ] {
        let mut invalid = wire.clone();
        invalid["targets"]["futureos-riscv128"] = bad.clone();
        assert!(
            serde_json::from_value::<ReleaseManifest>(invalid)
                .map_err(anyhow::Error::from)
                .and_then(|manifest| manifest.validate())
                .is_err(),
            "accepted malformed foreign descriptor: {bad}"
        );
    }
}

#[test]
fn native_host_target_has_its_own_bundled_node_pin() {
    let target = harness_bootstrap::host_target().unwrap();
    let pin = harness_bootstrap::NodePin::bundled().unwrap();
    assert!(pin.targets.contains_key(target));
    #[cfg(all(target_os = "linux", target_arch = "aarch64", target_env = "gnu"))]
    assert_eq!(target, "linux-arm64-glibc");
    #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
    assert_eq!(target, "linux-x64-glibc");
}
