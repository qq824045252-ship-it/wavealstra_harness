# Subagent Capability

Subagent is a MyBuddy product capability, compiled into the Main process from
`src/main/capabilities/subagent`. It is not a user-installable Pi extension and
is never discovered from `~/.mybuddy/extensions`.

The capability registers `subagent`, `subagent_list`, and `subagent_steer`
through Pi's ExtensionAPI. Pi is the runtime/ABI; MyBuddy owns capability
selection, lifecycle, permission policy, IPC integration, and worker execution.

## Runtime model

Each subagent instance is a task-scoped disposable worker. It inherits the task
cwd and selected role prompt, while permission/tool restrictions are computed by
the MyBuddy host. Worker execution uses the Pi RPC CLI with explicit tool
allow/exclude policy and a hard recursion-depth limit.

## Sources

- `index.ts`: capability registration and task-scoped orchestration
- `runtime.ts`: worker lifecycle and registry
- `rpc.ts`: Pi RPC child-process protocol
- `policy.ts`: child tool policy
- `agents.ts`: role discovery
- `config.ts`: model/thinking configuration
- `context.ts`: child context contract
- `invocation.ts`: executable/CLI resolution

## Role directories (agent scope)

`agents.ts` resolves roles from up to three directories; later entries override
earlier ones on the same `name`:

| Scope | Directory | Notes |
|---|---|---|
| user | `<PI_CODING_AGENT_DIR>/plugins/agents` | **MyBuddy product location** (`src/main/paths.ts` `getAgentsDir()` → `~/.mybuddy/plugins/agents`). Ships `planner` / `reviewer` / `scout` / `worker`. |
| user | `<PI_CODING_AGENT_DIR>/agents` | User overrides (`~/.mybuddy/agents`). Not created by default. |
| project / both | nearest `<cwd>/.pi/agents` | Repo-local roles; still gated by the project-agent confirmation prompt. |

Because `PI_CODING_AGENT_DIR` is redirected to `~/.mybuddy` by the host
(`src/main/agent-environment.ts`), the product directory is what makes
`agentScope: "both"` (or the default `user`) find `worker`. Skipping it produced
the historical `Unknown agent: "worker"` failure; `MYBUDDY_AGENTS_DIR` can point
the product directory elsewhere (tests/deployment). Unknown-agent errors now
print the searched directories and the effective scope.

The tests under `test/` exercise protocol, policy, lifecycle, and real-worker
behavior. Product regression tests also live under the repository `scripts/`
directory. Agent discovery specifically is covered by
`scripts/subagent-agent-discovery-test.ts` (`pnpm -s test:subagent-agent-discovery`).
