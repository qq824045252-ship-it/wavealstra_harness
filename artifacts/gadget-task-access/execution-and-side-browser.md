# Gadget execution and side-browser repair — 2026-11-02

Release: 0.1.68. This follows the 0.1.66 Gadget access change and includes the user's subsequent UI correction.

## Observed failure and cause

- Read the reported task's SQLite metadata and session JSONL read-only. After upgrading, the model still received only the historical `gadget_create` declaration. It made no `gadget_list/read/update/open` calls and repeatedly requested `computer_exec` with `action:list_windows`, an unrelated mouse-action batch, and `process_id:1`.
- Current Pi restores the active tool set from the transcript after registration. MyBuddy reconciled capability tools but omitted product extension defaults. The new tools existed in the registry without being declared to the model. Reconciliation now includes registered product tools, retaining explicit policy exclusions and the historical Pi/MCP selection.
- With the user's configured Magpie Responses route and GPT-6.1 Terra, an isolated live A/B call reproduced the malformed arguments: omitting `strict` produced all 49 computer parameters, including dummy batch actions; explicit `strict:false` produced only `{"action":"list_windows"}`. MyBuddy now declares Responses strict-field support for this provider, preserving an explicit opt-out. This is applied at runtime dispatch because Pi bypasses native-provider streams before a catalog refresh when that provider has no base models for an API.
- The reported final messages had `stopReason:aborted`. The user confirmed clicking Stop. A real partial SSE stream in the desktop fixture reproduced the erroneous IPC rejection. An accepted cancellation now settles without interpreting the retained provider EOF diagnostic as failure. Uncancelled truncation still fails.
- The task-top Gadget strip duplicated the side list and consumed conversation height. Opening used a modal sandboxed iframe, covering the application and restricting normal browser capabilities. The strip and modal viewer are removed. The side Gadgets view now owns management actions; all Open paths use the existing BrowserHost. An app-level event subscription handles Agent opens even when the list is unmounted, checks the active task, and refreshes a displayed Gadget after source updates.
- BrowserHost deliberately retains hidden pages. Explicit Gadget Open now requests reload of a retained page so edits made while viewing the list are visible. Ordinary browser navigation retains its existing behavior.

## Verification

- `pnpm -s typecheck`: passed; scripts ratchet remains 189 existing errors, zero new errors.
- `pnpm -s test:all`: 247 passed, zero failures/regressions after the UI changes.
- Native SDK regression: reopen a real persisted current-Pi session with the old subset; prove the new tool is registered but initially inactive, reconcile, inspect its provider declaration, and execute `gadget_list`. Explicit exclusions and the native historical selection remain intact. Failed before the fix, passed after.
- Native Responses wire regression: both `stream` and `streamSimple` send `strict:false`, leave the original optional schema unchanged, honor explicit opt-out, and do not mutate the model. Failed before the fix, passed after.
- `test:gadget-agent-live`: the actual configured `codex/gpt-6.1-terra` model chose `gadget_list → gadget_read → gadget_update → gadget_open` in an isolated restored session. A real temporary Gadget was updated in place, preserved its marker, and emitted an open request. No real user Gadget was modified. This verifies model choice; it is distinct from the deterministic desktop provider fixture.
- `test:gadget-task-desktop`: real app, temporary HOME/userData and controlled SSE endpoint. Checks no chat strip/overlay, inherited visibility, side management, Open, native WebContents visibility/bounds, clipboard write and storage, simultaneous chat input, task switching, source save/reopen/refresh, Agent open with no mounted Gadget list, inactive-task isolation, accepted Stop, and actual uncancelled EOF failure. Screenshots use native window capture so the WebContentsView is included. The clipboard fixture eagerly snapshots ClipboardItem data and restores it after testing.
- Windows package 0.1.68: payload gate passed (588 unpacked entries, zero missing; worker version equals the repository constant). All seven complete desktop scenarios passed against the actual executable. Its asar main hash equals the built main. SHA256 executable: `5f6f3467c86b9e12eec8404a4dc3bd8dc3375dcc88e027ce304bc295d16f6eae`; main: `0452c3229ecac47203ba1f651b0dd85c7805872a9bd2a5b3b9e22a9dce6fbb56`. Screenshots, payload results, launch/shortcut readback and cleanup evidence are in `out/diagnostics/gadget-execution/`.

## Reproduction commands

```powershell
pnpm -s test:pi-native-core-tools
pnpm -s test:magpie-catalog
pnpm -s build
pnpm -s test:gadget-task-desktop
# Explicit paid-model opt-in; the test guard still isolates HOME and all writes.
$env:MYBUDDY_GADGET_LIVE_MODEL='codex/gpt-6.1-terra'
$env:MYBUDDY_GADGET_LIVE_MODELS='C:\Users\servi\.mybuddy\models.json'
pnpm -s test:gadget-agent-live
```

The live test reads the selected credential into memory; reports contain only model ID, tool names and fixture metadata. Unrelated existing diagnostic changes are excluded from the scoped commit.
