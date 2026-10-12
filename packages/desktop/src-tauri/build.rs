fn main() {
    let root =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    let product_path = root.join("package.json");
    println!("cargo:rerun-if-changed={}", product_path.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("release/verification-key.pub").display()
    );
    println!("cargo:rerun-if-env-changed=HARNESS_RELEASE_BUILD");
    let product: serde_json::Value =
        serde_json::from_slice(&std::fs::read(product_path).unwrap()).unwrap();
    let version = product["version"].as_str().unwrap();
    assert_eq!(
        version,
        std::env::var("CARGO_PKG_VERSION").unwrap(),
        "Desktop/product versions differ"
    );
    let repository = "usatiuk/harness";
    println!("cargo:rustc-env=HARNESS_PRODUCT_VERSION={version}");
    println!(
        "cargo:rustc-env=HARNESS_MANIFEST_URL=https://github.com/{repository}/releases/download/v{version}/release.json"
    );
    println!(
        "cargo:rustc-env=HARNESS_RELEASE_BASE_URL=https://github.com/{repository}/releases/download"
    );
    println!(
        "cargo:rustc-env=HARNESS_BUILD_MODE={}",
        if std::env::var("HARNESS_RELEASE_BUILD").as_deref() == Ok("1") {
            "release"
        } else {
            "development"
        }
    );
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "window_material",
            "window_decorate",
            "window_modal",
            "server_connect",
            "server_write",
            "server_ack",
            "server_disconnect",
            "desktop_update",
            "connection_command",
            "cancel_connection_command",
        ]),
    ))
    .expect("Could not generate desktop permissions")
}
