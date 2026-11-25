use crate::{
    Result,
    dots_file_revision::{same_path, target},
    library_text::is_link,
    plugin_catalog::directories,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
};

const JOURNAL_DIRECTORY: &str = ".mybuddy-connector-installs";
const RETIRED_DIRECTORY: &str = ".mybuddy-connector-retired";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    root: PathBuf,
    legacy_skills_root: PathBuf,
    source_path: PathBuf,
    id: String,
    directory: String,
    name: String,
    installed_at: i64,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Maintenance {
    Startup {
        root: PathBuf,
        legacy_skills_root: PathBuf,
    },
    Uninstall {
        root: PathBuf,
        legacy_skills_root: PathBuf,
        id: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Installed {
        names: Vec<String>,
    },
    Recovered {
        warnings: Vec<String>,
    },
    Maintained {
        migrated: usize,
        removed: usize,
        skipped: usize,
        warnings: Vec<String>,
    },
    Uninstalled {
        warning: Option<String>,
    },
    Missing,
    NeedsHost,
    Failed {
        message: String,
    },
}

pub(crate) fn component(root: &Path, name: &str) -> Result<PathBuf> {
    let name = Path::new(name);
    if name.components().count() != 1 {
        return Err("invalid connector directory name".into());
    }
    target(root, name).ok_or_else(|| "invalid connector directory name".into())
}

pub(crate) fn real_directory(path: &Path) -> Result<PathBuf> {
    let info = fs::symlink_metadata(path)?;
    if !info.is_dir() || is_link(&info) {
        return Err(unsupported("connector directory is redirected"));
    }
    Ok(fs::canonicalize(path)?)
}

fn journal_root(root: &Path) -> Result<PathBuf> {
    sibling(root, JOURNAL_DIRECTORY)
}

fn sibling(root: &Path, name: &str) -> Result<PathBuf> {
    Ok(root
        .parent()
        .ok_or("connector directory has no parent")?
        .join(name))
}

pub(crate) fn unsupported(message: &str) -> Box<dyn std::error::Error> {
    io::Error::new(ErrorKind::Unsupported, message).into()
}

pub(crate) fn is_unsupported(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == ErrorKind::Unsupported)
}

fn copy_tree(source: &Path, dest: &Path) -> Result<()> {
    let info = fs::symlink_metadata(source)?;
    if is_link(&info) {
        return Err(unsupported("connector skills contain linked files"));
    }
    if info.is_file() {
        fs::copy(source, dest)?;
    } else if info.is_dir() {
        fs::create_dir(dest)?;
        copy_directory_contents(source, dest)?;
    } else {
        return Err(unsupported("connector skills contain unsupported files"));
    }
    Ok(())
}

pub(crate) fn copy_directory_contents(source: &Path, dest: &Path) -> Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
    }
    Ok(())
}

fn source_skills(source: &Path, directory: &str) -> Result<Option<Vec<(String, PathBuf)>>> {
    let skills = source.join("skills");
    match fs::symlink_metadata(&skills) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Ok(info) if is_link(&info) => return Err(unsupported("connector skills are redirected")),
        Ok(info) if !info.is_dir() => return Ok(None),
        Ok(_) => {}
        Err(error) => return Err(error.into()),
    }
    if ["SKILL.md", "skill.md"]
        .iter()
        .any(|name| skills.join(name).exists())
    {
        return Ok(Some(vec![(directory.to_owned(), skills)]));
    }
    Ok(Some(
        directories(&skills)?
            .into_iter()
            .map(|(name, source)| (name.to_lowercase(), source))
            .collect(),
    ))
}

fn json_file(path: &Path) -> Option<Value> {
    let info = fs::symlink_metadata(path).ok()?;
    if !info.is_file() || is_link(&info) {
        return None;
    }
    serde_json::from_reader(File::open(path).ok()?).ok()
}

fn skill_source(dir: &Path) -> Option<String> {
    json_file(&dir.join("_skillhub_meta.json"))?
        .get("source")?
        .as_str()
        .map(str::to_owned)
}

