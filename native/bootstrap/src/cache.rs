use crate::{
    Artifact, VerifiedRelease, archive::extract_layout, canonical_home, home::protect_directory,
    host_target, http_client,
};
use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub struct FileUse {
    _file: File,
}
pub struct ExclusiveLock {
    file: File,
    acquired: bool,
}

impl ExclusiveLock {
    pub fn new(home: &Path, key: &str) -> Result<Self> {
        Ok(Self {
            file: FileUse::file(home, key)?,
            acquired: false,
        })
    }
    pub fn try_acquire(&mut self) -> Result<bool> {
        if self.acquired {
            return Ok(true);
        }
        match self.file.try_lock() {
            Ok(()) => {
                self.acquired = true;
                Ok(true)
            }
            Err(std::fs::TryLockError::WouldBlock) => Ok(false),
            Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}

impl FileUse {
    pub fn shared(home: &Path, key: &str) -> Result<Self> {
        let file = Self::file(home, key)?;
        file.lock_shared()?;
        Ok(Self { _file: file })
    }
    pub fn try_exclusive(home: &Path, key: &str) -> Result<Option<Self>> {
        let file = Self::file(home, key)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
    pub(crate) fn file(home: &Path, key: &str) -> Result<File> {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
        {
            bail!("Invalid lock identity");
        }
        let directory = home.join(".cache-locks");
        protect_directory(&directory, true)?;
        Ok(File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(key))?)
    }
}

pub struct InstalledArtifact {
    pub directory: PathBuf,
    pub entry: PathBuf,
    pub version: String,
}

/// A running consumer owns the entire cache. Explicit pruning refuses while any
/// desktop, CLI, server, or preparation process holds this shared lease.
pub struct Cache {
    pub home: PathBuf,
    _usage: FileUse,
}

impl Cache {
    pub fn new(home: &Path) -> Result<Self> {
        let home = canonical_home(home)?;
        let usage = FileUse::shared(&home, "cache-use")?;
        Ok(Self {
            home,
            _usage: usage,
        })
    }
    pub fn prepare_node(&self) -> Result<InstalledArtifact> {
        let pin = crate::NodePin::bundled()?;
        let artifact = pin
            .targets
            .get(host_target()?)
            .context("Pinned Node is unavailable for this target")?;
        self.install("node", &pin.version, artifact, None)
    }
    pub(crate) fn existing(
        &self,
        component: &str,
        version: &str,
        artifact: &Artifact,
    ) -> Result<InstalledArtifact> {
        crate::manifest::version(version)?;
        artifact.validate()?;
        let base = if component == "node" {
            self.home.join("runtime/node")
        } else {
            self.home.join(component)
        };
        Self::open_artifact(
            &base.join(format!("{version}-{}", host_target()?)),
            version,
            artifact,
        )
        .context("Prepared cache is unavailable; reconnect to prepare it")
    }
    pub(crate) fn install(
        &self,
        component: &str,
        version: &str,
        artifact: &Artifact,
        release: Option<&VerifiedRelease>,
    ) -> Result<InstalledArtifact> {
        crate::manifest::version(version)?;
        artifact.validate()?;
        let base = if component == "node" {
            self.home.join("runtime/node")
        } else {
            self.home.join(component)
        };
        protect_directory(&base, true)?;
        let directory = base.join(format!("{version}-{}", host_target()?));
        self.install_using(&directory, version, artifact, release, || {
            let response = http_client()?
                .get(&artifact.url)
                .send()?
                .error_for_status()?;
            if response
                .content_length()
                .is_some_and(|size| size != artifact.size)
            {
                bail!("Artifact download size mismatch");
            }
            Ok(response)
        })
    }
    pub(crate) fn install_using<R: Read>(
        &self,
        directory: &Path,
        version: &str,
        artifact: &Artifact,
        release: Option<&VerifiedRelease>,
        download: impl FnOnce() -> Result<R>,
    ) -> Result<InstalledArtifact> {
        // One installation gate is sufficient; immutable completed directories
        // need no per-artifact lock or retained preparation handoff.
        let install = FileUse::file(&self.home, "install")?;
        install.lock()?;
        if !directory.exists() {
            let stage = self.stage()?;
            let archive = stage.path().join("download");
            copy_verified(
                &mut download()?,
                &mut File::create(&archive)?,
                artifact.size,
                &artifact.sha256,
            )?;
            let root = extract_layout(
                &archive,
                &stage.path().join("unpacked"),
                artifact.format,
                &artifact.root,
                &artifact.entry,
            )?;
            if let Some(release) = release {
                if artifact.entry == "server.mjs" {
                    let identity = crate::payload::validate_server(
                        &root,
                        "release",
                        &release.manifest.targets[host_target()?].node.version,
                    )?;
                    if identity.product_version != release.manifest.product_version
                        || identity.source_commit != release.manifest.source_commit
                    {
                        bail!("Server build identity differs from signed release");
                    }
                }
                std::fs::write(root.join("release.json"), &release.bytes)?;
                std::fs::write(root.join("release.json.minisig"), &release.signature)?;
            }
            std::fs::write(root.join(".artifact-sha256"), &artifact.sha256)?;
            std::fs::rename(root, directory)?;
            stage.close()?;
        }
        Self::open_artifact(directory, version, artifact)
    }
    fn open_artifact(
        directory: &Path,
        version: &str,
        artifact: &Artifact,
    ) -> Result<InstalledArtifact> {
        if std::fs::read_to_string(directory.join(".artifact-sha256"))? != artifact.sha256 {
            bail!("Cached artifact differs from requested bytes");
        }
        let entry = checked_entry(directory, &artifact.entry)?;
        Ok(InstalledArtifact {
            directory: directory.into(),
            entry,
            version: version.into(),
        })
    }
    pub(crate) fn stage(&self) -> Result<tempfile::TempDir> {
        let staging = self.home.join("staging");
        protect_directory(&staging, true)?;
        Ok(tempfile::tempdir_in(staging)?)
    }
}

pub(crate) fn checked_entry(directory: &Path, entry: &str) -> Result<PathBuf> {
    let path = directory.join(entry);
    if !path.is_file() || !path.canonicalize()?.starts_with(directory.canonicalize()?) {
        bail!("Payload entry point is missing or escapes its directory");
    }
    Ok(path)
}

pub(crate) fn copy_verified(
    source: &mut impl Read,
    destination: &mut File,
    size: u64,
    digest: &str,
) -> Result<()> {
    if size == 0
        || size > 2 * 1024 * 1024 * 1024
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("Invalid artifact size or SHA-256");
    }
    let mut hash = Sha256::new();
    let mut count = 0;
    let mut buffer = [0; 64 * 1024];
    loop {
        let length = source.read(&mut buffer)?;
        if length == 0 {
            break;
        }
        count += length as u64;
        if count > size {
            bail!("Artifact exceeds declared size");
        }
        hash.update(&buffer[..length]);
        destination.write_all(&buffer[..length])?;
    }
    if count != size || format!("{:x}", hash.finalize()) != digest {
        bail!("Artifact size or checksum verification failed");
    }
    destination.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ArchiveFormat;

    fn fixture(bytes: &[u8]) -> Artifact {
        Artifact {
            url: "https://example.invalid/artifact".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            format: ArchiveFormat::File,
            root: "payload".into(),
            entry: "entry".into(),
        }
    }

    #[test]
    fn shared_consumers_exclude_cleanup_until_physical_release() {
        let temporary = tempfile::tempdir().unwrap();
        let first = Cache::new(&temporary.path().join("home")).unwrap();
        let second = Cache::new(&temporary.path().join("home")).unwrap();
        assert!(
            FileUse::try_exclusive(&first.home, "cache-use")
                .unwrap()
                .is_none()
        );
        drop(second);
        assert!(
            FileUse::try_exclusive(&first.home, "cache-use")
                .unwrap()
                .is_none()
        );
        let home = first.home.clone();
        drop(first);
        assert!(
            FileUse::try_exclusive(&home, "cache-use")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn checksum_failure_never_publishes_and_removes_staging() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let artifact = fixture(b"valid");
        let directory = cache.home.join("failed");
        assert!(
            cache
                .install_using(&directory, "0.1.0", &artifact, None, || Ok(&b"wrong"[..]))
                .is_err()
        );
        assert!(!directory.exists());
        assert_eq!(
            std::fs::read_dir(cache.home.join("staging"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn concurrent_installers_publish_once_and_reuse_cache_offline() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let artifact = fixture(b"valid");
        let directory = cache.home.join("complete");
        let downloads = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    cache
                        .install_using(&directory, "0.1.0", &artifact, None, || {
                            downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            Ok(&b"valid"[..])
                        })
                        .unwrap();
                });
            }
        });
        assert_eq!(downloads.load(std::sync::atomic::Ordering::SeqCst), 1);
        let installed = cache
            .install_using::<&[u8]>(&directory, "0.1.0", &artifact, None, || bail!("offline"))
            .unwrap();
        assert_eq!(std::fs::read(installed.entry).unwrap(), b"valid");
        let changed = fixture(b"other");
        assert!(
            cache
                .install_using::<&[u8]>(&directory, "0.1.0", &changed, None, || bail!("offline"))
                .is_err()
        );
    }
}
