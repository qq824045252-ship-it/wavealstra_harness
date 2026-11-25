use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    root: PathBuf,
    task_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    backup_id: String,
    pub(crate) abs_path: String,
    rel_path: String,
    pub(crate) backup_path: PathBuf,
    created_at: f64,
    size: f64,
    task_id: String,
    kind: &'static str,
    pub(crate) is_dir: bool,
}

struct Manifest(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Manifest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ManifestObject;
        impl<'de> Visitor<'de> for ManifestObject {
            type Value = Manifest;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a backup manifest object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Manifest, M::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(Manifest(entries))
            }
        }
        deserializer.deserialize_map(ManifestObject)
    }
}

pub(crate) enum Lookup {
    Found(Backup),
    Missing,
    NeedsHost,
}

pub(crate) fn lookup(root: &Path, task_id: String, backup_id: String) -> Lookup {
    let Some(directory) = task_directory(root, &task_id) else {
        return Lookup::NeedsHost;
    };
    let Ok(data) = fs::read(directory.join("manifest.json")) else {
        return Lookup::Missing;
    };
    let Ok(Manifest(entries)) = serde_json::from_str(&String::from_utf8_lossy(&data)) else {
        return Lookup::NeedsHost;
    };
    let Some((backup_id, entry)) = entries.into_iter().rev().find(|(id, _)| *id == backup_id)
    else {
        return Lookup::Missing;
    };
    let Some(abs_path) = entry.get("absPath").and_then(Value::as_str) else {
        return Lookup::Missing;
    };
    match map_backup(&directory, task_id, backup_id, &entry, abs_path) {
        Some(backup) => Lookup::Found(backup),
        None => Lookup::NeedsHost,
    }
}

fn task_directory(root: &Path, task_id: &str) -> Option<PathBuf> {
    let name = task_id.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    if matches!(name.as_str(), "." | "..") {
        return None;
    }
    Some(root.join(name))
}

pub fn list(Query { root, task_id }: Query) -> Option<Vec<Backup>> {
    if !root.exists() {
        return Some(Vec::new());
    }
    let mut task_ids = if let Some(id) = task_id.filter(|id| !id.is_empty()) {
        vec![id]
    } else {
        fs::read_dir(&root)
            .ok()?
            .map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect::<Option<Vec<_>>>()?
    };
    task_ids.sort();
    let mut backups = Vec::new();
    for task_id in task_ids {
        let directory = task_directory(&root, &task_id)?;
        let Ok(data) = fs::read(directory.join("manifest.json")) else {
            continue;
        };
        let Manifest(mut entries) = serde_json::from_str(&String::from_utf8_lossy(&data)).ok()?;
        // JavaScript enumerates numeric object keys first, then keys in insertion order.
        entries.sort_by_key(|(id, _)| {
            id.parse::<u32>()
                .ok()
                .filter(|number| number.to_string() == *id)
                .unwrap_or(u32::MAX)
        });
        let mut seen = std::collections::HashSet::new();
        for (backup_id, entry) in entries {
            if !seen.insert(backup_id.clone()) {
                return None;
            }
            let Some(abs_path) = entry.get("absPath").and_then(Value::as_str) else {
                continue;
            };
            backups.push(map_backup(
                &directory,
                task_id.clone(),
                backup_id,
                &entry,
                abs_path,
            )?);
        }
    }
    backups.sort_by(|left, right| {
        right
            .created_at
            .partial_cmp(&left.created_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(backups)
}

fn map_backup(
    directory: &Path,
    task_id: String,
    backup_id: String,
    entry: &Value,
    abs_path: &str,
) -> Option<Backup> {
    if backup_id.contains(['/', '\\', ':']) {
        return None;
    }
    let rel_path = match entry.get("relPath").filter(|value| !value.is_null()) {
        Some(value) => value.as_str()?,
        None => basename(abs_path),
    };
    let number = |key| match entry.get(key).filter(|value| !value.is_null()) {
        Some(value) => value.as_f64(),
        None => Some(0.0),
    };
    Some(Backup {
        backup_path: directory.join(format!("{backup_id}.bak")),
        backup_id,
        abs_path: abs_path.to_owned(),
        rel_path: rel_path.to_owned(),
        created_at: number("createdAt")?,
        size: number("size")?,
        task_id,
        kind: if entry.get("kind").and_then(Value::as_str) == Some("deleted") {
            "deleted"
        } else {
            "modified"
        },
        is_dir: entry.get("isDir").and_then(Value::as_bool) == Some(true),
    })
}

fn basename(path: &str) -> &str {
    let separator = |value| value == '/' || (cfg!(windows) && value == '\\');
    let path = if cfg!(windows)
        && path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes()[0].is_ascii_alphabetic()
    {
        &path[2..]
    } else {
        path
    };
    path.trim_end_matches(separator)
        .rsplit(separator)
        .next()
        .unwrap_or_default()
}
