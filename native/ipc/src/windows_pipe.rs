use napi::{
    Env, Error, Result, Status, Task,
    bindgen_prelude::{AsyncTask, Object},
};
use napi_derive::napi;
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INSUFFICIENT_BUFFER, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_NOT_FOUND,
        ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
        WAIT_OBJECT_0,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1,
        },
        GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX,
    },
    System::{
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        LibraryLoader::{GetModuleHandleW, GetProcAddress},
        Pipes::{ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS},
        Threading::{
            CreateEventW, GetCurrentProcess, INFINITE, OpenProcessToken, SetEvent,
            WaitForMultipleObjects,
        },
    },
};

fn failure() -> Error {
    Error::from_reason(io::Error::last_os_error().to_string())
}
fn owned(raw: HANDLE) -> Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(failure());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}
fn event() -> Result<OwnedHandle> {
    owned(unsafe { CreateEventW(null(), 1, 0, null()) })
}
fn canceled() -> Error {
    Error::new(Status::Cancelled, "Pipe listener is closed")
}

struct LocalAllocation(*mut std::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        assert!(unsafe { LocalFree(self.0) }.is_null(), "LocalFree failed");
    }
}

fn current_sid() -> Result<String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(failure());
    }
    let token = owned(token)?;
    let mut size = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
    if io::Error::last_os_error().raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(failure());
    }
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(failure());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut string = null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut string) } == 0 {
        return Err(failure());
    }
    let _allocation = LocalAllocation(string.cast());
    let mut length = 0;
    while unsafe { *string.add(length) } != 0 {
        length += 1;
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(string, length) })
        .map_err(|error| Error::from_reason(error.to_string()))
}

fn instance(name: &[u16], sid: &str, first: bool) -> Result<OwnedHandle> {
    let sddl: Vec<_> = format!("D:P(A;;GA;;;{sid})")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(failure());
    }
    let _descriptor = LocalAllocation(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let flags = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    owned(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            flags,
            PIPE_REJECT_REMOTE_CLIENTS,
            255,
            65536,
            65536,
            0,
            &attributes,
        )
    })
}

struct Inner {
    name: Vec<u16>,
    sid: String,
    pending: Mutex<Option<OwnedHandle>>,
    cancel: OwnedHandle,
    closed: AtomicBool,
}

/// Only pipe admission is native. Node owns all connected stream I/O.
#[napi]
pub struct PipeListener {
    inner: Arc<Inner>,
}

impl Drop for PipeListener {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::Release);
        assert!(
            unsafe { SetEvent(self.inner.cancel.as_raw_handle()) } != 0,
            "Pipe cancellation failed"
        );
    }
}

#[napi]
impl PipeListener {
    #[napi(constructor)]
    pub fn new(name: String) -> Result<Self> {
        let suffix = name
            .strip_prefix(r"\\.\pipe\harness-")
            .ok_or_else(|| Error::new(Status::InvalidArg, "Expected a Harness local pipe name"))?;
        if suffix.is_empty()
            || suffix.len() > 160
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(Error::new(Status::InvalidArg, "Invalid Harness pipe name"));
        }
        let name: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
        let sid = current_sid()?;
        let pending = instance(&name, &sid, true)?;
        Ok(Self {
            inner: Arc::new(Inner {
                name,
                sid,
                pending: Mutex::new(Some(pending)),
                cancel: event()?,
                closed: AtomicBool::new(false),
            }),
        })
    }

    /// null means a peer disconnected before admission; it is an external edge.
    #[napi]
    pub fn accept<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
        let (deferred, promise) = env.create_deferred()?;
        let mut accept = Accept(self.inner.clone());
        // Admission can wait indefinitely. It must not occupy Node's shared
        // worker pool, which filesystem operations and shutdown also require.
        std::thread::spawn(move || match accept.compute() {
            Ok(output) => deferred.resolve(move |env| accept.resolve(env, output)),
            Err(error) => deferred.reject(error),
        });
        Ok(promise)
    }

    #[napi]
    pub fn close(&self) -> Result<AsyncTask<Close>> {
        self.inner.closed.store(true, Ordering::Release);
        // Persistent event prevents the cancel-before-wait race. Completion
        // still waits for pending I/O and the listener handle to be released.
        if unsafe { SetEvent(self.inner.cancel.as_raw_handle()) } == 0 {
            return Err(failure());
        }
        Ok(AsyncTask::new(Close(self.inner.clone())))
    }
}

