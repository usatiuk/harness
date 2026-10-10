use crate::{
    Cache, ExclusiveLock, FileUse, InstalledArtifact, Receipt, ReleaseManifest, VerifiedRelease,
    fetch_verified_release, host_target, http_client, verify_release,
};
use anyhow::{Context, Result, bail};
use std::{
    io::{ErrorKind, Read, Write},
    time::{Duration, Instant},
};

/// Each consumer retains its own payload and exact runtime through child exit.
pub struct PreparedCli {
    pub node: InstalledArtifact,
    pub cli: InstalledArtifact,
    pub manifest: ReleaseManifest,
}

/// Desktop and remote bridges need the server and its runtime, without a CLI.
pub struct PreparedServer {
    pub node: InstalledArtifact,
    pub server: InstalledArtifact,
    pub manifest: ReleaseManifest,
}

impl Cache {
    pub fn prepare_cli_release(
        &self,
        version: &str,
        url: &str,
        public_key: &str,
    ) -> Result<PreparedCli> {
        let (_capture, release) = self.capture_release("cli", version, url, public_key)?;
        let target = host_target()?;
        let metadata = release
            .manifest
            .targets
            .get(target)
            .context("This release does not support the current platform")?;
        let node = self.prepare_runtime(metadata)?;
        let cli = self.install(
            Receipt {
                format_version: 1,
                component: "cli".into(),
                version: version.into(),
                target: target.into(),
                artifact: metadata.cli.clone(),
                node_version: Some(node.receipt.version.clone()),
            },
            Some(&release),
        )?;
        Ok(PreparedCli {
            node,
            cli,
            manifest: release.manifest,
        })
    }

    pub fn prepare_server_release(
        &self,
        version: &str,
        url: &str,
        public_key: &str,
    ) -> Result<PreparedServer> {
        let (_capture, release) = self.capture_release("server", version, url, public_key)?;
        self.prepare_server(&release)
    }

    /// A provisioned remote bridge opens its exact immutable payload offline.
    /// The saved signature supplies this server's own Node requirement.
    pub fn prepare_cached_server_release(
        &self,
        version: &str,
        public_key: &str,
    ) -> Result<PreparedServer> {
        crate::manifest::version(version)?;
        let target = host_target()?;
        let _capture = FileUse::shared(&self.home, &format!("server-{version}-{target}"))?;
        let directory = self.home.join("server").join(format!("{version}-{target}"));
        let release = read_cached_release(&directory, public_key)?;
        if release.manifest.product_version != version {
            bail!("Cached release metadata does not match the captured server version");
        }
        let metadata = release
            .manifest
            .targets
            .get(target)
            .context("This release does not support the current platform")?;
        let node = self.open_cached(
            Receipt {
                format_version: 1,
                component: "node".into(),
                version: metadata.node.version.clone(),
                target: target.into(),
                artifact: metadata.node.artifact.clone(),
                node_version: None,
            },
            None,
        )?;
        let server = self.open_cached(
            Receipt {
                format_version: 1,
                component: "server".into(),
                version: version.into(),
                target: target.into(),
                artifact: metadata.server.clone(),
                node_version: Some(node.receipt.version.clone()),
            },
            Some(&release),
        )?;
        Ok(PreparedServer {
            node,
            server,
            manifest: release.manifest,
        })
    }

