import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const checkout = process.argv[2];
assert(checkout, "Usage: node scripts/verify-canban-review-upstream.mjs <canban-git-checkout>");
const revision = "390c057335c82f3973c22ecec6b2f4905e81fe82";
const upstream = (path) => execFileSync("git", ["-C", checkout, "show", `${revision}:${path}`], { encoding: "utf8" });
const vendored = (path) => readFileSync(new URL(`../vendor/canban-review/${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last >= 0, `Missing source markers ${start} and ${end}`);
  return source.slice(first, last);
}

function rustFunction(source, name) {
  return between(source, `fn ${name}(`, "\n}\n");
}

assert.equal(vendored("LICENSE"), upstream("LICENSE"));
const model = upstream("crates/ui/src/review/model.rs");
const localModel = vendored("src/model.rs");
assert.equal(
  between(localModel, "impl DiffHunk {", "pub fn parse_unified_hunks("),
  between(model, "impl DiffHunk {", "pub fn parse_unified_hunks("),
);
for (const func of ["format_pending_markdown", "is_generated_or_lock_path", "auto_fold_reason"]) {
  assert.equal(rustFunction(localModel, func), rustFunction(model, func));
}

// Ignore the documented adjustment that preserves hunk lines resembling path headers.
const metadataStart = "    for raw in patch.lines() {\n";
const headerStart = "        if let Some((os, oc, ns, nc, ctx))";
const parserBody = (source) => {
  const func = rustFunction(source, "parse_unified_hunks");
  return func.replace(between(func, metadataStart, headerStart), metadataStart);
};
assert.equal(parserBody(localModel), parserBody(model));

const context = upstream("crates/ui/src/review/context.rs");
const localContext = vendored("src/context.rs");
const compact = (text) => text.replaceAll(/\s/g, "");
for (const [start, end] of [
  ["let rem = gap_len.saturating_sub(entry.from_bottom);", "entry.from_bottom = (entry.from_bottom + step).min(gap_len);"],
  ["let rem = gap_len.saturating_sub(entry.from_top + entry.from_bottom);", "} else if let (Some(last), Some(total))"],
  ["let rem = gap_len.saturating_sub(entry.from_top);", "entry.from_top = (entry.from_top + step).min(gap_len);"],
]) {
  const core = between(context, start, end);
  assert(compact(localContext).includes(compact(core).replace(/}}$/, "}")), start);
}
assert.equal(
  between(localContext, "pub const CONTEXT_STEP", ";"),
  between(context, "pub const CONTEXT_STEP", ";"),
);

const git = upstream("crates/workspaces/src/git_client.rs");
const localGit = vendored("src/git.rs");
assert.equal(
  between(localGit, "    let mut entries = Vec::new();", "\n    entries"),
  between(git, "        let mut entries = Vec::new();", "\n        Ok(entries)").replace(/^ {4}/gm, ""),
);

const compare = upstream("crates/workspaces/src/compare.rs");
const localPatch = vendored("src/git_patch.rs");
for (const func of ["parse_diff_git_header", "unquote_git_path"]) {
  assert.equal(rustFunction(localPatch, func), rustFunction(compare, func));
}
assert.equal(
  between(localPatch, '        if line.starts_with("new file mode ")', "    }\n    if let Some(prev)"),
  between(compare, '        if line.starts_with("new file mode ")', "        if !file.patch.is_empty() ||"),
);
assert.equal(
  between(localPatch, "    let mut total_add = 0usize;", "\n}\n"),
  between(compare, "    let mut total_add = 0usize;", "\n}\n"),
);

console.log(`Canban review core matches ${revision} with the documented adapter changes`);
