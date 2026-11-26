//! A single application-database writer arbitration point. Readers never enter it.
//! Reentrant on one worker thread so domain helpers can guard a short transaction
//! even when an ordinary writer already holds admission for its operation.
use std::{
    cell::Cell,
    sync::{Mutex, MutexGuard},
};
static WRITER: Mutex<()> = Mutex::new(());
thread_local! { static DEPTH: Cell<usize> = const { Cell::new(0) }; }
pub struct Guard {
    _held: Option<MutexGuard<'static, ()>>,
}
pub fn enter() -> crate::Result<Guard> {
    let nested = DEPTH.with(|depth| depth.get() > 0);
    let held = if nested {
        None
    } else {
        Some(WRITER.lock().unwrap_or_else(|e| e.into_inner()))
    };
    crate::request_control::checkpoint()?;
    DEPTH.with(|depth| depth.set(depth.get() + 1));
    Ok(Guard { _held: held })
}

/// Acquires the shared writer lock without enforcing cancellation/deadline checkpoints.
/// Reserved strictly for post-side-effect cleanup and intent finalization commits so a
/// late cancellation cannot leave an orphaned child process or dangling `'launching'` row.
pub fn enter_unchecked() -> Guard {
    let nested = DEPTH.with(|depth| depth.get() > 0);
    let held = if nested {
        None
    } else {
        Some(WRITER.lock().unwrap_or_else(|e| e.into_inner()))
    };
    DEPTH.with(|depth| depth.set(depth.get() + 1));
    Guard { _held: held }
}
impl Drop for Guard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get() - 1));
    }
}
