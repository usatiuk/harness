use crate::{
    Artifact, Cache, InstalledArtifact, PreparedServer, Receipt, VerifiedRelease, host_target,
};
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

/// Private, per-attempt transfer paths. Executable trust comes from the captured
/// project key (release) or explicit source-build mode, never from a remote URL.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ServerTransfer {
    Release(ReleaseTransfer),
    Development(DevelopmentTransfer),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseTransfer {
    pub version: String,
    pub manifest: PathBuf,
    pub signature: PathBuf,
    pub node_archive: PathBuf,
    pub server_archive: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentTransfer {
    pub archive: PathBuf,
    pub size: u64,
    pub sha256: String,
    pub node_archive: PathBuf,
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("Transferred metadata exceeds its size limit");
    }
    Ok(bytes)
}

impl Cache {
    pub(crate) fn install_transferred_node(
        &self,
        version: &str,
        artifact: &Artifact,
        archive: &Path,
    ) -> Result<InstalledArtifact> {
        self.install_using(
            Receipt {
                format_version: 1,
                component: "node".into(),
                version: version.into(),
                target: host_target()?.into(),
                artifact: artifact.clone(),
                node_version: None,
            },
            None,
            |_| Ok(File::open(archive)?),
        )
    }

    /// The same receipt, use/install locks, bounds and atomic publication as
    /// local downloads. SSH/WSL supplies files instead of an HTTP response.
    /// Staging a payload does not activate it or replace server/current.json.
    pub fn install_transferred_release(
        &self,
        transfer: &ReleaseTransfer,
        public_key: &str,
    ) -> Result<PreparedServer> {
        let bytes = read_bounded(&transfer.manifest, 1024 * 1024)?;
        let signature = String::from_utf8(read_bounded(&transfer.signature, 16 * 1024)?)?;
        let manifest = crate::verify_release(&bytes, &signature, public_key)?;
        if manifest.product_version != transfer.version {
            bail!("Transferred release does not match the captured server version");
        }
        let target = host_target()?;
        let metadata = manifest
            .targets
            .get(target)
            .context("Transferred release does not support this platform")?;
        let node = self.install_transferred_node(
            &metadata.node.version,
            &metadata.node.artifact,
            &transfer.node_archive,
        )?;
        let receipt = Receipt {
            format_version: 1,
            component: "server".into(),
            version: manifest.product_version.clone(),
            target: target.into(),
            artifact: metadata.server.clone(),
            node_version: Some(metadata.node.version.clone()),
        };
        let release = VerifiedRelease {
            bytes,
            signature,
            manifest,
        };
        let server = self.install_using(receipt, Some(&release), |_| {
            Ok(File::open(&transfer.server_archive)?)
        })?;
        Ok(PreparedServer {
            node,
            server,
            manifest: release.manifest,
        })
    }
}