    /// Resolve the saved local release without replacing it with the client's version.
    /// Publish only the initial choice, after preparing it and under the same
    /// lifecycle gate as connection managers. Existing choices are never replaced.
    pub fn prepare_selected_server(
        &self,
        default_version: &str,
        release_base_url: &str,
        public_key: &str,
    ) -> Result<PreparedServer> {
        let version = self
            .selected_server_version()?
            .unwrap_or(default_version.into());
        let prepared = self.prepare_server_release(
            &version,
            &format!("{release_base_url}/v{version}/release.json"),
            public_key,
        )?;
        let mut gate = ExclusiveLock::new(&self.home, "server-lifecycle")?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !gate.try_acquire()? {
            if Instant::now() >= deadline {
                bail!(
                    "Another Harness server operation is still running; try again when it finishes"
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        match self.selected_server_version()? {
            Some(selected) if selected != version => {
                bail!("Selected server changed; prepare the selected version and reconnect");
            }
            Some(_) => {}
            None => {
                let mut file = tempfile::NamedTempFile::new_in(self.home.join("server"))?;
                serde_json::to_writer(
                    &mut file,
                    &serde_json::json!({
                        "formatVersion": 1,
                        "directory": format!("{version}-{}", host_target()?),
                    }),
                )?;
                file.flush()?;
                file.as_file().sync_all()?;
                file.persist_noclobber(self.home.join("server/current.json"))?;
            }
        }
        Ok(prepared)
    }

    pub fn selected_server_version(&self) -> Result<Option<String>> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Selection {
            format_version: u32,
            directory: String,
        }
        let path = self.home.join("server/current.json");
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).context("Cannot read selected server"),
        };
        let selected: Selection =
            serde_json::from_slice(&bytes).context("Invalid selected server record")?;
        if selected.format_version != 1 {
            bail!("Unsupported server selection format; upgrade the client");
        }
        if selected.directory.len() > 256 {
            bail!("Invalid selected server directory");
        }
        let suffix = format!("-{}", host_target()?);
        let version = selected
            .directory
            .strip_suffix(&suffix)
            .context("Selected server is not a release for this platform")?;
        crate::manifest::version(version)
            .context("Selected server is not a release; use its development checkout")?;
        Ok(Some(version.into()))
    }

    fn capture_release(
        &self,
        component: &str,
        version: &str,
        url: &str,
        public_key: &str,
    ) -> Result<(FileUse, VerifiedRelease)> {
        crate::manifest::version(version)?;
        let target = host_target()?;
        // Capture metadata under use protection: explicit prune cannot remove it
        // while this operation prepares its dependencies and child paths.
        let capture = FileUse::shared(&self.home, &format!("{component}-{version}-{target}"))?;
        let directory = self
            .home
            .join(component)
            .join(format!("{version}-{target}"));
        let release = if directory.exists() {
            read_cached_release(&directory, public_key)?
        } else {
            fetch_verified_release(&http_client()?, url, public_key)?
        };
        if release.manifest.product_version != version {
            bail!("Release metadata does not match this client's captured version");
        }
        Ok((capture, release))
    }

    fn prepare_runtime(&self, metadata: &crate::ReleaseTarget) -> Result<InstalledArtifact> {
        let target = host_target()?;
        // Node use is acquired first and spans publication of dependent receipts.
        // Prune therefore cannot delete Node while a new payload references it.
        self.install(
            Receipt {
                format_version: 1,
                component: "node".into(),
                version: metadata.node.version.clone(),
                target: target.into(),
                artifact: metadata.node.artifact.clone(),
                node_version: None,
            },
            None,
        )
    }

    fn prepare_server(&self, release: &VerifiedRelease) -> Result<PreparedServer> {
        let target = host_target()?;
        let metadata = release
            .manifest
            .targets
            .get(target)
            .context("This release does not support the current platform")?;
        let node = self.prepare_runtime(metadata)?;
        let server = self.install(
            Receipt {
                format_version: 1,
                component: "server".into(),
                version: release.manifest.product_version.clone(),
                target: target.into(),
                artifact: metadata.server.clone(),
                node_version: Some(node.receipt.version.clone()),
            },
            Some(release),
        )?;
        Ok(PreparedServer {
            node,
            server,
            manifest: release.manifest.clone(),
        })
    }
}

fn read_cached_release(directory: &std::path::Path, public_key: &str) -> Result<VerifiedRelease> {
    fn read(path: &std::path::Path, limit: u64) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(limit + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            bail!("Cached release metadata exceeds its size limit");
        }
        Ok(bytes)
    }
    let bytes = read(&directory.join("release.json"), 1024 * 1024)
        .context("Cached release metadata is missing")?;
    let signature = String::from_utf8(read(&directory.join("release.json.minisig"), 16 * 1024)?)?;
    let manifest = verify_release(&bytes, &signature, public_key)?;
    Ok(VerifiedRelease {
        bytes,
        signature,
        manifest,
    })
}
