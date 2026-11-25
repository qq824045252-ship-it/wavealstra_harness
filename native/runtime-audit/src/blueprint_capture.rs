use crate::{
    Result,
    gadget_files::{
        MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, SourceFile, encode_file, read_at_most,
        valid_windows_component,
    },
    library_text::is_link,
};
use regex_lite::{Regex, RegexBuilder};
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Reply {
    Captured { files: Vec<SourceFile> },
    Rejected { message: String },
}

pub fn deny_pattern(source: &str) -> Result<Regex> {
    Ok(RegexBuilder::new(source).case_insensitive(true).build()?)
}

pub fn workspace(root: &Path, paths: Vec<String>, deny: &str) -> Reply {
    match capture(root, paths, deny) {
        Ok(files) => Reply::Captured { files },
        Err(error) => Reply::Rejected {
            message: error.to_string(),
        },
    }
}

fn capture(root: &Path, paths: Vec<String>, deny: &str) -> Result<Vec<SourceFile>> {
    if paths.len() > MAX_FILES {
        return Err("Blueprint 选择文件数量超过限制".into());
    }
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err("Blueprint 工作空间目录不存在".into());
    }
    let deny = deny_pattern(deny)?;
    let mut files = Vec::with_capacity(paths.len());
    let mut total = 0;
    for relative in paths {
        if relative.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || part.contains(['\\', '\0'])
                || (cfg!(windows) && !valid_windows_component(part))
                || deny.is_match(part)
        }) {
            return Err(format!("Blueprint 选择文件不在白名单：{relative}").into());
        }
        let path = root.join(&relative);
        let info = fs::symlink_metadata(&path)
            .map_err(|error| format!("Blueprint 模板文件不存在或无法读取：{relative} ({error})"))?;
        if is_link(&info) || !info.is_file() {
            return Err(format!("Blueprint 模板文件不得是符号链接或非普通文件：{relative}").into());
        }
        let real = fs::canonicalize(&path)?;
        if !real.starts_with(&root) {
            return Err(format!("Blueprint 模板文件越出 Workspace：{relative}").into());
        }
        let limit = MAX_FILE_BYTES.min(MAX_TOTAL_BYTES - total);
        if info.len() > limit as u64 {
            return Err(format!("Blueprint 模板文件超过大小限制：{relative}").into());
        }
        let bytes = read_at_most(&real, limit)?;
        if bytes.len() > limit {
            return Err(format!("Blueprint 模板文件超过大小限制：{relative}").into());
        }
        total += bytes.len();
        files.push(encode_file(relative, &bytes));
    }
    Ok(files)
}
