# pstack in MyBuddy

This reference describes MyBuddy's native tools that pstack skills can use. Skill instructions do not add tool parameters, provider access, or permissions.

## Frozen Bot / Work design

[BOT-WORK-1.0](bot-work-design.md) and its [acceptance contract](bot-work-acceptance.md) define the frozen target architecture for persistent bot identities, independent work ownership, foreground/background hosts, and collaboration. They describe target behavior pending implementation and validation. The capability mappings below describe the current execution foundation and do not imply that the frozen product design is already implemented.

## Subagent model and reasoning selection

The `subagent` tool accepts `model`, `reasoning`, and `isolation` for a single task and for each entry in `tasks` or `chain`. In array modes, the top-level fields provide defaults. An item's explicit fields override those defaults. An item's `reasoning` replaces the whole top-level object, without a deep merge.

```typescript
{
	agent: "worker",
	task: "Inspect the selected module and report findings.",
	model: "inherit-parent",
	reasoning: { effort: "high" },
	isolation: "shared"
}
```

```typescript
{
	isolation: "auto",
	reasoning: { effort: "high" },
	tasks: [
		{ agent: "worker", task: "Implement the parser.", model: "provider/model-a" },
		{ agent: "worker", task: "Implement the formatter.", model: "provider/model-b",
			reasoning: { effort: "low" } }
	]
}
```

The provider/model names above are placeholders. An explicit `model` requires a qualified `provider/model` reference that is available in the native Pi model scope. Unknown or unavailable explicit choices fail before worker launch. The tool does not replace an explicit choice with a different model.

`model: "inherit-parent"` and `model: "auto"` select the current parent model. They fail if the parent model is missing or unavailable. They inherit the model only, not the parent's reasoning preference. Multiple workers on that same model do not constitute a multi-model review.

Without a `model` argument, selection uses the role's model, then the saved subagent default, then the global default. Unavailable configured defaults fall through with diagnostics. Selection fails if none is usable. Omitting `model` is not inheritance.

### Display names

`displayName` is an optional display-only name for a single task, or per entry in `tasks` / `chain`. It accepts any language and appears in the task's subagent list and panel. The ASCII `subagentId` remains the only identity: steering, file names, worker arguments, and duplicate detection all keep using it, so names may repeat. Input is normalized (trimmed, control and format characters removed, 32 code points max).

When omitted, the product assigns a name automatically: a random unused entry from the 151 Gen-1 species in Simplified Chinese (for example 皮卡丘), avoiding display names already held by active subagents in the same task. A batch may only be unique up to those 151 names; larger concurrent batches repeat names, and that is harmless because identity never depends on the display name. An explicit `displayName` always overrides the automatic pick.

```typescript
{
	agent: "scout",
	subagentId: "pikachu",
	displayName: "皮卡丘",
	task: "Read the target module and report findings."
}
```

### Model roles

`~/.mybuddy/subagent.json` may declare `roles`, a map from a role name to an ordered candidate list. Passing that role name as `model` lets the product pick the first candidate that exists in the native model scope.

```json
{
  "roles": {
    "fast": ["provider/light-model"],
    "strong": ["provider/strong-model-a", "provider/strong-model-b"],
    "diverse": ["provider/model-a", "provider/model-b", "provider/model-c"]
  }
}
```

A role resolves only through its declared candidates. When none is available the call fails with the candidate list. It does not fall back to a default model, and the product never scores or guesses a model from names, context length, or output limits. The result reports `resolvedModel`, `modelRole`, `roleCandidates`, `resolvedThinking`, `modelSource`, and the worker's `actualModel`, so the caller can confirm what the worker ran.

An unconfigured name is treated as an explicit `provider/model` reference and fails its format or availability check. `roles.diverse` is reserved for fan-out: with `model: "diverse"` on `tasks` or `chain`, each task receives a different available candidate. If the number of distinct available candidates is smaller than the task count, the tool refuses to run instead of repeating one model across a panel. A single-task call with `model: "diverse"` fails for the same reason. A diverse panel requires at least two tasks and cannot mix diverse selection with explicit models. Provider and routing prefixes are ignored when comparing terminal model names. This rejects aliases with the same model name; it cannot verify an opaque gateway\'s upstream implementation.

