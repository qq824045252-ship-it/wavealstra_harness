# Application permission retirement

User direction: remove MyBuddy's own execution authorization/approval system across normal tasks, Bot, Work, team members and subagents. This is not an OS permission change and does not disable authentication in external services.

## Contract

- Legacy `readonly/default/auto`, Bot scopes, expiry, target allowlists, external-path grants and application approval callbacks no longer decide whether an available tool executes.
- New subagents inherit the host's loaded tools. Capability mounting/configuration and actual service availability remain real prerequisites.
- Old authorization DTO fields remain readable compatibility data, not active policy. No task, conversation, artifact, or memory is deleted by this change.
- Application permission pickers, full-access confirmation, Bot workspace authorization and team scope toggles are removed. External ACP-provider requests are not misrepresented as application approvals.
- Identity and ownership, current execution/intent identity, explicit pause/cancel, idempotency, concurrency conflicts and real tool failure evidence remain meaningful. They are not permission prompts.
- Scheduled observation/readback instructions remain task instructions, not inherited readonly authorization. Private/project/team memory attribution remains intact.
- No packaging/version bump or production profile mutation.

## Verification

Typecheck passes, including scripts with zero new errors. Focused tests cover native file writes, MCP execution, ordinary task lifecycle cancellation, concurrent subagent writes, legacy Work expiry/scope/path compatibility, team creation/dispatch, retired UI entries, memory/project/library/workflow extensions, and summary delivery without expiry cards.

Real-model UI run: `BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --multi-delegation`. Actual dev Electron/preload/UI and local configured model gateway, temporary HOME, no production credentials copied. Six tasks: arithmetic, translation, JSON extraction, file write/readback, sales calculation persisted as JSON, and a prose plan. All three background Work items closed with `succeeded`; exact output file bytes and JSON total verified. Provider intervals overlap in 23 pairs. Both 1280px and 390px layouts verified; task titles associate each result with its request.

Supplemental real-model team run also passes: member → native subagent → read/write/read of unpredictable file bytes → member → owner → original conversation. Member/owner tasks and diagnostic groups remain distinct; actual provider cache data is present.

Upgrade regression: an old native `approval:<callId>` pending interaction is retired only by its matching persisted execution/call identity during replay. The same submission resumes and writes its file; an ordinary clarification with the same title remains intact and answerable. No title-based or blanket pending deletion.

Artifacts remain local under `out/diagnostics/bot-multi-delegation/live/`; raw provider payloads are not committed.

## Boundary at the initial landing (resolved in follow-up below)

A tool-execution review rejected the additional change that would clear the tools allowlist in historical subagent snapshots. That change was not executed or bypassed. New subagents inherit the host catalogue; an old persisted dispatch can still retain its historical `items[].tools` list in `DurableSubagents.runChild`, and an already-created child retains its configured catalogue. The user elected to apply that remaining migration manually. It is tracked separately, not reported as complete removal of every historical restriction.

Final broad non-fault regression: 418 passed / 0 failed / 0 known failures / 0 regressions (2.4 minutes). Twenty crash/recovery/fault-injection suites were excluded with a temporary runner, not a permanent gate or baseline edit, as requested. Those exclusions are deferred rather than marked passed. Final typecheck: web/node/scripts passed, scripts 0 errors.

## Follow-up: user-applied historical child migration

The user manually applied the remaining `DurableSubagents.ts` migration. Review verified that the immutable dispatch memo is retained; executable items inherit the current host catalogue, while already-created owned conversations have their AgentDoc tool catalogue refreshed. Stored workspace/isolation, model, original deadline, ownership and cancellation remain unchanged.

Added native SDK regression fixtures persist both legacy shapes: a dispatch with no child yet and an already-created owned child with an empty tool catalogue. Both execute a real filesystem write after catalogue restoration. The existing child's identity, workspace, start time, timeout and deadline remain identical. Closing/reopening the upgraded store and resubmitting the same request returns the same submission without repeating the write or creating another child. These are isolated persisted SDK fixtures, not claims about inspecting a user's historical production database or an online-model test.
