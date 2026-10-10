use crate::ArchiveFormat;
use anyhow::{Result, bail};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

/// These are authenticated project archives or hash-pinned official Node
/// archives. Maintained extractors own path and link handling in private staging.
pub(crate) fn extract_layout(
    archive: &Path,
    staging: &Path,
    format: ArchiveFormat,
    root: &str,
    entry: &str,
) -> Result<PathBuf> {
    crate::manifest::relative_path(root)?;
    crate::manifest::relative_path(entry)?;
    std::fs::create_dir_all(staging)?;
    match format {
        ArchiveFormat::TarGz => {
            let reader = flate2::read::GzDecoder::new(File::open(archive)?);
            let mut archive = tar::Archive::new(reader);
            archive.set_mask(0o077);
            archive.unpack(staging)?;
        }
        ArchiveFormat::Zip => zip::ZipArchive::new(File::open(archive)?)?.extract(staging)?,
        ArchiveFormat::File => {
            let destination = staging.join(root).join(entry);
            std::fs::create_dir_all(destination.parent().expect("payload parent"))?;
            std::fs::copy(archive, &destination)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    let payload = staging.join(root);
    if std::fs::symlink_metadata(&payload)?
        .file_type()
        .is_symlink()
    {
        bail!("Payload root is a symbolic link");
    }
    crate::cache::checked_entry(&payload, entry)?;
    Ok(payload)
}
