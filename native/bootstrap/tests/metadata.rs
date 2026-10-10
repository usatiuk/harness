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
