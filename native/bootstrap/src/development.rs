use crate::{Cache, FileUse, InstalledArtifact, NodePin, host_target};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentReceipt {
    pub format_version: u32,
    pub digest: String,
    pub target: String,
    pub node_version: String,
}

pub struct DevelopmentServer {
    pub directory: PathBuf,
    pub entry: PathBuf,
    pub receipt: DevelopmentReceipt,
    pub usage: FileUse,
}

pub struct PreparedDevelopmentServer {
    pub node: InstalledArtifact,
    pub server: DevelopmentServer,
}

impl Cache {
    /// Copy complete source-build bytes once; running owners never use build scratch.
    pub fn prepare_development_server(&self, payload: &Path) -> Result<PreparedDevelopmentServer> {
        let payload = payload.canonicalize()?;
        let target = host_target()?;
        let pin = NodePin::bundled()?;
        let node = self.prepare_node()?;
        let server = self.snapshot_development_server(&payload, target, &pin.version)?;
        Ok(PreparedDevelopmentServer { node, server })
    }

    pub fn prepare_cached_development_server(
        &self,
        digest: &str,
    ) -> Result<PreparedDevelopmentServer> {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("Invalid cached development server digest");
        }
        let pin = NodePin::bundled()?;
        let target = host_target()?;
        let node = self.open_cached(
            crate::Receipt {
                format_version: 1,
                component: "node".into(),
                version: pin.version.clone(),
                target: target.into(),
                artifact: pin.targets[target].clone(),
                node_version: None,
            },
            None,
        )?;
        let server = self
            .cached_development_server(&DevelopmentReceipt {
                format_version: 1,
                digest: digest.into(),
                target: target.into(),
                node_version: pin.version,
            })?
            .context("Required cached development server is missing; reconnect to install it")?;
        Ok(PreparedDevelopmentServer { node, server })
    }

    /// SSH/WSL carries these exact source-build bytes and the pinned runtime.
    /// Installation never consults the network or a target's Node/npm.
    pub fn install_transferred_development_server(
        &self,
        archive: &Path,
        size: u64,
        digest: &str,
        node_archive: &Path,
    ) -> Result<PreparedDevelopmentServer> {
        crate::cache::validate_transfer(size, digest)?;
        let pin = NodePin::bundled()?;
        let target = host_target()?;
        let node =
            self.install_transferred_node(&pin.version, &pin.targets[target], node_archive)?;
        let receipt = DevelopmentReceipt {
            format_version: 1,
            digest: digest.into(),
            target: target.into(),
            node_version: pin.version.clone(),
        };
        if let Some(server) = self.cached_development_server(&receipt)? {
            return Ok(PreparedDevelopmentServer { node, server });
        }
        let staging = self.home.join("staging");
        crate::home::protect_directory(&staging, true)?;
        let stage = tempfile::tempdir_in(staging)?;
        let downloaded = stage.path().join("download");
        let mut output = File::options()
            .write(true)
            .create_new(true)
            .open(&downloaded)?;
        crate::cache::copy_verified(&mut File::open(archive)?, &mut output, size, digest)?;
        drop(output);
        let root = crate::archive::extract_layout(
            &downloaded,
            &stage.path().join("unpacked"),
            crate::ArchiveFormat::TarGz,
            "server",
            "server.mjs",
            size,
        )?;
        let server = self.publish_development_server(&root, target, &pin.version, digest.into())?;
        Ok(PreparedDevelopmentServer { node, server })
    }

    fn cached_development_server(
        &self,
        receipt: &DevelopmentReceipt,
    ) -> Result<Option<DevelopmentServer>> {
        let name = format!("dev-{}-{}", receipt.target, receipt.digest);
        let key = format!("server-{name}");
        let usage = FileUse::shared(&self.home, &key)?;
        // Only publication takes the installation gate. A complete immutable
        // directory is safe to read under its shared lifetime protection.
        let directory = self.home.join("server").join(name);
        if !directory.exists() {
            return Ok(None);
        }
        let saved: DevelopmentReceipt =
            serde_json::from_slice(&fs::read(directory.join("development.json"))?)?;
        if &saved != receipt {
            bail!("Immutable development server identity conflicts with its receipt");
        }
        crate::payload::validate_server(
            &directory,
            "development",
            &receipt.target,
            &receipt.node_version,
        )?;
        let entry = directory.join("server.mjs");
        Ok(Some(DevelopmentServer {
            directory,
            entry,
            receipt: saved,
            usage,
        }))
    }

    fn snapshot_development_server(
        &self,
        payload: &Path,
        target: &str,
        node_version: &str,
    ) -> Result<DevelopmentServer> {
        let staging = self.home.join("staging");
        crate::home::protect_directory(&staging, true)?;
        let stage = tempfile::tempdir_in(staging)?;
        let mut hash = Sha256::new();
        copy_tree(payload, payload, stage.path(), &mut hash)?;
        self.publish_development_server(
            stage.path(),
            target,
            node_version,
            format!("{:x}", hash.finalize()),
        )
    }

    fn publish_development_server(
        &self,
        root: &Path,
        target: &str,
        node_version: &str,
        digest: String,
    ) -> Result<DevelopmentServer> {
        crate::payload::validate_server(root, "development", target, node_version)?;
        let receipt = DevelopmentReceipt {
            format_version: 1,
            digest,
            target: target.into(),
            node_version: node_version.into(),
        };
        let name = format!("dev-{target}-{}", receipt.digest);
        let key = format!("server-{name}");
        let usage = FileUse::shared(&self.home, &key)?;
        let install = FileUse::file(&self.home, &format!("install-{key}"))?;
        install.lock()?;
        let base = self.home.join("server");
        crate::home::protect_directory(&base, true)?;
        let directory = base.join(name);
        if directory.exists() {
            let saved: DevelopmentReceipt =
                serde_json::from_slice(&fs::read(directory.join("development.json"))?)?;
            if saved != receipt {
                bail!("Immutable development server identity conflicts with its receipt");
            }
            crate::payload::validate_server(&directory, "development", target, node_version)?;
        } else {
            let mut file = File::options()
                .write(true)
                .create_new(true)
                .open(root.join("development.json"))?;
            serde_json::to_writer_pretty(&mut file, &receipt)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            fs::rename(root, &directory)?;
        }
        let entry = directory.join("server.mjs");
        if !entry.is_file() || !entry.canonicalize()?.starts_with(directory.canonicalize()?) {
            bail!("Cached development entry is missing or escapes its payload");
        }
        Ok(DevelopmentServer {
            directory,
            entry,
            receipt,
            usage,
        })
    }
}

