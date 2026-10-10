use crate::{
    archive::extract,
    canonical_home,
    home::protect_directory,
    http_client,
    manifest::{Artifact, version},
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub struct FileUse {
    _file: File,
}

/// An outer manager polls contention without repeatedly preparing its lock file.
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
                .all(|byte| byte.is_ascii_alphanumeric() || [b'-', b'.', b'_'].contains(&byte))
        {
            bail!("Invalid cache lock identity");
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub format_version: u32,
    pub component: String,
    pub version: String,
    pub target: String,
    pub artifact: Artifact,
    pub node_version: Option<String>,
}

impl Receipt {
    fn validate(&self) -> Result<()> {
        self.artifact.validate()?;
        version(&self.version)?;
        if !["node", "server", "cli"].contains(&self.component.as_str())
            || !["windows-x64", "linux-x64-glibc", "macos-arm64", "macos-x64"]
                .contains(&self.target.as_str())
            || self.format_version != 1
        {
            bail!("Unsupported cache receipt");
        }
        Ok(())
    }
}

pub struct InstalledArtifact {
    pub directory: PathBuf,
    pub entry: PathBuf,
    pub receipt: Receipt,
    pub usage: FileUse,
}

pub struct Cache {
    pub home: PathBuf,
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("Harness staging cleanup failed: {error}");
            }
        }
    }
}

impl Cache {
    pub fn new(home: &Path) -> Result<Self> {
        Ok(Self {
            home: canonical_home(home)?,
        })
    }

