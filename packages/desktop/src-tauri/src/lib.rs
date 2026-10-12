pub mod command;
#[cfg(target_os = "linux")]
pub mod rendering;
pub mod runtime;

pub const MAX_FRAME: usize = 4 * 1024 * 1024;
