use anyhow::{Context, Result, bail};
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    io::{self, ErrorKind},
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{addr_of, null_mut},
};
use windows_sys::Win32::{
    Foundation::{ERROR_ALREADY_EXISTS, GENERIC_ALL, GENERIC_WRITE, LocalFree},
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
        },
        DACL_SECURITY_INFORMATION, GetAce, GetSecurityDescriptorDacl, GetTokenInformation,
        INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        CreateDirectoryW, DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, READ_CONTROL,
        WRITE_DAC, WRITE_OWNER,
    },
    System::{
        SystemServices::{
            ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_CALLBACK_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
            ACCESS_DENIED_CALLBACK_ACE_TYPE, ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE,
            ACCESS_DENIED_OBJECT_ACE_TYPE,
        },
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

const MUTATION: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER
    | GENERIC_WRITE
    | GENERIC_ALL;

struct LocalAllocation(*mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: only pointers allocated by Win32 for LocalFree are stored here.
        assert!(unsafe { LocalFree(self.0) }.is_null(), "LocalFree failed");
    }
}

fn checked(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn status(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

fn sid_string(sid: PSID) -> Result<String> {
    let mut string = null_mut();
    // SAFETY: sid belongs to the live token buffer or descriptor of the caller.
    checked(unsafe { ConvertSidToStringSidW(sid, &mut string) })?;
    let _allocation = LocalAllocation(string.cast());
    // SAFETY: Win32 returned an allocated, NUL-terminated string.
    let units = unsafe {
        let mut length = 0;
        while *string.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(string, length)
    };
    Ok(String::from_utf16(units)?)
}

fn current_sid() -> Result<String> {
    let mut token = null_mut();
    // SAFETY: the API receives a process pseudo-handle and initializes token on success.
    checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
    // SAFETY: OpenProcessToken returned an allocated handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0;
    // SAFETY: a zero-size query reports the required buffer length.
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
    if size == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    // SAFETY: the buffer is aligned for TOKEN_USER and has at least size bytes.
    checked(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    })?;
    // SAFETY: the successful query initialized TOKEN_USER in the buffer.
    sid_string(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
}

fn private_descriptor(user: &str) -> Result<LocalAllocation> {
    let sddl: Vec<u16> = format!("O:{user}D:P(A;OICI;FA;;;{user})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = null_mut();
    // SAFETY: sddl ends in NUL and descriptor is initialized on success.
    checked(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    })?;
    Ok(LocalAllocation(descriptor))
}

fn create(path: &Path, descriptor: &LocalAllocation) -> Result<()> {
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) {
        bail!("Harness directory path contains a NUL");
    }
    name.push(0);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let create_one = || {
        // SAFETY: the path is NUL-terminated and both attributes and descriptor are live.
        match checked(unsafe { CreateDirectoryW(name.as_ptr(), &attributes) }) {
            Err(error) if error.raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32) => Ok(()),
            result => result,
        }
    };
    if let Err(error) = create_one() {
        if error.kind() != ErrorKind::NotFound {
            return Err(error.into());
        }
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .with_context(|| format!("Cannot create Harness directory {}", path.display()))?;
        create(parent, descriptor)?;
        create_one()?;
    }
    Ok(())
}

fn verify(acl: *mut ACL, user: &str) -> Result<()> {
    if acl.is_null() {
        bail!("Harness home is writable by other users");
    }
    // SAFETY: acl points into the owned descriptor and was checked for null.
    for index in 0..u32::from(unsafe { (*acl).AceCount }) {
        let mut ace = null_mut();
        // SAFETY: the index is below the ACE count; Win32 supplies the ACE pointer.
        checked(unsafe { GetAce(acl, index, &mut ace) })?;
        // SAFETY: ACE_HEADER is the common, initialized prefix of every ACE.
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
            continue;
        }
        match u32::from(header.AceType) {
            ACCESS_DENIED_ACE_TYPE
            | ACCESS_DENIED_OBJECT_ACE_TYPE
            | ACCESS_DENIED_CALLBACK_ACE_TYPE
            | ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE => continue,
            ACCESS_ALLOWED_ACE_TYPE | ACCESS_ALLOWED_CALLBACK_ACE_TYPE => {}
            _ => bail!("Cannot verify Harness directory with an unsupported access rule"),
        }
        // SAFETY: basic and callback allow ACEs share the header, mask and SID prefix.
        let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
        if unsafe { (*allowed).Mask } & MUTATION != 0 {
            let principal = sid_string(unsafe { addr_of!((*allowed).SidStart) } as PSID)?;
            if principal != user && principal != "S-1-5-18" && principal != "S-1-5-32-544" {
                bail!("Harness home is writable by other users");
            }
        }
    }
    Ok(())
}

pub(super) fn protect(path: &Path, private: bool) -> Result<()> {
    let user = current_sid()?;
    let open = || {
        OpenOptions::new()
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES | if private { WRITE_DAC } else { 0 })
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
    };
    let directory: File = match open() {
        Err(error) if error.kind() == ErrorKind::NotFound => {
            create(path, &private_descriptor(&user)?)?;
            open()?
        }
        result => result?,
    };
    if !directory.metadata()?.is_dir() {
        bail!("Harness directory path is not a directory");
    }
    let handle = directory.as_raw_handle();
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: the file owns handle; owner and ACL point into the returned descriptor.
    status(unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    })?;
    let _descriptor = LocalAllocation(descriptor);
    if owner.is_null() || sid_string(owner)? != user {
        bail!("Harness directory has another owner");
    }
    if !private {
        return verify(acl, &user);
    }
    let descriptor = private_descriptor(&user)?;
    let mut present = 0;
    let mut acl = null_mut();
    let mut defaulted = 0;
    // SAFETY: the descriptor is live and owns the returned DACL.
    checked(unsafe {
        GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted)
    })?;
    assert!(
        present != 0 && !acl.is_null(),
        "private descriptor must have a DACL"
    );
    // SAFETY: the same directory handle was checked above and the ACL is live.
    status(unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            acl,
            null_mut(),
        )
    })?;
    Ok(())
}
