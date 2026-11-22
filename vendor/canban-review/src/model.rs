// Copyright 2026 JJy <jjyruby@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Extracted from crates/ui/src/review/model.rs. MyBuddy changes are documented in SOURCE.md.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PendingInlineComment {
    pub id: String,
    pub path: String,
    pub section: String,
    pub line: u64,
    pub side: String, // "LEFT" | "RIGHT"
    pub snippet: String,
    pub body: String,
    pub author: Option<String>,
    pub edited_by_user: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GapExpansion {
    pub from_top: u64,
    pub from_bottom: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: char, // '@', '+', '-', ' ', '\\'
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u64,
    pub old_count: u64,
    pub new_start: u64,
    pub new_count: u64,
    pub context: String,
    #[serde(skip_deserializing)]
    pub lines: Vec<DiffLine>,
}

impl DiffHunk {
    pub fn entry_old(&self) -> u64 {
        if self.old_count > 0 {
            self.old_start
        } else {
            self.old_start + 1
        }
    }

    pub fn entry_new(&self) -> u64 {
        if self.new_count > 0 {
            self.new_start
        } else {
            self.new_start + 1
        }
    }

    pub fn exit_old(&self) -> u64 {
        if self.old_count > 0 {
            self.old_start + self.old_count
        } else {
            self.old_start + 1
        }
    }

    pub fn exit_new(&self) -> u64 {
        if self.new_count > 0 {
            self.new_start + self.new_count
        } else {
            self.new_start + 1
        }
    }

    pub fn ends_with_no_newline(&self) -> bool {
        self.lines.last().is_some_and(|l| l.kind == '\\')
    }

    pub fn formatted_header(&self, expanded_above: u64) -> String {
        if expanded_above == 0 {
            return self.header.clone();
        }
        let adj_old_start = self.entry_old().saturating_sub(expanded_above);
        let adj_old_count = self.old_count + expanded_above;
        let adj_new_start = self.entry_new().saturating_sub(expanded_above);
        let adj_new_count = self.new_count + expanded_above;
        if self.context.is_empty() {
            format!("@@ -{adj_old_start},{adj_old_count} +{adj_new_start},{adj_new_count} @@")
        } else {
            format!(
                "@@ -{adj_old_start},{adj_old_count} +{adj_new_start},{adj_new_count} @@ {}",
                self.context
            )
        }
    }
}

fn parse_hunk_range(spec: &str) -> (u64, u64) {
    if let Some((start, count)) = spec.split_once(',') {
        (start.parse().unwrap_or(1), count.parse().unwrap_or(1))
    } else {
        (spec.parse().unwrap_or(1), 1)
    }
}

fn parse_hunk_header(raw: &str) -> Option<(u64, u64, u64, u64, String)> {
    let after = raw.strip_prefix("@@")?;
    let (header, context) = after.split_once("@@")?;
    let mut old_start = 1u64;
    let mut old_count = 1u64;
    let mut new_start = 1u64;
    let mut new_count = 1u64;
    for part in header.split_whitespace() {
        if let Some(old_spec) = part.strip_prefix('-') {
            (old_start, old_count) = parse_hunk_range(old_spec);
        } else if let Some(new_spec) = part.strip_prefix('+') {
            (new_start, new_count) = parse_hunk_range(new_spec);
        }
    }
    Some((
        old_start,
        old_count,
        new_start,
        new_count,
        context.trim().to_owned(),
    ))
}

fn is_diff_metadata_line(raw: &str) -> bool {
    raw.starts_with("diff --git ")
        || raw.starts_with("index ")
        || raw.starts_with("--- ")
        || raw.starts_with("+++ ")
        || raw.starts_with("new file mode ")
        || raw.starts_with("deleted file mode ")
        || raw.starts_with("similarity index ")
        || raw.starts_with("rename from ")
        || raw.starts_with("rename to ")
        || raw.starts_with("old mode ")
        || raw.starts_with("new mode ")
}

