use crate::{Result, expert_package};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Query {
    Connectors {
        roots: Vec<PathBuf>,
        installed_root: PathBuf,
        hidden_path: PathBuf,
    },
    Experts {
        installed_root: PathBuf,
        market_roots: Option<Vec<PathBuf>>,
        hidden_path: Option<PathBuf>,
    },
    ExpertDetail {
        installed_root: PathBuf,
        directory: String,
    },
    ExpertPrivateSkills {
        installed_root: PathBuf,
        directory: String,
        skill_root: PathBuf,
    },
    SkillMarket {
        legacy_root: PathBuf,
        market_roots: Vec<PathBuf>,
        hidden_path: PathBuf,
    },
}

pub(crate) fn directories(root: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(root)? {
        let item = item?;
        let path = item.path();
        if path.is_dir() {
            entries.push((item.file_name().to_string_lossy().into_owned(), path));
        }
    }
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    Ok(entries)
}

fn text(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    fs::read(path)
        .ok()
        .map(|raw| String::from_utf8_lossy(&raw).into_owned())
}

pub(crate) fn first_path(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.exists())
}

fn hidden_ids(path: &Path) -> Vec<String> {
    text(path)
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.to_lowercase())
        .collect()
}

fn connectors(roots: Vec<PathBuf>, installed_root: &Path, hidden_path: &Path) -> Result<Value> {
    let installed = directories(installed_root)?;
    let mut registrations = HashMap::new();
    for (name, path) in &installed {
        registrations.entry(name.to_lowercase()).or_insert(path);
    }
    let mut seen: HashSet<String> = hidden_ids(hidden_path).into_iter().collect();
    let mut items = Vec::new();
    for root in roots {
        let Ok(entries) = directories(&root) else {
            continue;
        };
        for (name, dir) in entries {
            let id = name.to_lowercase();
            if !seen.insert(id.clone()) {
                continue;
            }
            let skills = dir.join("skills");
            let skill_names = if !skills.is_dir() {
                Vec::new()
            } else if first_path(&skills, &["SKILL.md", "skill.md"]).is_some() {
                vec![id.clone()]
            } else {
                directories(&skills)?
                    .into_iter()
                    .map(|(name, _)| name.to_lowercase())
                    .collect()
            };
            let registration = registrations
                .get(name.trim().to_lowercase().as_str())
                .and_then(|path| text(&path.join("meta.json")));
            items.push(json!({
                "name": name,
                "dir": dir,
                "metadata": text(&dir.join("connector-meta.json")),
                "cli": text(&dir.join("cli.json")),
                "iconPath": first_path(&dir, &["icon.png", "icon.jpg", "icon.jpeg", "logo.png"]),
                "skillNames": skill_names,
                "installed": registrations.contains_key(&id),
                "registration": registration,
            }));
        }
    }
    Ok(items.into())
}

fn experts(
    installed_root: &Path,
    market_roots: Option<Vec<PathBuf>>,
    hidden_path: Option<PathBuf>,
) -> Result<Value> {
    let installed: Vec<_> = directories(installed_root)?
        .into_iter()
        .filter(|(name, _)| !name.starts_with('.'))
        .filter_map(|(_, dir)| {
            text(&dir.join("expert.json"))
                .map(|metadata| json!({ "dir": dir, "metadata": metadata }))
        })
        .collect();
    let mut market = Vec::new();
    for root in market_roots.into_iter().flatten() {
        let Ok(entries) = directories(&root) else {
            continue;
        };
        for (name, dir) in entries {
            if let Some(metadata) = text(&dir.join(".codebuddy-plugin").join("plugin.json")) {
                market.push(json!({ "name": name, "dir": dir, "metadata": metadata }));
            }
        }
    }
    Ok(
        json!({ "installed": installed, "market": market, "hidden": hidden_path.as_deref().map(hidden_ids).unwrap_or_default() }),
    )
}

fn skill_header(path: &Path) -> std::io::Result<String> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut header = Vec::new();
    reader.read_until(b'\n', &mut header)?;
    if !header.starts_with(b"---") {
        return Ok(String::new());
    }
    loop {
        let start = header.len();
        if reader.read_until(b'\n', &mut header)? == 0 {
            return Ok(String::new());
        }
        if header[start..].starts_with(b"---") {
            return Ok(String::from_utf8_lossy(&header).into_owned());
        }
    }
}

fn scan_skills(root: &Path, legacy: bool, items: &mut Vec<Value>) -> Result<()> {
    for (name, dir) in directories(root)? {
        if legacy && first_path(&dir, &["_skillhub_meta.json", "_user_meta.json"]).is_some() {
            continue;
        }
        if let Some(path) = first_path(&dir, &["SKILL.md", "skill.md"]) {
            items.push(json!({ "name": name, "dir": dir, "header": skill_header(&path)?, "legacy": legacy }));
        }
    }
    Ok(())
}

pub fn read(query: Query) -> Result<Value> {
    match query {
        Query::Connectors {
            roots,
            installed_root,
            hidden_path,
        } => connectors(roots, &installed_root, &hidden_path),
        Query::Experts {
            installed_root,
            market_roots,
            hidden_path,
        } => experts(&installed_root, market_roots, hidden_path),
        Query::ExpertDetail {
            installed_root,
            directory,
        } => expert_package::detail(&installed_root, &directory),
        Query::ExpertPrivateSkills {
            installed_root,
            directory,
            skill_root,
        } => expert_package::private_skills(&installed_root, &directory, &skill_root),
        Query::SkillMarket {
            legacy_root,
            market_roots,
            hidden_path,
        } => {
            let mut items = Vec::new();
            scan_skills(&legacy_root, true, &mut items)?;
            for root in market_roots {
                if root.is_dir() {
                    scan_skills(&root, false, &mut items)?;
                }
            }
            Ok(json!({ "items": items, "hidden": hidden_ids(&hidden_path) }))
        }
    }
}
