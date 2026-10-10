use anyhow::{Context, Result, bail};
use harness_bootstrap::{Cache, ExclusiveLock};
use std::{fs, path::Path, process::Command};

pub fn run(cache: &Cache, key: &str) -> Result<i32> {
    let mut gate = ExclusiveLock::new(&cache.home, "cli-update")?;
    if !gate.try_acquire()? {
        bail!("Another CLI update is running; try again when it finishes");
    }
    let latest = env!("HARNESS_LATEST_MANIFEST_URL");
    let Some(launcher) = cache.prepare_cli_update(env!("HARNESS_PRODUCT_VERSION"), latest, key)?
    else {
        println!("Harness {} is up to date", env!("HARNESS_PRODUCT_VERSION"));
        return Ok(0);
    };
    let mut command = Command::new(&launcher.entry);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let identity = command.output()?;
    if !identity.status.success()
        || std::str::from_utf8(&identity.stdout)?.trim() != launcher.version
    {
        bail!("Downloaded CLI launcher differs from the signed release version");
    }
    replace_executable(&launcher.entry, &std::env::current_exe()?)?;
    println!(
        "Updated Harness to {}. Run harness again to use it.",
        launcher.version
    );
    Ok(0)
}

fn replace_executable(source: &Path, target: &Path) -> Result<()> {
    // Stage beside the installation so the final rename stays on one filesystem.
    let candidate = tempfile::NamedTempFile::new_in(
        target
            .parent()
            .context("CLI has no installation directory")?,
    )?;
    fs::copy(source, candidate.path())?;
    fs::set_permissions(candidate.path(), fs::metadata(target)?.permissions())?;
    candidate.as_file().sync_all()?;
    #[cfg(windows)]
    {
        // Windows permits renaming a running image, but not deleting it. Keep one
        // previous binary; the next update removes it after its consumers exit.
        // This avoids self-replace's console-spawning deletion helper.
        let mut backup = target.as_os_str().to_os_string();
        backup.push(".previous");
        let backup = std::path::PathBuf::from(backup);
        if backup.exists() {
            fs::remove_file(&backup).context("Close older CLI processes before updating again")?;
        }
        fs::rename(target, &backup)?;
        if let Err(error) = candidate.persist(target) {
            fs::rename(&backup, target)
                .context("CLI replacement and restoration failed; restore the .previous binary")?;
            return Err(error.error.into());
        }
    }
    #[cfg(not(windows))]
    candidate.persist(target).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_preserves_installation_and_reuses_one_previous_binary() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("harness");
        let source = temporary.path().join("download");
        fs::write(&target, b"previous version").unwrap();
        fs::write(&source, b"new version").unwrap();
        replace_executable(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new version");
        fs::write(&source, b"next version").unwrap();
        replace_executable(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"next version");
        #[cfg(windows)]
        assert_eq!(
            fs::read(target.with_file_name("harness.previous")).unwrap(),
            b"new version"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "fixture subprocess for the mapped-image replacement test"]
    fn held_image() {
        use std::io::{Read, Write};
        println!("image-ready");
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_to_end(&mut Vec::new()).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn replacement_protects_a_running_previous_image_until_it_exits() {
        use std::{
            io::{BufRead, BufReader},
            os::windows::process::CommandExt,
            process::Stdio,
        };
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("harness.exe");
        let source = temporary.path().join("download.exe");
        fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
        fs::write(&source, b"new version").unwrap();
        let mut child = Command::new(&target)
            .args([
                "--exact",
                "update::tests::held_image",
                "--ignored",
                "--nocapture",
            ])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        // Always retire the fixture before asserting its replacement outcomes.
        let ready = BufReader::new(child.stdout.as_mut().unwrap())
            .lines()
            .any(|line| line.unwrap().contains("image-ready"));
        let replaced = replace_executable(&source, &target);
        fs::write(&source, b"next version").unwrap();
        let blocked = replace_executable(&source, &target);
        let installed = fs::read(&target);
        drop(child.stdin.take());
        let output = child.wait_with_output().unwrap();
        assert!(ready && output.status.success(), "{output:?}");
        replaced.unwrap();
        assert!(blocked.is_err());
        assert_eq!(installed.unwrap(), b"new version");
        replace_executable(&source, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"next version");
    }
}
