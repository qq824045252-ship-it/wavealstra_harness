# MyBuddy (`wavealstra_harness`) — Architecture Assessment

Scope: 1283 tracked `.ts`/`.tsx` files, ~316k lines. Layers `src/main` (357 files), `src/renderer/src` (261), `src/shared` (84), `src/preload` (3).
Method: git-aware file inventories, regex/AST-lite counts via PowerShell + .NET reads, DFS cycle detection over resolved module edges (2590 edges), cross-checked against the vendored Pi upstream typings at `artifacts/pi100-upgrade/upstream/pi-coding-agent/package`. Read-only; no source file modified.

---

## VERDICT

**Grade: B+** — a genuinely well-layered application with two specific, localized quality debts (error swallowing in the persistence layer; two very large files) and one real gap (no mechanical architecture enforcement).

- **Layer boundary integrity is the standout strength and is measurably clean.** Zero renderer→main imports (`0/261` renderer files contain the token `src/main` or `@main`). Zero cross-layer imports in any direction. Only **2** exported type names are declared in both main and renderer, of which just **1** (`PermissionMode`) also exists in `src/shared`. Deep relative imports (`>=3` × `../`) number **86**, and *every one* resolves into `src/shared`, not across layers — a cosmetic complaint, not a coupling defect.
- **Concentration risk is real but narrow.** `src/main/index.ts` is a **412-handler / 441-registration flat wiring table** spanning 34 `*Ipc` namespaces and 3421 LOC — a true dumping ground. However **423 of 441** handler lines are thin delegations (<140 chars) and wiring is **96%** centralized here (`index.ts` + only 3 other files register handlers), so the concentration is a navigation/maintainability cost, not a logic-coupling cost.
- **Error handling is the weakest dimension.** **79 literal empty `catch {}` blocks** in 23 files (`LibraryService.ts` alone: 15), plus **15** empty `.catch(() => {})`. In `LibraryService.refreshChunksForItem` (`:1217-1243`) these silently discard embedding-invalidation failures with no log, creating a silent-index-corruption class of bug. Counter-evidence: there are **0** TODO/FIXME/HACK markers repo-wide and only **86** `as any` in all of `src/main`, so this is disciplined-but-overbroad defensive coding, not neglect.
- **Testing is genuinely behavioral, not snapshot theater.** **0** snapshots, **0** test frameworks (`describe`/`it`/`expect` all zero); tests are **285** hand-written harnesses using `node:assert` (**3144** assertions, **4.8 per 100 LOC**) that import real `src/main` services **688** times against only **181** `src/shared` type imports. Real behavior is exercised. Cost: **441** `as any` casts in test code revert the strict typing those tests validate.
- **No mechanical enforcement of dependency direction exists.** No ESLint, no `eslint.config.*`, no dependency-cruiser, no madge anywhere outside `node_modules`; the only devDeps are typescript/electron/vite/react. The clean layering above is **convention + tsconfig `include` scoping**, not a gate — so it is unprotected against regression. The Pi extension seam, by contrast, **is real and non-trivial** (see §6).

---

## 1. Layer boundary integrity

**Clean.** Direction of dependency is `preload/renderer → shared ← main`; no back-edges found.

| Check | Result |
|---|---|
| Renderer files importing `src/main` / `@main` | **0** of 261 |
| Cross-layer relative imports (main→renderer/preload, shared→main/renderer, …) | **0** |
| Relative specifiers with `>=3` × `../` | **86** |
| … of those, resolving into `src/shared` | **86 / 86** |
| Types exported in *both* main and renderer | **2** (`PermissionMode`, `ThinkingLevel`) |
| … also present in `src/shared` | **1** (`PermissionMode`) |

Worst deep-import examples are depth-5 but all target shared:
- `src/renderer/src/components/pages/library/LibraryPage.tsx` → `../../../../../shared/library-ipc`
- `src/renderer/src/components/pages/library/LibraryDocumentView.tsx` → `../../../../../shared/library-ipc`
- depth-4 ×19: `src/renderer/src/components/pages/AutomationPage.tsx` → `../../../../shared/mode-profile` / `shared/agent-ipc` / `shared/expert-id`; `src/renderer/src/components/chat/ToolCallCard.tsx` → `../../../../shared/external-write`.

