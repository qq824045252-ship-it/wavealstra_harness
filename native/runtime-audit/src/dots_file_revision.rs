use serde::Serialize;
use std::{
    fs,
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
};

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Revision {
    Observed { value: String },
    Rejected { reason: Rejection },
    NeedsHost,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Rejection {
    RootChanged,
    ParentChanged,
    NotFile,
}

pub fn read(root: &Path, file: &Path) -> Revision {
    let Some(target) = target(root, file) else {
        return Revision::NeedsHost;
    };
    let Some(parent) = target.parent() else {
        return Revision::NeedsHost;
    };
    match checked_revision(root, parent, &target) {
        Ok(value) => value,
        Err(_) => Revision::NeedsHost,
    }
}

pub(crate) fn target(root: &Path, file: &Path) -> Option<PathBuf> {
    if !root.is_absolute()
        || file.as_os_str().is_empty()
        || file.components().any(|part| {
            !matches!(part, Component::Normal(name) if name.to_str().is_some_and(|name|
                !name.contains('\0') && (!cfg!(windows) || crate::gadget_files::valid_windows_component(name))))
        })
    {
        return None;
    }
    Some(root.join(file))
}

fn checked_revision(root: &Path, parent: &Path, target: &Path) -> io::Result<Revision> {
    if !same_path(root, &fs::canonicalize(root)?) {
        return Ok(Revision::Rejected {
            reason: Rejection::RootChanged,
        });
    }
    let physical = fs::canonicalize(parent)?;
    if !same_path(parent, &physical) {
        return Ok(Revision::Rejected {
            reason: Rejection::ParentChanged,
        });
    }
    let value = match fs::symlink_metadata(target) {
        Ok(info) if !info.is_file() => {
            return Ok(Revision::Rejected {
                reason: Rejection::NotFile,
            });
        }
        Ok(info) => fingerprint(target, info)?,
        Err(error) if error.kind() == ErrorKind::NotFound => "missing".into(),
        Err(error) => return Err(error),
    };
    if fs::canonicalize(parent)? != physical {
        return Ok(Revision::Rejected {
            reason: Rejection::ParentChanged,
        });
    }
    Ok(Revision::Observed { value })
}

#[cfg(not(windows))]
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

#[cfg(windows)]
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    fn key(path: &Path) -> String {
        let path = path.to_string_lossy().to_lowercase();
        if let Some(unc) = path.strip_prefix(r"\\?\unc\") {
            format!(r"\\{unc}")
        } else {
            path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
        }
    }
    key(a) == key(b)
}

#[cfg(unix)]
pub(crate) fn fingerprint(_: &Path, info: fs::Metadata) -> io::Result<String> {
    use std::os::unix::fs::MetadataExt;
    let ns = |seconds: i64, nanos: i64| i128::from(seconds) * 1_000_000_000 + i128::from(nanos);
    Ok(format!(
        "{}:{}:{}:{}:{}",
        info.dev(),
        info.ino(),
        info.size(),
        ns(info.mtime(), info.mtime_nsec()),
        ns(info.ctime(), info.ctime_nsec())
    ))
}

#[cfg(windows)]
pub(crate) fn fingerprint(path: &Path, _: fs::Metadata) -> io::Result<String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_BASIC_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FileBasicInfo,
        GetFileInformationByHandle, GetFileInformationByHandleEx,
    };

    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let handle = file.as_raw_handle();
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    let mut times = FILE_BASIC_INFO::default();
    // Both queries fill initialized structures through the live file handle.
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        || unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut times as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err(io::Error::new(
            ErrorKind::Unsupported,
            "file attributes require host verification",
        ));
    }
    let large = |high: u32, low: u32| (u64::from(high) << 32) | u64::from(low);
    // Match the existing libuv lstat dev:ino:size:mtimeNs:ctimeNs baseline.
    let ns = |ticks: i64| (i128::from(ticks) - 116_444_736_000_000_000) * 100;
    Ok(format!(
        "{}:{}:{}:{}:{}",
        info.dwVolumeSerialNumber,
        large(info.nFileIndexHigh, info.nFileIndexLow),
        large(info.nFileSizeHigh, info.nFileSizeLow),
        ns(times.LastWriteTime),
        ns(times.ChangeTime)
    ))
}
