# Test Suite & Repo Hygiene Audit — MyBuddy (`wavealstra_harness`)

Audited: 2026-10-09 · HEAD `3261a43` (2026-10-08) · branch `main` · ~291k LOC
Method: executed tests, not merely read them. All commands run in the workspace.

---

## VERDICT

**Grade: B− for test substance, D for verification *wiring*.**

The individual tests are mostly **real verification, not theater** — but the suite is
**not wired into any gate**, so it verifies almost nothing automatically.

**What is genuinely good**
- Tests assert real behavior against **real implementations** (real SQLite via `AppDatabase`, deps injected). 209 of 257 `scripts/*-test.ts` import `../src/*` and drive it.
- Tests **can and do fail**, and when they fail the output is informative. Negative control: `node scripts/test-guard.mjs out/quality-audit/probe-fail.cjs` → `code=1`; an unhandled rejection also yields `code=1`.
- `scripts/test-guard.mjs` is **well-engineered**, not a rubber stamp: real wall-clock timeout (900 s → exit 124), out-of-process memory cap (6144 MB → exit 137) sampling both WorkingSet and private commit, whole-process-tree kill via `taskkill /T /F`, and correct **exit-code passthrough** (L149–153).
- Assertion density is high: `test:architecture` 211 checks, `test:cad-security` 114, `test:expert` 77, `test:prompt-context` 35, `test:artifact-gate` 30.
- `pnpm -s typecheck` passes (exit 0).

**What is bad — headline findings**
1. **258 of 297 `test:*` scripts (87%) are referenced by no gate.** Only 39 are wired into a `gate:*`. There is **no CI** (`.github` does not exist) and **no aggregate all-tests runner**.
2. **`pnpm -s test:harness-quality` — the repo "gate" — is a weak proxy.** It runs `harness-quality-gate-test.ts` (163 lines). Its largest function, `nativeControlBoundary()` (L15–25), is 5 `existsSync()` assertions that files are **ABSENT** (L16–22) — it asserts deleted code stays deleted and validates no live behavior.
3. **Two real, deterministic, reproducible failures sit in the tree ignored.** `test:architecture` fails every run (6 `✗` + hard crash); `test:artifact-gate` fails 2/32. Neither is in a gate, so nothing noticed.

**Hygiene: poor but bounded — the brief overstated tracked junk.**
- `out/` (1084.6 MB) and `release-mybuddy-0.1.17/` (1283.6 MB) are **fully `.gitignore`d — 0 tracked files each.** Disk-only, not a repo defect.
- `artifacts/upstream/pi-*`: **0 tracked files** (ignored). The 106 MB is disk-only.
- **Real tracked junk is 67.1 MB under `artifacts/`** (1217 files), incl. **two byte-identical duplicated `pi-coding-agent` trees** and **7 committed APK build outputs**.
- Working tree is **incoherent**: 20 deleted-but-uncommitted files, explained by **no commit**.
- 4 `docs/` status files are stale by ~2.5 weeks vs HEAD.

---

## 1. The repo gate: `pnpm -s test:harness-quality`

**Result: PASS (exit 0), 0 s.**

```
harness quality gate: PASS (native control boundary, context budget, semantic outcome, effective loadout, prompt run registry)
[test-guard] exit pid=68940 code=0 elapsed=0s
```

The gate is **honest about what it covers** (it names its 5 areas) and the 4 behavioral
functions are genuine: `contextBudgetGate()` asserts exact budget arithmetic and that
permission/workspace safety segments survive truncation (L44–48); `semanticOutcomeGate()`
asserts a `not_evaluable` status rather than a false pass (L104). This is good work.

**But it is a proxy, not a suite gate.** `nativeControlBoundary()` (L15–25) is pure
existence checks on *removed* files:

| Location | Assertion | Nature |
|---|---|---|
| L16–17 | `!existsSync("src/main/agent/ExecutionRouter.ts")` | absent-file |
| L18–19 | 8 retired wrapper files absent | absent-file |
| L21–22 | 5 retired chat services absent | absent-file |
| L23–24 | regex: no `agent_end`/`sendMessage`/`routeExecution` in one file | static text |

A file-absence test passes trivially forever once the file is gone. It is **regression
protection for a past refactor**, faithful to its name — but it is not coverage of the product.

### `test-guard.mjs` — what it actually enforces

Read in full (183 lines). It enforces **process hygiene, not correctness**:

