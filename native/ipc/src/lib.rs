use harness_bootstrap::{ExclusiveLock, FileUse};
use napi::{Error, Result};
use napi_derive::napi;

/// The controller verifies executable metadata before transferring a target
/// bootstrap. Keep one signature implementation and one compiled trust key.
#[napi]
pub fn verify_release(bytes: napi::bindgen_prelude::Buffer, signature: String) -> Result<String> {
    if bytes.len() > 1024 * 1024 || signature.len() > 16 * 1024 {
        return Err(Error::from_reason(
            "Release metadata exceeds its size limit",
        ));
    }
    let manifest = harness_bootstrap::verify_release(
        &bytes,
        &signature,
        include_str!("../../../release/verification-key.pub"),
    )
    .map_err(|error| Error::from_reason(format!("{error:#}")))?;
    serde_json::to_string(&manifest).map_err(|error| Error::from_reason(error.to_string()))
}

/// Packaging verifies the exact updater bytes against the compiled project key.
#[napi]
pub fn verify_artifact_signature(
    bytes: napi::bindgen_prelude::Buffer,
    signature: String,
) -> Result<()> {
    if bytes.is_empty()
        || bytes.len() as u64 > 2 * 1024 * 1024 * 1024
        || signature.len() > 16 * 1024
    {
        return Err(Error::from_reason(
            "Updater artifact/signature exceeds its size limit",
        ));
    }
    harness_bootstrap::verify_signature(
        &bytes,
        &signature,
        include_str!("../../../release/verification-key.pub"),
    )
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}

#[cfg(windows)]
mod windows_pipe;

/// A Node owner keeps its own guards after its initiating launcher exits.
#[napi]
pub struct CacheUse {
    guards: Vec<FileUse>,
}

#[napi]
impl CacheUse {
    #[napi(constructor)]
    pub fn new(home: String, keys: Vec<String>) -> Result<Self> {
        let home = harness_bootstrap::canonical_home(std::path::Path::new(&home))
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let guards = keys
            .iter()
            .map(|key| {
                FileUse::shared(&home, key)
                    .map_err(|error| Error::from_reason(format!("{error:#}")))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { guards })
    }

    /// Consumers close only after every child and worker that uses their paths exits.
    #[napi]
    pub fn close(&mut self) {
        self.guards.clear();
    }
}

/// The outer manager owns this lock; a spawned owner never reacquires it.
#[napi]
pub struct LifecycleLock {
    lock: Option<ExclusiveLock>,
}

#[napi]
impl LifecycleLock {
    #[napi(constructor)]
    pub fn new(home: String) -> Result<Self> {
        let home = harness_bootstrap::canonical_home(std::path::Path::new(&home))
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let lock = ExclusiveLock::new(&home, "server-lifecycle")
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        Ok(Self { lock: Some(lock) })
    }

    #[napi]
    pub fn try_acquire(&mut self) -> Result<bool> {
        self.lock
            .as_mut()
            .ok_or_else(|| Error::from_reason("Lifecycle lock is already closed"))?
            .try_acquire()
            .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    #[napi]
    pub fn close(&mut self) {
        self.lock.take();
    }
}
