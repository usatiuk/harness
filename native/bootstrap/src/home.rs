use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[cfg(windows)]
#[path = "home/windows.rs"]
mod platform;

pub fn default_home() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("HARNESS_HOME") {
        return Ok(PathBuf::from(value));
    }
    let base = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .context("Cannot resolve the current account's home directory")?;
    Ok(PathBuf::from(base).join(".harness"))
}

pub fn canonical_home(path: &Path) -> Result<PathBuf> {
    protect_directory(path, false)?;
    #[cfg(windows)]
    let home = dunce::canonicalize(path)?;
    #[cfg(not(windows))]
    let home = path.canonicalize()?;
    if home != path {
        protect_directory(&home, false)?;
    }
    Ok(home)
}

/// Create `path` user-privately, then confirm no untrusted principal can mutate it.
///
/// `private` additionally applies the private ACL to an existing directory.
/// Verification-only is used for the home itself, which may legitimately carry
/// inherited rules from its parent.
pub fn protect_directory(path: &Path, private: bool) -> Result<()> {
    platform::protect(path, private)
}

#[cfg(unix)]
mod platform {
    use anyhow::{Result, bail};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    use std::path::Path;

    pub(super) fn protect(path: &Path, private: bool) -> Result<()> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        let metadata = std::fs::metadata(path)?;
        // SAFETY: geteuid has no arguments or preconditions. Avoid spawning host
        // utilities, which inherit AppImage libraries incompatible with the host.
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid {
            bail!("Harness directory has another owner");
        }
        if private {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        } else if metadata.mode() & 0o022 != 0 {
            bail!("Harness home is writable by other users");
        }
        Ok(())
    }
}
