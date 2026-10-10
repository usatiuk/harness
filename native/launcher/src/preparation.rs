use anyhow::Result;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// SSH closure does not terminate a command blocked on an OS lock. Only remote
/// preparation helpers consume stdin; EOF retires that exact unfinished helper.
pub(crate) struct PreparationConnection {
    ready: Arc<AtomicBool>,
}

impl PreparationConnection {
    pub(crate) fn new() -> Result<Self> {
        let ready = Arc::new(AtomicBool::new(false));
        let completed = Arc::clone(&ready);
        std::thread::Builder::new()
            .name("preparation-connection".into())
            .spawn(move || {
                let _input = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
                if !completed.load(Ordering::Acquire) {
                    eprintln!("Remote preparation disconnected before readiness");
                    std::process::exit(130);
                }
            })?;
        Ok(Self { ready })
    }
    pub(crate) fn ready(&self) {
        self.ready.store(true, Ordering::Release);
    }
}
