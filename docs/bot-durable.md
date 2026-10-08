# Bot / Pi Durable

Bot replaces the former `design` mode. `working` and `coding` retain their existing Pi AgentSession paths.

## Execution ownership

`AgentService` routes Bot inputs directly to `DurableBotService`. Each task owns a Pi Durable Harness and a JSONL store under `.mybuddy/durable/<task-id-hash>`. SQLite binds the task, store and working directory. It does not schedule work or decide whether an execution has finished.

Pi Durable owns input admission, steering/follow-up queues, retries, compaction, cancellation, tool scheduling and recovery. Bot does not enter MyBuddy's scenario policy resolver, model admission wrapper, approval queue, continuation loop or file-write gate. Existing model/auth files, projects, directories, prompt blocks, experts and enabled skills supply configuration and context.

Native mode uses Pi Durable's CodingTools. MCP clients use Pi's native transports and authentication store, and register tools/resources as Durable tools. Installed plugin enable/disable and exposure settings still select which capabilities are configured; scenario blacklists and provider-dependent Tag gates do not apply.

With Pi Durable 1.0.4, Windows Bot also registers the native `powershell` tool in Native mode and Code Mode's nested tool catalog. Durable starts `pwsh`, falling back to Windows PowerShell, directly as argv and returns UTF-8 output. Tool configuration refreshes retain it. Bash remains available for existing calls and unfinished checkpoints.

Durable's persisted provider session UUID supplies prompt-cache and provider-session affinity across retry and reopening; different Bot conversations have distinct identities. The host uses the upstream `NodeExecutionEnv`, so the 1.0.3 binary-reader, paged-directory-reader, watch and argv-execution API changes are handled by that implementation. Windows watches use polling, which allows parent directory renames. The 1.0.4 read tool supports growing logs. Generation partials and tool output retain Durable's default 100 ms commit interval.

Legacy Durable agent selections and running checkpoints that name `azure-openai-responses` resolve to the new native `azure` provider at the model lookup boundary. Immutable transcript entries and persisted checkpoint selections are retained; reopening does not require a new configuration write to recover the run or its queued inputs.

Bot uses Pi's native MCP authentication provider with the shared credential store, proactive token-expiry refresh, cross-process refresh locks and rotated-token persistence. OAuth `clientRegistration` (`dcr` or `cimd`), metadata URL and callback settings reach that provider. Sign-in stays in plugin management, including when a server requests additional scope.

Existing memory, project context/plans/events/knowledge, library, resource locator, work graph and gadget operations are registered as Durable tools. Enabled browser/search/media/diagnostic capabilities use the same adapter. The adapter only accepts tool registration and presentation metadata; it cannot register AgentSession execution hooks. Native Bash/Code Mode replace the legacy `execute_code` controller, and computer actions do not enter MyBuddy's approval or recovery coordinator. Changing MCP configuration refreshes it on the next input without closing clients still owned by in-flight native calls.

## Persistent task identity

Experts are reusable templates. Binding one from the chat's plus menu or task context menu saves a task-owned snapshot of its name, instructions, private skills and capability references. The editor separates saving to the current task from editing the shared template. Updating, disabling or uninstalling a template does not silently rewrite an existing task; explicitly synchronizing adopts the new template. Imported replacements are staged before the installed package is exchanged, and template edits reject stale revisions.

SQLite `task_expert_bindings` stores the desired and active revisions. Save changes only the desired revision. A newly admitted input after the runtime is idle promotes it; current tool loops, already queued inputs and restart recovery retain the active revision. Compaction rebuilds the identity section from the active snapshot. Task-owned skill packages live under `.mybuddy/task-expert-bindings/<task-id-hash>/<revision>` and follow permanent task deletion.

Selected MCP servers and connectors remain references to installed configuration and credentials. They cannot enable a globally disabled service. A bound expert narrows MCP selection to its saved list; an unbound task retains normal global MCP selection. Manually attached connectors stay separate and survive unbinding. Office and coding use the same snapshot storage while retaining their existing project and mode policies.