The native `reasoning` object has optional `enabled`, `effort`, and `budgetTokens` fields. An explicit preference must be supported by the selected model and represented losslessly by the current Pi worker transport. Supported effort values map to CLI thinking levels. Unsupported values, conflicting fields, and empty preferences fail. `budgetTokens` and toggle-only `{ enabled: true }` fail because this transport cannot represent them losslessly. They do not silently select another effort or the model default.

When `reasoning` is omitted, a saved subagent reasoning transport can apply if it is valid and bound to the selected model. Otherwise the worker uses the model default. Omission does not copy the parent's effort.

The schema lives in [shared.ts](../src/main/capabilities/subagent/shared.ts) and is wired into the Durable tools in [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts). Selection, role resolution, and diverse assignment live in [selection.ts](../src/main/capabilities/subagent/selection.ts). Native preference validation lives in [subagent-model-config.ts](../src/shared/subagent-model-config.ts).

## Subagent execution settings

Open **Settings → Models → Subagent execution limits**. These controls save to `~/.mybuddy/subagent.json` and apply to subsequent runs without restarting the app. A running app built before these controls were introduced needs a normal restart into the updated build.

- **Limit subagent models** intersects the checked list with enabled models in the app and workspace. An unset `allowedModels` permits every model in that scope; `[]` blocks all subagents. The limit applies to explicit choices, parent inheritance, role defaults, role candidates, and diverse panels. Workers recheck it before requests. The default-model dropdown alone is not a model restriction.
- **Role candidates** edits the ordered `roles` lists. A provider error ends the run; it does not try a different candidate. `diverse` requires enough distinct allowed models for the panel.
- **Total run limit in seconds** stores `timeoutMs`. The default is 600 seconds, and valid settings range from 1 to 3600 seconds. The limit starts when the ready worker receives its task and includes model calls and tool execution. It is not an idle timeout and does not reset on progress.
- **Fixed at this value** is the default `timeoutPolicy`. It ignores per-call `timeout_ms`. **Callers may override each run** stores `allow-override` and permits that parameter to replace the configured duration. Each result reports `timeoutMs` and `timeoutSource`.

Settings saves submit only changed fields, reject stale revisions, and atomically replace the file. Invalid configuration fails explicitly instead of removing restrictions. A runtime worker crash returns a bounded, redacted stderr tail with its exit code. API errors, cancellations, and timeouts remain distinct results.

The shared contract is [subagent-execution-policy.ts](../src/shared/subagent-execution-policy.ts). [subagent-settings-test.ts](../scripts/subagent-settings-test.ts) checks selection and duration policy. [validate-subagent-settings-package.cjs](../scripts/validate-subagent-settings-package.cjs) drives the actual packaged settings page, saves and reloads controls, rejects stale writes, and verifies real worker requests against a local provider.

## Subagent workspace isolation

`isolation` accepts these values.

- `auto` is the default. It isolates only a dispatch that can run more than one concurrent writer: a `tasks` dispatch whose items have write-capable tools and that resolves to more than one runnable item with `maxConcurrency` above one. Every other dispatch uses the supplied working directory. That covers a single task, a `chain`, a read-only toolset, a `tasks` array with one item, one runnable item after the others were rejected, and `maxConcurrency=1`.
- `worktree` requests a separate Git worktree even for a single task or chain step.
- `shared` explicitly uses the supplied working directory. Parallel workers can then change the same files.

The isolation decision is made once, while the dispatch is planned, and each child then runs exactly that decision. It counts only items that resolved to a usable role, model, and toolset, so a rejected item neither forces nor prevents a worktree for its peers. The result states the decision: an isolated task reports `Retained worktree:`, and a task in the supplied directory reports `Workspace: shared (<cwd>); <reason>`. The reason is also available in the tool details as `isolationNote`. It explains the resolution instead of announcing a degraded run:

- A single task: `isolation:auto does not isolate a single task; writes land in the original directory`.
- A `chain`: `isolation:auto does not isolate chain steps; each step writes to the original directory`.
- A read-only toolset: `isolation:auto keeps the supplied directory because the toolset is read-only`.
- A `tasks` dispatch that runs one child, because the array has one item or the other items were rejected: `isolation:auto does not isolate a dispatch that runs one child; writes land in the original directory`.
- An effective concurrency of one: `isolation:auto needs more than one concurrent writer; maxConcurrency=1 keeps the supplied directory`.
- An explicit `shared`: `isolation:"shared" was selected; writes land in the original directory, not an isolated copy`.

