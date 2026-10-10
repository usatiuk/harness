use anyhow::{Context, Result};
use std::{
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
};

/// SSH channel closure does not terminate a noninteractive command blocked on
/// an OS lock. EOF on this preparation's stdin retires that exact process.
pub(crate) struct PreparationConnection {
    ready: Arc<AtomicBool>,
    reader: JoinHandle<std::io::Result<()>>,
}

impl PreparationConnection {
    pub(crate) fn new() -> Result<Self> {
        let ready = Arc::new(AtomicBool::new(false));
        let completed = Arc::clone(&ready);
        let reader = std::thread::Builder::new()
            .name("preparation-connection".into())
            .spawn(move || {
                let result = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
                if !completed.load(Ordering::Acquire) {
                    eprintln!("Remote preparation disconnected before readiness");
                    // Preparation can be inside a blocking OS lock or download.
                    // Process exit releases its handles; no detached task survives.
                    std::process::exit(130);
                }
                result.map(|_| ())
            })?;
        Ok(Self { ready, reader })
    }

    pub(crate) fn ready(&self) {
        self.ready.store(true, Ordering::Release);
    }

    pub(crate) fn finish(self) -> Result<()> {
        std::io::stdout().flush()?;
        self.reader
            .join()
            .map_err(|_| anyhow::anyhow!("Preparation connection reader failed"))?
            .context("Preparation connection input failed")
    }
}
