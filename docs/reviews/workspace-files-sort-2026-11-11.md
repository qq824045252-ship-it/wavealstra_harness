# Workspace file-tree sorting performance, 2026-11-11

## Scope

Baseline: `6766877792496b1af1c617bba3eaf1138b3baad5`. Work ran on `main` in an isolated Linux clone using synthetic files and temporary profiles. No live application profile/database was read or changed. No product build, package, installation, dependency change, sidebar change or Durable implementation change was made.

The only production change is in `src/main/workspace/WorkspaceService.ts`: reuse the bound comparator from one `Intl.Collator("zh-CN", { numeric: true })` rather than repeatedly passing the same explicit locale and options to `String.localeCompare` for every sibling comparison. There is no file-tree cache or retained workspace data. Folder-first grouping, stable ties, natural numeric order, traversal, depth/file limits, filtering, errors and refresh behavior are unchanged.

The collator now initializes once during module evaluation. The measurements below are warmed listing measurements and exclude module import/initial collator construction. No startup improvement is claimed.

## Paired measurements

The reproducible runner bundles the actual production `listWorkspaceFiles` and the exact baseline version from Git. Other dependencies come from the same current checkout. Both versions read the same synthetic, disk-backed directory fixtures, including Chinese, Latin and accented numeric names. After two warm-ups, six alternating AB/BA pairs are recorded per scenario. Complete returned DTO comparisons are outside the timed section. Medians average the two central values for six samples.

Host: AMD Ryzen 7 4800H; Linux 7.2.14-arch1-1; Node v26.13.0. Final measurement ran before the full test gate, without the GUI fixture or other delegated tests running.

| Fixture | Baseline median | Candidate median |
| --- | ---: | ---: |
| 100 files in one directory | 3.31 ms | 0.53 ms |
| 1,000 files in one directory | 30.20 ms | 3.83 ms |
| 5,000 files in one directory | 144.27 ms | 15.37 ms |
| 50 directories, 100 files each | 148.70 ms | 21.55 ms |

All **52 complete-tree DTO comparisons** passed. The 5,000-file case saves about 129 ms (89%); this is warm backend filesystem listing, not measured UI response time, startup, network or model latency. These synthetic scale cases are not a measurement of the user's existing workspaces. Raw wall/process-CPU samples, source hashes and tested diff are in the adjacent JSON.

## Behavior and validation

`test:workspace-files-sort` checks the actual production reader against the pre-change reader, including:

- Natural numeric ordering, folders first, Chinese, accents, composed/decomposed Unicode, case, Turkish characters and stable equivalent-name ties.
- Hidden-file visibility, ignored folders, internal manifest filtering and new-file refresh.
- Missing root, a file supplied as root, and real permission-denied paths. The final Linux run used UID 1000, and the test requires EACCES on non-root POSIX. Platforms that cannot enforce chmod denial only compare outcomes.
- A flat 5,010-file fixture and 15-level tree, preserving existing truncation semantics rather than changing them.
- Four subprocess default locales, asserted on Linux: en-US, de-DE, tr-TR and zh-CN. The sort itself retains its explicit zh-CN setting.

The new `test:workspace-files-sort-desktop` uses the current production source with exactly one guarded replacement back to the original `localeCompare` expression for its default reference. It therefore does not require old Git objects in shallow CI checkouts. An explicit Git-baseline mode remains optional. It ran in real Electron 44.5.1 on the desktop, using the production React `WorkspaceFilesView`, real filesystem backend, isolated HOME/userData and a narrow store/callback fixture. Both baseline and candidate passed ordering, expansion/collapse, Electron mouse input selection/open callback, text filtering, three refreshes, failed-refresh retention, real filesystem error display and remount recovery. Complete backend DTOs and every captured DOM state match. The run made 14 backend IPC calls; screenshots and its full report are generated under `out/tests/workspace-files-sort-desktop/`. The adjacent JSON preserves the report summary and hashes. The final default-mode run also passed with Git subprocess calls explicitly denied. Launcher cleanup was checked after success, preparation failure and an injected child-spawn failure.

This is component-level Electron UI equivalence, not a full-app/end-to-end opening-files test or UI latency benchmark. Case- or normalization-insensitive filesystems can collapse some filename fixtures; Linux filesystem coverage does not prove those platforms. No Windows, full GUI suite, NETWORK, DATASET, ARTIFACT or packaged-app acceptance is claimed.

Independent read-only review found no blocking production regression. Focused existing suites `workspace-files-ui`, `task-workspace-isolation` and `workspace-tree` passed. Typecheck passed with zero web/node/scripts errors. Classification audit passed: headless 479, GUI 89, NETWORK 41, DATASET 3, ARTIFACT 3, pending 0. Syntax checks and `git diff --check` passed. The existing failure baseline, timeouts and memory guard were not relaxed.

**Full default headless gate: 479/479 PASS, zero failures and zero known failures, 4.5 minutes.** All individual results are preserved in the adjacent JSON, including the unchanged serial recovery/crash/performance pool.

## Reproduce

Use an isolated writable temporary directory outside the checkout. This machine's `/tmp` previously caused SQLite I/O errors in unrelated tests, so validation used a short separate directory rather than a live app profile.

```sh
TMPDIR=/path/to/isolated-temp node scripts/perf-workspace-files.mjs
TMPDIR=/path/to/isolated-temp pnpm -s test:workspace-files-sort
TMPDIR=/path/to/isolated-temp env -u ELECTRON_RUN_AS_NODE pnpm -s test:workspace-files-sort-desktop
pnpm -s typecheck
TMPDIR=/path/to/isolated-temp pnpm -s test:all
node scripts/test-all.mjs --audit
```

The standalone benchmark requires its pinned baseline Git object; the default regression and GUI tests do not require historical Git objects. Benchmark output is written to `out/diagnostics/workspace-files/`. The committed evidence captures tested pre-commit source.
