use serde::{Deserialize, Serialize};
use std::{
    fs::{self, DirEntry, FileType},
    io::{self, ErrorKind},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    root: PathBuf,
    kind: Kind,
    max_depth: usize,
    file_limit: usize,
    excluded_directories: Vec<String>,
    internal_name: String,
    internal_suffix: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Tree,
    Snapshot,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scan {
    Tree { nodes: Vec<Node> },
    Snapshot { files: Vec<(String, u64, f64)> },
    NeedsHost,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Node {
    File { name: String },
    Folder { name: String, children: Vec<Node> },
}

pub fn scan(query: Query) -> Scan {
    if !query.root.is_absolute() || query.max_depth > 12 {
        return Scan::NeedsHost;
    }
    match query.kind {
        Kind::Tree => match query.tree(&query.root, 0, &mut 0) {
            Ok(nodes) => Scan::Tree { nodes },
            Err(_) => Scan::NeedsHost,
        },
        Kind::Snapshot => query.snapshot().unwrap_or(Scan::NeedsHost),
    }
}

impl Query {
    fn entries(&self, path: &Path) -> io::Result<Vec<(String, DirEntry, FileType)>> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| {
                io::Error::new(ErrorKind::InvalidData, "workspace entry is not Unicode")
            })?;
            if name == self.internal_name || name.ends_with(&self.internal_suffix) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() && (name.starts_with('.') || self.excluded_directories.contains(&name))
            {
                continue;
            }
            if kind.is_dir() || kind.is_file() {
                entries.push((name, entry, kind));
            }
        }
        // Node's scandir order determines which folders are visited before the
        // file count boundary. The caller applies the UI's locale sort later.
        entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        Ok(entries)
    }

    fn tree(&self, path: &Path, depth: usize, seen: &mut usize) -> io::Result<Vec<Node>> {
        if depth > self.max_depth || *seen > self.file_limit {
            return Ok(Vec::new());
        }
        let mut nodes = Vec::new();
        for (name, entry, kind) in self.entries(path)? {
            if kind.is_dir() {
                let children = self.tree(&entry.path(), depth + 1, seen)?;
                nodes.push(Node::Folder { name, children });
            } else {
                *seen += 1;
                nodes.push(Node::File { name });
            }
        }
        Ok(nodes)
    }

    fn snapshot_paths(
        &self,
        path: &Path,
        depth: usize,
        paths: &mut Vec<PathBuf>,
    ) -> io::Result<()> {
        if depth > self.max_depth || paths.len() >= self.file_limit {
            return Ok(());
        }
        let entries = match self.entries(path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::InvalidData => return Err(error),
            Err(_) => return Ok(()),
        };
        for (_, entry, kind) in entries {
            if paths.len() >= self.file_limit {
                break;
            }
            if kind.is_dir() {
                self.snapshot_paths(&entry.path(), depth + 1, paths)?;
            } else {
                paths.push(entry.path());
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> Option<Scan> {
        let mut paths = Vec::new();
        self.snapshot_paths(&self.root, 0, &mut paths).ok()?;
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let Ok(info) = fs::metadata(&path) else {
                continue;
            };
            let relative = path.strip_prefix(&self.root).ok()?.to_str()?.to_owned();
            files.push((relative, info.len(), millis(info.modified().ok()?)));
        }
        Some(Scan::Snapshot { files })
    }
}

fn millis(time: SystemTime) -> f64 {
    let (seconds, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => (duration.as_secs() as f64, duration.subsec_nanos()),
        Err(error) => {
            let duration = error.duration();
            let nanos = duration.subsec_nanos();
            if nanos == 0 {
                (-(duration.as_secs() as f64), 0)
            } else {
                (-(duration.as_secs() as f64) - 1.0, 1_000_000_000 - nanos)
            }
        }
    };
    seconds * 1_000.0 + f64::from(nanos) / 1_000_000.0
}