pub struct Close(Arc<Inner>);
impl Task for Close {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        self.0
            .pending
            .lock()
            .map_err(|_| Error::from_reason("Pipe listener mutex poisoned"))?
            .take();
        Ok(())
    }
    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

pub struct Accept(Arc<Inner>);
impl Task for Accept {
    type Output = Option<OwnedHandle>;
    type JsValue = Option<i32>;
    fn compute(&mut self) -> Result<Self::Output> {
        let mut slot = self
            .0
            .pending
            .lock()
            .map_err(|_| Error::from_reason("Pipe listener mutex poisoned"))?;
        if self.0.closed.load(Ordering::Acquire) {
            return Err(canceled());
        }
        let pipe = slot.take().expect("Open listener has a pending instance");
        let complete = event()?;
        let mut overlap: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlap.hEvent = complete.as_raw_handle();
        let started = unsafe { ConnectNamedPipe(pipe.as_raw_handle(), &mut overlap) };
        let code = if started != 0 {
            0
        } else {
            io::Error::last_os_error().raw_os_error().unwrap() as u32
        };
        let mut connected = true;
        if code == ERROR_IO_PENDING {
            let handles = [self.0.cancel.as_raw_handle(), complete.as_raw_handle()];
            let waited = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
            if waited != WAIT_OBJECT_0 + 1 {
                // OVERLAPPED memory cannot leave this stack while the kernel
                // still references it, even after requesting cancellation.
                let cancellation = unsafe { CancelIoEx(pipe.as_raw_handle(), &overlap) };
                let cancellation_error = if cancellation == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                        None
                    } else {
                        Some(error)
                    }
                } else {
                    None
                };
                let mut transferred = 0;
                let drained = unsafe {
                    GetOverlappedResult(pipe.as_raw_handle(), &overlap, &mut transferred, 1)
                };
                if drained == 0
                    && io::Error::last_os_error().raw_os_error()
                        != Some(ERROR_OPERATION_ABORTED as i32)
                {
                    return Err(failure());
                }
                if let Some(error) = cancellation_error {
                    return Err(Error::from_reason(error.to_string()));
                }
                if waited == WAIT_OBJECT_0 {
                    return Err(canceled());
                }
                return Err(Error::from_reason("Cannot wait for pipe admission"));
            }
            let mut transferred = 0;
            if unsafe { GetOverlappedResult(pipe.as_raw_handle(), &overlap, &mut transferred, 0) }
                == 0
            {
                return Err(failure());
            }
        } else if code == ERROR_NO_DATA {
            connected = false;
        } else if code != 0 && code != ERROR_PIPE_CONNECTED {
            return Err(failure());
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(canceled());
        }
        // Keep the name occupied, with the same security policy, before handing
        // the connected instance to Node. There is no replacement-instance gap.
        *slot = Some(instance(&self.0.name, &self.0.sid, false)?);
        Ok(if connected { Some(pipe) } else { None })
    }
    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        let Some(pipe) = output else {
            return Ok(None);
        };
        if self.0.closed.load(Ordering::Acquire) {
            return Err(canceled());
        }
        let module = unsafe { GetModuleHandleW(null()) };
        let function = unsafe { GetProcAddress(module, c"uv_open_osfhandle".as_ptr().cast()) }
            .ok_or_else(|| Error::from_reason("Managed Node does not export uv_open_osfhandle"))?;
        let open: unsafe extern "C" fn(HANDLE) -> i32 = unsafe { std::mem::transmute(function) };
        let descriptor = unsafe { open(pipe.as_raw_handle()) };
        if descriptor < 0 {
            return Err(Error::from_reason("Cannot transfer pipe ownership to Node"));
        }
        // The pinned Node CRT reserves 0–2 even without console handles, and
        // Node's fs.close cannot release those slots. A standard descriptor here
        // means this host violates the managed-runtime ownership contract.
        assert!(
            descriptor > 2,
            "Managed Node returned a standard pipe descriptor"
        );
        let _transferred_handle = pipe.into_raw_handle();
        Ok(Some(descriptor))
    }
}