fn copy_tree(root: &Path, source: &Path, destination: &Path, hash: &mut Sha256) -> Result<()> {
    let mut entries = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source = entry.path();
        let relative = source
            .strip_prefix(root)?
            .to_str()
            .context("Non-Unicode payload path")?
            .replace('\\', "/");
        let destination = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source)?;
        hash.update((relative.len() as u64).to_le_bytes());
        hash.update(relative.as_bytes());
        if metadata.is_symlink() {
            let target = fs::read_link(&source)?;
            if target.is_absolute() || !source.canonicalize()?.starts_with(root) {
                bail!("Development payload link escapes its root: {relative}");
            }
            hash.update(b"link");
            let text = target.to_str().context("Non-Unicode payload link")?;
            hash.update((text.len() as u64).to_le_bytes());
            hash.update(text.as_bytes());
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &destination)?;
            #[cfg(windows)]
            if source.is_dir() {
                std::os::windows::fs::symlink_dir(&target, &destination)?;
            } else {
                std::os::windows::fs::symlink_file(&target, &destination)?;
            }
        } else if metadata.is_dir() {
            hash.update(b"directory");
            fs::create_dir(&destination)?;
            copy_tree(root, &source, &destination, hash)?;
        } else if metadata.is_file() {
            hash.update(b"file");
            fs::copy(&source, &destination)?;
            let mut file = File::open(&destination)?;
            hash.update(file.metadata()?.len().to_le_bytes());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                hash.update(file.metadata()?.permissions().mode().to_le_bytes());
            }
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
        } else {
            bail!("Unsupported development payload entry: {relative}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BuildIdentity;

    fn fixture(payload: &Path) {
        fs::create_dir_all(payload.join("node_modules/@harness/native")).unwrap();
        for name in [
            "server.mjs",
            "worker.mjs",
            "node_modules/@harness/native/harness-native.node",
            if cfg!(windows) {
                "harness-bootstrap.exe"
            } else {
                "harness-bootstrap"
            },
        ] {
            fs::write(payload.join(name), name).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                payload.join("harness-bootstrap"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        fs::write(
            payload.join("build.json"),
            serde_json::to_vec(&BuildIdentity {
                mode: "development".into(),
                product_version: "0.1.0".into(),
                source_commit: "a".repeat(40),
                target: host_target().unwrap().into(),
                node_version: "22.23.3".into(),
                release_manifest_url: None,
                release_verification_public_key: None,
            })
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn snapshots_complete_bytes_and_keeps_previous_payloads_immutable() {
        let temporary = tempfile::tempdir().unwrap();
        let payload = temporary.path().join("payload");
        fixture(&payload);
        let payload = payload.canonicalize().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let first = cache
            .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
            .unwrap();
        let warm = cache
            .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
            .unwrap();
        assert_eq!(first.directory, warm.directory);
        let key = format!(
            "server-dev-{}-{}",
            first.receipt.target, first.receipt.digest
        );
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_none());
        fs::write(
            payload.join("node_modules/@harness/native/harness-native.node"),
            "new native bytes",
        )
        .unwrap();
        let changed = cache
            .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
            .unwrap();
        assert_ne!(first.directory, changed.directory);
        fs::remove_dir_all(payload).unwrap();
        assert_eq!(
            fs::read_to_string(
                first
                    .directory
                    .join("node_modules/@harness/native/harness-native.node")
            )
            .unwrap(),
            "node_modules/@harness/native/harness-native.node"
        );
        assert_eq!(
            fs::read_to_string(
                changed
                    .directory
                    .join("node_modules/@harness/native/harness-native.node")
            )
            .unwrap(),
            "new native bytes"
        );
        drop(first);
        drop(warm);
        assert!(FileUse::try_exclusive(&cache.home, &key).unwrap().is_some());
        assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
    }

    #[test]
    fn rejects_wrong_runtime_incomplete_payload_and_conflicting_receipt() {
        let temporary = tempfile::tempdir().unwrap();
        let payload = temporary.path().join("payload");
        fixture(&payload);
        let payload = payload.canonicalize().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        assert!(
            cache
                .snapshot_development_server(&payload, host_target().unwrap(), "99.0.0")
                .is_err()
        );
        let prepared = cache
            .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
            .unwrap();
        fs::write(prepared.directory.join("development.json"), "{}").unwrap();
        assert!(
            cache
                .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
                .is_err()
        );
        fs::remove_file(payload.join("worker.mjs")).unwrap();
        assert!(
            cache
                .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
                .is_err()
        );
        assert_eq!(fs::read_dir(cache.home.join("staging")).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_internal_relative_links_and_rejects_external_links() {
        let temporary = tempfile::tempdir().unwrap();
        let payload = temporary.path().join("payload");
        fixture(&payload);
        let payload = payload.canonicalize().unwrap();
        std::os::unix::fs::symlink("worker.mjs", payload.join("alias.mjs")).unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let prepared = cache
            .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
            .unwrap();
        assert_eq!(
            fs::read_link(prepared.directory.join("alias.mjs")).unwrap(),
            PathBuf::from("worker.mjs")
        );
        fs::write(temporary.path().join("outside"), "private").unwrap();
        std::os::unix::fs::symlink("../outside", payload.join("escape")).unwrap();
        assert!(
            cache
                .snapshot_development_server(&payload, host_target().unwrap(), "22.23.3")
                .is_err()
        );
    }
}