**Assessment.** Severity **Low**. The `@shared/*` alias exists and is used **189** times, but ~694 `@/` (renderer-local) and 86 deep-relative reads coexist, so path style is inconsistent. `PermissionMode`/`ThinkingLevel` being declared in both `src/main` and `src/renderer` while also (for `PermissionMode`) in `src/shared` is a genuine but trivial single-name duplication.

tsconfig enforces the boundary *structurally*: `tsconfig.web.json` includes only `src/renderer/src`, `src/shared`, `src/preload/index.d.ts`; `tsconfig.node.json` includes `src/main`, `src/preload`, `src/shared`. A renderer file importing main would fail `pnpm typecheck`. **This is a real, active guard** — but it is incidental to build config rather than an explicit architectural rule, and it does not prevent new main-internal coupling *within* main.

## 2. God files / concentration risk

Top 10 by LOC, with composition metrics (`imp`=import stmts, `exp`=exports, `ipc`=`ipcMain.handle/on`):

| # | File | LOC | imp | exp | Composition verdict |
|---|---|---|---|---|---|
| 1 | `src/renderer/src/store/appStore.ts` | 6323 | 42 | 30 | **Cohesive by design** — 39 fns + 27 arrow actions over one Zustand store; single concern (app state), 0 `useState`. Large but not a dumping ground. |
| 2 | `src/main/agent/AgentService.ts` | 5806 | **138** | 3 | **Most coupled file.** 138 imports, 1 class, only 3 exports. Legitimately the agent-runtime façade, but 138 inbound dependencies means almost any subsystem change touches it. |
| 3 | `src/main/db/AppDatabase.ts` | 3746 | 14 | 5 | **Mixed.** 1 class + 6 interfaces; single-class schema+migration+query owner. Cohesive-ish; fan-in 50. |
| 4 | `src/main/capabilities/web-access/curator-page.ts` | 3472 | **0** | 1 | **Not code** — 81 fns, 0 imports: an inlined/embedded generator asset. Should be a data file. |
| 5 | `src/main/index.ts` | 3421 | 117 | **0** | **Dumping ground.** 412 handlers / 34 namespaces / 0 exports. |
| 6 | `src/main/capabilities/web-access/index.ts` | 3293 | 52 | 2 | 60 fns, 6 interfaces — large capability module, moderate cohesion. |
| 7 | `src/renderer/src/components/chat/ChatInput.tsx` | 2311 | 41 | 1 | **Over-loaded component**: 19 `useState` + 18 `useEffect` + 46 store reads + 30 arrows. Highest hook density in the codebase. |
| 8 | `src/renderer/src/components/settings/ModesTab.tsx` | 2286 | 10 | 1 | 11 `useState` + 13 `useMemo` + 31 arrows — large but relatively cohesive settings surface. |
| 9 | `src/shared/agent-ipc.ts` | 2268 | 1 | **169** | **Intentional contract hub** — 123 interfaces + 30 types + 16 consts, 1 import. High fan-in (154) is correct for a shared protocol module. |
| 10 | `src/main/library/LibraryService.ts` | 2046 | 13 | 4 | 3 classes + 12 fns; cohesive domain service. Notable for §4, not for size. |

Fan-in leaders by basename (import references): `agent-ipc` **154**, `project-domain` **138**, `appStore` **107**, `icons` 93, `library-ipc` 78, `types` 71, `memory-kernel` 69, `pi-coding-agent` 68, `mode-profile` 61, `AppDatabase` 50.

**Assessment.** Severity **Medium**, concentrated in 2 files. `index.ts` (412 handlers, 0 exports, 34 namespaces) is the clearest maintainability liability; `AgentService.ts` (138 imports) is the clearest change-amplification risk. Counter-evidence: the remainder of the top 10 are cohesive single-concern modules, fan-in leaders are shared contracts (appropriate), and the `src/main` subsystem split is otherwise healthy — 33 subdirectories, largest non-outlier being `capabilities` (91 files / 29k LOC across many small capability modules). `curator-page.ts` (3472 LOC, 0 imports) should be demoted to a data asset.

