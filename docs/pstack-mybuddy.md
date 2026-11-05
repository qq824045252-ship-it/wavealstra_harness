# pstack in MyBuddy

This reference describes MyBuddy's native tools that pstack skills can use. Skill instructions do not add tool parameters, provider access, or permissions.

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

The schema lives in [index.ts](../src/main/capabilities/subagent/index.ts). Selection, role resolution, and diverse assignment live in [selection.ts](../src/main/capabilities/subagent/selection.ts). Native preference validation lives in [subagent-model-config.ts](../src/shared/subagent-model-config.ts).

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

- `auto` is the default. Parallel tasks with write-capable tools receive separate Git worktrees. Other tasks use the supplied working directory.
- `worktree` requests a separate Git worktree even for a single task or chain step.
- `shared` explicitly uses the supplied working directory. Parallel workers can then change the same files.

Worktree creation requires a Git repository with a committed `HEAD` and a clean working tree, including untracked files. Dirty or non-Git input fails before the worker launches. The tool does not commit, stash, or snapshot dirty input. A task started from a repository subdirectory keeps that relative directory inside its worktree.

Worktrees use separate branches based on the source commit. Their files and branches remain after completion, failure, or cancellation. The tool does not automatically merge or delete them. Result text and details contain workspace information and the receipt path. A receipt records the source repository, base commit, branch, worktree paths, and provisioning state. A failed provisioning attempt reports retained paths when allocation has occurred. A `ready` receipt describes workspace provisioning, not task completion.

`subagent_list` lists active workers. `subagent_steer` guides active work without changing the selected model. Completed worktree artifacts remain accessible through their receipts rather than through the active-worker list.

Workspace creation and receipts live in [worktree.ts](../src/main/capabilities/subagent/worktree.ts). Execution and results live in [index.ts](../src/main/capabilities/subagent/index.ts). Pi worker startup and model readback live in [runtime.ts](../src/main/capabilities/subagent/runtime.ts). The trusted Pi entry is [worker-launcher.mjs](../src/main/capabilities/subagent/worker-launcher.mjs).

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
- [subagent-pstack-execution-test.ts](../scripts/subagent-pstack-execution-test.ts) exercises the registered tool and real Pi workers against a local fixture provider. It checks distinct models, reasoning in provider requests, isolated writes, receipts, and parent selection.
- [subagent-model-ui-test.ts](../scripts/subagent-model-ui-test.ts) covers saved native preferences and CLI transport limits.
- [cron-scheduling-test.ts](../scripts/cron-scheduling-test.ts) covers real SQLite, timers, cancellation races, quotas, deadlines, restart policy, and task scope with a fixture agent.
- [local-workflow-integration-test.ts](../scripts/local-workflow-integration-test.ts) executes a real timed AgentService and Pi session against a local HTTP fixture provider. It verifies tool registration, permissions, persisted output, and the authoritative task directory.
- [task-terminal-live-test.ts](../scripts/task-terminal-live-test.ts) drives a real TUI and checks screen rendering, input, resize, Ctrl-C, exit, active child cleanup, and preservation of a separate user terminal. Windows and Linux require separate executions.
- [validate-local-workflow-package.cjs](../scripts/validate-local-workflow-package.cjs) starts the actual packaged app with an isolated profile. Its local provider calls the real terminal and scheduling tools, then verifies scheduled continuation and the Automation page.

The script commands are declared in [package.json](../package.json).