When the caller passes `isolation:"auto"` explicitly and that dispatch does not isolate, the line ends with `isolation:"auto" has no isolation effect here; pass isolation:"worktree" to force a separate worktree.` Use `worktree` when a separate working tree is required; `auto` does not create one for those dispatches.

Worktree creation requires a Git repository with a committed `HEAD` and a clean working tree, including untracked files. The tool does not commit, stash, or snapshot dirty input. This precondition is checked before any child starts. In a `tasks` or `chain` dispatch, an item that cannot be isolated is rejected before start without creating a child: the other `tasks` items still run, and a `chain` stops at that step. A single-task call fails as a whole. A task started from a repository subdirectory keeps that relative directory inside its worktree.

Worktrees use separate branches based on the source commit. Their files and branches remain after completion, failure, or cancellation. The tool does not automatically merge or delete them. Result text and details contain workspace information and the receipt path. A receipt records the source repository, base commit, branch, worktree paths, and provisioning state. A failed provisioning attempt reports retained paths when allocation has occurred. A `ready` receipt describes workspace provisioning, not task completion.

`subagent_list` lists active workers. `subagent_steer` guides active work without changing the selected model. Completed worktree artifacts remain accessible through their receipts rather than through the active-worker list.

Workspace creation and receipts live in [worktree.ts](../src/main/capabilities/subagent/worktree.ts). Dispatch, execution, and results run as durable child conversations in [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts). The trusted Pi entry is [worker-launcher.mjs](../src/main/capabilities/subagent/worker-launcher.mjs).

## Subagent concurrency, write conflicts, and timeouts

These limits belong to the whole subagent runtime and are not per-call options. The result reports how every item ended.

- **Concurrency.** The product accepts up to 200 tasks per dispatch and runs up to 100 workers at once. These are product defaults, not provider quotas. A dispatch uses a rolling pool: up to `maxConcurrency` children run at once, a finished child frees its slot immediately so the next waiting item starts without waiting for the rest of a batch, and the `Concurrency:` line reports how many items are waiting for a slot. Set `maxConcurrency` in `~/.mybuddy/subagent.json` to run fewer workers at once; the setting can only lower the product default and cannot raise it.
- **Provider concurrency quota.** The upstream provider may enforce a lower membership concurrency quota, for example 10 for a given plan. The product does not know that quota, so requests above it fail with HTTP 400 `tier_limit_exceeded` / `membership concurrency limit exceeded`, not with 429. Set `maxConcurrency` below the provider quota to avoid the rejection. After the pool has drained, each affected item is retried once, serially, under a new request id and inside the original deadline; the retry is not guaranteed to succeed across a provider quota window. A recovered item is reported with its final outcome, the header adds `<n> recovered after provider concurrency limit`, and its diagnostics include `retried after provider concurrency rejection (attempt 2)`.
- **Result reporting.** A `tasks` dispatch reports `Parallel: <clean>/<total> succeeded (...)` and, when at least one item actually runs, a second line `Concurrency: <workers> worker(s), <queued> queued (maxConcurrency <max>)`; an all-rejected batch has no pool to describe and omits that line. `total` is every item in that dispatch, including rejected ones. `succeeded` counts clean completions only. The parenthesized segments appear only when they apply, joined with `; `: `<n> blocked by write conflict: parallel subagents must write different files`, `<n> rejected before start`, `<n> recovered after provider concurrency limit`. The `Concurrency:` line writes `no queue` when no item is waiting, so a raised cap is distinguishable from queued work. Each item then has its own block headed `### [<agent>] completed|failed|blocked|rejected (id: <id>)`, where a failure appends its stop reason, for example `failed (error)`; a `chain` uses `Step <n>: [<agent>] <status> (id: <id>)`. A single-task result and a `chain` have no `Parallel:` or `Concurrency:` line. Tool details carry `mode`, `agentScope`, `projectAgentsDir`, `concurrency: { workers, queued, maxConcurrency }`, and one result per item. `isError` is true when any item is not a clean completion.
- **Per-item rejection.** Item-scoped configuration errors reject that item only: an unknown agent, a `cwd` outside the task workspace, an unavailable or settings-blocked model, and a failed isolation preflight. No child conversation is created for it. Its block reports the reason, and the details record `status: "error"`, `exitCode: 1`, and `rejected: true`. The valid items still run and report their own results. A single-task call fails as a whole instead, and in a `chain` a rejected step stops the remaining steps, with the result naming the step that stopped.
- **Write conflicts.** Concurrent writes to the same file are not supported and there is no compare-and-swap: `write` carries only `{ path, content }`. A parallel dispatch with more than one worker therefore guards `write` and `edit` per dispatch: the first worker to write a path owns it for the rest of that dispatch, and any other worker writing the same path is blocked with an explicit conflict error that names the path, both worker ids, and the fix. The blocked write is not performed, so no content is silently lost. The affected item is reported as `blocked` rather than `completed` and does not count in `succeeded`: the header says `<n> blocked by write conflict: ...`, its diagnostics keep the `write conflict blocked: <path> already written by <id> (<tool>)` line, and the details keep its durable status `completed` plus a `writeConflicts` array with one entry per blocked write. `isError` is true. A single task and `chain` steps are not guarded, because a later step may legitimately rewrite an earlier step's file. Writes that go through `bash` or `powershell` bypass the guard, and parallel workers that each got their own worktree write different paths, so they never conflict. The guard is [write-conflict.ts](../src/main/capabilities/subagent/write-conflict.ts); dispatch-time ownership is registered in [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts) and enforced from the tool hook in [AgentService.ts](../src/main/agent/AgentService.ts).
- **Isolation.** `auto` isolates only a dispatch that can run more than one concurrent writer: a parallel `tasks` dispatch with write-capable tools and an effective concurrency above one. A single task, a `chain`, a read-only toolset, a one-item `tasks` array, a dispatch that ends up with one runnable item, and `maxConcurrency=1` use the supplied working directory, and their result says why. `worktree` forces a separate worktree for any task. Isolation prerequisites are checked before any child starts: a non-Git directory or a dirty tree, including untracked files, fails explicitly and never degrades silently to the shared directory. Under `auto` that check applies only to the dispatches auto isolates. Choose `shared` deliberately when the working directory is not a clean Git repository. The evidence lines are listed under Subagent workspace isolation above.
- **Timeouts.** With the default `timeoutPolicy: "fixed"`, a per-call `timeout_ms` is ignored and not rejected; the configured duration applies. Diagnostics still identify the request and the effective value: `timeout_ms=<n> ignored: fixed policy (<m>s settings)`, plus `timeoutMs` and `timeoutSource: "settings"`, with the evidence line `Run time limit: <m>s (settings)`. That call does not test a `timeout_ms` override; to test one, switch the policy: open **Settings → Models → Subagent execution limits** and change **Fixed at this value** to **Callers may override each run**, then pass a valid `timeout_ms` (1 to 3600 seconds) to a slow task. The run then reports `timeoutSource: "invocation"` and `Run time limit: <n>s (invocation)`; a run that exceeds the limit ends with `status: "timedout"`, `exitCode: 1`, and `isError: true`. The deadline is set when the child conversation is created, so steering does not extend it.

