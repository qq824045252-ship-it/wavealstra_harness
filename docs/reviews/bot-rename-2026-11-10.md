# Bot rename

- Entry point: only inside Bot settings (the slider icon beside “所有消息”). No extra title/header button. A small native dialog supports Enter, Cancel and Escape.
- Saving updates the existing identity, never recreates it. Conversations, Work owner/member IDs, memory scope, permissions and expert snapshots remain unchanged.
- Existing automatically named Bot workspace groups follow the new name. Custom space names, physical paths and running tasks remain unchanged.
- Name validation shares creation's 1–80 character/control-character rules; duplicate comparison uses NFKC + case folding within the same user.
- Atomic update checks the latest identity timestamp. A stale edit is rejected with a reopen instruction; replay of an already saved identical name is safe.
- Shared Bot store is updated immediately, then Bot/space projections are refreshed. Team member names resolve from the same Bot IDs. Foreground instructions receive the current display name without rewriting old expert versions.
- No database schema bump or migration, no model call required.

## Verification
- Typecheck (including scripts), IPC channel inventory and test classification audit passed.
- Native test covers blank/long/control names, Unicode duplicates, foreign identity, stable Work/conversation/configuration, conflict/replay, database reopen, custom space preservation and rollback.
- Bot creation and settings regression tests passed.
- Real Electron component checks cover blank, cancel, duplicate, concurrent edit, successful save, reactive name labels, reload and Escape.
- Full isolated pnpm dev acceptance uses the real Bot page, preload IPC and SQLite, checks title/sidebar and reload. It does not access the user's profile or tasks.
- No crash/fault-injection suite, packaging, version changes or user-app restart. Screenshots are diagnostic; Wayland may fail to capture occluded surfaces independently of functional assertions.