## Memory and project continuity

Current project instructions, project resources, plans, pinned library items and scoped memory are supplied to the native generation request. Retrieved evidence is request-only: it does not become another persisted user instruction. Global/project/workspace scope rules still identify the data belonging to the conversation; they do not gate Bot execution.

Committed completed turns feed the existing Memory Pipeline in the background. Nested Code Mode tool results remain available as procedure-learning evidence. Task/conversation/entry identities and a transactional projection cursor prevent duplicate capture on reconnect; aborted/failed replies and compaction summaries are not learned as completed user turns. Native mode and Code Mode share the same project memory. Project binding and the memory setting are re-read for subsequent inputs.

## Tags and Code Mode

Bot ships only the Native and Code Mode Tags. The general design Tag is retired. Penpot lives under Daily Office with its existing `web-prototype` ID, prompt, MCP configuration and backend/HTTP/browser runtime behavior; legacy design/Bot configuration is carried over when resolving the office preset.

Each Bot preset has `botToolMode: "native" | "codemode"`. Tags remain editable after the first message; the next submitted input applies the selected configuration through `conversation.configure`.

Code Mode uses `pi-codemode`'s QuickJS sandbox. Its nested calls are actual Durable `ToolTask`s in a private, task-owned child conversation. Cancellation and child cleanup use Durable ownership. `store`/`load` values are conversation documents. Code Mode and external MCP side effects are registered as unsafe to replay: after interruption Durable records their interruption rather than executing them twice. Model continuation and queued inputs resume through Durable.

Bot's sandbox exposes its registered tools and output/store helpers. The AgentSession Code Mode `pi.models` classifier helper is currently available in office/coding conversations; Pi Durable 1.0.4 has no models accessor on its tool execution API, and Bot does not install that helper.

Search-result reference metadata is persisted on the owning Bot conversation, following Durable's ownership chain. A later Code Mode child can restore those references after process restart.

The host adds image content to native `read` results using the same Durable environment's binary reader and Pi's image resizing. Text reads retain upstream behavior. Code Mode can call `tools.read()` and pass its returned image block to `image()`. Code Mode image outputs are saved under the task's Durable `images` directory, deduplicated by content, and returned with an absolute path before each image block. The paths are persisted in native result details and restored as image artifacts on reopening. Save failures preserve the script's output and produce a diagnostic. Stored images follow the existing trash/permanent-purge lifecycle.

## Interface and persistence

New Gateway inputs from Feishu, WeCom, WeChat, Telegram and Slack use Bot / Native with an explicit `native` preset. A separate `gw-bot-*` task namespace leaves existing `gw-*` AgentSession tasks and their history untouched. Subsequent inputs from the same channel/chat or Slack thread reuse the new Bot. Desktop/remote configuration writes preserve this mode; other Bot tasks can still switch Tags normally.

Gateway replies await the native submission receipt and read that input's persisted answer. Stable platform-message request IDs prevent duplicate tool effects on redelivery; queued messages, cancellation and model errors follow native outcomes. Transport credentials, sender authorization, event deduplication and reply delivery remain Gateway responsibilities. They do not apply scenario blacklists, approval waits or artifact filters to Bot execution.

Slack journals mark new receipts as Durable and retain the original channel-history context. Restart reacquires the same native input and continues the reply outbox. Legacy running receipts keep their existing interrupted behavior and never replay an old task. Shutdown suspends inbound transport before closing the native Harness, so checkpointing is not converted into a failure reply.

`DurableBotSnapshot` projects complete persisted entries, live partial output, nested tool records, inbox entries, retry state and compaction state. History is read across compaction boundaries. Desktop and remote reconnects replace their display with that snapshot. No speculative assistant shell or old session JSONL is treated as execution truth.

