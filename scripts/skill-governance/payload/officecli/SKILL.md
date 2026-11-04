---
name: officecli
description: "Read, inspect and precisely modify existing DOCX, XLSX and PPTX files using officecli DOM/XML operations; also create ordinary Word/Excel documents. Use open-kimi-ppt for a new designed presentation, visual deck recreation or an explicit PPTD workflow."
---

# officecli

AI-friendly CLI for .docx, .xlsx, .pptx. Single binary, no dependencies, no Office installation needed.

## MyBuddy runtime

MyBuddy bundles a pinned, SHA-256 verified OfficeCLI binary for Windows/Linux x64.
Run `officecli --version` using the task's shell/execute_code tools; its directory is
already on the task PATH, including child agents. No download, global install,
Office installation, or administrator access is required. If the command fails,
report the error and repair/reinstall MyBuddy; do not run remote install scripts.
The absolute bundled executable is also available as `MYBUDDY_OFFICECLI`.
Keep `OFFICECLI_NO_AUTO_RESIDENT=1` so task commands save files before returning.
Use paths inside the task workspace or explicitly authorized project materials.
After edits, read back the affected content and run `officecli validate <file>`.

---

## Strategy

**L1 (read) → L2 (DOM edit) → L3 (raw XML)**. Always prefer higher layers. Add `--json` for structured output.

For specialist document work, consult references/specialized-routing.md only when relevant and only load skills actually available in the current task. Presentation routing follows Routing Boundary below.

---

## Help System (IMPORTANT)

**When unsure about property names, value formats, or command syntax, ALWAYS run help instead of guessing.** One help query beats guess-fail-retry loops.

`officecli help` ≡ `officecli --help`, and `officecli <cmd> --help` ≡ `officecli help <cmd>` — same content.

```bash
officecli help                                  # All commands + global options + schema entry points
officecli help docx                             # List all docx elements
officecli help docx paragraph                   # Full schema: properties, aliases, examples, readbacks
officecli help docx set paragraph               # Verb-filtered: only props usable with `set`
officecli help docx paragraph --json            # Structured schema (machine-readable)
```

Format aliases: `word`→`docx`, `excel`→`xlsx`, `ppt`/`powerpoint`→`pptx`. Verbs: `add`, `set`, `get`, `query`, `remove`. MCP exposes the same schema via the single `command` string param: `{"command":"help docx paragraph"}` (not a structured `{"format":...,"type":...}` object — the MCP tool has exactly one param, `command`, and passes it through to the CLI verbatim).

---

## Performance: Resident Mode

**Every command auto-starts a resident on first access** (60s idle timeout) — file-lock conflicts are automatically avoided. Explicit `open`/`close` is still recommended for longer sessions (12min idle):
```bash
officecli open report.docx       # explicitly keep in memory
officecli set report.docx ...    # no file I/O overhead
officecli close report.docx      # save and release
```

Opt out of auto-start: `OFFICECLI_NO_AUTO_RESIDENT=1`.

**Flush only at the non-officecli boundary.** officecli's own reads (`get`/`query`/`view`/`dump`) always see your latest edits, so you never need to save mid-workflow. Run `save` (keeps the resident) or `close` (flush + release) only **before a non-officecli program reads the file** — python-docx/openpyxl, Word, a renderer, delivery/upload. (Idle sessions auto-flush within seconds; `OFFICECLI_RESIDENT_FLUSH=each` makes every mutation flush before returning.)

---

## Delivery acceptance (required)

Work on a copy; preserve the original. Order: create/edit → `officecli close <final-file>` (save and release) → independent disk readback → semantic checks → render when an engine exists → deliver. Resident `get/view` and preview caches do not prove saved results.

