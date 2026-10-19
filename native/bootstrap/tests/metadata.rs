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
fn signed_arm64_extension_normalizes_without_breaking_legacy_decoders() {
    use harness_bootstrap::{NodePin, ReleaseManifest, ReleaseTarget};
    use serde::Deserialize;
    use std::collections::BTreeMap;

    let bytes = include_bytes!("fixtures/arm64-release.json");
    let signature = include_str!("fixtures/arm64-release.json.sig");
    let key = include_str!("fixtures/arm64-verification-key.pub");
    let manifest = verify_release(bytes, signature, key).unwrap();
    let arm = &manifest.targets["linux-arm64-glibc"];
    let pin = NodePin::bundled().unwrap();
    assert_eq!(arm.node.artifact, pin.targets["linux-arm64-glibc"]);
    assert_eq!(arm.node.version, pin.version);

    // The shipped decoder ignored root extensions, then validated every target key.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyManifest {
        format_version: u32,
        product_version: String,
        targets: BTreeMap<String, ReleaseTarget>,
    }
    let legacy: LegacyManifest = serde_json::from_slice(bytes).unwrap();
    let legacy = ReleaseManifest {
        format_version: legacy.format_version,
        product_version: legacy.product_version,
        targets: legacy.targets,
    };
    legacy.validate().unwrap();
    assert!(legacy.targets.keys().all(|key| {
        ["windows-x64", "linux-x64-glibc", "macos-arm64", "macos-x64"].contains(&key.as_str())
    }));

    // Canonical Rust serialization is also readable; N-API returns the original signed bytes.
    let canonical = serde_json::to_vec(&manifest).unwrap();
    let decoded: ReleaseManifest = serde_json::from_slice(&canonical).unwrap();
    decoded.validate().unwrap();
    assert_eq!(
        decoded.targets["linux-arm64-glibc"].node.artifact,
        arm.node.artifact
    );
    let mut duplicate: serde_json::Value = serde_json::from_slice(&canonical).unwrap();
    duplicate["linuxArm64Glibc"] = duplicate["targets"]["linux-arm64-glibc"].clone();
    assert!(serde_json::from_value::<ReleaseManifest>(duplicate).is_err());

    for bad in [
        serde_json::Value::Null,
        serde_json::json!({}),
        serde_json::json!({"node": {"version": "bad"}}),
    ] {
        let mut wire: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        wire["linuxArm64Glibc"] = bad;
        assert!(serde_json::from_value::<ReleaseManifest>(wire).is_err());
    }
    let mut tampered: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    tampered["linuxArm64Glibc"]["node"]["artifact"]["sha256"] = "b".repeat(64).into();
    assert!(verify_release(&serde_json::to_vec(&tampered).unwrap(), signature, key).is_err());
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
