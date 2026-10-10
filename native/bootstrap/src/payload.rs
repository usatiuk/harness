use crate::BuildIdentity;
use anyhow::{Result, bail};
use std::{fs::File, io::Read, path::Path};

/// Validate the complete executable unit before publication and on cache reuse.
pub(crate) fn validate_server(
    root: &Path,
    mode: &str,
    target: &str,
    node_version: &str,
) -> Result<BuildIdentity> {
    let canonical = root.canonicalize()?;
    let bootstrap = if cfg!(windows) {
        "harness-bootstrap.exe"
    } else {
        "harness-bootstrap"
    };
    for name in [
        "build.json",
        "server.mjs",
        "worker.mjs",
        "node_modules/@harness/native/harness-native.node",
        bootstrap,
    ] {
        let entry = root.join(name);
        if !entry.is_file() || !entry.canonicalize()?.starts_with(&canonical) {
            bail!("Server payload is incomplete or has an escaping entry: {name}");
        }
    }
    let mut bytes = Vec::new();
    File::open(root.join("build.json"))?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        bail!("Server build metadata exceeds its size limit");
    }
    let identity: BuildIdentity = serde_json::from_slice(&bytes)?;
    if identity.mode != mode || identity.target != target {
        bail!("Server payload is not built for this mode and host");
    }
    if identity.node_version != node_version {
        bail!("Server payload requires a different pinned Node; rebuild or upgrade it");
    }
    crate::manifest::version(&identity.product_version)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(root.join(bootstrap))?
            .permissions()
            .mode()
            & 0o100
            == 0
        {
            bail!("Server native bootstrap is not executable");
        }
    }
    Ok(identity)
}