fn has_legacy_skill(root: &Path, name: &str, source: &str) -> Result<bool> {
    let dir = component(root, name)?;
    Ok(skill_source(&dir).as_deref() == Some(source))
}

fn recover_transaction(root: &Path, dir: &Path, name: &str) -> Result<()> {
    real_directory(dir)?;
    let live = component(root, name)?;
    let previous = dir.join("previous");
    if previous.exists() {
        real_directory(&previous)?;
        // Publishing moves next out of the journal. If it is still there, restore previous
        // registrations. This also covers a process that stopped during the backup loop.
        if dir.join("next").exists() || !live.exists() {
            for entry in fs::read_dir(&previous)? {
                let entry = entry?;
                let old_name = entry.file_name();
                let old_name = old_name.to_str().ok_or("invalid previous connector name")?;
                if old_name.to_lowercase() != name {
                    return Err("invalid previous connector registration".into());
                }
                real_directory(&entry.path())?;
                let destination = component(root, old_name)?;
                if fs::symlink_metadata(&destination).is_ok() {
                    return Err("connector registration changed during recovery".into());
                }
                fs::rename(entry.path(), destination)?;
            }
        }
    }
    fs::remove_dir_all(dir)?;
    Ok(())
}

fn install(request: Install) -> Result<Vec<String>> {
    let root = real_directory(&request.root)?;
    let source = real_directory(&request.source_path)?;
    if !same_path(&request.root, &root)
        || !request.source_path.is_absolute()
        || request.directory != request.id.to_lowercase()
        || request
            .source_path
            .file_name()
            .and_then(|value| value.to_str())
            != Some(&request.id)
    {
        return Err(unsupported(
            "connector package id requires host verification",
        ));
    }
    let skills = source_skills(&source, &request.directory)?;
    let mut names = Vec::new();
    let mut unique = HashSet::new();
    let owner = format!("connector:{}", request.id);
    for (name, _) in skills.iter().flatten() {
        if !unique.insert(name) || has_legacy_skill(&request.legacy_skills_root, name, &owner)? {
            return Err(unsupported(
                "connector installation requires legacy skill handling",
            ));
        }
        names.push(name.clone());
    }

    publish_package(&root, &request.directory, true, |stage| {
        if let Some(skills) = skills {
            let stage_skills = stage.join("skills");
            fs::create_dir(&stage_skills)?;
            for (name, source) in skills {
                copy_tree(&source, &component(&stage_skills, &name)?)?;
            }
        }
        let mut meta = File::create(stage.join("meta.json"))?;
        meta.write_all(&serde_json::to_vec_pretty(&json!({
            "id": request.id, "name": request.name, "sourcePath": request.source_path,
            "installedAt": request.installed_at, "installedSkillNames": names, "enabled": true,
        }))?)?;
        meta.sync_all()?;
        Ok(())
    })?;
    Ok(names)
}

pub(crate) fn publish_package(
    root: &Path,
    directory: &str,
    replace_case_variants: bool,
    prepare: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let live = component(root, directory)?;
    let journals = journal_root(root)?;
    fs::create_dir_all(&journals)?;
    real_directory(&journals)?;
    let transaction = component(&journals, directory)?;
    if transaction.exists() {
        recover_transaction(root, &transaction, directory).map_err(|error| {
            format!("could not recover previous connector installation: {error}")
        })?;
    }
    fs::create_dir(&transaction)?;
    let result: Result<()> = (|| {
        let stage = transaction.join("next");
        let previous = transaction.join("previous");
        fs::create_dir(&stage)?;
        fs::create_dir(&previous)?;
        prepare(&stage)?;

        let existing = if replace_case_variants {
            directories(root)?
                .into_iter()
                .filter(|(name, _)| name.to_lowercase() == directory)
                .collect::<Vec<_>>()
        } else {
            match fs::symlink_metadata(&live) {
                Ok(_) => vec![(directory.to_owned(), live.clone())],
                Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
                Err(error) => return Err(error.into()),
            }
        };
        for (_, path) in &existing {
            real_directory(path)?;
        }
        for (name, path) in existing {
            fs::rename(path, component(&previous, &name)?)?;
        }
        fs::rename(stage, live)?;
        Ok(())
    })();
    let cleanup = recover_transaction(root, &transaction, directory);
    let _ = fs::remove_dir(&journals);
    if result.is_ok() {
        // Even if a backup is locked, the new installation is already published.
        return Ok(());
    }
    cleanup
        .map_err(|error| format!("could not restore previous connector installation: {error}"))?;
    result
}

