use crate::manifest::{ArchiveFormat, Artifact, relative_path};
use anyhow::{Result, bail};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_EXPANDED: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_EXTENSION: u64 = 16 * 1024;

/// Bound all decompressed bytes, including bodies skipped internally by tar.
struct Budget<R> {
    inner: R,
    remaining: u64,
}
impl<R: Read> Read for Budget<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0u8];
            if self.inner.read(&mut extra)? == 0 {
                return Ok(0);
            }
            return Err(std::io::Error::other(
                "Archive expanded size limit exceeded",
            ));
        }
        let length = buffer.len().min(self.remaining as usize);
        let count = self.inner.read(&mut buffer[..length])?;
        self.remaining -= count as u64;
        Ok(count)
    }
}

fn tar_reader(path: &Path) -> Result<Budget<flate2::read::GzDecoder<File>>> {
    Ok(Budget {
        inner: flate2::read::GzDecoder::new(File::open(path)?),
        remaining: MAX_EXPANDED,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    fn fixture(root: &Path, entries: &[(&str, tar::EntryType, &str, &[u8])]) -> PathBuf {
        let path = root.join("fixture.tar.gz");
        let mut archive = tar::Builder::new(GzEncoder::new(
            File::create(&path).unwrap(),
            Compression::fast(),
        ));
        for &(name, kind, link, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(kind);
            header.set_mode(0o755);
            header.set_size(body.len() as u64);
            if !link.is_empty() {
                header.set_link_name(link).unwrap();
            }
            header.set_cksum();
            archive.append_data(&mut header, name, body).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap();
        path
    }

    fn artifact(root: &str, entry: &str) -> Artifact {
        Artifact {
            url: "https://example.invalid/a".into(),
            size: 1,
            sha256: "a".repeat(64),
            format: ArchiveFormat::TarGz,
            root: root.into(),
            entry: entry.into(),
        }
    }

    #[test]
    fn extracts_complete_entry_and_rejects_missing_entry() {
        let temp = tempfile::tempdir().unwrap();
        let archive = fixture(
            temp.path(),
            &[(
                "payload/bin/program",
                tar::EntryType::Regular,
                "",
                b"program",
            )],
        );
        let root = extract(
            &archive,
            &temp.path().join("good"),
            &artifact("payload", "bin/program"),
        )
        .unwrap();
        assert_eq!(std::fs::read(root.join("bin/program")).unwrap(), b"program");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join("bin/program"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
        assert!(
            extract(
                &archive,
                &temp.path().join("missing"),
                &artifact("payload", "missing")
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_nested_payload_link_escape_and_root_link() {
        let temp = tempfile::tempdir().unwrap();
        let archive = fixture(
            temp.path(),
            &[(
                "top/payload/bin/program",
                tar::EntryType::Symlink,
                "../../outside",
                b"",
            )],
        );
        assert!(
            extract(
                &archive,
                &temp.path().join("unpacked"),
                &artifact("top/payload", "bin/program")
            )
            .is_err()
        );
        let archive = fixture(
            temp.path(),
            &[("payload", tar::EntryType::Symlink, "other", b"")],
        );
        assert!(
            extract(
                &archive,
                &temp.path().join("root-link"),
                &artifact("payload", "program")
            )
            .is_err()
        );
    }

    #[test]
    fn bounds_tar_extensions_before_library_allocation() {
        let temp = tempfile::tempdir().unwrap();
        let body = vec![b'x'; MAX_EXTENSION as usize + 1];
        let archive = fixture(
            temp.path(),
            &[("././@LongLink", tar::EntryType::GNULongName, "", &body)],
        );
        assert!(
            extract(
                &archive,
                &temp.path().join("unpacked"),
                &artifact("payload", "program")
            )
            .unwrap_err()
            .to_string()
            .contains("metadata limit")
        );
    }

    #[test]
    fn bounds_all_reader_bytes_even_when_not_copied_to_files() {
        let mut reader = Budget {
            inner: &b"12345"[..],
            remaining: 4,
        };
        assert!(std::io::copy(&mut reader, &mut std::io::sink()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_internal_links_but_rejects_extracting_through_them() {
        let temp = tempfile::tempdir().unwrap();
        let archive = fixture(
            temp.path(),
            &[
                (
                    "top/payload/lib/program",
                    tar::EntryType::Regular,
                    "",
                    b"program",
                ),
                (
                    "top/payload/bin/program",
                    tar::EntryType::Symlink,
                    "../lib/program",
                    b"",
                ),
            ],
        );
        let root = extract(
            &archive,
            &temp.path().join("good"),
            &artifact("top/payload", "bin/program"),
        )
        .unwrap();
        assert_eq!(std::fs::read(root.join("bin/program")).unwrap(), b"program");
        let archive = fixture(
            temp.path(),
            &[
                ("payload/link", tar::EntryType::Symlink, "lib", b""),
                (
                    "payload/link/program",
                    tar::EntryType::Regular,
                    "",
                    b"program",
                ),
            ],
        );
        assert!(
            extract(
                &archive,
                &temp.path().join("bad"),
                &artifact("payload", "link/program")
            )
            .is_err()
        );
    }
}

fn validate_tar(path: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(tar_reader(path)?);
    let mut metadata = 0u64;
    // Raw iteration avoids the library allocating extension bodies before we
    // can bound them. A second normal pass interprets the validated extensions.
    for (count, entry) in archive.entries()?.raw(true).enumerate() {
        if count >= MAX_ENTRIES {
            bail!("Archive entry limit exceeded");
        }
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_gnu_longname()
            || kind.is_gnu_longlink()
            || kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
        {
            let size = entry.header().size()?;
            metadata += size;
            if size > MAX_EXTENSION || metadata > 16 * 1024 * 1024 {
                bail!("Archive extension metadata limit exceeded");
            }
        }
        std::io::copy(&mut entry, &mut std::io::sink())?;
    }
    Ok(())
}

fn destination(root: &Path, name: &str) -> Result<PathBuf> {
    let name = name.trim_end_matches('/');
    relative_path(name)?;
    let path = root.join(name);
    // Reject paths traversing a previously extracted symlink, including directory entries.
    let mut cursor = root.to_path_buf();
    for part in name.split('/') {
        cursor.push(part);
        if std::fs::symlink_metadata(&cursor).is_ok_and(|info| info.file_type().is_symlink()) {
            bail!("Archive path traverses a symbolic link");
        }
    }
    Ok(path)
}

fn copy_entry(reader: &mut impl Read, path: &Path, size: u64, expanded: &mut u64) -> Result<()> {
    *expanded = expanded
        .checked_add(size)
        .ok_or_else(|| anyhow::anyhow!("Archive size overflow"))?;
    if *expanded > MAX_EXPANDED {
        bail!("Archive expanded size limit exceeded");
    }
    std::fs::create_dir_all(path.parent().expect("archive path parent"))?;
    let mut file = File::options().write(true).create_new(true).open(path)?;
    let copied = std::io::copy(&mut reader.take(size + 1), &mut file)?;
    if copied != size {
        bail!("Archive entry size mismatch");
    }
    file.flush()?;
    Ok(())
}

pub(crate) fn extract(archive: &Path, staging: &Path, artifact: &Artifact) -> Result<PathBuf> {
    extract_layout(
        archive,
        staging,
        artifact.format,
        &artifact.root,
        &artifact.entry,
        artifact.size,
    )
}

/// Source transfers have an archive layout and digest, without pretending to be
/// signed release artifacts with a download URL.
pub(crate) fn extract_layout(
    archive: &Path,
    staging: &Path,
    format: ArchiveFormat,
    root: &str,
    entry: &str,
    size: u64,
) -> Result<PathBuf> {
    relative_path(root)?;
    relative_path(entry)?;
    let mut expanded = 0;
    let payload_root = staging.join(root);
    match format {
        ArchiveFormat::TarGz => {
            validate_tar(archive)?;
            let mut archive = tar::Archive::new(tar_reader(archive)?);
            for (count, entry) in archive.entries()?.enumerate() {
                if count >= MAX_ENTRIES {
                    bail!("Archive entry limit exceeded");
                }
                let mut entry = entry?;
                let name = entry
                    .path()?
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Non-Unicode archive path"))?
                    .to_owned();
                let path = destination(staging, &name)?;
                let kind = entry.header().entry_type();
                if kind.is_dir() {
                    std::fs::create_dir_all(path)?;
                } else if kind.is_file() {
                    let size = entry.header().size()?;
                    copy_entry(&mut entry, &path, size, &mut expanded)?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &path,
                            std::fs::Permissions::from_mode(entry.header().mode()? & 0o777),
                        )?;
                    }
                } else if kind.is_symlink() {
                    let target = entry
                        .link_name()?
                        .ok_or_else(|| anyhow::anyhow!("Missing symlink target"))?;
                    // Bundled dependencies may use internal links. They cannot escape their payload.
                    let parent = path.parent().expect("link parent");
                    let relative_parent = parent.strip_prefix(&payload_root)?;
                    let mut depth = relative_parent.components().count();
                    for part in target.components() {
                        match part {
                            std::path::Component::Normal(_) => depth += 1,
                            std::path::Component::CurDir => {}
                            std::path::Component::ParentDir if depth > 0 => depth -= 1,
                            _ => bail!("Archive link escapes its payload"),
                        }
                    }
                    std::fs::create_dir_all(parent)?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&target, &path)?;
                    #[cfg(windows)]
                    bail!("Windows payloads must not require symlink privileges");
                } else {
                    bail!("Unsupported archive entry type");
                }
            }
        }
        ArchiveFormat::Zip => {
            let mut archive = zip::ZipArchive::new(File::open(archive)?)?;
            if archive.len() > MAX_ENTRIES {
                bail!("Archive entry limit exceeded");
            }
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                if entry.is_symlink() {
                    bail!("ZIP symlinks are not supported");
                }
                let name = entry.name()?.into_owned();
                let path = destination(staging, &name)?;
                if entry.is_dir() {
                    std::fs::create_dir_all(path)?;
                } else {
                    let size = entry.size();
                    copy_entry(&mut entry, &path, size, &mut expanded)?;
                }
            }
        }
        ArchiveFormat::File => {
            let path = destination(staging, &format!("{root}/{entry}"))?;
            copy_entry(&mut File::open(archive)?, &path, size, &mut expanded)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    let root = payload_root;
    if std::fs::symlink_metadata(&root)?.file_type().is_symlink() {
        bail!("Payload root must not be a symbolic link");
    }
    let entry = root.join(entry);
    if !entry.is_file() || !entry.canonicalize()?.starts_with(root.canonicalize()?) {
        bail!("Payload entry point is missing or escapes its payload");
    }
    Ok(root)
}
