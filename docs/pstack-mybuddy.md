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

Without a `model` argument, selection uses the role's model, then the saved subagent default, then the global default. Unavailable configured defaults fall through with diagnostics. Selection fails if none is usable.

The native `reasoning` object has optional `enabled`, `effort`, and `budgetTokens` fields. An explicit preference must be supported by the selected model and represented losslessly by the current Pi worker transport. Supported effort values map to CLI thinking levels. Unsupported values, conflicting fields, and empty preferences fail. `budgetTokens` and toggle-only `{ enabled: true }` fail because this transport cannot represent them losslessly. They do not silently select another effort or the model default.

When `reasoning` is omitted, a saved subagent reasoning transport can apply if it is valid and bound to the selected model. Otherwise the worker uses the model default. Omission does not copy the parent's effort.

The schema lives in [index.ts](../src/main/capabilities/subagent/index.ts). Selection and strict errors live in [selection.ts](../src/main/capabilities/subagent/selection.ts). Native preference validation lives in [subagent-model-config.ts](../src/shared/subagent-model-config.ts).

## Subagent workspace isolation

`isolation` accepts these values.

- `auto` is the default. Parallel tasks with write-capable tools receive separate Git worktrees. Other tasks use the supplied working directory.
- `worktree` requests a separate Git worktree even for a single task or chain step.
- `shared` explicitly uses the supplied working directory. Parallel workers can then change the same files.

Worktree creation requires a Git repository with a committed `HEAD` and a clean working tree, including untracked files. Dirty or non-Git input fails before the worker launches. The tool does not commit, stash, or snapshot dirty input. A task started from a repository subdirectory keeps that relative directory inside its worktree.

Worktrees use separate branches based on the source commit. Their files and branches remain after completion, failure, or cancellation. The tool does not automatically merge or delete them. Result text and details contain workspace information and the receipt path. A receipt records the source repository, base commit, branch, worktree paths, and provisioning state. A failed provisioning attempt reports retained paths when allocation has occurred. A `ready` receipt describes workspace provisioning, not task completion.

`subagent_list` lists active workers. `subagent_steer` guides active work without changing the selected model. Completed worktree artifacts remain accessible through their receipts rather than through the active-worker list.

Workspace creation and receipts live in [worktree.ts](../src/main/capabilities/subagent/worktree.ts). Execution and results live in [index.ts](../src/main/capabilities/subagent/index.ts). Pi worker startup and model readback live in [runtime.ts](../src/main/capabilities/subagent/runtime.ts). The trusted Pi entry is [worker-launcher.mjs](../src/main/capabilities/subagent/worker-launcher.mjs).

## Other pstack capability mappings

These tools are registered conditionally. Their presence depends on the configured capability and service availability.

- `skill_authoring_assess(intent, model_id?)` assesses whether to create, reuse, improve, or avoid a skill. It does not write files. `skill_authoring_create(intent, force_create?, model_id?)` runs the creation gate again and installs a new skill disabled by default. `force_create` requires an explicit user request to bypass the gate.
- `ui_exec` observes and operates MyBuddy's own interface, embedded browser, and Artifact pages through Electron input events. `browser_exec` operates MyBuddy's browser through enumerated actions. Neither tool executes arbitrary page JavaScript.
- `runtime_probe` reads bounded runtime evidence, including console events, exceptions, navigation failures, renderer exits, focus, and document state. It does not modify product state.
- `execute_code` runs one-shot code in the task directory when code execution is enabled and native execution has not replaced this tool. It supports JavaScript, managed Python, shell, and PowerShell on supported platforms. JavaScript uses Node ESM. Python script mode accepts scripts in task or skill directories and uses the managed runtime.

The registration conditions, schemas, and descriptions are in [builtin-capability-extension.ts](../src/main/capabilities/builtin-capability-extension.ts).

Cursor `/loop` and Cursor cloud agents are not MyBuddy capabilities supplied by these mappings. A local worktree does not create a cloud agent. A repeated prompt does not establish a durable `/loop` implementation.

A GitHub MCP configured as read-only remains read-only. A skill cannot grant it write access. GitHub writes through `gh` require an available CLI, suitable authentication, and authorization for the requested write. This reference does not assert that `gh` is installed or authenticated.

## Relevant test scripts

These scripts define the corresponding checks. This reference does not report an execution result.

- [subagent-selection-test.ts](../scripts/subagent-selection-test.ts) covers explicit model rejection, parent selection, configured fallback, and native reasoning constraints.
- [subagent-worktree-test.ts](../scripts/subagent-worktree-test.ts) covers workspace isolation and retained provisioning receipts.
- [subagent-pstack-execution-test.ts](../scripts/subagent-pstack-execution-test.ts) exercises the registered tool and real Pi workers against a local fixture provider. It checks distinct models, reasoning in provider requests, isolated writes, receipts, and parent selection.
- [subagent-model-ui-test.ts](../scripts/subagent-model-ui-test.ts) covers saved native preferences and CLI transport limits.

The script commands are declared in [package.json](../package.json).
