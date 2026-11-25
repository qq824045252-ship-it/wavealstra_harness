use crate::{
    Result,
    gadget_files::read_at_most,
    library_text::is_link,
    plugin_catalog::{directories, first_path},
};
use same_file::Handle;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io,
    path::{Component, Path, PathBuf},
};

const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const SKILL_FILES: [&str; 2] = ["SKILL.md", "skill.md"];

fn package(root: &Path, directory: &str) -> Result<PathBuf> {
    let mut parts = Path::new(directory).components();
    if !root.is_absolute()
        || !matches!(parts.next(), Some(Component::Normal(_)))
        || parts.next().is_some()
    {
        return Err("expert directory outside installed root".into());
    }
    let dir = root.join(directory);
    let info = fs::symlink_metadata(&dir)?;
    if !info.is_dir() || is_link(&info) {
        return Err("nonstandard expert directory".into());
    }
    Ok(fs::canonicalize(dir)?)
}

fn document(path: &Path) -> Result<Vec<u8>> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_file() || is_link(&info) || info.len() > MAX_DOCUMENT_BYTES as u64 {
        return Err("expert document needs host reader".into());
    }
    let bytes = read_at_most(path, MAX_DOCUMENT_BYTES)?;
    if bytes.len() != info.len() as usize {
        return Err("expert document changed during read".into());
    }
    Ok(bytes)
}

fn stored(raw: &[u8]) -> Result<Value> {
    let row: Value = serde_json::from_slice(raw)?;
    if !row.is_object() || row["kind"] == "team" || row["teamOf"].is_string() {
        return Err("expert metadata needs host reader".into());
    }
    Ok(row)
}

pub fn detail(root: &Path, directory: &str) -> Result<Value> {
    let dir = package(root, directory)?;
    let identity = Handle::from_path(&dir)?;
    let meta_path = dir.join("expert.json");
    let metadata = document(&meta_path)?;
    let expert = stored(&metadata)?;
    let prompt = Path::new(expert["promptFile"].as_str().unwrap_or("prompt.md"));
    if prompt.as_os_str().is_empty()
        || prompt
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("expert prompt path needs host reader".into());
    }
    let prompt_path = fs::canonicalize(dir.join(prompt))?;
    if !prompt_path.starts_with(&dir) {
        return Err("expert prompt outside package".into());
    }
    let meta_path = fs::canonicalize(meta_path)?;
    let mut scan = PackageRevision {
        hash: Sha256::new(),
        meta_path: &meta_path,
        metadata: &metadata,
        prompt_path: &prompt_path,
        prompt: None,
    };
    scan.visit(&dir, "")?;
    let prompt = scan.prompt.ok_or("expert prompt is missing")?;
    let skills_dir = dir.join("skills");
    let skills: Vec<_> = if !skills_dir.is_dir() {
        Vec::new()
    } else if first_path(&skills_dir, &SKILL_FILES).is_some() {
        vec![
            expert["id"]
                .as_str()
                .ok_or("expert id is missing")?
                .to_lowercase(),
        ]
    } else {
        directories(&skills_dir)?
            .into_iter()
            .map(|(name, _)| name.to_lowercase())
            .collect()
    };
    if Handle::from_path(&dir)? != identity {
        return Err("expert package changed during read".into());
    }
    Ok(json!({
        "metadata": String::from_utf8_lossy(&metadata),
        "prompt": prompt,
        "skills": skills,
        "revision": format!("{:x}", scan.hash.finalize())
    }))
}

struct PackageRevision<'a> {
    hash: Sha256,
    meta_path: &'a Path,
    metadata: &'a [u8],
    prompt_path: &'a Path,
    prompt: Option<String>,
}

impl PackageRevision<'_> {
    fn visit(&mut self, path: &Path, relative: &str) -> Result<()> {
        let info = fs::symlink_metadata(path)?;
        if is_link(&info) {
            return Err("linked expert package needs host reader".into());
        }
        self.hash.update(serde_json::to_vec(relative)?);
        if info.is_dir() {
            self.hash.update(b"directory:");
            let mut entries = fs::read_dir(path)?
                .map(|entry| {
                    let entry = entry?;
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "expert path is not Unicode")?;
                    Ok((name, entry.path()))
                })
                .collect::<Result<Vec<_>>>()?;
            // JavaScript's Array.sort compares UTF-16 units, including surrogate pairs.
            entries.sort_unstable_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            for (name, path) in entries {
                self.visit(&path, &format!("{relative}/{name}"))?;
            }
        } else if info.is_file() {
            self.hash.update(format!("file:{}:", info.len()));
            if path == self.meta_path || path == self.prompt_path {
                let bytes = document(path)?;
                if bytes.len() as u64 != info.len()
                    || (path == self.meta_path && bytes != self.metadata)
                {
                    return Err("expert package changed during read".into());
                }
                self.hash.update(&bytes);
                if path == self.prompt_path {
                    self.prompt = Some(String::from_utf8_lossy(&bytes).into_owned());
                }
            } else {
                let mut file = File::open(path)?;
                if io::copy(&mut file, &mut self.hash)? != info.len() {
                    return Err("expert package changed during read".into());
                }
            }
        }
        Ok(())
    }
}

pub fn private_skills(root: &Path, directory: &str, skill_root: &Path) -> Result<Value> {
    let dir = package(root, directory)?;
    let metadata = document(&dir.join("expert.json"))?;
    let expert = stored(&metadata)?;
    let skills = dir.join("skills");
    if expert["enabled"] == false || !skills.is_dir() {
        return Ok(json!({ "items": [], "globalNames": [] }));
    }
    if is_link(&fs::symlink_metadata(&skills)?) {
        return Err("linked private skills need host reader".into());
    }
    let mut items = Vec::new();
    if let Some(path) = first_path(&skills, &SKILL_FILES) {
        let raw = document(&path)?;
        items.push(json!({ "name": null, "markdown": String::from_utf8_lossy(&raw) }));
    } else {
        for (name, dir) in directories(&skills)? {
            if is_link(&fs::symlink_metadata(&dir)?) {
                return Err("linked private skill needs host reader".into());
            }
            if let Some(path) = first_path(&dir, &SKILL_FILES) {
                let raw = document(&path)?;
                items.push(json!({ "name": name, "markdown": String::from_utf8_lossy(&raw) }));
            }
        }
    }
    let global_names = directories(skill_root)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, _)| name.to_lowercase())
        .collect::<Vec<_>>();
    Ok(json!({ "items": items, "globalNames": global_names }))
}
