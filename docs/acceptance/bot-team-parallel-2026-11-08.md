# Bot team bounded parallel execution acceptance

## Scope and baseline

Based on main `b59456a008aaa403d5c034bb21b7b838e6d4887b`, preserving the user's Cloudflared detection change and scoped read-verification fix `134db8d`.

This change extends the existing per-Work team, not a general autonomous chat group. Explicit member dependencies and a maximum of 1–4 concurrent bindings are opt-in. Existing plans remain sequential. Templates retain scheduling choices without expanding authorization. Each member still uses its own Bot identity and frozen input. The owner waits for all members' results and accounting before summarizing.

A dependency means settled execution, not successful execution. Failed/stopped predecessors without deliverables remain visible in the input as explicit host status and uncovered scope. No success is inferred. Unknown budget/effects fence new dispatches; already admitted executions can settle. File-resource mutual exclusion remains enforced.

## Changes

- Team dialog: sequential/parallel policy, bounded concurrency and earlier-member dependencies, persisted in templates.
- Team detail: scheduling policy, dependency and waiting reasons; handoff-aware read-only replan removes the new owner from member slots and cleans dangling dependencies.
- Durable scheduler: independent bindings overlap; dependency results are frozen only when prerequisites settle; owner barrier and pause/resume remain effective.
- Owner summary: original copied delegate recipients no longer create phantom waiting members after handoff. A completed owner execution remains attributed to its actual executor after a later handoff.

## Evidence

- Typecheck and script typecheck: pass.
- Team service: pass, including parallel cap, explicit dependency snapshots, pause/resume, owner barrier, unknown provider-budget reconciliation, stopped predecessor without a deliverable, and post-summary owner handoff.
- Team native: pass using real durable execution, workspace files and tools with a deterministic local model. One member is held in-flight while another completes a real read; the owner waits and a database reopen does not duplicate completed bindings or model requests. This is not an online LLM-quality claim.
- Team React UI: 22 checks pass, including template/dependency handling and read-only replan cleanup. This is not native Electron visual acceptance.
- Work suite: 79/79 pass on the final code after review corrections (1.2 minutes, zero failures).
- Architecture assertions: 278 pass; graph suite 5/5 pass.

## Unverified and blocked

- Native Electron visual acceptance could not start: three isolated `pnpm dev` attempts exhausted memory (exit 137 at 4096/3072 MB, V8 OOM 134 at 2048 MB). Four QA Bots were created through BotCreationService in an isolated database, but no new application window appeared. Creation, template restart and handoff display have NOT been visually accepted.
- The default aggregate runner was not completed. Its AT-SPI private-bus prerequisite was denied AF_UNIX access in this environment. No bypass was attempted. Do not describe this as an all-tests pass.
- No online model/team quality, packaged application, cross-platform desktop, autonomous member selection, or expanded external-channel tool capability is claimed.

## Follow-up acceptance

On a desktop with sufficient memory, run the dev application, create a three-member parallel team with one dependency, save/reopen the template, observe overlapping independent members and the waiting owner, pause/resume, and verify owner handoff before and after summary. Validate real online-model output separately from scheduling correctness.