## 3. Test quality — internals vs. public surfaces

Tests live in `scripts/` (285 test-ish `.ts`/`.tsx`, 64.9k LOC) and are invoked via **297** `test:*` scripts in `package.json`.

| Signal | Count |
|---|---|
| `toMatchSnapshot` / `toMatchInlineSnapshot` | **0 / 0** |
| `describe(` / `it(` / `expect(` | **0 / 0 / 0** |
| `node:assert` imports | 251 |
| `assert(` calls | **3144** (4.8 per 100 LOC) |
| Tests importing real `../src/*` | **242** files, 960 import statements |
| → `../src/main/*` | **688** |
| → `../src/shared/*` | 181 |
| → `../src/renderer/*` | 91 |
| `as any` in test files | **441** |
| `JSON.stringify` structural compares | 579 across 137 files |

**Assessment: quality is above typical.** These are real integration harnesses, not implementation-detail assertions — `scripts/architecture-test.ts` (2403 LOC) asserts observable policy outcomes ("preset 权限建议覆盖 base", "zip 路径穿越条目（../evil.md）被拒绝", "大小写变体旧副本已清理") and drives actual services with a sandboxed `HOME` (line 38). Tests import real `src/main` services ~4× more than shared types, i.e. they exercise production code paths rather than mocks. Severity **Low** for fakery.

Two honest caveats:
- Zero snapshots is a *positive* here, but `JSON.stringify` equality is used as a de-facto structural snapshot in 137 files — these break on key-order/incidental-shape changes just as brittlely as real snapshots, only invisibly.
- **441 `as any` in tests** is the mirror image of the 0 `as any` in `src/shared`/`src/preload`: the strict typing the product enforces internally is routinely bypassed by the harnesses that validate it.

## 4. Error handling and concurrency

| Metric | Count |
|---|---|
| `catch` clauses | 1114 (1920 `catch` keyword occurrences) |
| **Literal empty `catch {}`** | **79** across **23** files |
| Empty `.catch(() => {})` | 15 |
| `.catch(` callbacks total | 139 |
| `console.error`/`warn` | 298 (vs 1114 catches → ~27% logged) |
| `void expr` discards | **736** |
| `.then(` in `src/main` | 66 |
| `ipcMain.handle/on` | **450** |
| `ipcRenderer.invoke/send/on` | 480 |
| TODO/FIXME/HACK/XXX | **0** |

Concentration of the 79 empty catches: `src/main/library/LibraryService.ts` **15**, `src/main/index.ts` 8, `src/main/capabilities/web-access/index.ts` 7, `src/main/capabilities/windows/windowsAutomationHostScript.ts` 7, `src/main/workgraph/WorkGraphIntegrity.ts` 6, `src/main/capabilities/web-access/curator-server.ts` 5, `src/renderer/src/components/workspace/WorkspaceSharedContextSection.tsx` 4.

**Representative worst case** — `src/main/library/LibraryService.ts:1217-1243`, `refreshChunksForItem`:
```
1220      try { const prev = this.repo.listChunks(itemId); ... } catch {}          // :1223
1226        try { this.invalidateEmbeddingsForChangedChunks(...); } catch {}       // :1226
1233      try { this.invalidateEmbeddingsForChangedChunks(...); } catch {}         // :1233
1238      } catch {}                                                               // :1238
```
Embedding-invalidation failures are discarded with **no log at all**, while the outer write failure *is* logged (`console.warn(...)` at `:1241`). A failure here silently leaves stale embeddings indexed — a correctness bug that surfaces later as bad retrieval, with no diagnostic trail. Same shape at `:1247`, `:1251`, `:1259`, `:1483-1487`. Line 753-754 additionally swallows a schema/API-probe failure pair (`(this.db as any).deleteChunkEmbeddings?.(...)`).

