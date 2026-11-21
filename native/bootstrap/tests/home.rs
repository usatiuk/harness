use harness_bootstrap::{canonical_home, protect_directory};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{path::PathBuf, process::Command};

#[test]
fn home_validation_does_not_require_external_commands() {
    if let Some(path) = std::env::var_os("HARNESS_TEST_ACCOUNT_HOME") {
        let path = PathBuf::from(path);
        assert_eq!(
            canonical_home(&path).unwrap().canonicalize().unwrap(),
            path.canonicalize().unwrap()
        );
        let private = path.join("runtime");
        // The second call exercises protection of an existing directory.
        protect_directory(&private, true).unwrap();
        protect_directory(&private, true).unwrap();
        let file = path.join("file");
        std::fs::write(&file, []).unwrap();
        assert!(protect_directory(&file, false).is_err());
        #[cfg(unix)]
        {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();
            assert_eq!(
                canonical_home(&path).unwrap_err().to_string(),
                "Harness home is writable by other users"
            );
        }
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let status = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "home_validation_does_not_require_external_commands",
        ])
        .env("PATH", "")
        .current_dir(directory.path())
        .env(
            "HARNESS_TEST_ACCOUNT_HOME",
            directory.path().join("nested/home"),
        )
        .status()
        .unwrap();
    assert!(status.success());
}