pub fn install_reply(request: Install) -> Reply {
    match install(request) {
        Ok(names) => Reply::Installed { names },
        Err(error) if is_unsupported(error.as_ref()) => Reply::NeedsHost,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

pub fn recover(root: &Path) -> Reply {
    let result = (|| -> Result<Vec<String>> {
        let root = real_directory(root)?;
        let journals = real_directory(&journal_root(&root)?)?;
        let mut warnings = Vec::new();
        for (name, dir) in directories(&journals)? {
            if let Err(error) =
                component(&root, &name).and_then(|_| recover_transaction(&root, &dir, &name))
            {
                warnings.push(format!("{name}: {error}"));
            }
        }
        let _ = fs::remove_dir(&journals);
        Ok(warnings)
    })();
    match result {
        Ok(warnings) => Reply::Recovered { warnings },
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

fn registrations(root: &Path) -> Result<HashMap<String, PathBuf>> {
    let mut installed = HashMap::new();
    for (name, path) in directories(root)? {
        installed.entry(name.to_lowercase()).or_insert(path);
    }
    Ok(installed)
}

fn connector_owner(source: &str) -> Option<String> {
    let id = source.strip_prefix("connector:")?.trim();
    if id.is_empty() || id.contains(['/', '\\', '\0']) || matches!(id, "." | "..") {
        return None;
    }
    Some(id.to_lowercase())
}

fn move_legacy_skill(reg_dir: &Path, name: &str, dir: &Path) -> Result<bool> {
    let reg_dir = real_directory(reg_dir)?;
    let dest_root = reg_dir.join("skills");
    match fs::create_dir(&dest_root) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let dest_root = real_directory(&dest_root)?;
    let target = component(&dest_root, name)?;
    for entry in fs::read_dir(&dest_root)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().to_lowercase() == name {
            // An already installed private skill wins. A file or link is not a valid replacement.
            real_directory(&entry.path())?;
            fs::remove_dir_all(dir)?;
            return Ok(false);
        }
    }
    match fs::rename(dir, &target) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::CrossesDevices => {
            // The stage is outside the active skills tree. Publish only a complete copy.
            let stage = reg_dir.join(".mybuddy-legacy-skill-stage");
            if stage.exists() {
                real_directory(&stage)?;
                fs::remove_dir_all(&stage)?;
            }
            fs::create_dir(&stage)?;
            let copy = stage.join("skill");
            let result =
                copy_tree(dir, &copy).and_then(|()| fs::rename(&copy, &target).map_err(Into::into));
            let _ = fs::remove_dir_all(&stage);
            result?;
            fs::remove_dir_all(dir)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(true)
}

fn finish_uninstall(
    ticket: &Path,
    skills_root: &Path,
    id: &str,
    cleanup_legacy: bool,
) -> Result<()> {
    real_directory(ticket)?;
    let retired = ticket.join("retired");
    if cleanup_legacy && retired.exists() {
        real_directory(&retired)?;
        if let Some(names) = json_file(&retired.join("meta.json"))
            .and_then(|meta| meta.get("installedSkillNames")?.as_array().cloned())
        {
            for name in names.iter().filter_map(Value::as_str) {
                let Ok(dir) = component(skills_root, name) else {
                    continue;
                };
                if real_directory(&dir).is_err() {
                    continue;
                }
                let owns_skill = skill_source(&dir)
                    .as_deref()
                    .and_then(connector_owner)
                    .as_deref()
                    == Some(id);
                if owns_skill {
                    fs::remove_dir_all(dir)?;
                }
            }
        }
    }
    fs::remove_dir_all(ticket)?;
    Ok(())
}

fn recover_retired(
    root: &Path,
    skills_root: &Path,
    installed: &HashMap<String, PathBuf>,
    warnings: &mut Vec<String>,
) -> Result<()> {
    let retired = sibling(root, RETIRED_DIRECTORY)?;
    if !retired.exists() {
        return Ok(());
    }
    let retired = real_directory(&retired)?;
    for (id, ticket) in directories(&retired)? {
        if let Err(error) = component(root, &id)
            .and_then(|_| finish_uninstall(&ticket, skills_root, &id, !installed.contains_key(&id)))
        {
            warnings.push(format!("{id}: {error}"));
        }
    }
    let _ = fs::remove_dir(&retired);
    Ok(())
}

fn maintain(root: &Path, skills_root: &Path) -> Result<Reply> {
    let root = real_directory(root)?;
    let skills_root = real_directory(skills_root)?;
    let installed = registrations(&root)?;
    let mut warnings = Vec::new();
    recover_retired(&root, &skills_root, &installed, &mut warnings)?;
    let (mut migrated, mut removed, mut skipped) = (0, 0, 0);
    if !installed.is_empty() {
        for (name, dir) in directories(&skills_root)? {
            if real_directory(&dir).is_err() {
                continue;
            }
            let Some(source) = skill_source(&dir).filter(|source| source.starts_with("connector:"))
            else {
                continue;
            };
            let Some(id) = connector_owner(&source) else {
                skipped += 1;
                continue;
            };
            let Some(registration) = installed.get(&id) else {
                continue;
            };
            match move_legacy_skill(registration, &name.to_lowercase(), &dir) {
                Ok(true) => migrated += 1,
                Ok(false) => removed += 1,
                Err(error) => {
                    skipped += 1;
                    warnings.push(format!("{name}: {error}"));
                }
            }
        }
    }
    Ok(Reply::Maintained {
        migrated,
        removed,
        skipped,
        warnings,
    })
}

pub(crate) fn uninstall(root: &Path, skills_root: &Path, id: &str) -> Result<Reply> {
    let id = id.trim().to_lowercase();
    if id.is_empty() || id.contains(['/', '\\', '\0']) || matches!(id.as_str(), "." | "..") {
        return Ok(Reply::Missing);
    }
    let root = real_directory(root)?;
    let skills_root = real_directory(skills_root)?;
    let Some(reg_dir) = registrations(&root)?.remove(&id) else {
        return Ok(Reply::Missing);
    };
    real_directory(&reg_dir)
        .map_err(|error| format!("could not verify connector registration: {error}"))?;

    let retired = sibling(&root, RETIRED_DIRECTORY)?;
    fs::create_dir_all(&retired)?;
    let retired = real_directory(&retired)?;
    let ticket = component(&retired, &id)?;
    if ticket.exists() {
        finish_uninstall(&ticket, &skills_root, &id, true)
            .map_err(|error| format!("could not finish previous connector uninstall: {error}"))?;
    }
    fs::create_dir(&ticket)?;
    if let Err(error) = fs::rename(reg_dir, ticket.join("retired")) {
        let _ = fs::remove_dir(&ticket);
        return Err(error.into());
    }
    // The registration is already gone. Leave the ticket so startup can retry a locked cleanup.
    let warning = finish_uninstall(&ticket, &skills_root, &id, true)
        .err()
        .map(|error| error.to_string());
    let _ = fs::remove_dir(&retired);
    Ok(Reply::Uninstalled { warning })
}

pub fn maintain_reply(request: Maintenance) -> Reply {
    let result = match request {
        Maintenance::Startup {
            root,
            legacy_skills_root,
        } => maintain(&root, &legacy_skills_root),
        Maintenance::Uninstall {
            root,
            legacy_skills_root,
            id,
        } => uninstall(&root, &legacy_skills_root, &id),
    };
    match result {
        Ok(reply) => reply,
        Err(error) if is_unsupported(error.as_ref()) => Reply::NeedsHost,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}