In this repository use `python3 scripts/office-delivery.py FINAL EXPECTATIONS.json REPORT.json --close --render RENDER_DIR`. Verify the CLI/engine in the target app environment first; do not install silently. Expectations support `texts`, PPTX `pages`/`template`, and XLSX `cells` (`Sheet1!C1`: expected number). The report records the final path/hash/mtime, semantic failures and unverified scope. Deliver that exact file; if modified, rerun acceptance.

XLSX: independently checks only requested SUM(range) and cell+cell formulas and compares disk caches; stale/missing caches fail. Use an actual calculation engine for broader formulas and explicitly report its coverage. PPTX: checks slide count/text, template masters/layouts/themes and objects beyond page bounds; render every page and inspect text overflow within shapes manually. DOCX: read back target text/paragraph structure and inspect target-format layout. Render availability alone is not visual approval. Without save/close evidence or calculation/render review, report PARTIAL and the missing scope, never “fully verified”.

## Quick Start

**PPT:**
```bash
officecli create slides.pptx
officecli add slides.pptx / --type slide --prop title="Q4 Report" --prop background=1A1A2E
officecli add slides.pptx '/slide[1]' --type shape --prop text="Revenue grew 25%" --prop x=2cm --prop y=5cm --prop font=Arial --prop size=24 --prop color=FFFFFF
```

**Word:**
```bash
officecli create report.docx
officecli add report.docx /body --type paragraph --prop text="Executive Summary" --prop style=Heading1
officecli add report.docx /body --type paragraph --prop text="Revenue increased by 25% year-over-year."
```

**Excel:**
```bash
officecli create data.xlsx
officecli set data.xlsx /Sheet1/A1 --prop value="Name" --prop bold=true
officecli set data.xlsx /Sheet1/A2 --prop value="Alice"
```

---

## CLI operation reference

Read for view/get/query/watch, DOM edits, batch or raw XML syntax: [references/cli-operations.md](references/cli-operations.md).

## Common Pitfalls

| Pitfall | Correct Approach |
|---------|-----------------|
| `--name "foo"` | Use `--prop name="foo"` — all attributes go through `--prop` |
| Unquoted `[N]` paths in zsh/bash | Always quote: `'/slide[1]'` or `"/slide[1]"` (shell glob-expands brackets) |
| PPT `shape[1]` for content | `shape[1]` is typically the title placeholder. Use `shape[2]+` for content shapes |
| `/shape[myname]` | Name indexing not supported. Use numeric index or `@name=` (PPT only) |
| Guessing property names | Run `officecli help <format> <element>` to see exact names |
| Modifying an open file | Close the file in PowerPoint/WPS first |
| `\n` in shell strings | Use `\\n` for newlines in `--prop text="..."` |
| `$` in shell text | `--prop text="$15M"` strips `$15`. Use single quotes: `--prop text='$15M'`, or heredoc batch |

---

## Specialized workflows

For a specialized document workflow, inspect the relevant routing entry only: [references/specialized-routing.md](references/specialized-routing.md).

## Notes

- Paths are **1-based** (XPath convention): `'/body/p[3]'` = third paragraph
- `--index` is **0-based** (array convention): `--index 0` = first position
- **Excel exception**: for `add --type row` and `add --type col`, `--index N` is **1-based** (matches OOXML RowIndex / column letter index). `--index 5` inserts at row 5 / column 5.
- After modifications, verify with `validate` and/or `view issues`
- **When unsure**, run `officecli help <format> <element>` instead of guessing

## Routing Boundary

现有 PPTX 的文字、字体、DOM/XML 精确修改由本 Skill 完成，避免无谓格式转换。从零设计演示文稿、参考图复刻、显式 PPTD/Kimi 工作流交给 open-kimi-ppt。

## Workflow / Output Contract

Read/query the original → choose the smallest DOM edit → save/close before external readers → validate and re-read the edited fields. Deliver the saved absolute path, exact changes and validation results; preserve unrelated document content. A structural check is not visual QA. Stop before overwriting unsaved Office GUI edits or when the requested DOM property is unsupported.

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