    pub(crate) fn install(
        &self,
        receipt: Receipt,
        release: Option<&crate::VerifiedRelease>,
    ) -> Result<InstalledArtifact> {
        self.install_using(receipt, release, |artifact| {
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

    /// Opening a prepared target must never start a download. SSH/WSL repairs
    /// missing cache entries in its explicit provisioning step before launch.
    pub(crate) fn open_cached(
        &self,
        receipt: Receipt,
        release: Option<&crate::VerifiedRelease>,
    ) -> Result<InstalledArtifact> {
        receipt.validate()?;
        let name = format!("{}-{}", receipt.version, receipt.target);
        let base = if receipt.component == "node" {
            self.home.join("runtime/node")
        } else {
            self.home.join(&receipt.component)
        };
        let directory = base.join(&name);
        let usage = FileUse::shared(&self.home, &format!("{}-{name}", receipt.component))?;
        if !directory.exists() {
            bail!("Required cached component is missing; reconnect to install it")
        }
        protect_directory(&base, false)?;
        // Complete directories publish atomically and are immutable. Shared use
        // excludes removal; opening them needs no installation gate or download.
        let entry = cached_entry(&directory, &receipt, release)?;
        Ok(InstalledArtifact {
            directory,
            entry,
            receipt,
            usage,
        })
    }

    pub(crate) fn install_using<R: Read>(
        &self,
        receipt: Receipt,
        release: Option<&crate::VerifiedRelease>,
        download: impl FnOnce(&Artifact) -> Result<R>,
    ) -> Result<InstalledArtifact> {
        receipt.validate()?;
        let name = format!("{}-{}", receipt.version, receipt.target);
        let base = if receipt.component == "node" {
            self.home.join("runtime/node")
        } else {
            self.home.join(&receipt.component)
        };
        protect_directory(&base, true)?;
        let directory = base.join(&name);
        let key = format!("{}-{name}", receipt.component);
        let usage = FileUse::shared(&self.home, &key)?;
        let install = FileUse::file(&self.home, &format!("install-{key}"))?;
        install.lock()?;
        if directory.exists() {
            let entry = cached_entry(&directory, &receipt, release)?;
            return Ok(InstalledArtifact {
                directory,
                entry,
                receipt,
                usage,
            });
        }
        let staging = self.home.join("staging");
        protect_directory(&staging, true)?;
        let stage = Stage(staging.join(uuid::Uuid::new_v4().to_string()));
        protect_directory(&stage.0, true)?;
        eprintln!(
            "Preparing {} {} ({})",
            receipt.component, receipt.version, receipt.target
        );
        let archive_path = stage.0.join("download");
        let mut response = download(&receipt.artifact)?;
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&archive_path)?;
        copy_verified(
            &mut response,
            &mut file,
            receipt.artifact.size,
            &receipt.artifact.sha256,
        )?;
        drop(file);
        let root = extract(&archive_path, &stage.0.join("unpacked"), &receipt.artifact)?;
        validate_server_receipt(&root, &receipt, release)?;
        let metadata = root.join("receipt.json");
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(metadata)?;
        file.write_all(&serde_json::to_vec_pretty(&receipt)?)?;
        file.sync_all()?;
        drop(file);
        if let Some(release) = release {
            for (name, bytes) in [
                ("release.json", release.bytes.as_slice()),
                ("release.json.minisig", release.signature.as_bytes()),
            ] {
                let mut file = File::options()
                    .write(true)
                    .create_new(true)
                    .open(root.join(name))?;
                file.write_all(bytes)?;
                file.sync_all()?;
            }
        }
        std::fs::rename(root, &directory)?;
        let entry = directory.join(&receipt.artifact.entry);
        Ok(InstalledArtifact {
            directory,
            entry,
            receipt,
            usage,
        })
    }

    pub fn prepare_node(&self) -> Result<InstalledArtifact> {
        let pin = crate::NodePin::bundled()?;
        let target = crate::host_target()?;
        let artifact = pin
            .targets
            .get(target)
            .context("Pinned Node is unavailable for this target")?
            .clone();
        self.install(
            Receipt {
                format_version: 1,
                component: "node".into(),
                version: pin.version,
                target: target.into(),
                artifact,
                node_version: None,
            },
            None,
        )
    }
}

fn cached_entry(
    directory: &Path,
    receipt: &Receipt,
    release: Option<&crate::VerifiedRelease>,
) -> Result<PathBuf> {
    let mut existing: Receipt = serde_json::from_slice(
        &std::fs::read(directory.join("receipt.json"))
            .context("Cached payload has no valid receipt")?,
    )?;
    existing.validate()?;
    // A transport mirror does not change immutable content identity. Keep all
    // digest/size/layout and component/version/runtime checks; never rewrite the
    // installed receipt just because a client uses another verified HTTPS URL.
    existing.artifact.url.clone_from(&receipt.artifact.url);
    if &existing != receipt {
        bail!("Immutable cache identity conflicts with requested artifact");
    }
    validate_server_receipt(directory, receipt, release)?;
    let entry = directory.join(&receipt.artifact.entry);
    if !entry.is_file() || !entry.canonicalize()?.starts_with(directory.canonicalize()?) {
        bail!("Cached entry point is missing or escapes its payload");
    }
    Ok(entry)
}

/// Both HTTPS downloads and SSH/WSL transfers publish only exact declared bytes.
pub(crate) fn copy_verified(
    source: &mut impl Read,
    destination: &mut File,
    size: u64,
    digest: &str,
) -> Result<()> {
    validate_transfer(size, digest)?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
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

pub(crate) fn validate_transfer(size: u64, digest: &str) -> Result<()> {
    if size == 0
        || size > 2 * 1024 * 1024 * 1024
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("Invalid transferred artifact size or SHA-256");
    }
    Ok(())
}

fn validate_server_receipt(
    root: &Path,
    receipt: &Receipt,
    release: Option<&crate::VerifiedRelease>,
) -> Result<()> {
    if receipt.component != "server" {
        return Ok(());
    }
    let release = release.context("Released server is missing verified metadata")?;
    if receipt.artifact.entry != "server.mjs" {
        bail!("Released server entry point must be server.mjs");
    }
    let identity = crate::payload::validate_server(
        root,
        "release",
        &receipt.target,
        receipt
            .node_version
            .as_deref()
            .context("Server receipt has no Node requirement")?,
    )?;
    if identity.product_version != receipt.version
        || identity.source_commit != release.manifest.source_commit
    {
        bail!("Server build identity does not match signed release metadata");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ArchiveFormat, host_target};
    use std::io::Cursor;

    fn receipt(bytes: &[u8]) -> Receipt {
        Receipt {
            format_version: 1,
            component: "node".into(),
            version: "1.0.0".into(),
            target: host_target().unwrap().into(),
            node_version: None,
            artifact: Artifact {
                url: "https://example.invalid/node".into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(bytes)),
                format: ArchiveFormat::File,
                root: "payload".into(),
                entry: "program".into(),
            },
        }
    }

    #[test]
    fn failed_transfer_never_publishes_or_leaves_this_attempt_staged() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        for bytes in [b"bad".to_vec(), b"correct plus extra".to_vec()] {
            let result = cache.install_using(receipt(b"correct"), None, |_| Ok(Cursor::new(bytes)));
            assert!(result.is_err());
            assert!(
                !cache
                    .home
                    .join(format!("runtime/node/1.0.0-{}", host_target().unwrap()))
                    .exists()
            );
            assert_eq!(
                std::fs::read_dir(cache.home.join("staging"))
                    .unwrap()
                    .count(),
                0
            );
        }
    }