- **Timeout**: `GUARD_TIMEOUT_S` default 900 → kills tree, exits **124** (L156–162).
- **Memory**: `GUARD_MEM_MB` default 6144 → kills tree, exits **137** (L166–182). Uses `max(WorkingSet, PrivatePageCount)` (L174), correctly targeting demand-zero commit.
- **Exit codes**: child code passed through verbatim (L149–153) — **confirmed empirically**.
- **Unhandled errors**: it does **not** inspect stderr or detect unhandled rejections itself; it relies on Node's own non-zero exit. Since Node 15 unhandled rejections are fatal, so this works in practice — confirmed: a rejecting script without `process.exitCode` exited **1**.
- **What it does NOT do**: no assertion counting, no coverage, no "zero tests ran" detection.

**Consequence worth flagging:** a test bundle that exits 0 while asserting nothing would
pass the guard silently. The guard cannot detect a vacuous test.

---

## 2. Executed test sample (18 tests)

Ran directly; exit codes recorded. Logs in `out/quality-audit/*.log`.

| Test | Exit | Checks | Notes |
|---|---|---|---|
| `test:harness-quality` (gate) | **0** | — | 0 s, PASS |
| `test:architecture` | **1** | 211✓ / 6✗ | **real defect — crashes** |
| `test:artifact-gate` | **1** | 30✓ / 2✗ | **real defect** |
| `test:memory` | 0 | text-only | "all focused checks passed" |
| `test:task-expert-binding` | 0 | 4 | |
| `test:expert` | 0 | 77 | |
| `test:cad-security` | 0 | 114 | |
| `test:prompt-context` | 0 | 35 | |
| `test:pi0992-memory-capsule` | 0 | 30 | |
| `test:memory-skill-revision` | 0 | — | |
| `test:selection-store` | 0 | — | |
| `test:native-surface` | 0 | — | |
| `test:artifact-domain` | 0 | — | |
| `test:compaction` | 0 | — | |
| `test:project-cadence` | 0 | — | |
| `test:chat-scroll-anchor` | 0 | 15/15 | static regex (see §3) |
| `test:mcp-composer-focus` | 0 | — | static regex |
| `test:security` | n/a | — | **does not exist** (`pnpm` suggests `test:cad-security`) |
| `test:task-isolation` | n/a | — | **does not exist** (`audit:task-isolation` exists) |

Two of my probe names were simply wrong — my error, recorded for honesty. **13/15 real
runs passed.**

### Failure A — `test:architecture` (deterministic, reproducible)

Ran twice; identical failures both times:

```
  ✗ 显式模型进入主路径 payload
  ✗ 显式权限进入主路径 payload
  ✗ 任务级 Active 连接器进入主路径 payload
  ✗ F2：任务 A 显式值继续作为 explicit 传递
  ✗ P3-3：空闲切换专家 → registry 释放
  ✗ P3-3：MCP session 扩展引用同步清理（无残留）

Error: 未找到已安装专家: e1
    at ExpertService.getDetail (.../architecture-test.mjs:9729:38)
    at TaskExpertBindingService.save (.../architecture-test.mjs:52438:39)
    at _AgentService.switchExpert (.../architecture-test.mjs:79981:14)
    at main (.../architecture-test.mjs:84769:17)
[test-guard] exit pid=18276 code=1 elapsed=3s
```

A **hard crash** (`ExpertService.getDetail` throws) that aborts the remaining run. The
"explicit model/permission/connector into main-path payload" failures are plausibly related
to the newest feature (`per-task expert bindings`, HEAD `3261a43`) — i.e. **this may be a
genuine regression in the most recent commit, undetected because the test is orphaned**
(`test:architecture` is referenced by **no** gate).

The crash path in `TaskExpertBindingService.save` calls `getDetail`, which **throws** when a
fixture expert is not installed. That is a **test-double defect** (fixture assumes an
installed expert) layered on top of real assertion failures. Both deserve fixes.

### Failure B — `test:artifact-gate` (30/32 PASS)

```
FAIL  R4 PreviewHost registry 外部访问 = 0  — src/main/index.ts.captureSurface ×3
FAIL  R15 stale 判断仅存在于 SelectionStore  — src/main/memory/MemorySkillRevisionService.ts: markStale(id: string):
Artifact Machine Gate: 30/32 PASS
```

