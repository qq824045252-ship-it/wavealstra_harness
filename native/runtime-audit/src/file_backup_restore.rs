use crate::file_backup_list::{self, Backup, Lookup};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    root: PathBuf,
    task_id: String,
    backup_id: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Restored { backup: Backup },
    Rejected { message: String },
    NeedsHost,
}

pub fn restore(
    Request {
        root,
        task_id,
        backup_id,
    }: Request,
) -> Reply {
    if !root.is_absolute() {
        return Reply::NeedsHost;
    }
    let id = backup_id.clone();
    let backup = match file_backup_list::lookup(&root, task_id, backup_id) {
        Lookup::Found(backup) => backup,
        Lookup::Missing => return rejected(format!("备份不存在: {id}")),
        Lookup::NeedsHost => return Reply::NeedsHost,
    };
    let target = Path::new(&backup.abs_path);
    if backup.is_dir || !target.is_absolute() || !has_terminal_name(target, &backup.abs_path) {
        return Reply::NeedsHost;
    }

    let source_info = match fs::symlink_metadata(&backup.backup_path) {
        Ok(info) if info.is_file() => info,
        Ok(info) if info.file_type().is_symlink() => return Reply::NeedsHost,
        Ok(_) => {
            return rejected(format!(
                "备份不是普通文件: {}",
                backup.backup_path.display()
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return rejected(format!("备份文件缺失: {}", backup.backup_path.display()));
        }
        Err(error) => return rejected(error.to_string()),
    };
    match fs::symlink_metadata(target) {
        Ok(info) if info.file_type().is_symlink() => return Reply::NeedsHost,
        Ok(info) if info.is_file() => {
            // Renaming a staged file changes only this name. Let the existing
            // in-place copy handle targets whose other names must also change.
            if has_multiple_links(target, &info).unwrap_or(true) {
                return Reply::NeedsHost;
            }
            match same_file::is_same_file(&backup.backup_path, target) {
                Ok(true) => return Reply::Restored { backup },
                Ok(false) => {}
                Err(error) => return rejected(error.to_string()),
            }
            // Atomic replace also needs the copy's pre-existing permission on
            // the target file itself, even when its directory permits renames.
            if let Err(error) = OpenOptions::new().write(true).open(target) {
                return rejected(error.to_string());
            }
        }
        Ok(_) => return rejected(format!("无法还原到非文件路径: {}", target.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return rejected(error.to_string()),
    }

    let result = publish_file(&backup.backup_path, target, source_info.permissions());
    match result {
        Ok(()) => Reply::Restored { backup },
        Err(error) => rejected(format!("无法还原文件 {}: {error}", target.display())),
    }
}

fn rejected(message: String) -> Reply {
    Reply::Rejected { message }
}

fn has_terminal_name(target: &Path, spelling: &str) -> bool {
    target.file_name().is_some()
        && !spelling.ends_with('/')
        && !(cfg!(windows) && spelling.ends_with('\\'))
}

fn publish_file(source: &Path, target: &Path, permissions: fs::Permissions) -> io::Result<()> {
    static TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let mut source = File::open(source)?;
    let parent = target.parent().expect("absolute target has a parent");
    fs::create_dir_all(parent)?;
    let name = format!(
        ".mybuddy-backup-restore-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let temporary = parent.join(name);
    let mut staged = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let written = io::copy(&mut source, &mut staged)
        .and_then(|_| staged.set_permissions(permissions))
        .and_then(|_| staged.sync_all());
    drop(staged);
    let published = written.and_then(|()| fs::rename(&temporary, target));
    if published.is_err() {
        #[cfg(windows)]
        if let Ok(metadata) = fs::metadata(&temporary) {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                let _ = fs::set_permissions(&temporary, permissions);
            }
        }
        let _ = fs::remove_file(&temporary);
    }
    published
}

#[cfg(unix)]
fn has_multiple_links(_: &Path, metadata: &fs::Metadata) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(metadata.nlink() > 1)
}

#[cfg(windows)]
fn has_multiple_links(path: &Path, _: &fs::Metadata) -> io::Result<bool> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        GetFileInformationByHandle,
    };
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // The live handle and initialized structure are kept until the query returns.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks > 1)
}
