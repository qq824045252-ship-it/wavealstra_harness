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

## Parallel limits

`index.ts` exports the hard caps; `subagent.json` may only lower them (never raise):

| Constant | Default | Meaning |
|---|---|---|
| `MAX_PARALLEL_TASKS` | **200** | tasks allowed in one `parallel` call (exceeding it fails the whole call) |
| `MAX_CONCURRENCY` | **100** | worker processes alive at once; the rest queue in array order |
| `PER_PARALLEL_TOTAL_OUTPUT_CAP` | 400 KB | total text returned to the main model per `parallel` call; per-task cap = `min(50 KB, total / n)` |
| `MAX_SUBAGENT_DEPTH` | 2 | subagents cannot delegate further |
| `MAX_IDLE_WORKERS` | 3 | idle process pool kept warm for reuse (not a task limit) |
| `WORKER_START_TIMEOUT_MS` | 45 s | readiness timeout, widened for 100-way cold starts |

Cost warning measured on this machine: one Pi worker ≈ **200 MB RSS**, so 100 concurrent
≈ **20 GB** — more than the 10 GB that was free when the cap was raised. Lower
`maxConcurrency` (e.g. 24) if runs start failing with OOM/exit errors. 100 concurrent
model calls can also hit provider rate limits; those surface per-task as failures.

```json
// ~/.mybuddy/subagent.json — optional, only lowers the caps
{ "maxParallelTasks": 200, "maxConcurrency": 24 }
```

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
