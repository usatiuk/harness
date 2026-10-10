use anyhow::{Context, Result, bail};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn default_home() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("HARNESS_HOME") {
        return Ok(PathBuf::from(value));
    }
    let base = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .context("Cannot resolve the current account's home directory")?;
    Ok(PathBuf::from(base).join(".harness"))
}

pub fn canonical_home(path: &Path) -> Result<PathBuf> {
    protect_directory(path, false)?;
    #[cfg(windows)]
    let home = dunce::canonicalize(path)?;
    #[cfg(not(windows))]
    let home = path.canonicalize()?;
    protect_directory(&home, false)?;
    Ok(home)
}

pub(crate) fn protect_directory(path: &Path, private: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        let metadata = std::fs::metadata(path)?;
        // The account ID comes from the OS, not a user-controlled environment variable.
        let uid = Command::new("id").arg("-u").output()?;
        if !uid.status.success() {
            bail!("Cannot identify runtime account");
        }
        let uid: u32 = std::str::from_utf8(&uid.stdout)?.trim().parse()?;
        if metadata.uid() != uid {
            bail!("Harness directory has another owner");
        }
        if private {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        } else if metadata.mode() & 0o022 != 0 {
            bail!("Harness home is writable by other users");
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let path = path
            .to_str()
            .context("Harness home is not Unicode")?
            .replace('\'', "''");
        let script = format!(
            r#"$ErrorActionPreference='Stop'; $path='{path}';
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=[System.Security.AccessControl.DirectorySecurity]::new();
$acl.SetOwner($user); $acl.SetAccessRuleProtection($true,$false);
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
[void][System.IO.Directory]::CreateDirectory($path,$acl);
$actual=[System.IO.Directory]::GetAccessControl($path);
if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {{ exit 77 }};
if ({private}) {{ [System.IO.Directory]::SetAccessControl($path,$acl) }} else {{
$trusted=@($user.Value,'S-1-5-18','S-1-5-32-544');
$mutation=[System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership;
foreach($rule in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {{
if($rule.AccessControlType -eq 'Allow' -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $mutation) -ne 0) {{ exit 78 }}
}} }}"#,
            private = if private { "$true" } else { "$false" }
        );
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(0x08000000)
            .output()?;
        match output.status.code() {
            Some(0) => {}
            Some(77) => bail!("Harness directory has another owner"),
            Some(78) => bail!("Harness home is writable by other users"),
            _ => bail!(
                "Cannot protect Harness directory: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
        }
    }
    Ok(())
}
