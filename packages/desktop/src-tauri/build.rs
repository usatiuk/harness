fn main() {
    let root =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    let product_path = root.join("release/product.json");
    println!("cargo:rerun-if-changed={}", product_path.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("release/verification-key.pub").display()
    );
    println!("cargo:rerun-if-env-changed=HARNESS_RELEASE_BUILD");
    println!("cargo:rerun-if-env-changed=HARNESS_SOURCE_COMMIT");
    let product: serde_json::Value =
        serde_json::from_slice(&std::fs::read(product_path).unwrap()).unwrap();
    let version = product["version"].as_str().unwrap();
    assert_eq!(
        version,
        std::env::var("CARGO_PKG_VERSION").unwrap(),
        "Desktop/product versions differ"
    );
    let repository = product["repository"].as_str().unwrap();
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
    let source = std::env::var("HARNESS_SOURCE_COMMIT").unwrap_or_else(|_| {
        let mut command = std::process::Command::new("git");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command
            .args(["rev-parse", "HEAD"])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Cannot capture desktop source identity"
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    });
    assert!(
        source.len() == 40 && source.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid desktop source identity"
    );
    println!("cargo:rustc-env=HARNESS_SOURCE_COMMIT={source}");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "window_material",
            "window_decorate",
            "window_modal",
            "server_connect",
            "server_write",
            "server_ack",
            "server_disconnect",
            "connection_command",
            "cancel_connection_command",
        ]),
    ))
    .expect("Could not generate desktop permissions")
}
