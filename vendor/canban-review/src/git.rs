// Copyright Canban contributors. Licensed under Apache-2.0.
// Extracted from crates/workspaces/src/git_client.rs::Ops::status_files at
// https://github.com/jjyr/canban/tree/390c057335c82f3973c22ecec6b2f4905e81fe82
// The Electron host runs Git; this module retains the upstream status parser.
use serde_json::{Value, json};

pub fn parse_status_files(raw: &str) -> Vec<Value> {
    let raw = raw.as_bytes();
    let mut entries = Vec::new();
    let mut parts = raw.split(|&b| b == 0).filter(|s| !s.is_empty());
    while let Some(rec) = parts.next() {
        if rec.len() < 4 || rec[2] != b' ' {
            continue;
        }
        let x = rec[0] as char;
        let y = rec[1] as char;
        let path = String::from_utf8_lossy(&rec[3..]).into_owned();
        let orig_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            parts
                .next()
                .map(|orig| String::from_utf8_lossy(orig).into_owned())
        } else {
            None
        };
        if x == '!' && y == '!' {
            continue;
        }
        let untracked = x == '?' && y == '?';
        let conflicted = matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'));
        let staged = x != ' ' && x != '?' && x != '!';
        let unstaged = y != ' ' && y != '?' && y != '!';
        entries.push(json!({
            "path": path,
            "orig_path": orig_path,
            "index_code": x.to_string(),
            "worktree_code": y.to_string(),
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
            "conflicted": conflicted,
        }));
    }
    entries
}

// Extracted Git argument branches of compare.rs::Ops::git_compare (698–847).
// The host appends output options and scopes literal paths to the task checkout.
pub fn compare_git_args<'a>(
    mode: &str,
    effective_base_sha: Option<&'a str>,
    compare_sha: Option<&'a str>,
) -> Option<Vec<&'a str>> {
    match mode {
        "WORKDIR" => Some(vec![
            "diff", "--no-ext-diff", "--no-textconv", "-M", effective_base_sha?, "--",
        ]),
        "STAGED" => {
            let mut args = vec!["diff", "--cached", "--no-ext-diff", "--no-textconv", "-M"];
            // The Electron host leaves the tree implicit for an unborn SHA-1 or SHA-256 repo.
            args.extend(effective_base_sha);
            args.push("--");
            Some(args)
        }
        "UNSTAGED" => Some(vec!["diff", "--no-ext-diff", "--no-textconv", "-M", "--"]),
        "REVISION" => Some(vec![
            "diff", "--no-ext-diff", "--no-textconv", "-M", effective_base_sha?, compare_sha?, "--",
        ]),
        _ => None,
    }
}
