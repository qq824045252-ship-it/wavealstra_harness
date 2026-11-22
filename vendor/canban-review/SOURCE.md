# Canban review source

[Canban by JJy](https://github.com/jjyr/canban), commit `390c057335c82f3973c22ecec6b2f4905e81fe82`, Copyright 2026 JJy, Apache-2.0. The upstream license is in `LICENSE`. The packaged application includes this file, the license, and the linked Rust libraries' notices.

| Upstream source | MyBuddy integration |
| --- | --- |
| [Review model, lines 264–457 and 527–594](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/ui/src/review/model.rs#L264-L457) (`6e9035ad036a01f8e0383b3703a214f46e610cba`) | `src/model.rs` retains the hunk parser, old and new line numbering, hunk headers, and generated-file or large-diff collapse rules. The adapter adds Serde attributes and keeps source lines starting with `--- ` or `+++ ` when a hunk still expects content. |
| [Review model, lines 5–16 and 473–510](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/ui/src/review/model.rs#L473-L510) | `src/model.rs` retains Canban's formatter for review summaries and inline comments, with comment input supplied by the MyBuddy composer. |
| [Context expansion, lines 10 and 545–585](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/ui/src/review/context.rs#L545-L585) (`0628843c4a10279e9af4d8d84ac4d16d1799d100`) | `src/context.rs` retains the 20-line increments and directional expansion arithmetic. React supplies the gap length and state, and anchors its own scrolling. The bridge clamps stale gap state to the available length. |
| [Git status, lines 62–106](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/workspaces/src/git_client.rs#L62-L106) (`760357c5ad0ddfb69bb82feeaae942a5802f8db5`) | `src/git.rs` retains the parsed status categories. MyBuddy runs Git in the selected task checkout and restricts results to that workspace. |
| [Git patch splitter, lines 11–168](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/workspaces/src/compare.rs#L34-L168) (`1f205a93f9f2c84d20700553c84ed66f47c683a0`) | `src/git_patch.rs` retains Canban's patch splitting and path handling. It tracks whether the parser is in a hunk to retain source lines with path-header prefixes. The host uses NUL-delimited Git metadata to identify files independently of patch path quoting. |
| [Git comparison, lines 698–847](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/workspaces/src/compare.rs#L698-L847) | `src/git.rs` retains the Git diff arguments for staged, unstaged, working-directory and revision comparisons. The host adds task-scoped literal paths, NUL-delimited metadata and output limits. For an unborn repository Git supplies the empty tree for a staged comparison. |

MyBuddy provides the task checkout and Git subprocesses. Pi-recorded file changes use `git diff --no-index` against private copies of the recorded text. The native NSH view and reactive state are adapted to the existing React workbench.

| Canban native view | Electron / React port |
| --- | --- |
| [File navigation and the continuous diff workbench](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/ui/src/review/diff.rs#L85-L242) | `ChangesView.tsx` and `ReviewFileDetails.tsx` implement the file rail, expandable file cards, and incremental loading. |
| [Diff lines, inline comments and editing](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/ui/src/review/diff.rs#L1475-L1918) | `CodeReviewDiff.tsx` displays the Rust model's old and new line coordinates. `ReviewDraft.tsx` anchors a comment to its file version and side. |
| [Review submission](https://github.com/jjyr/canban/blob/390c057335c82f3973c22ecec6b2f4905e81fe82/crates/ui/src/review/submit.rs#L119-L235) | The local submission drawer assembles the summary and comments with the upstream Markdown formatter. MyBuddy stores the draft locally and delivers it to the originating task. |

Accepting or rejecting Pi changes is a MyBuddy operation. It uses that task's recorded before/after snapshots. The entry badge counts outstanding file decisions from the same records.

`canban-review.wasm.json` carries the compiled Rust module. Node calls it directly and the renderer uses it in a dedicated external Worker under the existing Electron content security policy. The runtime makes no Rust toolchain request. Build-only Cargo dependencies are recorded in `Cargo.lock`. `licenses/` includes the licenses for the linked Cargo runtime crates and the Rust toolchain's standard library notices.

From the MyBuddy checkout, verify the extracted bodies against a local copy of Canban with the pinned commit, build the generated module, and run the bridge:

```text
node scripts/verify-canban-review-upstream.mjs <canban-git-checkout>
rustup target add wasm32-unknown-unknown --toolchain 1.97.1
node scripts/build-canban-review-wasm.mjs --check
pnpm run test:canban-review-engine
```

Run the build script without `--check` to regenerate the module after changing the Rust source. The script compiles only this crate.
