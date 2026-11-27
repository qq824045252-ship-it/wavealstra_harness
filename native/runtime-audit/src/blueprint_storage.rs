use crate::{
    Result,
    gadget_files::{
        InputFile, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, checked_directory,
        decode_source_files, gadget_path, remove_orphan, valid_windows_component,
    },
    gadget_materialize::{materialize_gadget, write_new},
    library_text::is_link,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use duckdb::{Connection};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

const MARKER: &str = ".mybuddy-blueprint-stage";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    workspace_instances_root: PathBuf,
    seeds: Vec<Seed>,
    gadgets: Vec<GeneratedGadget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Seed {
    workspace_id: String,
    path: String,
    base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedGadget {
    id: String,
    root: PathBuf,
    manifest: String,
    entry: String,
    backend_entry: Option<String>,
    files: Vec<InputFile>,
}

#[derive(Default)]
pub struct Directories(Vec<PathBuf>);

impl Directories {
    fn reserve(&mut self, target: PathBuf, operation_id: &str) -> Result<()> {
        match fs::create_dir(&target) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                checked_directory(
                    &target,
                    target.parent().ok_or("Blueprint 目录无效")?,
                    "Blueprint",
                )?;
                let marker = target.join(MARKER);
                let metadata = fs::symlink_metadata(&marker)?;
                if !metadata.is_file()
                    || is_link(&metadata)
                    || metadata.len() != operation_id.len() as u64
                    || fs::read(&marker)? != operation_id.as_bytes()
                {
                    return Err("Blueprint 实例目录已存在".into());
                }
                fs::remove_dir_all(&target)?;
                fs::create_dir(&target)?;
            }
            Err(error) => return Err(error.into()),
        }
        self.0.push(target.clone());
        write_new(&target.join(MARKER), operation_id.as_bytes())
    }

    pub fn finalize(self) {
        for directory in self.0 {
            let _ = fs::remove_file(directory.join(MARKER));
        }
    }

    pub fn discard(self) {
        for directory in self.0.into_iter().rev() {
            if let Err(error) = fs::remove_dir_all(&directory) {
                eprintln!("[Blueprint] instance directory cleanup deferred: {error}");
            }
        }
    }
}

impl Storage {
    pub fn materialize(
        self,
        operation_id: &str,
        workspaces: &[(String, PathBuf)],
        gadget_ids: &HashSet<String>,
        directories: &mut Directories,
    ) -> Result<()> {
        let supplied_ids: HashSet<_> = self
            .gadgets
            .iter()
            .map(|gadget| gadget.id.clone())
            .collect();
        if &supplied_ids != gadget_ids || supplied_ids.len() != self.gadgets.len() {
            return Err("Blueprint Gadget 文件计划不完整".into());
        }
        if let Some((_, first_path)) = workspaces.first() {
            let managed = &self.workspace_instances_root;
            let folder = first_path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or("Blueprint 实例目录无效")?;
            if !is_instance(folder)
                || !managed.is_absolute()
                || first_path.parent() != Some(managed)
            {
                return Err("Blueprint 实例目录越界".into());
            }
            let instance = fs::canonicalize(managed)?.join(folder);
            directories.reserve(instance.clone(), operation_id)?;
            let mut locations = HashMap::new();
            for (id, path) in workspaces {
                let relative = path.strip_prefix(first_path)?;
                let location = create_subdirectories(&instance, relative)?;
                locations.insert(id.as_str(), location);
            }
            write_seeds(&instance, &locations, self.seeds)?;
        } else if !self.seeds.is_empty() {
            return Err("Blueprint 缺少 seed 文件的工作空间".into());
        }
        for gadget in self.gadgets {
            let target = gadget_path(&gadget.root, &gadget.id)?;
            let files = decode_source_files(gadget.files)?;
            directories.reserve(target.clone(), operation_id)?;
            materialize_gadget(
                &target,
                &files,
                &gadget.manifest,
                &gadget.entry,
                gadget.backend_entry.as_deref(),
            )?;
        }
        Ok(())
    }
}

fn write_seeds(root: &Path, locations: &HashMap<&str, PathBuf>, seeds: Vec<Seed>) -> Result<()> {
    if seeds.len() > MAX_FILES {
        return Err("Blueprint seed 文件数量超过限制".into());
    }
    let mut total = 0;
    for seed in seeds {
        let workspace = locations
            .get(seed.workspace_id.as_str())
            .ok_or("Blueprint seed 工作空间不存在")?;
        validate_seed_path(&seed.path)?;
        if seed.base64.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
            return Err("Blueprint seed 文件超过大小限制".into());
        }
        let bytes = STANDARD.decode(seed.base64)?;
        total += bytes.len();
        if bytes.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
            return Err("Blueprint seed 文件超过大小限制".into());
        }
        let target = workspace.join(&seed.path);
        let relative_parent = target
            .parent()
            .ok_or("Blueprint seed 路径无效")?
            .strip_prefix(root)?;
        create_subdirectories(root, relative_parent)?;
        if let Err(error) = write_new(&target, &bytes) {
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::AlreadyExists)
            {
                return Err(format!("Blueprint seed 文件已存在，拒绝覆盖：{}", seed.path).into());
            }
            return Err(error);
        }
    }
    Ok(())
}

