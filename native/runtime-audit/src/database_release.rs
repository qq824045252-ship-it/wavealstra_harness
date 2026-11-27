use crate::Result;
use same_file::Handle;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs::{self, File, Metadata, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

const STAMP: &str = "database-release.json";
const STAGED_STAMP: &str = ".database-release.json.pending";
const SQLITE_SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];
const GATEWAY_CHANNELS: [&str; 9] = [
    "qq-default",
    "weixin-default",
    "telegram-default",
    "dingtalk-default",
    "discord-default",
    "feishu-default",
    "wecom-default",
    "wechat-default",
    "slack-default",
];

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Stamp {
    pub release_version: String,
    pub database_generation: String,
}

pub(super) struct DatabaseRelease {
    pub root: PathBuf,
    version: String,
    identity: Handle,
}

impl DatabaseRelease {
    pub fn verify(data_dir: &Path, db_path: &Path, release_version: &str) -> Result<Self> {
        if !valid_version(release_version)
            || data_dir.file_name() != Some(OsStr::new(".mybuddy"))
            || db_path.file_name() != Some(OsStr::new("app.duckdb"))
        {
            return Err(
                "Release reset requires a MyBuddy data directory, app.duckdb and a release version"
                    .into(),
            );
        }
        verify_directory(data_dir)?;
        let parent = db_path.parent().ok_or("Missing database directory")?;
        verify_directory(parent)?;
        let root = data_dir.canonicalize()?;
        if parent.canonicalize()? != root {
            return Err("Release reset database must be within the MyBuddy data directory".into());
        }
        for name in [
            "core.lock",
            "core-worker.lock",
            "core.lease",
            "app.duckdb",
            "app.duckdb.wal",
            "app.duckdb-wal",
            "app.duckdb-shm",
            "app.duckdb-journal",
        ] {
            regular_metadata(&root.join(name))?;
        }
        let spill = root.join("app.duckdb.tmp");
        if let Some(meta) = metadata(&spill)? {
            reject_link(&spill, &meta)?;
        }
        Ok(Self {
            identity: Handle::from_path(&root)?,
            root,
            version: release_version.into(),
        })
    }

    pub fn read_stamp(&self) -> Result<Option<Stamp>> {
        self.verify_root()?;
        let path = self.root.join(STAMP);
        let Some(meta) = regular_metadata(&path)? else {
            return Ok(None);
        };
        if meta.len() > 4096 {
            return Err("MyBuddy database release stamp is too large".into());
        }
        let stamp: Stamp = serde_json::from_reader(File::open(path)?)?;
        if !valid_version(&stamp.release_version) || stamp.database_generation.trim().is_empty() {
            return Err("Invalid MyBuddy database release stamp".into());
        }
        Ok(Some(stamp))
    }

    pub fn matches(&self, stamp: Option<&Stamp>) -> bool {
        stamp.is_some_and(|stamp| stamp.release_version == self.version)
    }

    pub fn verify_current_database(&self) -> Result<()> {
        self.verify_root()?;
        let path = self.root.join("app.duckdb");
        let Some(meta) = regular_metadata(&path)? else {
            return Ok(());
        };
        if meta.len() == 0 {
            return Ok(());
        }
        let mut header = [0; 12];
        File::open(path)?.read_exact(&mut header)?;
        if &header[8..12] != b"DUCK" {
            return Err("Current-release database does not use DuckDB".into());
        }
        Ok(())
    }

    pub fn remove_old_databases(&self) -> Result<Vec<String>> {
        self.verify_root()?;
        writable_file(&self.root.join(STAMP))?;
        writable_file(&self.root.join(STAGED_STAMP))?;
        let mut files = Vec::new();
        let mut spill = None;
        for base in [
            "app.db",
            "native-hooks.sqlite",
            "native-improvement.sqlite",
            ".mybuddy-writer-lock.sqlite",
        ] {
            collect_database(&self.root, base, false, &mut files)?;
        }
        // The canonical name may contain the old SQLite file on a pre-policy installation.
        collect_file(self.root.join("app.duckdb.wal"), &mut files)?;
        let spill_path = self.root.join("app.duckdb.tmp");
        if let Some(meta) = metadata(&spill_path)? {
            reject_link(&spill_path, &meta)?;
            if meta.is_dir() {
                for entry in fs::read_dir(&spill_path)? {
                    let entry = entry?;
                    let name = entry.file_name();
                    if !name.to_str().is_some_and(|name| {
                        name.starts_with("duckdb_temp_storage") && name.ends_with(".tmp")
                    }) {
                        return Err(format!(
                            "Unexpected file in DuckDB spill directory: {}",
                            entry.path().display()
                        )
                        .into());
                    }
                    collect_file(entry.path(), &mut files)?;
                }
                spill = Some((Handle::from_path(&spill_path)?, spill_path));
            } else {
                collect_file(spill_path, &mut files)?;
            }
        }
        collect_database(&self.root, "app.duckdb", true, &mut files)?;
        for dir in [self.root.join("durable"), self.root.join("durable-bots")] {
            collect_stores(&dir, &mut files)?;
        }
        let gateway = self.root.join("gateway");
        if optional_directory(&gateway)? {
            let spaces = gateway.join("spaces");
            if optional_directory(&spaces)? {
                for channel in GATEWAY_CHANNELS {
                    collect_stores(&spaces.join(channel), &mut files)?;
                }
            }
        }

        let mut deleted = Vec::with_capacity(files.len() + usize::from(spill.is_some()));
        for (identity, path) in files {
            verify_directory(path.parent().ok_or("Missing reset file parent")?)?;
            if regular_metadata(&path)?.is_none() || Handle::from_path(&path)? != identity {
                return Err(format!("Reset file changed: {}", path.display()).into());
            }
            fs::remove_file(&path)?;
            drop(identity);
            deleted.push(path.display().to_string());
        }
        if let Some((identity, path)) = spill {
            verify_directory(&path)?;
            if Handle::from_path(&path)? != identity {
                return Err(format!("DuckDB spill directory changed: {}", path.display()).into());
            }
            fs::remove_dir(&path)?;
            deleted.push(path.display().to_string());
        }
        Ok(deleted)
    }

