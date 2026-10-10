use crate::BuildIdentity;
use anyhow::{Result, bail};
use std::{fs::File, io::Read, path::Path};

pub(crate) fn validate_server(
    root: &Path,
    mode: &str,
    node_version: &str,
) -> Result<BuildIdentity> {
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
        crate::cache::checked_entry(root, name)?;
    }
    let mut bytes = Vec::new();
    File::open(root.join("build.json"))?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        bail!("Server build metadata exceeds its limit");
    }
    let identity: BuildIdentity = serde_json::from_slice(&bytes)?;
    if identity.mode != mode
        || identity.target != crate::host_target()?
        || identity.node_version != node_version
    {
        bail!("Server payload has a different mode, platform, or Node requirement");
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
            bail!("Server bootstrap is not executable");
        }
    }
    Ok(identity)
}