**Assessment.** Severity **Medium-High** for the persistence/embedding path specifically (silent data-integrity failure, zero observability), **Low** elsewhere: `src/main/index.ts` swallows are shutdown/cleanup paths. Mitigations that are real: **0** TODO/FIXME debt markers; explicit `void` (736) shows deliberate, not accidental, fire-and-forget; 298 logged errors indicate the codebase mostly does surface failures; and `scripts/test-guard.mjs` (184 LOC) exists specifically because of a documented 2026-08-15 OOM incident (unbounded process growth), enforcing a 6 GB working-set cap and 900 s wall-clock kill — evidence the concurrency/failure class is taken seriously operationally.

Specifically on **unawaited promises in IPC handlers**: 52 handlers are declared `async` inline, and 423/441 are thin delegations — the risk pattern (floating promise inside a handler body) is *not* widespread. The 736 `void` discards are the larger surface, but they are explicit.

## 5. Circular dependencies and dependency-direction enforcement

DFS over 2590 resolved import edges found **14** cycle paths. Classifying each by whether the returning edge is `import type` (erased at build) or a value import:

**Type-only (12 of 14 — harmless at runtime):**
- `src/shared/agent-ipc.ts` ↔ `agent-loadout.ts`, `durable-bot.ts`, `expert-binding.ts`, `external-agent.ts` — all use inline `import("./x").T` in type positions; reverse edge is `import type`.
- `src/main/mcp/McpConfigService.ts` ↔ `BundledMcpExtensions.ts` (reverse `import type { McpServerEntry }`)
- `src/main/mcp/McpModeFilter.ts` → `McpConfigService.ts` (forward is `import type`)
- `src/main/memory/MemoryService.ts` → `agent/MemoryContextProjection.ts` (reverse `import type { MemoryService }`)
- `src/main/capabilities/ComputerAutomationService.ts` → `ComputerUseRunCoordinator.ts` (reverse `import type`)
- `src/main/capabilities/ComputerUseOverlayService.ts` → `ComputerUsePolicy.ts` (`import type { ComputerUsePhase }`)
- also the longer chains through `ComputerUseRecoveryPolicy` / `NativeMcpConfig` / `project-domain`.

**Value-level (2 of 14 — genuine):**
- `src/shared/mode-profile.ts` → `runtime-policy.ts` (`import { composeMcpPolicies, composeSkillPolicies }`) with `runtime-policy.ts` → `mode-profile.ts` returning a **value** import.
- `src/main/mcp/McpModeFilter.ts` → `McpConfigService.ts` (`emptyMcpFilterResult` value) against `McpConfigService.ts` → `McpModeFilter.ts`.

**Enforcement: none exists.** Confirmed absent at repo root (all glob matches were inside `node_modules`):
- no `.eslintrc*` or `eslint.config.*`; **ESLint is not in `devDependencies`**
- no `.dependency-cruiser.js`; no `madge`/`.madgerc`
- `devDependencies` are build/runtime only: `typescript 7.0.2`, `electron 44.5.1`, `electron-vite 5.0.0`, `vite 7.3.6`, React 19, etc.
- The `"arch"` key in `package.json` is **not a script** — it is `build.win.target[].arch` = `["x64"]` (an electron-builder setting). The name is a red herring.
- `eslint-disable` comments exist in source (e.g. `scripts/architecture-test.ts:43-83`) with no linter installed to honour or check them.

**Assessment.** Severity **Medium** for the enforcement gap, **Low** for the cycles themselves. The 2 value-level cycles are cyclic-import hazards (undefined-at-module-init risk under some bundler orderings) but currently innocuous — 12 of 14 cycles are compile-time-only, which indicates the type/value split is understood by the authors. The real issue is that the exemplary layering in §1 has **no mechanical gate**: nothing prevents a future `renderer → main` import from landing between `pnpm typecheck` runs. Adding `dependency-cruiser` or ESLint `no-restricted-imports` with a layer rule would convert a convention into a guarantee at low cost. `pnpm typecheck` (`tsc --noEmit` × both configs) is the only structural check today, and 297 test scripts provide behavioral coverage.

