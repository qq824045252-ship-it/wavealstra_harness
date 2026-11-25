use crate::{Result, dots_file_revision};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
};

#[derive(Default)]
struct Watches {
    files: HashMap<String, WatchedFile>,
    pending: HashMap<String, bool>,
}

struct WatchedFile {
    target: PathBuf,
    directory: PathBuf,
}

#[derive(Serialize)]
struct Notice {
    id: String,
    lost: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireNotice {
    dots_file_watches: Vec<Notice>,
}

pub struct FileWatches {
    watcher: RecommendedWatcher,
    state: Arc<Mutex<Watches>>,
}

impl FileWatches {
    pub fn new() -> Result<Self> {
        let state = Arc::new(Mutex::new(Watches::default()));
        let (wake, pending) = mpsc::sync_channel(1);
        let source = state.clone();
        let watcher = notify::recommended_watcher(move |event| {
            let mut watches = source.lock().unwrap();
            if watches.record(event) {
                let _ = wake.try_send(());
            }
        })?;
        let dispatch = state.clone();
        thread::Builder::new()
            .name("dots-file-events".into())
            .spawn(move || {
                while pending.recv().is_ok() {
                    let dots_file_watches = dispatch
                        .lock()
                        .unwrap()
                        .pending
                        .drain()
                        .map(|(id, lost)| Notice { id, lost })
                        .collect::<Vec<_>>();
                    if !dots_file_watches.is_empty()
                        && write_notice(WireNotice { dots_file_watches }).is_err()
                    {
                        break;
                    }
                }
            })?;
        Ok(Self { watcher, state })
    }

    pub fn start(&mut self, id: String, root: &Path, file: &Path) -> bool {
        let Some(target) = dots_file_revision::target(root, file) else {
            return false;
        };
        let Some(parent) = target.parent() else {
            return false;
        };
        let Ok(physical) = fs::canonicalize(parent) else {
            return false;
        };
        if !dots_file_revision::same_path(parent, &physical) {
            return false;
        }
        let shared = {
            let watches = self.state.lock().unwrap();
            if let Some(registered) = watches.files.get(&id) {
                return dots_file_revision::same_path(&registered.target, &target);
            }
            watches.directory_used(&physical)
        };
        if !shared
            && self
                .watcher
                .watch(&physical, RecursiveMode::NonRecursive)
                .is_err()
        {
            return false;
        }
        self.state.lock().unwrap().files.insert(
            id,
            WatchedFile {
                target,
                directory: physical,
            },
        );
        true
    }

    pub fn stop(&mut self, id: &str) {
        let mut watches = self.state.lock().unwrap();
        watches.pending.remove(id);
        let Some(file) = watches.files.remove(id) else {
            return;
        };
        if watches.directory_used(&file.directory) {
            return;
        }
        drop(watches);
        let _ = self.watcher.unwatch(&file.directory);
    }
}

impl Watches {
    fn directory_used(&self, directory: &Path) -> bool {
        self.files
            .values()
            .any(|file| dots_file_revision::same_path(&file.directory, directory))
    }

    fn record(&mut self, event: notify::Result<notify::Event>) -> bool {
        let (paths, all, error, removed) = match event {
            Ok(event) if matches!(event.kind, EventKind::Access(_)) && !event.need_rescan() => {
                return false;
            }
            Ok(event) => {
                let all = event.need_rescan() || event.paths.is_empty();
                (
                    event.paths,
                    all,
                    false,
                    matches!(event.kind, EventKind::Remove(_)),
                )
            }
            Err(error) => {
                let all = error.paths.is_empty();
                (error.paths, all, true, false)
            }
        };
        for (id, file) in &self.files {
            let is_parent = paths
                .iter()
                .any(|path| dots_file_revision::same_path(path, &file.directory));
            let matches_file = paths
                .iter()
                .any(|path| dots_file_revision::same_path(path, &file.target));
            if all || is_parent || matches_file {
                let lost = error || (removed && is_parent);
                *self.pending.entry(id.clone()).or_default() |= lost;
            }
        }
        !self.pending.is_empty()
    }
}

fn write_notice(notice: WireNotice) -> Result<()> {
    let mut output = BufWriter::new(io::stdout().lock());
    serde_json::to_writer(&mut output, &notice)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}
