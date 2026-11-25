use crate::{
    Result, artifact_content::physical_directory, gadget_files::remove_orphan,
    library_text::is_link,
};
use rusqlite::{Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cleanup {
    Selected { paths: Vec<String> },
    Orphans,
}

#[derive(Default, Serialize)]
pub struct Report {
    removed: Vec<String>,
    failed: Vec<String>,
}

pub fn clean(db: &mut Connection, root: &Path, cleanup: Cleanup) -> Result<Report> {
    if !root.is_absolute() {
        return Err("成果存储目录必须是绝对路径".into());
    }
    let mut report = Report::default();
    let root = match fs::canonicalize(root) {
        Ok(root) if root.is_dir() => root,
        Ok(_) => return Err("成果存储目录必须是真实文件夹".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(error.into()),
    };

    let candidates = match cleanup {
        Cleanup::Selected { paths } => paths
            .into_iter()
            .filter_map(|path| relative(Path::new(&path)))
            .collect(),
        Cleanup::Orphans => {
            let before = registered(db)?;
            find_orphans(&root, &before, &mut report.failed)?
        }
    };
    if candidates.is_empty() {
        return Ok(report);
    }

    // The walk does not hold the writer lock. Recheck ownership under the same lock
    // used to publish new managed files before removing any candidate.
    let _write_guard = crate::write_gate::enter()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let live = registered(&tx)?;
    let mut live_targets = None;
    let mut seen = HashSet::new();
    for path in candidates {
        let key = path_key(&path);
        if live.protected.contains(&key) || !seen.insert(key) {
            continue;
        }
        let live_targets =
            live_targets.get_or_insert_with(|| canonical_targets(&root, &live.paths));
        if live_targets.contains(&path_key(&root.join(&path))) {
            continue;
        }
        match remove_file(&root, &path) {
            Ok(true) => report.removed.push(display(&path)),
            Ok(false) => (),
            Err(_) => report.failed.push(display(&path)),
        }
    }
    Ok(report)
}

struct Registered {
    paths: Vec<PathBuf>,
    protected: HashSet<PathBuf>,
}

fn registered(db: &Connection) -> Result<Registered> {
    let mut query = db.prepare(
        "SELECT storage_path FROM artifacts WHERE source_type='managed-content' AND storage_path IS NOT NULL",
    )?;
    let paths = query.query_map([], |row| row.get::<_, String>(0))?;
    let mut live = Registered {
        paths: Vec::new(),
        protected: HashSet::new(),
    };
    for path in paths {
        if let Some(path) = relative(Path::new(&path?)) {
            live.protected.extend(
                path.ancestors()
                    .filter(|part| !part.as_os_str().is_empty())
                    .map(path_key),
            );
            live.paths.push(path);
        }
    }
    Ok(live)
}

fn relative(path: &Path) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(part) if valid_name(part) => relative.push(part),
            Component::CurDir => (),
            Component::ParentDir if relative.pop() => (),
            _ => return None,
        }
    }
    (!relative.as_os_str().is_empty()).then_some(relative)
}

fn valid_name(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        !name.contains('\0')
            && (!cfg!(windows) || crate::gadget_files::valid_windows_component(name))
    })
}

fn path_key(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_owned()
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn canonical_targets(root: &Path, live: &[PathBuf]) -> HashSet<PathBuf> {
    live.iter()
        .filter_map(|path| fs::canonicalize(root.join(path)).ok())
        .filter(|path| path.starts_with(root))
        .map(|path| path_key(&path))
        .collect()
}

fn find_orphans(
    root: &Path,
    registered: &Registered,
    failed: &mut Vec<String>,
) -> Result<Vec<PathBuf>> {
    let mut pending = vec![root.to_owned()];
    let mut candidates = Vec::new();
    while let Some(folder) = pending.pop() {
        let entries =
            match physical_directory(&folder, root).and_then(|folder| Ok(fs::read_dir(folder)?)) {
                Ok(entries) => entries,
                Err(error) => {
                    if let Ok(path) = folder.strip_prefix(root) {
                        if !path.as_os_str().is_empty() {
                            failed.push(display(path));
                            continue;
                        }
                    }
                    return Err(error);
                }
            };
        for entry in entries {
            let entry = entry?;
            let absolute = entry.path();
            let path = absolute.strip_prefix(root)?;
            let info = match fs::symlink_metadata(&absolute) {
                Ok(info) => info,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(_) => {
                    failed.push(display(path));
                    continue;
                }
            };
            if info.is_dir() && !is_link(&info) {
                pending.push(absolute);
            } else if !registered.protected.contains(&path_key(path)) {
                if relative(path).is_some() {
                    candidates.push(path.to_owned());
                } else {
                    failed.push(display(path));
                }
            }
        }
    }
    Ok(candidates)
}

fn remove_file(root: &Path, path: &Path) -> Result<bool> {
    let mut parent = root.to_owned();
    for part in path.parent().ok_or("成果清理路径无效")?.components() {
        let Component::Normal(part) = part else {
            return Err("成果清理路径无效".into());
        };
        match physical_directory(&parent.join(part), root) {
            Ok(directory) => parent = directory,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
            {
                return Ok(false);
            }
            Err(error) => return Err(error),
        }
    }
    let target = parent.join(path.file_name().ok_or("成果清理路径无效")?);
    let info = match fs::symlink_metadata(&target) {
        Ok(info) => info,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if info.is_dir() && !is_link(&info) {
        return Err("成果文件已变为目录，停止清理".into());
    }
    remove_orphan(&target, &info)?;
    for directory in parent
        .ancestors()
        .take_while(|directory| *directory != root)
    {
        if fs::remove_dir(directory).is_err() {
            break;
        }
    }
    Ok(true)
}