## 6. The `src/main/agent` extension model and the Pi seam

**The seam is real, typed, and used — not shallow.** MyBuddy composes onto Pi via `InlineExtension` / `ExtensionFactory`, imported from `@earendil-works/pi-coding-agent@1.0.4` (declared as a devDependency).

**Evidence the contract is upstream-supported, not internal invention.** The vendored upstream typings (`artifacts/pi100-upgrade/upstream/pi-coding-agent/package/dist/core/extensions/types.d.ts`) declare the real API:
- `types.d.ts:1473` — `export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;`
- `types.d.ts:1474-1480` — `export type InlineExtension = ExtensionFactory | { ...; factory: ExtensionFactory }`
- `types.d.ts:1144-1184` — `on(...)` overloads for **45** lifecycle events
- `types.d.ts:1186` — `registerTool<TParams, TDetails, TState>(tool: ToolDefinition<...>): void`
- `docs/extensions.md` and `examples/extensions/*.ts` ship a documented extension authoring guide.

**How MyBuddy uses it.**
- `src/main/agent/SessionExtensionAssembler.ts` (254 LOC) is the single owner of registration and ordering. `build()` at `:98-109` returns a deterministic 5-group array: subagent → conversation-capability → MCP/permission → domain → caller `extraFactories`. `domainExtensions()` at `:91-96` feeds **durable/scheduled** runs a deliberately restricted set — with hard-coded `getPermissionMode: () => "auto"` and `requestApproval: async () => true` — so headless paths cannot block on interactive approval. That is a substantive policy distinction encoded in composition, not a pass-through.
- **19** exported `create*Extension` factories across 19 files, **78** `pi.registerTool` call sites.
- `AgentService.ts` supplies live bridges and calls `this.sessionExtensions.build({...})` at `:5424-5481` (with `cadFactory` and `contextProjection.extension` as `extraFactories` at `:5401`), then loads via `new DefaultResourceLoader({ ... noExtensions: true, extensionFactories })` at `:5482-5503`.
- Notably `noExtensions: true` (`:5501`, also `:1938`, `:4542`) **disables Pi's on-disk extension discovery**: `~/.mybuddy/plugins/extensions` is intentionally not an executable surface (`:5498-5500`). Product capabilities are compile-time injected. This is a security-conscious choice and shows the team controls the seam rather than accepting defaults.
- `skillsOverride` at `:5494-5497` closes a real bypass: SDK-discovered skills are re-filtered to the final allowed set so a Tag-rejected Global Skill cannot re-enter the system prompt. Comment calls it a "硬门禁，非软约束" (hard gate, not soft constraint).

**Where it is shallow.** MyBuddy exercises only **7 distinct** of the 45 available lifecycle events — **13** `pi.on` call sites total:
`tool_call` (`permission-extension.ts:26`, `mcp-side-effect-extension.ts:66`), `context` (`conversation-runtime-extension.ts:37`, `EphemeralContextProjection.ts:44`), `message_start` (`:61`), `cache_warming_decision` (`:64`), `agent_settled` (`:67`), `session_shutdown` (`:68`, `subagent/index.ts:864`, `web-access/index.ts:1582`), `session_start` (`subagent/index.ts:857`, `web-access/index.ts:1579`), `session_tree` (`web-access/index.ts:1580`). Unused and notable: `before_agent_start`, `turn_start`/`turn_end`, `tool_result`, `tool_execution_*`, `before_provider_request`, `after_provider_response`, `session_before_compact`, `input`, `agent_before_settle`.

The `pi.*` surface used: `registerTool` 77, `on` 13, `appendEntry` 5, `registerCommand` 4, `exec` 3, `registerShortcut` 2, `registerMcpServer` 1. So the integration is **overwhelmingly tool-registration + a thin slice of lifecycle hooks**.