These are **architectural-boundary assertions** (single-writer/encapsulation). R4 flags three
`captureSurface` accesses in `src/main/index.ts`; R15 flags a `markStale` method outside
`SelectionStore`. R15 is plausibly a **false positive** (a different domain's `markStale`), but
R4 looks like genuine layering drift. Either way: **a failing architectural gate is committed
and unenforced** — `test:artifact-gate` *is* in `gate:artifact`, but `gate:artifact` is not
wired into anything that runs on commit.

### Environment vs. real defect — Electron/GUI tests

`ELECTRON_RUN_AS_NODE=1` is set in this shell, which per `AGENTS.md` breaks Electron UI tests
(`app` undefined). I confirmed both halves:

- `env -u ELECTRON_RUN_AS_NODE ...` → **fails with a Git-Bash `env.exe` pipe error** (`Win32 error 5`), exit `-1073741502`. A *shell/环境* failure, not a product failure.
- Removing the variable in-process and running `pnpm -s test:project-materials-ui` → **esbuild bundles successfully (1.8 MB + 57 assets) and Electron launches**, then exits `2147483651` (0x80000003) — a **real Electron/GUI failure in this headless-ish environment**, not a test-quality signal.

**Distinction:** no GUI test in this sample failed in a way attributable to a product defect.
Electron **does** run here; the failures are environment/launch-level. GUI coverage therefore
**could not be verified** by me and remains **unproven either way** — it should not be counted
as passing.

---

## 3. Are the tests substantive, shallow, or vacuous?

### Classification criteria

| Class | Criterion |
|---|---|
| **Substantive** | Imports real `../src/*` code **and** drives it with inputs; assertions are on **computed outputs/state**, incl. negative cases; has a real failure path (`exitCode = 1`). |
| **Shallow** | Executes real code but asserts only **existence/shape/smoke**, or reads source text with **regex instead of exercising behavior** (passes if a string is present; would not catch a logic bug). |
| **Vacuous** | No assertion of any kind and no failure path — cannot fail. |

Detection was automated over all 257 `scripts/*-test.ts`, then **manually corrected**: an
initial regex for `assert` falsely flagged 34 files as assertion-free. On inspection these
use **custom `ok()`/`check()` harnesses** (e.g. `project-cadence-test.ts` L22–32) that *do*
set `process.exitCode = 1` (L299–310). Corrected result: **32 are custom-harness, and only
2 appear genuinely assertion-free.** This correction is the most important methodological
point — a crude grep would have produced a false "13% vacuous" headline.

### Result over 257 test files

| Class | Count |
|---|---|
| Behavioral (imports `../src/*`) | **209 (81%)** |
| Static source-text scanning (regex over `readFileSync`) | **26 (10%)** |
| Genuinely assertion-free | **2 (0.8%)** |

### 10-file sample, individually classified

| # | File | Class | Why |
|---|---|---|---|
| 1 | `scripts/project-cadence-test.ts` | **Substantive** | Real SQLite + `ProjectService`; fake scheduler + injected clock; 30+ assertions on timer counts, boundary math, clock rollback, clamps. |
| 2 | `scripts/prompt-context-test.ts` | **Substantive** | 20+ numbered cases incl. sanitizer strips, version mismatch rejection, injection handling. |
| 3 | `scripts/harness-quality-gate-test.ts` | **Mixed** | 4 substantive fns; `nativeControlBoundary()` is shallow (absent-file). |
| 4 | `scripts/artifact-machine-gate.ts` | **Substantive** | 32 boundary rules, catches real drift (R4). |
| 5 | `scripts/memory-kernel-test.ts` | **Substantive** | Real migration/purge/restart-recovery paths. |
| 6 | `scripts/task-expert-binding-test.ts` | **Shallow** | Static source scan (no `../src` import). |
| 7 | `scripts/chat-scroll-anchor-test.ts` | **Shallow** | 15 regexes over `ChatView.tsx`/`global.css`; asserts a string *exists*, never runs it. |
| 8 | `scripts/mcp-composer-focus-test.ts` | **Shallow** | Static source scan. |
| 9 | `scripts/mcp-discover-test.ts` | **Vacuous** | `console.log`s discovery output; no assertion, no failure path. |
| 10 | `scripts/visual-polish-ux-test.ts` | **Shallow** | Static source scan. |

**Sample: 5 substantive, 4 shallow, 1 vacuous.**

**The 10% static tier is the real weak spot** — 26 files (incl. `visual-polish-ux-test.ts`,
`pi100-features-test.ts`, `pi104-features-test.ts`, `minimal-coding-mode-test.ts`) assert that
source code *contains a pattern*. Useful as anti-regression tripwires, but they are **not
behavioral verification** and inflate the apparent test count.

---

## 4. Repo hygiene

### 4.1 Working tree incoherence — 20 unexplained deletions

`git status --short | Measure-Object` → **22 lines: 20 `D`, 1 `M`, plus the report itself.**

Deleted-but-uncommitted:
`.commandcode/taste/*` (2), `.workbuddy-ai/memory/*` (3), `.workbuddy/backups/*` (7),
`.workbuddy/memory/*` (4), `extensions/mcp/**` (4). All four directories are **absent from disk**.

`git log --oneline -5 -- .workbuddy .commandcode extensions/mcp` returns **only `ff9e756
Initial commit`**. **No commit explains these deletions.** The paths were committed in the
initial commit and later deleted on disk without ever being staged. Also `M
artifacts/magpie-desktop/results.json`.

**Is the working tree coherent? No.** A fresh `git checkout .` would resurrect ~20 files
including `.workbuddy/backups/*.bak`. These were tracked **by mistake at the initial commit**
(agent-scratch/config state belongs in `.gitignore`, which does not list `.workbuddy`), and the
correct remediation is to **commit the deletions** — not to restore the files.

### 4.2 Tracked vs. merely-present junk

`.gitignore` correctly covers `out/`, `release/`, `release-*/`, `vendor/`, `*.onnx`, `/.tmp-*`.

> 2026-10-29 更正：原 `MyBuddyTools/*` 规则已随「不内置第三方软件」删除（commit `0366e5a`）；
> 受管工具根改为 `~/.mybuddy/tools`（只放 compose/配置），仓库内不再有便携工具目录。

| Path | On disk | **Tracked files** | **Tracked MB** |
|---|---|---|---|
| `out/` | 1084.6 MB | **0** | **0** |
| `release-mybuddy-0.1.17/` | 1283.6 MB | **0** | **0** |
| `artifacts/upstream/` | (part of 106.2) | **0** | **0** |
| `artifacts/` (other) | — | **1217** | **67.1** |

**The 1 GB `out/` and 1.28 GB `release-*/` are NOT a repo problem** — the brief's framing
overstated this. Verified: `git ls-files out/` → 0, `git ls-files release-mybuddy-0.1.17/` → 0.

**Genuine tracked junk (67.1 MB, 1217 files):**

- **Duplicated upstream trees**: `artifacts/pi100-upgrade/upstream/pi-coding-agent/package`
  (1243 files, 21.7 MB, 195 tracked) and `artifacts/pi0992-memory/upstream/pi-coding-agent/package`
  (184 files, 4.3 MB, 194 tracked). `exy.png` in both is **byte-identical**
  (`A8F2533…F601DE`) — the same third-party package committed twice. **~26 MB of duplicated vendor code.**
- **7 committed APK build outputs**, ~29 MB total — release binaries in git history:
  `artifacts/remote-mybuddy-1.1.16/Mybuddy-1.1.16.apk` (4.17 MB),
  `artifacts/remote-mybuddy-1.1.13/Mybuddy-1.1.13.apk` (4.16 MB),
  `android-thinking-stream/…1.1.10.apk`, `android-thinking-height/…1.1.12.apk`,
  `android-startup-reconnect/…1.1.9.apk`, `pi0992-memory/android/…1.1.8-pi0992.apk`,
  `android-navigation-motion/…1.1.11.apk` (~4.11 MB each).
- 374 tracked files under `artifacts/dsh-inspect/pkg` — a vendored inspection dump.
- `artifacts/` also holds agent run logs (`desktop-live/`, `checks/`) committed as source.

`.gitignore` has **no rule for `artifacts/`**, so this directory acts as an accidental
catch-all for vendored code, binaries, and run logs.

### 4.3 Leftover branches and stale temp dirs

Branches: `code-review-7nCFHI` (2026-10-06, `6128a51`), `feat/pi-pocket-bots-abcd-20261005`
(2026-10-06, `ed7967a`), `main` (2026-10-08), `origin/main`.

`AGENTS.md` states *"use `main` as the only active local branch"* — **two extra local branches
violate the documented policy.** Their names (`code-review-7nCFHI`, `…-abcd-20261005`) are
machine-generated/throwaway, indicating **abandoned agent work not cleaned up**.

Stale temp dirs, all matching the `.gitignore`d `/.tmp-*` pattern (so ignored, but present):
- `/.tmp-pi104-patch-coding` — **exists**, a full pi source tree (`dist/`, `examples/extensions`).
- `/.tmp-pi104-rebase.cjs` — **exists**.
- `.tmp-pi104-patch-coding` + `pi104-upgrade-20261007.md` + `docs/pi104-upgrade*` indicate an
  **abandoned pi 1.0.4 rebase**.

**Verdict: yes, these indicate abandoned work** — a pi104 rebase, a code-review branch, a
20261005 feature branch, and a scratch verifier — none removed.

### 4.4 Docs staleness

77 files in `docs/` (68 tracked, 3.3 MB). Newest: `bot-durable.md` (2026-10-08).

**The four "status" docs are stale and contradict reality:**

| File | mtime | Lines | Self-declared state |
|---|---|---|---|
| `docs/STATUS.md` | **2026-09-21** | 496 | *"最后核对时间：2026-08-08 … V3.5 收口批次"* |
| `docs/V3.5_STATUS.md` | **2026-09-21** | 152 | *"V3.5 CLOSED (2026-08-09)…不再扩功能"* |
| `docs/plan.md` | **2026-09-21** | 504 | *"已结案"* |
| `docs/plan2.md` | **2026-09-21** | 243 | — |

HEAD is **2026-10-08**; these files are frozen at **2026-09-21** and internally claim
verification on **2026-08-08**. `V3.5_STATUS.md` declares the project *"CLOSED, no new
features"* while HEAD ships `feat: add per-task expert bindings …, release MyBuddy 0.1.17`.
`STATUS.md` cites branch `cursor/mybuddy-ui-parity`, which **does not exist** locally.

**These are stale by ~2.5 weeks (mtime) to ~2 months (content).** Meanwhile `docs/` gained ~15
dated `pi*-acceptance`/`MyBuddy-Pi-*` files in Oct — so documentation **practice** is healthy
and current; only the **canonical status/plan docs** rotted, and nobody pruned them.

---

## 5. Recommendations (priority order)

1. **Fix or delete `test:architecture`.** Real reproducible failure + fixture crash (`未找到已安装专家: e1`). Investigate whether the 6 `✗` are a regression from `3261a43`.
2. **Wire the suite into a gate.** Add `test:all` enumerating `test:*`, and run it (or a CI job). 258 orphaned tests is the single largest quality risk.
3. **Commit the 20 deletions** and add `.workbuddy*`, `.commandcode/`, `extensions/mcp/*/repo` to `.gitignore`. Stop tracking agent state.
4. **Untrack `artifacts/`** (add to `.gitignore`, `git rm -r --cached`): removes ~67 MB, incl. duplicated vendor trees and 7 APKs. Use `git lfs` or releases for binaries.
5. **Delete the 2 stale branches** and `.tmp-pi104-*` per the `AGENTS.md` single-branch policy.
6. **Reconcile `docs/STATUS.md`/`V3.5_STATUS.md`/`plan*.md`** with HEAD, or archive them under `docs/archive/` with a dated banner.
7. **Convert the 26 static-regex tests** to behavioral ones where feasible; keep them only as tripwires and label them as such.

---

## Appendix — evidence commands

```bash
pnpm -s test:harness-quality            # exit 0 (gate PASS)
pnpm -s test:architecture               # exit 1, 6 ✗, crash — reproducible ×2
pnpm -s test:artifact-gate              # exit 1, 30/32 PASS
pnpm -s typecheck                       # exit 0
git status --short | Measure-Object     # 22 lines (20 D, 1 M)
git log --oneline -5 -- .workbuddy .commandcode extensions/mcp   # only ff9e756
git ls-files out/ | Measure-Object                              # 0
git ls-files release-mybuddy-0.1.17/ | Measure-Object           # 0
git ls-files artifacts/ | Measure-Object                        # 1217 (67.1 MB)
node scripts/test-guard.mjs out/quality-audit/probe-fail.cjs    # exit 1 (passthrough OK)
```

Logs: `out/quality-audit/*.log`. Raw size data: `artifacts/` 106.2 MB, `out/` 1084.6 MB,
`release-mybuddy-0.1.17/` 1283.6 MB, `docs/` 3.5 MB, `.git` 75.7 MB.

*Scope: read-only audit; no repository file modified. Report only.*
