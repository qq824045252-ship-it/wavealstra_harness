# Agent notes

- Git workflow: use `main` as the only active local branch and commit directly to it. Do not create additional branches or worktrees unless the user explicitly requests them. Push only when explicitly requested.
- Typecheck: `pnpm -s typecheck`
- Focused tests are `pnpm -s test:<name>` scripts in package.json (e.g. `test:memory`, `test:project-memory-extraction`, `test:pi0992-memory-capsule`, `test:project-materials-ui`).
- Electron UI tests fail with `app` undefined when the shell inherits `ELECTRON_RUN_AS_NODE=1`; run them as `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`. Screenshots land in `out/tests/*.png`.
- Run esbuild via the pnpm scripts, not by hand in Git Bash: MSYS path conversion mangles `--alias:@/store/appStore=...`.
- Live app data: `~/.mybuddy/app.db` (SQLite, open read-only for diagnosis).
