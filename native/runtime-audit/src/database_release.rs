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
    #[serde(default)]
    pub sqlite_cutover_recorded: bool,
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
        stamp.is_some_and(|stamp| stamp.release_version == self.version && stamp.sqlite_cutover_recorded)
    }

    pub fn verify_current_database(&self, required: bool) -> Result<()> {
        self.verify_root()?;
        let path = self.root.join("app.duckdb");
        let usable = regular_metadata(&path)?.is_some_and(|meta| meta.len() != 0);
        if !usable {
            return if required {
                Err("Previously initialized MyBuddy DuckDB is missing or empty; refusing to replace it".into())
            } else {
                Ok(())
            };
        }
        let mut header = [0; 12];
        File::open(path)?.read_exact(&mut header)?;
        if &header[8..12] != b"DUCK" {
            return Err("Current-release database does not use DuckDB".into());
        }
        Ok(())
    }

    /// Only open a positively identified DuckDB. A pre-cutover SQLite file can
    /// occupy the same path and is validated separately before cleanup.
    pub fn has_cutover_receipt(&self) -> Result<bool> {
        use duckdb::{AccessMode, Config, Connection};
        let path = self.root.join("app.duckdb");
        if !regular_metadata(&path)?.is_some_and(|m| m.len() >= 12) {
            return Ok(false);
        }
        let mut header = [0; 12];
        File::open(&path)?.read_exact(&mut header)?;
        if &header[8..] != b"DUCK" {
            return Ok(false);
        }
        let conn = Connection::open_with_flags(path, Config::default().access_mode(AccessMode::ReadOnly)?)?;
        if !crate::database::table_exists(&conn, "packaged_sqlite_cutover")? {
            return Ok(false);
        }
        Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM packaged_sqlite_cutover c JOIN database_meta d ON d.database_generation=c.database_generation WHERE d.id=1)", [], |r| r.get(0))?)
    }

    pub fn remove_legacy_sqlite_databases(&self) -> Result<Vec<String>> {
        self.verify_root()?;
        writable_file(&self.root.join(STAMP))?;
        writable_file(&self.root.join(STAGED_STAMP))?;
        let mut files = Vec::new();
        for base in [
            "app.db",
            "native-hooks.sqlite",
            "native-improvement.sqlite",
            ".mybuddy-writer-lock.sqlite",
        ] {
            collect_database(&self.root, base, &mut files)?;
        }
        // A pre-cutover installation can use the canonical filename for SQLite.
        // Prove that format before collecting it or any SQLite-style companions.
        // DuckDB's .wal and .tmp are never cleanup targets.
        let canonical = self.root.join("app.duckdb");
        let size = regular_metadata(&canonical)?.map_or(0, |meta| meta.len());
        let mut magic = [0; 16];
        if size >= magic.len() as u64 {
            File::open(&canonical)?.read_exact(&mut magic)?;
        }
        let legacy_canonical = &magic == b"SQLite format 3\0";
        if size == 0 || legacy_canonical {
            if metadata(&self.root.join("app.duckdb.wal"))?.is_some()
                || metadata(&self.root.join("app.duckdb.tmp"))?.is_some()
            {
                return Err("Cannot create DuckDB while its recovery files remain without a valid database".into());
            }
        }
        if legacy_canonical {
            collect_database(&self.root, "app.duckdb", &mut files)?;
        } else {
            self.verify_current_database(false)?;
        }
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

        let mut deleted = Vec::with_capacity(files.len());
        for (identity, path) in files {
            verify_directory(path.parent().ok_or("Missing reset file parent")?)?;
            if regular_metadata(&path)?.is_none() || Handle::from_path(&path)? != identity {
                return Err(format!("Reset file changed: {}", path.display()).into());
            }
            fs::remove_file(&path)?;
            drop(identity);
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
            sqlite_cutover_recorded: true,
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
            if !sqlite {
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
            collect_database(&store, base, files)?;
        }
    }
    Ok(())
}
