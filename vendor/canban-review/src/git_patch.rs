// Copyright Canban contributors. Licensed under Apache-2.0.
// Extracted from crates/workspaces/src/compare.rs::split_unified_patch at
// https://github.com/jjyr/canban/tree/390c057335c82f3973c22ecec6b2f4905e81fe82
use serde_json::{Value, json};

#[derive(Default)]
struct ParsedFile {
    filename: String,
    status: String,
    additions: usize,
    deletions: usize,
    patch: String,
    in_hunk: bool,
}


pub fn split_unified_patch(raw: &str) -> (Vec<Value>, usize, usize) {
    let mut files: Vec<ParsedFile> = Vec::new();
    let mut current: Option<ParsedFile> = None;

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(prev) = current.take()
                && !prev.filename.is_empty()
            {
                files.push(prev);
            }
            let filename = parse_diff_git_header(rest);
            current = Some(ParsedFile {
                filename,
                status: "modified".into(),
                ..Default::default()
            });
            continue;
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        // Unified hunk lines beginning with +++ or --- are source text, not path headers.
        if line.starts_with("@@") || file.in_hunk {
            file.in_hunk = true;
            if !file.patch.is_empty() {
                file.patch.push('\n');
            }
            file.patch.push_str(line);
            if line.starts_with('+') {
                file.additions += 1;
            } else if line.starts_with('-') {
                file.deletions += 1;
            }
            continue;
        }
        if line.starts_with("new file mode ") {
            file.status = "added".into();
            continue;
        }
        if line.starts_with("deleted file mode ") {
            file.status = "removed".into();
            continue;
        }
        if line.starts_with("rename from ") {
            file.status = "renamed".into();
            continue;
        }
        if let Some(to) = line.strip_prefix("rename to ") {
            file.status = "renamed".into();
            file.filename = unquote_git_path(to.trim());
            continue;
        }
        if let Some(plus) = line.strip_prefix("+++ ") {
            let clean = plus.trim();
            if clean != "/dev/null" {
                let name = unquote_git_path(clean);
                let name = name.strip_prefix("b/").unwrap_or(&name).to_owned();
                if !name.is_empty() {
                    file.filename = name;
                }
            }
            continue;
        }
        if let Some(minus) = line.strip_prefix("--- ") {
            let clean = minus.trim();
            if clean == "/dev/null" && file.status == "modified" {
                file.status = "added".into();
            } else if file.filename.is_empty() && clean != "/dev/null" {
                let name = unquote_git_path(clean);
                file.filename = name.strip_prefix("a/").unwrap_or(&name).to_owned();
            }
            continue;
        }
        if line.starts_with("index ")
            || line.starts_with("similarity index ")
            || line.starts_with("dissimilarity index ")
            || line.starts_with("old mode ")
            || line.starts_with("new mode ")
        {
            continue;
        }
        if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            if file.patch.is_empty() {
                file.patch.push_str(line);
            }
            continue;
        }
    }
    if let Some(prev) = current.take()
        && !prev.filename.is_empty()
    {
        files.push(prev);
    }

    let mut total_add = 0usize;
    let mut total_del = 0usize;
    let out = files
        .into_iter()
        .map(|f| {
            total_add += f.additions;
            total_del += f.deletions;
            json!({
                "filename": f.filename,
                "status": f.status,
                "additions": f.additions,
                "deletions": f.deletions,
                "patch": f.patch,
            })
        })
        .collect();
    (out, total_add, total_del)
}

fn parse_diff_git_header(rest: &str) -> String {
    let trimmed = rest.trim();
    if let Some((_, right)) = trimmed.rsplit_once(" b/") {
        return unquote_git_path(right);
    }
    if let Some(part) = trimmed.split_whitespace().last() {
        let clean = unquote_git_path(part);
        return clean.strip_prefix("b/").unwrap_or(&clean).to_owned();
    }
    trimmed.to_owned()
}

fn unquote_git_path(path: &str) -> String {
    let s = path.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\t", "\t")
            .replace("\\n", "\n")
    } else {
        s.to_owned()
    }
}
