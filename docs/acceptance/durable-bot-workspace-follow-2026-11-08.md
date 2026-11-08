# Durable Bot follows its space workspace

Base: `cf749815c154285fa5b9b8de1e739df72809cc3f`. This change preserves that commit and the earlier scoped read verification fixes.

## Product contract

- An ordinary Bot follows its space's explicit path or nearest ancestor path. Without a space path it returns to its isolated task workspace. Invalid explicit paths fail closed.
- Existing running, queued, approval-waiting and recovery operations retain their original working directory. The organizational move is deferred until a native, whole-store quiescence check succeeds. The next safe open/admission performs the switch.
- Background Work execution bindings and versioned continuation workspaces remain pinned; moving a sidebar item does not expand their delegated execution scope.
- Both native root/user branches and SQLite cwd projections switch consistently. A durable pending intent allows recovery across the native-to-SQLite commit window. Task-owned child conversations retain their own workspaces.
- The native storage directory and historical artifacts do not move. Tools, MCP clients and file policy are rebuilt for the new root. Historical relative artifact paths retain their original per-message workspace, including entries outside the current UI history window.
- No existing user Work records are cancelled, reset or removed. No files are copied from the old workspace into the new space.

## Verification

- `typecheck`: passed.
- First default headless run: 392 passed, 0 failed. The final-source repeat was 390 passed / 2 failed (`media-capabilities-dom` and `project-materials-dom`, missing DOM elements / timing). Both failed tests were then run independently and passed. No baseline or timeout was relaxed to hide them. The environment-restricted `test:atspi-transport` was explicitly not retried; the current complete default suite contains 393 tests after adding `test:durable-workspace-binding`.
- Final focused checks cover native migration, full-store/child queues and regeneration fences, terminal isolated children, rollback, crash replay, 12 service orchestration cases, exact Work approvals, workspace lifecycle, and architecture gates. The final-source repeat includes the history-window and authoritative preparation fixes.
- Desktop fixture is run against `pnpm dev` in an isolated profile, with deterministic local model/MCP fixtures. It is not online-model or Omarchy/Hyprland certification. No packaged build is produced.

## Recovery limit

If the old execution directory has already been physically removed, opening its native runtime fails before a new migration can be proven safe. Restore that directory first; this change does not guess a replacement for an interrupted execution.

## Desktop result

`MYBUDDY_DESKTOP_DEV=1 MYBUDDY_WORKSPACE_ONLY=1 pnpm -s test:durable-bot-desktop`: **14 groups passed**, real Electron in the connected desktop, isolated profile and deterministic local provider/MCP.

The run covers native input/MCP/write, real selection and clipboard, idle space movement, original artifact preservation and pre-existing target files, relative Code Mode output in the target directory, whole-app normal restart, and an in-flight provider request that retains its old directory until the next idle input rebinds the same native store.

This is an explicitly scoped desktop run, not the entire historical desktop suite. The full-mode diagnostic attempt reached the first 12 groups, then an old image-output assertion ran before the operation had settled; the fixture now waits for settlement, but later full-mode image/unsafe-shell replay/legacy conversion scenarios were not all rerun in this change. Native recovery, approval and lifecycle tests remain separate evidence. No online model or physical Omarchy test is claimed.