    #[test]
    fn concurrent_preparation_publishes_once_and_warm_use_needs_no_transport() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let requested_home = &cache.home;
        let calls = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let mut jobs = Vec::new();
            for _ in 0..2 {
                let calls = &calls;
                jobs.push(scope.spawn(move || {
                    let cache = Cache::new(requested_home).unwrap();
                    let installed = cache
                        .install_using(receipt(b"correct"), None, |_| {
                            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            Ok(Cursor::new(b"correct"))
                        })
                        .unwrap();
                    assert_eq!(std::fs::read(installed.entry).unwrap(), b"correct");
                }));
            }
            for job in jobs {
                job.join().unwrap();
            }
        });
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let installed = cache
            .install_using::<Cursor<Vec<u8>>>(receipt(b"correct"), None, |_| {
                bail!("Offline transport used")
            })
            .unwrap();
        assert_eq!(std::fs::read(installed.entry).unwrap(), b"correct");
    }

    #[test]
    fn verified_mirrors_share_content_without_rewriting_or_weakening_identity() {
        let temporary = tempfile::tempdir().unwrap();
        let cache = Cache::new(&temporary.path().join("home")).unwrap();
        let original = receipt(b"correct");
        let installed = cache
            .install_using(original.clone(), None, |_| Ok(Cursor::new(b"correct")))
            .unwrap();
        let saved = std::fs::read(installed.directory.join("receipt.json")).unwrap();
        let mut mirror = original.clone();
        mirror.artifact.url = "https://github.com/example/releases/download/runtime/node".into();
        let reused = cache
            .install_using::<Cursor<Vec<u8>>>(mirror.clone(), None, |_| {
                bail!("Offline transport used")
            })
            .unwrap();
        assert_eq!(reused.directory, installed.directory);
        assert_eq!(
            std::fs::read(cache.open_cached(mirror.clone(), None).unwrap().entry).unwrap(),
            b"correct"
        );
        assert_eq!(
            std::fs::read(installed.directory.join("receipt.json")).unwrap(),
            saved
        );
        mirror.artifact.sha256 = format!("{:x}", Sha256::digest(b"different"));
        assert!(cache.open_cached(mirror, None).is_err());
        let mut changed_layout = original;
        changed_layout.artifact.entry = "different".into();
        assert!(cache.open_cached(changed_layout, None).is_err());
        assert_eq!(std::fs::read(installed.entry).unwrap(), b"correct");
    }
}
