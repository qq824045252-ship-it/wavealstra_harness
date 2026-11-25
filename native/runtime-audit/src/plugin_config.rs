use crate::{
    Result,
    dots_file_revision::{fingerprint, same_path, target},
    library_text::is_link,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions, Permissions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

// Leave room for JSON escaping in the worker's reply size limit.
const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Skill,
    Expert,
    Connector,
    ConnectorHidden,
    SubagentSettings,
}

#[derive(Deserialize)]
pub struct Target {
    root: PathBuf,
    file: PathBuf,
    kind: Kind,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Observed {
        text: Option<String>,
        version: String,
    },
    Saved,
    Changed,
    NeedsHost,
    Failed {
        message: String,
    },
}

impl Target {
    pub(crate) fn connector_hidden(root: PathBuf) -> Self {
        Self {
            root,
            file: "market-hidden-connectors.json".into(),
            kind: Kind::ConnectorHidden,
        }
    }

    pub(crate) fn subagent_settings(root: PathBuf) -> Self {
        Self {
            root,
            file: "subagent.json".into(),
            kind: Kind::SubagentSettings,
        }
    }

    fn resolve(&self) -> Result<PathBuf> {
        let expected = match self.kind {
            Kind::Skill => "skill.md",
            Kind::Expert => "expert.json",
            Kind::Connector => "meta.json",
            Kind::ConnectorHidden => "market-hidden-connectors.json",
            Kind::SubagentSettings => "subagent.json",
        };
        if !self
            .file
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
        {
            return Err("unexpected plugin configuration filename".into());
        }
        let path = target(&self.root, &self.file)
            .ok_or("plugin configuration path is outside its root")?;
        let parent = path.parent().ok_or("plugin configuration has no parent")?;
        if !same_path(&self.root, &fs::canonicalize(&self.root)?)
            || !same_path(parent, &fs::canonicalize(parent)?)
            || is_link(&fs::symlink_metadata(parent)?)
        {
            return Err("plugin configuration parent is redirected".into());
        }
        Ok(path)
    }
}

struct Snapshot {
    text: Option<String>,
    permissions: Option<Permissions>,
    version: String,
}

fn snapshot(request: &Target, path: &Path) -> Result<Snapshot> {
    let parent = path.parent().ok_or("plugin configuration has no parent")?;
    let parent_id = directory_identity(parent)?;
    let (text, permissions, file_id) = match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() && !is_link(&info) && info.len() <= MAX_CONFIG_BYTES => {
            let file_id = fingerprint(path, info.clone())?;
            let file = File::open(path)?;
            let mut bytes = Vec::new();
            file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_CONFIG_BYTES {
                return Err("plugin configuration exceeds the worker limit".into());
            }
            let current = fs::symlink_metadata(path)?;
            if !current.is_file() || is_link(&current) || fingerprint(path, current)? != file_id {
                return Err("plugin configuration changed while reading".into());
            }
            (
                Some(String::from_utf8(bytes)?),
                Some(info.permissions()),
                file_id,
            )
        }
        Err(error)
            if error.kind() == ErrorKind::NotFound
                && matches!(
                    request.kind,
                    Kind::Connector | Kind::ConnectorHidden | Kind::SubagentSettings
                ) =>
        {
            (None, None, String::new())
        }
        _ => return Err("plugin configuration requires host verification".into()),
    };
    if request.resolve()? != path || directory_identity(parent)? != parent_id {
        return Err("plugin directory changed while reading".into());
    }
    let mut version = Sha256::new();
    version.update(parent_id.as_bytes());
    version.update([u8::from(text.is_some())]);
    version.update(file_id.as_bytes());
    if let Some(text) = &text {
        version.update(text.as_bytes());
    }
    Ok(Snapshot {
        text,
        permissions,
        version: format!("{:x}", version.finalize()),
    })
}

pub fn read(request: Target) -> Reply {
    match request.resolve().and_then(|path| snapshot(&request, &path)) {
        Ok(Snapshot { text, version, .. }) => Reply::Observed { text, version },
        Err(_) => Reply::NeedsHost,
    }
}

pub fn replace(request: Target, version: &str, text: &str) -> Reply {
    let Ok(path) = request.resolve() else {
        return Reply::Changed;
    };
    let Ok(previous) = snapshot(&request, &path) else {
        return Reply::Changed;
    };
    if previous.version != version {
        return Reply::Changed;
    }
    if previous.text.as_deref() == Some(text) {
        return Reply::Saved;
    }
    match replace_checked(&request, &path, previous, text) {
        Ok(true) => Reply::Saved,
        Ok(false) => Reply::Changed,
        Err(error) => Reply::Failed {
            message: error.to_string(),
        },
    }
}

fn replace_checked(request: &Target, path: &Path, previous: Snapshot, text: &str) -> Result<bool> {
    let parent = path.parent().ok_or("plugin configuration has no parent")?;
    let staging = parent.join(format!(
        ".mybuddy-plugin-config-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed),
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    if matches!(request.kind, Kind::SubagentSettings) {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staging)?;
    let result = (|| {
        file.write_all(text.as_bytes())?;
        if !matches!(request.kind, Kind::SubagentSettings)
            && let Some(permissions) = previous.permissions
        {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        drop(file);
        if !snapshot(request, path).is_ok_and(|current| current.version == previous.version) {
            return Ok(false);
        }
        fs::rename(&staging, path)?;
        Ok(true)
    })();
    if !matches!(result, Ok(true)) {
        let _ = fs::remove_file(staging);
    }
    result
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path)?;
    Ok(format!("{}:{}:", meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        GetFileInformationByHandle,
    };
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(format!(
        "{}:{}:{}:",
        info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
    ))
}