**Assessment.** Severity **Low** for the seam's authenticity, **Medium-Low** for under-utilisation. The seam is architecturally sound: typed, upstream-sanctioned, centrally assembled, with a genuine durable-vs-interactive policy split and disk-discovery deliberately disabled. It is *not* shallow in the sense of being a fake abstraction — `pi.registerTool` ×78 and the durable policy divergence prove real depth. But the event surface is used at ~16% (7/45), which means several capability classes Pi explicitly enables (streaming/turn boundaries, provider-request shaping, compaction interception, input transformation) are currently handled inside MyBuddy's own 5806-LOC `AgentService` rather than at the hook boundary — plausible root cause for why `AgentService` is the fan-in outlier in §2.

**Positive signal:** `scripts/architecture-test.ts:108-116` implements `makeFakePi()` — a minimal `on`/`fire` double — so the extension seam is itself unit-testable. `test:pi100-features`, `test:pi104-features`, `test:pi-native-lifecycle`, `test:pi-native-control` (297 test scripts) track upstream upgrades explicitly, and `artifacts/pi099-*` → `pi100-upgrade` → `pi104-upgrade` show deliberate, documented version migrations.

---

## Recommendations (ranked by value/effort)

1. **Add a mechanical layer gate** (half-day). `dependency-cruiser` or ESLint `no-restricted-imports` encoding: renderer ↛ main, shared ↛ {main,renderer}, preload ↛ renderer. This converts §1's convention into a guarantee; §1 currently scores perfectly with nothing preventing regression.
2. **Fix `LibraryService.ts` empty catches** (2-4 hours). The 15 sites at `:753,1223,1226,1233,1238,1247,1251,1259,1271,1286,1430,1435,1483,1487` should at minimum `console.warn` like their sibling `:1241`. Highest correctness ROI in the codebase — currently a silent index-corruption path.
3. **Split `src/main/index.ts`** by `*Ipc` namespace (1-2 days). Move registrations into per-subsystem `register*Ipc()` modules — the 34 namespaces already provide the cut lines, and 423/441 handlers are already thin delegations, so this is mechanical.
4. **Move `curator-page.ts` out of source** (1 hour). 3472 LOC / 0 imports is an embedded asset masquerading as code.
5. **Reduce `AgentService.ts` fan-in** (ongoing). At 138 imports / 3 exports, evaluate extracting the persistence and session-registry concerns already partly factored into `SessionExtensionAssembler`, `SessionRegistry`, `SessionLifecycleManager`.
6. **Consider the unused Pi hooks** (§6) before adding more logic to `AgentService` — `before_agent_start`, `turn_start`/`turn_end`, and `tool_result` are the most likely candidates for relocating prompt-assembly and verification concerns to the supported seam.
7. **Tighten the 2 value-level cycles** (`mode-profile ↔ runtime-policy`, `McpModeFilter ↔ McpConfigService`) by extracting the shared leaf, and replace `JSON.stringify` structural compares in the 137 test files with field-wise assertions.

## Method notes / limitations

- Counts are regex-based over raw source and can include commented-out code; LOC is newline-split (so it counts comment/blank lines) on all **1283** tracked `.ts`/`.tsx` files, total **316,375**.
- Cycle detection resolves relative and `@/`/`@shared/` specifiers against the tracked file index with `.ts`/`.tsx`/`index.*` candidates; unresolved dynamic imports are excluded, so 14 is a **lower bound** on detected cycles, not a proof of acyclicity.
- Type-duplication detection compares only `export interface|type|enum|class` **names**. Structurally-identical-but-differently-named types are not counted, so "2 duplicated names" understates semantic duplication if any.
- The `pi-coding-agent` typings inspected are the **vendored artifact copy** (`artifacts/pi100-upgrade/...`), not `node_modules` (which ships `package.json`/`CHANGELOG.md` only, no `dist/` typings). API-shape conclusions therefore reflect the Pi 1.0.0-era artifact; `package.json` pins `1.0.4`.
- §4's "unawaited promise in IPC handler" question was answered structurally (handler thinness + explicit `void` counts), not by data-flow analysis; a floating promise inside a multi-line handler body would not be caught by these counts.