    pub fn publish(&self, database_generation: String) -> Result<()> {
        self.verify_root()?;
        let target = self.root.join(STAMP);
        let staged = self.root.join(STAGED_STAMP);
        writable_file(&target)?;
        if writable_file(&staged)?.is_some() {
            fs::remove_file(&staged)?;
        }
        let stamp = Stamp {
            release_version: self.version.clone(),
            database_generation,
        };
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&staged)?;
        file.write_all(&serde_json::to_vec(&stamp)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(staged, target)?;
        #[cfg(unix)]
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    fn verify_root(&self) -> Result<()> {
        verify_directory(&self.root)?;
        if Handle::from_path(&self.root)? != self.identity {
            return Err("MyBuddy data directory changed".into());
        }
        Ok(())
    }
}

fn valid_version(version: &str) -> bool {
    (1..=128).contains(&version.len())
        && version.as_bytes()[0].is_ascii_digit()
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn metadata(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn reject_link(path: &Path, meta: &Metadata) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "Refusing a reparse point in the database reset path: {}",
                path.display()
            )
            .into());
        }
    }
    if meta.file_type().is_symlink() {
        return Err(format!(
            "Refusing a symlink in the database reset path: {}",
            path.display()
        )
        .into());
    }
    Ok(())
}

fn optional_directory(path: &Path) -> Result<bool> {
    let Some(meta) = metadata(path)? else {
        return Ok(false);
    };
    reject_link(path, &meta)?;
    if !meta.is_dir() {
        return Err(format!("Expected a MyBuddy directory: {}", path.display()).into());
    }
    Ok(true)
}

fn verify_directory(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .ancestors()
            .any(|ancestor| ancestor.as_os_str().is_empty())
    {
        return Err("Database reset directory must be absolute".into());
    }
    for ancestor in path.ancestors() {
        if !optional_directory(ancestor)? {
            return Err(format!("Missing database reset directory: {}", ancestor.display()).into());
        }
    }
    Ok(())
}

fn regular_metadata(path: &Path) -> Result<Option<Metadata>> {
    let Some(meta) = metadata(path)? else {
        return Ok(None);
    };
    reject_link(path, &meta)?;
    if !meta.is_file() {
        return Err(format!(
            "Expected a regular MyBuddy database file: {}",
            path.display()
        )
        .into());
    }
    Ok(Some(meta))
}

fn writable_file(path: &Path) -> Result<Option<File>> {
    let Some(meta) = regular_metadata(path)? else {
        return Ok(None);
    };
    if meta.permissions().readonly() {
        return Err(format!("Read-only database reset file: {}", path.display()).into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::{
            Foundation::{GENERIC_READ, GENERIC_WRITE},
            Storage::FileSystem::{
                DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
            },
        };
        options
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    reject_link(path, &file.metadata()?)?;
    Ok(Some(file))
}

fn collect_file(path: PathBuf, files: &mut Vec<(Handle, PathBuf)>) -> Result<()> {
    if let Some(file) = writable_file(&path)? {
        files.push((Handle::from_file(file)?, path));
    }
    Ok(())
}

fn collect_database(
    directory: &Path,
    base: &str,
    duckdb: bool,
    files: &mut Vec<(Handle, PathBuf)>,
) -> Result<()> {
    for suffix in SQLITE_SIDECARS {
        collect_file(directory.join(format!("{base}{suffix}")), files)?;
    }
    let path = directory.join(base);
    if let Some(mut file) = writable_file(&path)? {
        let len = file.metadata()?.len();
        if len != 0 {
            let mut header = [0; 100];
            file.read_exact(&mut header)?;
            let stored_page_size = u16::from_be_bytes([header[16], header[17]]);
            let page_size = if stored_page_size == 1 {
                65536
            } else {
                u64::from(stored_page_size)
            };
            let sqlite = header.starts_with(b"SQLite format 3\0")
                && (512..=65536).contains(&page_size)
                && page_size.is_power_of_two()
                && len >= page_size
                && len % page_size == 0
                && matches!(header[18], 1 | 2)
                && matches!(header[19], 1 | 2)
                && header[21..24] == [64, 32, 32];
            if !sqlite && !(duckdb && &header[8..12] == b"DUCK" && len >= 4096) {
                return Err(format!("Unrecognized database reset file: {}", path.display()).into());
            }
        }
        files.push((Handle::from_file(file)?, path));
    }
    Ok(())
}

fn collect_stores(directory: &Path, files: &mut Vec<(Handle, PathBuf)>) -> Result<()> {
    if !optional_directory(directory)? {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name.to_str().is_some_and(|name| {
            name.len() == 64
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            continue;
        }
        let store = entry.path();
        if !optional_directory(&store)? {
            return Err(format!(
                "MyBuddy store disappeared during reset: {}",
                store.display()
            )
            .into());
        }
        for base in ["durable.sqlite", ".mybuddy-writer-lock.sqlite"] {
            collect_database(&store, base, false, files)?;
        }
    }
    Ok(())
}
