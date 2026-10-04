---
name: dim-feature-add
description: Evidence-first new-feature addition for MyBuddy/DimAgent (Electron+pi). Use when adding a UI feature, new metric, or new field that spans shared types, DB, main IPC, store, and renderer. Triggers on 添加新功能, 新增字段, 弹窗显示, 实时指标, cache hit rate, context usage, or any end-to-end shared→DB→main→store→UI 5-layer patch.
---

# Dim Feature Add — Evidence-First New Feature (9-Step Chain)

Transform a vague "add X to Y" request into a verified 5-layer patch without speculation.

## When to Use vs Not

**Use when:**
- User asks to display/calculate a new metric in an existing UI surface (e.g., "在上下文用量显示缓存命中率")
- Request touches `shared/*.ts` types → `main/db` → `main/agent` → `renderer/store` → `renderer/components` → `styles`
- Need to align with an existing pi/MyBuddy formula or event

**Do NOT use when:**
- Fixing a runtime bug, flaky test, or "works here but not there" — use `dimagent-debug`
- Pure exploration without code change — use `code-view`
- Docs/planning only — use `docs-sprint`

## Core Rule

**Explore before coding. Type before implementation. One formula, one event, five layers.**

A plausible placement is not a correct placement. A local calculation that duplicates an existing formula is a future inconsistency.

## Workflow — 9 Steps (Do in Order)

### 1. Anchor visual truth
If request includes a screenshot, call image read first. Extract app, version, target surface, and exact text/percentages. Do not rely on verbal description.

```
dim image read "<path>" --json --prompt "描述截图:界面,标注区域,上下文用量相关显示"
```

### 2. Probe project skeleton
List top-level dirs. Confirm `src/shared`, `src/main`, `src/renderer`, `node_modules/@earendil-works/pi-coding-agent` exist. Never write before knowing the layering.

### 3. Locate the UI entry by grep (Chinese literal)
Search the literal the user sees, not an English guess.

```
grep -r "上下文用量" src --files
```

Read the single component that owns it fully (e.g., `ContextUsageControl.tsx`). Record its props, state selectors, helper functions (`buildCategories`, `estimateChars`), and styling classes.

### 4. Trace data lineage backward
From component → store → IPC → main → pi:
- Store: `grep contextUsedTokens|contextWindowTokens appStore.ts`
- IPC: `grep ContextUsageDto|context_usage shared/agent-ipc.ts`
- Main emitter: `grep emitContextUsage AgentService.ts`
- DB snapshot: `grep setTaskContextUsage AppDatabase.ts`
- pi truth: `grep getSessionStats|getContextUsage pi-coding-agent/dist`

### 5. Read the canonical formula and event
- Formula lives in `shared/usage-stats.ts` (e.g., `cacheHitRate = cacheRead/(input+cacheRead+cacheWrite)`, denom≤0→null). Never redefine.
- Event lives in `AgentService` (`tool_execution_end|compaction_end|agent_end`). Real-time = hook existing emitter, not polling.

For pi semantics, read the installed dist file, not memory:
```
Select-String pi-coding-agent/dist/core/agent-session.js -Pattern getContextUsage -Context 5,30
```

### 6. Design the 5-layer patch (type-first)
Order matters:
1. `shared/agent-ipc.ts`: `AgentUiPatch` variant + `ContextUsageDto`
2. `main/db/AppDatabase.ts`: `CREATE TABLE` column + idempotent `ALTER TABLE ... ADD COLUMN` + `set/get`
3. `main/agent/AgentService.ts`: `sessionCacheHitRate()` from `getSessionStats().tokens` + `emitContextUsage` + `getContextUsage` live/snapshot branches
4. `renderer/store/appStore.ts`: `contextXxx` state + `applyAgentPatch` + `hydrate` (activeTaskId guard)
5. `renderer/components/*` + `styles/global.css`: isolated row/chip, not mixed into category percentages

See [references/checklist.md](references/checklist.md) for exact diff templates.

### 7. Implement smallest patch per layer
- Keep `CREATE TABLE` and `ALTER` in sync.
- Keep `ContextUsageDto` required (`number|null`), `AgentUiPatch.cacheHitRate` optional (`?: number|null`) for backward compat.
- Compute rate centrally in main; renderer only formats (`Math.round(x*1000)/10`).
- DB fallback: snapshot already contains rate; live `null` → UI shows `—`.

### 8. Handle boundaries explicitly
- Unknown: `null` → `—`, tooltip "暂无调用数据"
- Zero denom → `null` (not NaN)
- Color: `≥60% → #34c759`, else `#f5a623`, unknown → `var(--fg-muted)`
- Category bar: do not inject new metric into `buildCategories` palette (keeps sum=100%)

### 9. Validate
- `tsc --noEmit` (or `pnpm typecheck`) — shared type propagates to all layers
- Launch and open the popup: verify `—` before first call, `%` after `tool_execution_end`
- Restart app: verify snapshot restores (not `—`)
- Leave existing tests green; no broad refactor in same patch

## Tool Guidance

- Prefer `grep` with literal Chinese for UI, English field name for data.
- For large files (>30KB, e.g., `AppDatabase.ts` 3.7k lines, `appStore.ts` 5k+), read by offset, never whole file.
- Use `runtime_probe` only if the feature involves live interaction; for metric display, event grep is sufficient.
- Validate skill after edit: `python ~/.dimcode/v2/skills/skill-creator/scripts/quick_validate.py <skill-path>`

## Anti-Patterns

- Do not calculate hit rate in renderer from message history — duplicates pi truth.
- Do not bump `CURRENT_DATABASE_SCHEMA_VERSION` to add a display column — use idempotent `ALTER`.
- Do not merge new metric into `buildCategories` percentages.
- Do not create `README.md`/`CHANGELOG.md` inside the skill — only `SKILL.md` + `references/` + `scripts/`.

## References

- [checklist.md](references/checklist.md) — 5-layer diff templates, exact line patterns, and copy-paste guards
- [formula.md](references/formula.md) — pi-aligned formulas and when to reuse vs define

## Boundary / Output Contract

交付跨层最小修改、字段来源/计算口径、相关边界与实际验证结果。区分静态检查、构建与真实 Electron 行为；缺上游字段或可信事件时先报告数据缺口，不用 UI 假值补齐。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
