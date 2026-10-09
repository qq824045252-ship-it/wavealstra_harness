# Agent notes

- Git workflow: use `main` as the only active local branch and commit directly to it. Do not create additional branches or worktrees unless the user explicitly requests them. The release workflow below is standing authorization for its scoped commit and push; otherwise push only when explicitly requested.
- Typecheck: `pnpm -s typecheck`
- Focused tests are `pnpm -s test:<name>` scripts in package.json (e.g. `test:memory`, `test:project-memory-extraction`, `test:pi0992-memory-capsule`, `test:project-materials-ui`).
- **Full gate: `pnpm -s test:all`** (aggregate runner over every `test:*`, excluding GUI/CDP/GPU/network cases — see `EXCLUDE_PATTERNS` in `scripts/test-all.mjs`). It is a **ratchet**: failures listed in `scripts/test-baseline.json` are tolerated but printed; any *new* failure fails the gate. Fix a test → remove its baseline entry (`pnpm -s test:all:update-baseline` rewrites the file). Never add an entry to silence a real regression.
- GUI/desktop suites need a real desktop session: `pnpm -s test:all:live`.
- Prefer asserting **behaviour** over source text. 30% of test files grep implementation source with `readFileSync` + `.includes()`; those break on correct refactors (e.g. `chat-markdown` pinned `isSvgFenceLanguage(extracted.language)` and broke when the call correctly gained a second argument). Do not hardcode versions/schema numbers in tests — read them from the code (`CURRENT_DATABASE_SCHEMA_VERSION`, the Pi `EXPECTED_PI_VERSION` pin).
- Electron UI tests fail with `app` undefined when the shell inherits `ELECTRON_RUN_AS_NODE=1`; run them as `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`. Screenshots land in `out/tests/*.png`.
- Run esbuild via the pnpm scripts, not by hand in Git Bash: MSYS path conversion mangles `--alias:@/store/appStore=...`.
- Live app data: `~/.mybuddy/app.db` (SQLite, open read-only for diagnosis).

## Default release workflow

- After completing a feature or bug fix, bump the desktop patch version unless the user specifies another version, run relevant checks, commit the scoped changes to `main`, and push to `origin/main`.
- Build the Windows distribution, validate the actual packaged app, update the Desktop and Start Menu shortcuts to the accepted build, and read back their target, working directory, icon, and application identity.
- Keep one accepted desktop release. Delete obsolete generated release directories only after checking their resolved paths, active processes, and shortcut references, and verifying the retained package's hash and startup. Preserve unrelated source changes, user data, and diagnostic reports.
- Do not interrupt an active user task without authorization. If release validation fails, retain the previously accepted build and report the specific failure.