## Skill policy needles

Mode, project, and tag skill policies separate hard lists from ranking lists.

- `hide` and `allow` match skill identity only. A needle matches when it equals the skill `id`, `name`, or `command`, case-insensitive after trimming. A short list word cannot become a substring rule, so `allow: ["bro"]` no longer admits `ego-browser` through its description.
- `prefer` and `demote` keep the historical ranking semantics: identity first, then a case-insensitive substring over `id`, `name`, `command`, and `description`.
- Any needle may opt into substring matching with the `keyword:` prefix. `keyword:arch` matches `archify`; a bare `arch` does not. Stored policies that relied on the old implicit substring behavior in `hide` or `allow` must be rewritten as `keyword:<needle>`; nothing converts them silently.

The main-process decision and the renderer `+` menu read the same functions. Hard lists use `matchesSkillIdentityNeedles`, ranking uses `matchesSkillPolicyNeedles`, both in [runtime-policy.ts](../src/shared/runtime-policy.ts). The UI filter is [mode-access-filter.ts](../src/shared/mode-access-filter.ts); the catalog text and skill filtering are in [SkillPolicy.ts](../src/main/agent/SkillPolicy.ts).

## Other pstack capability mappings

These tools are registered conditionally. Their presence depends on the configured capability and service availability.

