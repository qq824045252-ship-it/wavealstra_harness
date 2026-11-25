use crate::{
    Result,
    connector_install::{
        component, copy_directory_contents, is_unsupported, publish_package, real_directory,
        unsupported,
    },
    dots_file_revision::same_path,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader},
    path::{Path, PathBuf},
};
use zip::ZipArchive;

const MARKERS: [&str; 2] = ["connector-meta.json", "cli.json"];

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Import {
    Directory {
        root: PathBuf,
        source: PathBuf,
        id: String,
    },
    Zip {
        root: PathBuf,
        source: PathBuf,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Imported { id: String },
    NeedsHost,
    Failed { message: String },
}

pub fn import(request: Import) -> Reply {
    let result = match request {
        Import::Directory { root, source, id } => import_directory(&root, &source, id),
        Import::Zip { root, source } => import_zip(&root, &source),
    };
    match result {
        Ok(id) => Reply::Imported { id },
        Err(error) if is_unsupported(error.as_ref()) => Reply::NeedsHost,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

fn market(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute() {
        return Err("连接器市场路径无效".into());
    }
    fs::create_dir_all(root)?;
    let real = real_directory(root)?;
    if !same_path(root, &real) {
        return Err(unsupported("connector market is redirected"));
    }
    Ok(real)
}

fn package_marker_exists(dir: &Path) -> bool {
    MARKERS.iter().any(|name| dir.join(name).is_file())
}

fn import_directory(root: &Path, source: &Path, id: String) -> Result<String> {
    let root = market(root)?;
    let source = real_directory(source)?;
    if !package_marker_exists(&source) {
        return Err("不是有效的连接器目录：缺少 connector-meta.json / cli.json".into());
    }
    let dest = component(&root, &id)?;
    if !same_path(&source, &dest) {
        publish_package(&root, &id, false, |stage| {
            copy_directory_contents(&source, stage)
        })?;
    }
    Ok(id)
}

struct Entry {
    index: usize,
    name: String,
}

fn import_zip(root: &Path, source: &Path) -> Result<String> {
    let file = File::open(source).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            "连接器 ZIP 文件不存在".to_string()
        } else {
            error.to_string()
        }
    })?;
    let mut zip = ZipArchive::new(BufReader::new(file))?;
    let mut entries = Vec::new();
    for index in 0..zip.len() {
        let file = zip.by_index_raw(index)?;
        if !file.is_dir() {
            entries.push(Entry {
                index,
                name: file.name()?.replace('\\', "/"),
            });
        }
    }
    if entries.is_empty() {
        return Err("连接器 ZIP 为空".into());
    }
    let marker = entries
        .iter()
        .map(|entry| entry.name.as_str())
        .filter(|entry| {
            MARKERS.iter().any(|marker| {
                entry
                    .rsplit('/')
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case(marker))
            })
        })
        .min_by_key(|entry| entry.bytes().filter(|&byte| byte == b'/').count())
        .ok_or("不是有效的连接器 ZIP：缺少 connector-meta.json / cli.json")?;
    let (prefix, source_name) = match marker.rfind('/') {
        Some(index) => (
            &marker[..=index],
            marker[..index]
                .rsplit('/')
                .find(|part| !part.is_empty())
                .unwrap_or_default(),
        ),
        None => {
            let filename = source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let name = filename
                .rsplit_once('.')
                .filter(|(_, extension)| extension.eq_ignore_ascii_case("zip"))
                .map_or(filename, |(stem, _)| stem);
            ("", name)
        }
    };
    let id = normalize_id(source_name)?;
    let root = market(root)?;
    publish_package(&root, &id, false, |stage| {
        for entry in entries
            .iter()
            .filter(|entry| entry.name.starts_with(prefix))
        {
            let output = zip_entry_path(stage, &entry.name, prefix)?;
            fs::create_dir_all(output.parent().ok_or("无效的连接器 ZIP 路径")?)?;
            let mut destination = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)?;
            io::copy(&mut zip.by_index(entry.index)?, &mut destination)?;
        }
        if !package_marker_exists(stage) {
            return Err("不是有效的连接器 ZIP：缺少 connector-meta.json / cli.json".into());
        }
        Ok(())
    })?;
    Ok(id)
}

fn normalize_id(name: &str) -> Result<String> {
    let mut id = String::new();
    for character in name.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_') {
            id.push(character);
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    let id = id.trim_matches(['.', '-']);
    if id.is_empty() {
        return Err("无法从连接器包确定有效 id".into());
    }
    Ok(id.to_owned())
}

fn zip_entry_path(stage: &Path, name: &str, prefix: &str) -> Result<PathBuf> {
    // Validate the complete archive name before stripping the selected package wrapper.
    if name.starts_with('/')
        || name.as_bytes().get(1) == Some(&b':')
        || name
            .split('/')
            .any(|part| part == "." || part == ".." || part.contains('\0'))
    {
        return Err(format!("连接器 ZIP 含非法路径: {name}").into());
    }
    let mut output = stage.to_path_buf();
    for part in name[prefix.len()..]
        .split('/')
        .filter(|part| !part.is_empty())
    {
        output = component(&output, part).map_err(|_| format!("连接器 ZIP 含非法路径: {name}"))?;
    }
    if output == stage {
        return Err(format!("连接器 ZIP 含非法路径: {name}").into());
    }
    Ok(output)
}
