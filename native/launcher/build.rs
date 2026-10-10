use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let product_path = root.join("package.json");
    let public_key = root.join("release/verification-key.pub");
    println!("cargo:rerun-if-changed={}", product_path.display());
    println!("cargo:rerun-if-changed={}", public_key.display());
    println!("cargo:rerun-if-env-changed=HARNESS_RELEASE_BUILD");
    println!(
        "cargo:rustc-env=HARNESS_RELEASE_BUILD={}",
        env::var("HARNESS_RELEASE_BUILD").unwrap_or_else(|_| "0".into())
    );
    let product: serde_json::Value =
        serde_json::from_slice(&fs::read(product_path).unwrap()).unwrap();
    let version = product["version"].as_str().unwrap();
    assert_eq!(
        version,
        env::var("CARGO_PKG_VERSION").unwrap(),
        "Native/product versions differ"
    );
    let repository = "usatiuk/harness-releases";
    println!("cargo:rustc-env=HARNESS_PRODUCT_VERSION={version}");
    println!(
        "cargo:rustc-env=HARNESS_MANIFEST_URL=https://github.com/{repository}/releases/download/v{version}/release.json"
    );
    println!(
        "cargo:rustc-env=HARNESS_RELEASE_BASE_URL=https://github.com/{repository}/releases/download"
    );
}