- `skill_authoring_assess(intent, model_id?)` assesses whether to create, reuse, improve, or avoid a skill. It does not write files. `skill_authoring_create(intent, force_create?, model_id?)` runs the creation gate again and installs a new skill disabled by default. `force_create` requires an explicit user request to bypass the gate.
- `ui_exec` observes and operates MyBuddy's own interface, embedded browser, and Artifact pages through Electron input events. `browser_exec` operates MyBuddy's browser through enumerated actions. Neither tool executes arbitrary page JavaScript.
- `runtime_probe` reads bounded runtime evidence, including console events, exceptions, navigation failures, renderer exits, focus, and document state. It does not modify product state.
- `execute_code` runs one-shot code in the task directory when code execution is enabled and native execution has not replaced this tool. It supports JavaScript, managed Python, shell, and PowerShell on supported platforms. JavaScript uses Node ESM. Python script mode accepts scripts in task or skill directories and uses the managed runtime.

The registration conditions, schemas, and descriptions are in [builtin-capability-extension.ts](../src/main/capabilities/builtin-capability-extension.ts).

`automation_exec` provides local task-owned scheduling with create, list, runs, pause, resume, and cancel. It reuses CronService and SQLite run history. Targets distinguish continuing the current task from creating a new task. The current task keeps its model, permissions, workspace, and conversation. New tasks follow the normal task-workspace resolver. Intervals such as `90s` are elapsed durations, not converted calendar expressions. Busy targets skip a tick without queueing. Quotas and deadlines stop future runs. Restart policy either resumes future ticks without catch-up or pauses the job. Cancellation stops future starts, not a turn already in progress.

`terminal_exec` provides open, list, read, input, resize, and close for model-owned PTYs. Generated terminal IDs and session IDs bind every operation to its source task. Reads return the ANSI-parsed screen, cursor, size, and exit state. A bounded literal wait reports matched, timeout, or exited. Each task can own four active terminals. Stopping the task cleans its model terminals without closing user terminals. The terminal capability flag and permission policy apply.

The tools appear only when the application has registered their services. An older running process does not gain them through a skill edit. Scheduling requires the local application to remain running. There is no execution while the application is closed or the machine is asleep. Neither local scheduling nor a worktree provides Cursor cloud execution. Do not substitute a long shell sleep for persistent scheduling.

A GitHub MCP configured as read-only remains read-only. A skill cannot grant it write access. GitHub writes through `gh` require an available CLI, suitable authentication, and authorization for the requested write. This reference does not assert that `gh` is installed or authenticated.

## Relevant test scripts

These scripts define the corresponding checks. This reference does not report an execution result.

- [subagent-selection-test.ts](../scripts/subagent-selection-test.ts) covers explicit model rejection, parent selection, configured fallback, and native reasoning constraints.
- [subagent-worktree-test.ts](../scripts/subagent-worktree-test.ts) covers workspace isolation and retained provisioning receipts.
- [durable-subagent-test.ts](../scripts/durable-subagent-test.ts) runs Durable child conversations against a local fixture provider. It covers child identity, model, display name, bound cwd, restart reattachment, and completed-effect reuse; the `Parallel:` and `Concurrency:` header lines with per-item status; the rolling pool; dispatch-time isolation preflight, one rejected item among valid ones, and a lone surviving item staying in the supplied directory; blocked-write counting; a provider quota rejection recovered by one deferred retry; the ignored `timeout_ms` diagnostic and an `allow-override` run that ends `timedout`; and `chain` steps, including a rejected step that stops the chain after the steps before it keep their results.
- [subagent-write-conflict-test.ts](../scripts/subagent-write-conflict-test.ts) covers the write guard directly: path claims, cross-child `write` and `edit` conflicts, repeated writes by the same child, different paths and working directories, and the hook entry that production installs.
- [subagent-model-ui-test.ts](../scripts/subagent-model-ui-test.ts) covers saved native preferences and CLI transport limits.
- [cron-scheduling-test.ts](../scripts/cron-scheduling-test.ts) covers real SQLite, timers, cancellation races, quotas, deadlines, restart policy, and task scope with a fixture agent.
- [local-workflow-integration-test.ts](../scripts/local-workflow-integration-test.ts) executes a real timed AgentService and Pi session against a local HTTP fixture provider. It verifies tool registration, permissions, persisted output, and the authoritative task directory.
- [task-terminal-live-test.ts](../scripts/task-terminal-live-test.ts) drives a real TUI and checks screen rendering, input, resize, Ctrl-C, exit, active child cleanup, and preservation of a separate user terminal. Windows and Linux require separate executions.
- [validate-local-workflow-package.cjs](../scripts/validate-local-workflow-package.cjs) starts the actual packaged app with an isolated profile. Its local provider calls the real terminal and scheduling tools, then verifies scheduled continuation and the Automation page.

The script commands are declared in [package.json](../package.json).
