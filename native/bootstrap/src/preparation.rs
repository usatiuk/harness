use crate::{Cache, InstalledArtifact, ReleaseManifest, VerifiedRelease, host_target};
use anyhow::{Context, Result, bail};
use std::{
    io::{Read, Write},
    time::{Duration, Instant},
};

pub struct PreparedCli {
    pub node: InstalledArtifact,
    pub cli: InstalledArtifact,
    pub manifest: ReleaseManifest,
}
pub struct PreparedServer {
    pub node: InstalledArtifact,
    pub server: InstalledArtifact,
    pub manifest: ReleaseManifest,
}

impl Cache {
    pub fn prepare_cli_release(&self, version: &str, url: &str, key: &str) -> Result<PreparedCli> {
        let release = self.capture_release("cli", version, url, key)?;
        let target = &release.manifest.targets[host_target()?];
        let node = self.install("node", &target.node.version, &target.node.artifact, None)?;
        let cli = self.install("cli", version, &target.cli, Some(&release))?;
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
        key: &str,
    ) -> Result<PreparedServer> {
        let release = self.capture_release("server", version, url, key)?;
        self.prepare_server(release, false)
    }
    pub fn prepare_cached_server_release(
        &self,
        version: &str,
        key: &str,
    ) -> Result<PreparedServer> {
        crate::manifest::version(version)?;
        let directory = self
            .home
            .join("server")
            .join(format!("{version}-{}", host_target()?));
        let release = read_cached_release(&directory, key)?;
        if release.manifest.product_version != version {
            bail!("Cached release has a different version");
        }
        self.prepare_server(release, true)
    }
    pub fn prepare_selected_server(
        &self,
        default_version: &str,
        base_url: &str,
        key: &str,
    ) -> Result<PreparedServer> {
        let version = self
            .selected_server_version()?
            .unwrap_or(default_version.into());
        let prepared = self.prepare_server_release(
            &version,
            &format!("{base_url}/v{version}/release.json"),
            key,
        )?;
        let mut gate = crate::ExclusiveLock::new(&self.home, "server-lifecycle")?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !gate.try_acquire()? {
            if Instant::now() >= deadline {
                bail!("Another server operation is running; try again when it finishes");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        match self.selected_server_version()? {
            Some(selected) if selected != version => {
                bail!("Selected server changed; reconnect to prepare that version")
            }
            Some(_) => {}
            None => {
                let mut file = tempfile::NamedTempFile::new_in(self.home.join("server"))?;
                serde_json::to_writer(
                    &mut file,
                    &serde_json::json!({"formatVersion":1,"directory":format!("{version}-{}",host_target()?)}),
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
        let bytes = match std::fs::read(self.home.join("server/current.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let selected: Selection = serde_json::from_slice(&bytes)?;
        if selected.format_version != 1 {
            bail!("Unsupported server selection; upgrade Harness");
        }
        let suffix = format!("-{}", host_target()?);
        let version = selected
            .directory
            .strip_suffix(&suffix)
            .context("Selected server is a source build; use its development checkout")?;
        crate::manifest::version(version)?;
        Ok(Some(version.into()))
    }
    fn capture_release(
        &self,
        component: &str,
        version: &str,
        url: &str,
        key: &str,
    ) -> Result<VerifiedRelease> {
        crate::manifest::version(version)?;
        let directory = self
            .home
            .join(component)
            .join(format!("{version}-{}", host_target()?));
        let release = if directory.exists() {
            read_cached_release(&directory, key)?
        } else {
            crate::fetch_verified_release(&crate::http_client()?, url, key)?
        };
        if release.manifest.product_version != version {
            bail!("Release metadata has a different version");
        }
        if !release.manifest.targets.contains_key(host_target()?) {
            bail!("Release does not support this platform");
        }
        Ok(release)
    }
    fn prepare_server(&self, release: VerifiedRelease, cached: bool) -> Result<PreparedServer> {
        let target = release
            .manifest
            .targets
            .get(host_target()?)
            .context("Release does not support this platform")?;
        let node = if cached {
            self.existing("node", &target.node.version, &target.node.artifact)?
        } else {
            self.install("node", &target.node.version, &target.node.artifact, None)?
        };
        let server = if cached {
            self.existing("server", &release.manifest.product_version, &target.server)?
        } else {
            self.install(
                "server",
                &release.manifest.product_version,
                &target.server,
                Some(&release),
            )?
        };
        let identity =
            crate::payload::validate_server(&server.directory, "release", &node.version)?;
        if identity.product_version != release.manifest.product_version {
            bail!("Server build identity differs from signed release");
        }
        Ok(PreparedServer {
            node,
            server,
            manifest: release.manifest,
        })
    }
}

fn read_cached_release(directory: &std::path::Path, key: &str) -> Result<VerifiedRelease> {
    fn read(path: &std::path::Path, limit: u64) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(limit + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            bail!("Cached metadata exceeds its limit");
        }
        Ok(bytes)
    }
    let bytes = read(&directory.join("release.json"), 1024 * 1024)?;
    let signature = String::from_utf8(read(&directory.join("release.json.minisig"), 16 * 1024)?)?;
    let manifest = crate::verify_release(&bytes, &signature, key)?;
    Ok(VerifiedRelease {
        bytes,
        signature,
        manifest,
    })
}
