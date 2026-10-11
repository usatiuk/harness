#![cfg(unix)]

use harness_bootstrap::canonical_home;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

#[test]
fn home_validation_does_not_require_external_commands() {
    if let Some(path) = std::env::var_os("HARNESS_TEST_ACCOUNT_HOME") {
        let path = PathBuf::from(path);
        assert_eq!(canonical_home(&path).unwrap(), path.canonicalize().unwrap());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            canonical_home(&path).unwrap_err().to_string(),
            "Harness home is writable by other users"
        );
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "home_validation_does_not_require_external_commands",
        ])
        .env("PATH", "")
        .env("HARNESS_TEST_ACCOUNT_HOME", directory.path().join("home"))
        .status()
        .unwrap();
    assert!(status.success());
}