pub fn parse_unified_hunks(patch: &str) -> Vec<DiffHunk> {
    let mut hunks = Vec::new();
    let mut current: Option<DiffHunk> = None;
    let mut old_ln = 0u64;
    let mut new_ln = 0u64;

    for raw in patch.lines() {
        // Lines starting with "--- " or "+++ " inside a hunk can be source
        // content beginning with "-- " or "++ ", not patch metadata.
        if is_diff_metadata_line(raw)
            && current.as_ref().is_none_or(|hunk| {
                old_ln >= hunk.old_start + hunk.old_count
                    && new_ln >= hunk.new_start + hunk.new_count
            })
        {
            continue;
        }
        if let Some((os, oc, ns, nc, ctx)) = parse_hunk_header(raw) {
            if let Some(prev) = current.take() {
                hunks.push(prev);
            }
            old_ln = os;
            new_ln = ns;
            current = Some(DiffHunk {
                header: raw.to_owned(),
                old_start: os,
                old_count: oc,
                new_start: ns,
                new_count: nc,
                context: ctx,
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = current.as_mut() else {
            continue;
        };
        if raw.starts_with('\\') {
            hunk.lines.push(DiffLine {
                kind: '\\',
                old_line: None,
                new_line: None,
                text: raw.to_owned(),
            });
        } else if let Some(added) = raw.strip_prefix('+') {
            let ln = new_ln.max(1);
            hunk.lines.push(DiffLine {
                kind: '+',
                old_line: None,
                new_line: Some(ln),
                text: added.to_owned(),
            });
            new_ln = ln + 1;
        } else if let Some(removed) = raw.strip_prefix('-') {
            let ln = old_ln.max(1);
            hunk.lines.push(DiffLine {
                kind: '-',
                old_line: Some(ln),
                new_line: None,
                text: removed.to_owned(),
            });
            old_ln = ln + 1;
        } else {
            let content = raw.strip_prefix(' ').unwrap_or(raw);
            let o = old_ln.max(1);
            let n = new_ln.max(1);
            hunk.lines.push(DiffLine {
                kind: ' ',
                old_line: Some(o),
                new_line: Some(n),
                text: content.to_owned(),
            });
            old_ln = o + 1;
            new_ln = n + 1;
        }
    }
    if let Some(prev) = current.take() {
        hunks.push(prev);
    }
    hunks
}

pub fn format_pending_markdown(
    context_label: &str,
    summary: &str,
    comments: &[PendingInlineComment],
) -> String {
    let mut out = format!("### Code Review ({context_label})\n");
    if !summary.trim().is_empty() {
        out.push('\n');
        out.push_str(summary.trim());
        out.push('\n');
    }
    if !comments.is_empty() {
        out.push_str("\n#### Inline Comments\n");
        for (idx, item) in comments.iter().enumerate() {
            let side_note = if item.side == "LEFT" { " (old)" } else { "" };
            let source_note = if item.section.is_empty() {
                String::new()
            } else {
                format!(" ({})", item.section)
            };
            out.push_str(&format!(
                "\n{}. **`{}:{}`**{side_note}{source_note}\n",
                idx + 1,
                item.path,
                item.line
            ));
            if !item.snippet.trim().is_empty() {
                out.push_str(&format!("   > `{}`\n", item.snippet.trim()));
            }
            if !item.body.trim().is_empty() {
                for line in item.body.trim().lines() {
                    out.push_str(&format!("   {line}\n"));
                }
            }
        }
    }
    out
}

/// Extreme diffs above this line count start collapsed by default (GitHub-style),
/// while expanding renders the complete patch without mid-file truncation.
pub const LARGE_DIFF_AUTO_FOLD_LINES: usize = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoFoldReason {
    Generated,
    LargeDiff(usize),
}

pub fn is_generated_or_lock_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if matches!(
        base,
        "cargo.lock"
            | "package-lock.json"
            | "npm-shrinkwrap.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "bun.lock"
            | "bun.lockb"
            | "gemfile.lock"
            | "poetry.lock"
            | "uv.lock"
            | "pipfile.lock"
            | "composer.lock"
            | "go.sum"
            | "podfile.lock"
            | "packages.lock.json"
            | "flake.lock"
            | "mix.lock"
            | "pubspec.lock"
            | "gradle.lockfile"
    ) {
        return true;
    }
    lower.ends_with(".min.js")
        || lower.ends_with(".min.mjs")
        || lower.ends_with(".min.css")
        || lower.ends_with(".js.map")
        || lower.ends_with(".css.map")
        || lower.ends_with(".pb.go")
        || lower.ends_with(".pb.rs")
        || lower.ends_with(".g.dart")
        || lower.ends_with(".freezed.dart")
        || lower.ends_with(".snap")
}

pub fn auto_fold_reason(file: &Value, hunks: Option<&[DiffHunk]>) -> Option<AutoFoldReason> {
    let path = file["filename"].as_str().unwrap_or("");
    if is_generated_or_lock_path(path) {
        return Some(AutoFoldReason::Generated);
    }
    let line_count = if let Some(hs) = hunks {
        hs.iter().map(|h| h.lines.len() + 1).sum()
    } else {
        let patch = file["patch"].as_str().unwrap_or("");
        let stat_sum = (file["additions"].as_u64().unwrap_or(0)
            + file["deletions"].as_u64().unwrap_or(0)) as usize;
        if stat_sum > LARGE_DIFF_AUTO_FOLD_LINES {
            stat_sum
        } else {
            patch.bytes().filter(|&b| b == b'\n').count() + usize::from(!patch.is_empty())
        }
    };
    (line_count > LARGE_DIFF_AUTO_FOLD_LINES).then_some(AutoFoldReason::LargeDiff(line_count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_unified_hunks_handles_multiple_hunks_and_dynamic_headers() {
        let patch = concat!(
            "@@ -10,3 +10,4 @@ fn top_fn() {\n",
            " ctx1\n",
            "+added\n",
            " ctx2\n",
            " ctx3\n",
            "@@ -50,2 +51,2 @@ fn second_fn() {\n",
            "-old\n",
            "+new\n",
            " tail\n",
        );
        let hunks = parse_unified_hunks(patch);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].entry_old(), 10);
        assert_eq!(hunks[0].entry_new(), 10);
        assert_eq!(hunks[0].exit_old(), 13);
        assert_eq!(hunks[0].exit_new(), 14);
        assert_eq!(hunks[1].entry_old(), 50);
        assert_eq!(hunks[1].entry_new(), 51);
        assert_eq!(
            hunks[1].formatted_header(20),
            "@@ -30,22 +31,22 @@ fn second_fn() {"
        );
        // Gap between hunk 0 and hunk 1 has identical old/new length (37 lines).
        assert_eq!(
            hunks[1].entry_old() - hunks[0].exit_old(),
            hunks[1].entry_new() - hunks[0].exit_new()
        );

        let pure_insert = parse_unified_hunks("@@ -10,0 +11,2 @@\n+a\n+b");
        assert_eq!(pure_insert[0].entry_old(), 11);
        assert_eq!(pure_insert[0].entry_new(), 11);
        assert_eq!(pure_insert[0].exit_old(), 11);
        assert_eq!(pure_insert[0].exit_new(), 13);

        let single_line = parse_unified_hunks("@@ -1 +1 @@\n-a\n+b");
        assert_eq!(single_line[0].old_count, 1);
        assert_eq!(single_line[0].new_count, 1);
        assert_eq!(single_line[0].exit_old(), 2);
        assert_eq!(single_line[0].exit_new(), 2);
    }

    #[test]
    fn auto_fold_detects_lockfiles_generated_assets_and_extreme_diffs() {
        assert_eq!(
            auto_fold_reason(
                &json!({"filename": "Cargo.lock", "patch": "@@ -1 +1 @@\n+a"}),
                None
            ),
            Some(AutoFoldReason::Generated)
        );
        assert_eq!(
            auto_fold_reason(
                &json!({"filename": "web/dist/app.min.js", "patch": "@@ -1 +1 @@\n+a"}),
                None
            ),
            Some(AutoFoldReason::Generated)
        );
        assert_eq!(
            auto_fold_reason(
                &json!({"filename": "src/feature.rs", "additions": 1200, "deletions": 0, "patch": "@@ -0,0 +1,2 @@\n+a\n+b"}),
                None
            ),
            None
        );
        assert!(matches!(
            auto_fold_reason(
                &json!({"filename": "src/huge.rs", "additions": 5001, "deletions": 0, "patch": "@@ -0,0 +1,2 @@\n+a\n+b"}),
                None
            ),
            Some(AutoFoldReason::LargeDiff(_))
        ));
    }
}