A native `pi.live.run` projects a waiting row before the first token. The generation task identity keeps that row mounted through partial output and entry commit, preserving entry and collapse transitions. Response completion timestamps are stored in a native conversation document by an observational `afterResponse` hook; they supply display-only durations and survive reconnect. Historical replies without recorded timing show their outcome without invented elapsed times.

Artifact cards are presentation metadata. Bot bypasses scenario display filters and internal file filters. Workspace changes and successful native write/edit records, including absolute paths outside the workspace, can create cards. All tool output remains visible in the transcript independently of card detection.

Closing the application checkpoints the Harness; pressing Stop invokes native abort. Moving a task to trash aborts and closes its Harness. On upgrade, old `design` tasks use the existing recoverable trash lifecycle. Missing Bot configuration files are copied from `modes/design`; prompts and custom Tags are preserved while old policy gates are stripped.

Bot defaults describe general-purpose assistance, progress communication and task-appropriate deliverables. Exact former factory prompt blocks and factory design examples migrate to these defaults; user-edited blocks remain editable configuration. The settings entry is named Modes and Prompts.

Original user text, display text and attachment references are stored in a native conversation document. Reopening restores attachment cards, while memory capture uses the original text rather than expanded terminal/vision context. Committed assistant usage projects idempotently into usage statistics; unknown timing metrics remain empty. The context indicator reads the native usage ledger. Completion notifications and scheduled-run results follow native outcomes, including failure and cancellation. Permanent task purge removes its hashed Durable directory; trash keeps it recoverable.

Old AgentSession message deletion, regeneration, goal and branch controls are not shown on Bot conversations. Send a new instruction or create a new Bot conversation. Office and coding controls keep their prior behavior.

## Verification

- `pnpm -s typecheck`
- `pnpm -s test:expert`, `test:task-expert-binding`, `test:expert-ui` and `test:expert-binding-desktop`: template replacement, editing and revision conflicts; task-owned skills; idle/queue/restart/compaction identity boundaries; cancellation and UI scope; real Electron IPC, HTTP model and MCP fixtures. The desktop test accepts `MYBUDDY_DESKTOP_EXECUTABLE` for packaged acceptance.
- `pnpm -s test:gateway-durable`, `test:slack-gateway` and `test:gateway`: isolated five-channel routing, legacy task preservation, native tools despite readonly settings, input-specific replies, deduplication, queued inputs, cancellation, failure, delivery retry, native checkpoint/reopen and Slack journal/outbox recovery. All credentials and message transports are fixtures.
- `pnpm -s remote:typecheck`
- `pnpm -s test:mode` and `pnpm -s test:mode-preset`
- `pnpm -s test:durable-bot`: real Durable storage, frozen 1.0.0 JSONL upgrade/recovery (including legacy Azure selections/checkpoints), native tools, QuickJS, Windows PowerShell argv/UTF-8 execution in both Tags after configuration refresh, provider session UUID persistence/isolation, image input/read/output persistence and reopening, image-save failure, native MCP OAuth refresh against an isolated HTTP fixture, interruption recovery, unsafe replay, queues, abort, retry, streaming, compaction, extension metadata recovery and isolated permanent-purge boundaries.
- `pnpm -s build` then `pnpm -s test:durable-bot-desktop`: real Electron renderer/IPC, local scripted model server, real MCP process and isolated profile. Covers inherited deny/readonly settings, Tag switching, artifacts, memory recall/extraction, project resources/plans, cross-Bot project memory, attachment restoration, usage deduplication, MCP config refresh, scheduled success/failure, active app restart and retirement of an old design task. Reports and screenshots: `out/tests/durable-bot-desktop/`.
- `pnpm -s test:memory`, `test:project-memory-extraction`, `test:project-domain`, `test:builtin-capabilities`, `test:usage-stats`, `test:usage-recon` and `test:remote-access` cover the reused product domains.

The desktop test creates temporary profiles and uses fixture-only credentials; it does not replace the running installed application or migrate its live database.
