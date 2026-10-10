use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let product_path = root.join("release/product.json");
    let public_key = root.join("release/verification-key.pub");
    println!("cargo:rerun-if-changed={}", product_path.display());
    println!("cargo:rerun-if-changed={}", public_key.display());
    println!("cargo:rerun-if-env-changed=HARNESS_RELEASE_BUILD");
    println!(
        "cargo:rustc-env=HARNESS_RELEASE_BUILD={}",
        env::var("HARNESS_RELEASE_BUILD").unwrap_or_else(|_| "0".into())
    );
    println!("cargo:rerun-if-env-changed=HARNESS_SOURCE_COMMIT");
    let product: serde_json::Value =
        serde_json::from_slice(&fs::read(product_path).unwrap()).unwrap();
    let version = product["version"].as_str().unwrap();
    assert_eq!(
        version,
        env::var("CARGO_PKG_VERSION").unwrap(),
        "Native/product versions differ"
    );
    let repository = product["repository"].as_str().unwrap();
    println!("cargo:rustc-env=HARNESS_PRODUCT_VERSION={version}");
    println!(
        "cargo:rustc-env=HARNESS_MANIFEST_URL=https://github.com/{repository}/releases/download/v{version}/release.json"
    );
    println!(
        "cargo:rustc-env=HARNESS_RELEASE_BASE_URL=https://github.com/{repository}/releases/download"
    );
    let source = env::var("HARNESS_SOURCE_COMMIT").unwrap_or_else(|_| {
        let mut command = Command::new("git");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success(), "Cannot capture source identity");
        String::from_utf8(output.stdout).unwrap().trim().into()
    });
    assert!(
        source.len() == 40 && source.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid source commit"
    );
    println!("cargo:rustc-env=HARNESS_SOURCE_COMMIT={source}");
}