fn validate_seed_path(path: &str) -> Result<()> {
    for part in path.split('/') {
        if part.is_empty()
            || matches!(
                part,
                "." | ".."
                    | "node_modules"
                    | "cache"
                    | ".cache"
                    | ".next"
                    | "dist"
                    | "build"
                    | ".mybuddy-task.json"
                    | MARKER
            )
            || part.contains(['\\', '\0'])
            || (cfg!(windows) && !valid_windows_component(part))
        {
            return Err(format!("Blueprint seed 文件路径无效：{path}").into());
        }
    }
    Ok(())
}

fn create_subdirectories(root: &Path, relative: &Path) -> Result<PathBuf> {
    let mut location = root.to_owned();
    for part in relative.components() {
        let Component::Normal(part) = part else {
            return Err("Blueprint 工作空间目录越界".into());
        };
        if cfg!(windows) && !part.to_str().is_some_and(valid_windows_component) {
            return Err(
                format!("Blueprint 工作空间目录名称无效：{}", part.to_string_lossy()).into(),
            );
        }
        location.push(part);
        match fs::create_dir(&location) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
        location = checked_directory(&location, root, "Blueprint")?;
    }
    Ok(location)
}

pub fn reconcile(db: &mut Connection, path: &Path) -> Result<Vec<String>> {
    if !path.is_absolute() {
        return Err("Blueprint 工作空间目录必须是绝对路径".into());
    }
    let root = fs::canonicalize(path)?;
    let tx = db.transaction()?;
    let paths = {
        let mut query =
            tx.prepare("SELECT path FROM spaces WHERE path IS NOT NULL AND path <> ''")?;
        query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<duckdb::Result<Vec<_>>>()?
    };
    let registered: HashSet<_> = paths.iter().map(|path| path_key(Path::new(path))).collect();
    let mut real_paths = None;
    let mut failures = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_instance(name) {
            continue;
        }
        let target = entry.path();
        if registered.contains(&path_key(&path.join(name)))
            || registered.contains(&path_key(&target))
        {
            if let Err(error) = cleanup_committed_marker(&tx, &target) {
                failures.push(format!("{name}: {error}"));
            }
            continue;
        }
        let real_paths = real_paths.get_or_insert_with(|| {
            paths
                .iter()
                .filter_map(|path| fs::canonicalize(path).ok())
                .map(|path| path_key(&path))
                .collect::<HashSet<_>>()
        });
        if real_paths.contains(&path_key(&target)) {
            if let Err(error) = cleanup_committed_marker(&tx, &target) {
                failures.push(format!("{name}: {error}"));
            }
            continue;
        }
        if let Err(error) =
            fs::symlink_metadata(&target).and_then(|metadata| remove_orphan(&target, &metadata))
        {
            failures.push(format!("{name}: {error}"));
        }
    }
    Ok(failures)
}

pub(crate) fn cleanup_committed_marker(db: &Connection, directory: &Path) -> Result<()> {
    let directory_meta = fs::symlink_metadata(directory)?;
    if !directory_meta.is_dir() || is_link(&directory_meta) {
        return Ok(());
    }
    let marker = directory.join(MARKER);
    let metadata = match fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || is_link(&metadata) || metadata.len() != 36 {
        return Ok(());
    }
    let operation_id = fs::read_to_string(&marker)?;
    if is_instance(&format!("bp-{operation_id}"))
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM blueprint_instance_receipts WHERE operation_id=?1)",
            [&operation_id],
            |row| row.get::<_, bool>(0),
        )?
    {
        fs::remove_file(marker)?;
    }
    Ok(())
}

fn is_instance(name: &str) -> bool {
    name.get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bp-"))
        && name.len() == 39
        && name[3..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy().to_lowercase();
    #[cfg(windows)]
    {
        let key = key.replace('/', "\\");
        if let Some(unc) = key.strip_prefix(r"\\?\unc\") {
            return format!("\\\\{unc}");
        }
        if let Some(drive) = key.strip_prefix(r"\\?\") {
            return drive.to_owned();
        }
        return key;
    }
    #[cfg(not(windows))]
    key
}
