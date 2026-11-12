# Shell / PTY routing repair

## Evidence

A real ordinary-mode task had `terminal_exec` in its tool schema but made no terminal calls. Its PowerShell `Start-Process npx.cmd` invocation redirected output and returned `SKILLS_PROMPT_REQUIRES_TTY`. The final answer incorrectly generalized that invocation failure to lacking TTY capability.

## Change

- Native Durable bash/PowerShell descriptions identify non-interactive execution and direct interactive CLI/TUI use to the existing task-owned PTY.
- Recognized non-TTY output includes recovery guidance without changing exit status, suppressing original output, opening terminals, or replaying commands. Inspect partial effects before any retry.
- The existing terminal tool describes when to use it. No new terminal implementation or approval system.

## Verification on Windows

- `pnpm -s typecheck`: passed, scripts zero new errors.
- `pnpm -s test:task-terminal`: passed, including native streamed and explicit result advice, unrelated success, abort propagation, no automatic retry, terminal ownership and cancellation.
- `pnpm -s test:task-terminal:live`: passed on real ConPTY. Same local fixture rejects piped stdin, then accepts PTY input; read/resize/Ctrl-C/exit and child cleanup preserve a separate user terminal.
- `git diff --check`: passed.

The shared esbuild executable under Temp was denied output writes; used an identical local copy via ESBUILD_BINARY_PATH for these tests, without modifying shared dependencies. No installer was rerun. No real-model choice acceptance, full regression, build or packaging in this targeted pass.
