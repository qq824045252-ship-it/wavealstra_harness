mod context;
mod git;
mod git_patch;
mod model;

use context::{CONTEXT_STEP, ExpandDirection, GapKind, expand_gap};
use model::{
    AutoFoldReason, DiffHunk, GapExpansion, PendingInlineComment, auto_fold_reason,
    format_pending_markdown, parse_unified_hunks,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::cell::RefCell;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Request {
    Parse {
        patch: String,
        filename: String,
    },
    FormatHunkHeader {
        hunk: DiffHunk,
        expanded_above: u64,
    },
    ExpandGap {
        gap: GapKind,
        length: u64,
        expansion: GapExpansion,
        direction: ExpandDirection,
    },
    FormatPendingMarkdown {
        context_label: String,
        summary: String,
        comments: Vec<PendingInlineComment>,
    },
    GitStatus {
        status: String,
    },
    GitCompareCommand {
        mode: String,
        base: Option<String>,
        compare: Option<String>,
    },
    GitPatchFiles {
        patch: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedHunk {
    #[serde(flatten)]
    hunk: DiffHunk,
    entry_old: u64,
    entry_new: u64,
    exit_old: u64,
    exit_new: u64,
    ends_with_no_newline: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
enum FoldReason {
    Generated(&'static str),
    LargeDiff(usize),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedReview {
    hunks: Vec<ParsedHunk>,
    auto_fold_reason: Option<FoldReason>,
}

fn review_response(input: &[u8]) -> serde_json::Result<Vec<u8>> {
    match serde_json::from_slice(input)? {
        Request::Parse { patch, filename } => {
            let hunks = parse_unified_hunks(&patch);
            let fold_reason = auto_fold_reason(&json!({ "filename": filename }), Some(&hunks))
                .map(|reason| match reason {
                    AutoFoldReason::Generated => FoldReason::Generated("generated"),
                    AutoFoldReason::LargeDiff(lines) => FoldReason::LargeDiff(lines),
                });
            let hunks = hunks
                .into_iter()
                .map(|hunk| ParsedHunk {
                    entry_old: hunk.entry_old(),
                    entry_new: hunk.entry_new(),
                    exit_old: hunk.exit_old(),
                    exit_new: hunk.exit_new(),
                    ends_with_no_newline: hunk.ends_with_no_newline(),
                    hunk,
                })
                .collect();
            serde_json::to_vec(&ParsedReview {
                hunks,
                auto_fold_reason: fold_reason,
            })
        }
        Request::FormatHunkHeader { hunk, expanded_above } => {
            serde_json::to_vec(&hunk.formatted_header(expanded_above))
        }
        Request::ExpandGap { gap, length, expansion, direction } => {
            serde_json::to_vec(&expand_gap(gap, length, expansion, direction))
        }
        Request::FormatPendingMarkdown { context_label, summary, comments } => {
            serde_json::to_vec(&format_pending_markdown(&context_label, &summary, &comments))
        }
        Request::GitStatus { status } => serde_json::to_vec(&git::parse_status_files(&status)),
        Request::GitCompareCommand { mode, base, compare } => {
            serde_json::to_vec(&git::compare_git_args(&mode, base.as_deref(), compare.as_deref()))
        }
        Request::GitPatchFiles { patch } => serde_json::to_vec(&git_patch::split_unified_patch(&patch).0),
    }
}

thread_local! {
    static REQUEST: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static RESPONSE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

// The wrapper writes the request and reads the response synchronously within
// this module's linear memory. Rust owns both buffers for their entire use.
#[unsafe(no_mangle)]
pub extern "C" fn prepare_request(length: usize) -> *mut u8 {
    REQUEST.with_borrow_mut(|input| {
        input.resize(length, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn run_request() -> *const u8 {
    let input = REQUEST.take();
    let output = review_response(&input).unwrap_or_default();
    let pointer = output.as_ptr();
    RESPONSE.set(output);
    pointer
}

#[unsafe(no_mangle)]
pub extern "C" fn response_length() -> usize {
    RESPONSE.with_borrow(Vec::len)
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_response() {
    RESPONSE.set(Vec::new());
}

#[unsafe(no_mangle)]
pub extern "C" fn context_step() -> u64 {
    CONTEXT_STEP
}
