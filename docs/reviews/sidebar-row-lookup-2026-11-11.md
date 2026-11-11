# Sidebar task lookup performance, 2026-11-11

## Scope and current path

Baseline: `c8d951597edb9580b3d06e1b7bc2fbf9e349143a`. The only production change is in `src/renderer/src/components/Sidebar.tsx`. It lazily builds a first-occurrence-wins Task index inside one `visibleRows` computation and replaces the per-row `tasks.find` with a lookup. The index is not retained across computations and is not built when no task node is visited.

This is a current UI path, not a dead helper. Expanding spaces, changing status/time filters, task summary changes and changed foreground navigation snapshots can invalidate the memo. Ordinary streaming text usually preserves `useSidebarTasks` identity, so this is not an every-token optimization. Bot foreground snapshots can change at the existing navigation refresh cadence. Sidebar hooks execute even when Bot mode does not display the ordinary task tree.

Space lookups, tree construction, sorting, memo dependencies, selector behavior, pinned collection, foreground grouping/limits/status, refresh cadence and the existing 500 ms debounce are unchanged. The Durable execution/scheduling implementation is untouched. The first duplicate Task still wins, missing IDs still skip, and rows still reference the original Task objects.

The new index trades O(T) temporary references for repeated scans. A very sparse view with an early matching Task can do more work than the former early-exit find. No universal latency or memory improvement is claimed.

## Real Electron measurements

The benchmark uses the real `pnpm dev` application, main process, preload, database IPC, store, navigation hooks and React components in a disposable source checkout and isolated profile. It changes only the Sidebar lookup between variants, with identical instrumentation. No product build/package or model calls were used.

One fixed synthetic database contains 5,000 Tasks, 27 completed foreground requests, 3 conversations and 5 resulting spaces. Actual bootstrapped Task objects are sliced to 20/1,000/5,000 entries in the real renderer store. These sizes are **renderer history sizes, not three different database sizes**. In the decisive case Bot mode is visible/focused and renders zero ordinary-task DOM nodes, while the independent historical task rows are still derived.

A real archive IPC followed by the application's refresh event exercises the unchanged debounce and real navigation snapshot IPC/hook path. After warming, baseline/candidate/candidate/baseline rounds produce 10 samples per variant and size. Medians average the two central samples. The primary metric starts when the actual navigation IPC begins and ends at the second requestAnimationFrame, a paint-opportunity proxy. It includes IPC/store/renderer work, but excludes scheduled debounce and is not physical user-input or display-presentation latency.

**These are development-mode timings. React.StrictMode evaluates the projection twice in each recorded refresh; they are not packaged-production estimates.** Host: AMD Ryzen 7 4800H, Linux, Electron 44.5.1.

| Renderer Task entries | IPC start → second rAF, baseline | Candidate | Refresh-event → second rAF, baseline | Candidate |
| ---: | ---: | ---: | ---: | ---: |
| 20 | 37.40 ms | 36.70 ms | 538.05 ms | 537.80 ms |
| 1,000 | 60.05 ms | 38.55 ms | 550.85 ms | 537.95 ms |
| 5,000 | 97.70 ms | 45.65 ms | 598.15 ms | 546.25 ms |

The 5,000-entry processing window saves about 52 ms. Including the unchanged scheduled wait, the observed refresh also saves about 52 ms, **not half its total duration**. Baseline 5k round medians were 97.7/97.9 ms and candidate 45.2/46.9 ms; complete ranges were 84.8–98.8 and 35.7–79.6 ms. Twenty entries show no meaningful change. The adjacent JSON contains all 60 raw navigation samples and recomputed summaries.

### What this does not fix

Exploratory full-tree expansion was dominated by React/DOM work: about 4,000 task DOM nodes took 7,638.7 ms baseline versus 7,369.7 ms candidate. This was sequential A/B, not the ABBA attribution test, and is not the headline evidence. The current component creates a virtualizer but maps every row in its JSX; this patch does not change rendering or restore virtualization. Search opening/selection did not show a speedup.

That exploratory run's full-text parity assertion encountered relative-time labels crossing an hour boundary. Raw evidence is retained; task/row/state/count/order and stable DOM values matched when only clock-dependent display text was excluded. It is not recorded as an unqualified full-text test pass.

## Behavior and gates

The new headless `test:sidebar-row-lookup` compiles the actual current memo callback and compares it with the same callback restored to its legacy lookup. It needs no historical Git object. Its 241 differential cases check complete values/order, strict object references, duplicate precedence, missing IDs, nested/collapsed spaces, foreground grouping/order/status/limits/show-more, and no input mutation. Additional checks cover updated status/title/pin/order/message fields on later calls, removal, duplicate reordering, and no persistent stale index. A 1,000-row operation-count fixture reduces Task ID reads from 500,500 to at most 2,000 without a machine-dependent timing threshold.

A separate real-app test uses an actual 20-Task database and checks 16 paired snapshots: status and IPC persistence, rename/recency, grouping, existing explicit sibling order, pinning, all six status filters, expand/collapse, and foreground conversation limits/show-more. It types a search query and selects the same result in both variants. Paired snapshot actions run under the baseline and compare candidate rendering of the resulting state; this is projection parity, not independent replay of every action. Task timestamps remain in the data comparison; clock-dependent display strings are excluded from stable DOM comparison.

An additional **12-action candidate-mounted smoke** verifies immediate status, title, pin/unpin, group and filter/count updates, plus status/pin/group IPC persistence. No HMR occurs during these actions (module sequence stays 36). Existing pending-status-only display behavior is preserved rather than changed. The final run has zero renderer errors.

Final fixture cache directories are owned by the disposable checkout. The final UI run verifies shared generated dependency-cache contents/mtime inventory remains unchanged and no owned Electron main remains. This is Linux development acceptance, not Windows, packaged-app or full GUI-suite acceptance.

Independent read-only review found no blocking correctness issue. Focused suites `sidebar-pinned`, `sidebar-space-collapse`, `app-store-transactions`, `workspace-tree` and `bot-workspace` passed. Typecheck and classification audit passed. No failure baseline, guard, timeout or existing test classification was relaxed.

**Full default headless gate: 480/480 PASS, zero failures, zero known failures and zero new regressions, 4.5 minutes.** All individual results are in the adjacent JSON. The manual dev harness is validated separately and is not included in this headless count.

## Reproduce

Use a short writable temporary directory outside the checkout and a real Linux desktop. The manual dev harness needs the pinned baseline Git object. It verifies that the actual candidate source is exactly the measured task-only patch. Generated reports remain under `out/diagnostics/sidebar-projection-dev-*`.

```sh
TMPDIR=/path/to/isolated-temp pnpm -s test:sidebar-row-lookup
TMPDIR=/path/to/isolated-temp SIDEBAR_NAV_ONLY=1 node scripts/sidebar-projection-dev-test.cjs
TMPDIR=/path/to/isolated-temp SIDEBAR_NAV_ONLY=1 SIDEBAR_SMALL_PARITY=1 node scripts/sidebar-projection-dev-test.cjs
pnpm -s typecheck
TMPDIR=/path/to/isolated-temp pnpm -s test:all
node scripts/test-all.mjs --audit
```
