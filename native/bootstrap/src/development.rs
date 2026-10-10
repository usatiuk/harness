use crate::{ArchiveFormat, Cache, InstalledArtifact, NodePin, host_target};
use anyhow::{Result, bail};
use std::{fs::File, path::Path};

pub struct PreparedDevelopmentServer {
    pub node: InstalledArtifact,
    pub server: InstalledArtifact,
}

impl Cache {
    pub fn prepare_development_server(&self, payload: &Path) -> Result<PreparedDevelopmentServer> {
        let digest = std::fs::read_to_string(payload.join("server.tar.gz.sha256"))?;
        self.install_development_server(&payload.join("server.tar.gz"), digest.trim())
    }
    pub fn prepare_cached_development_server(
        &self,
        digest: &str,
    ) -> Result<PreparedDevelopmentServer> {
        validate_digest(digest)?;
        let pin = NodePin::bundled()?;
        let node = self.existing("node", &pin.version, &pin.targets[host_target()?])?;
        let directory = self
            .home
            .join("server")
            .join(format!("dev-{}-{digest}", host_target()?));
        crate::payload::validate_server(&directory, "development", &node.version)?;
        let entry = crate::cache::checked_entry(&directory, "server.mjs")?;
        Ok(PreparedDevelopmentServer {
            node,
            server: InstalledArtifact {
                directory,
                entry,
                version: digest.into(),
            },
        })
    }
    pub fn install_development_server(
        &self,
        archive: &Path,
        digest: &str,
    ) -> Result<PreparedDevelopmentServer> {
        validate_digest(digest)?;
        let node = self.prepare_node()?;
        let base = self.home.join("server");
        crate::home::protect_directory(&base, true)?;
        let directory = base.join(format!("dev-{}-{digest}", host_target()?));
        let install = crate::FileUse::file(&self.home, "install")?;
        install.lock()?;
        if !directory.exists() {
            let stage = self.stage()?;
            let copied = stage.path().join("download");
            let mut source = File::open(archive)?;
            let size = source.metadata()?.len();
            crate::cache::copy_verified(&mut source, &mut File::create(&copied)?, size, digest)?;
            let root = crate::archive::extract_layout(
                &copied,
                &stage.path().join("unpacked"),
                ArchiveFormat::TarGz,
                "server",
                "server.mjs",
            )?;
            crate::payload::validate_server(&root, "development", &NodePin::bundled()?.version)?;
            std::fs::rename(root, &directory)?;
            stage.close()?;
        }
        crate::payload::validate_server(&directory, "development", &node.version)?;
        let entry = crate::cache::checked_entry(&directory, "server.mjs")?;
        Ok(PreparedDevelopmentServer {
            node,
            server: InstalledArtifact {
                directory,
                entry,
                version: digest.into(),
            },
        })
    }
}

fn validate_digest(digest: &str) -> Result<()> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("Invalid development archive SHA-256");
    }
    Ok(())
}
