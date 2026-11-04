# Issue #14: Linux native implementation validation

**Version 0.1.93 has an implementation and recorded checks, but it is not an accepted Linux release.** The final headless gate exited 1, packaging did not produce an application directory, and both GUI commands failed their graphical-session prerequisite. No real D-Bus, GTK/Electron desktop, fractional-scale desktop, or packaged desktop success is claimed.

This record covers the working implementation based on source commit [`21e9ce5aa7bb55429990fc1251fa52c63e65eb64`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/21e9ce5aa7bb55429990fc1251fa52c63e65eb64). The commit containing this evidence identifies the resulting change; the baseline hash is not presented as the implementation commit. Runs were recorded on **2026-11-04 UTC / 2026-11-05 Asia/Shanghai**. The dependency is pinned to `dbus-native@0.16.3`.

## Final command results

| Command / check | Result | Evidence and limits |
| --- | --- | --- |
| `pnpm -s typecheck` | **PASS**, exit 0 | [Final log](raw/typecheck-final.log). Web and main project checks passed. The scripts ratchet reported 176 historical errors against a baseline of 188, with **0 new errors**. This is not a claim that the repository has no historical type errors. |
| `pnpm -s test:all` | **FAIL**, exit 1 | [Final log](raw/test-all-final.log): **283 commands, 282 passed, 1 failed, 0 known failures**. The sole failure was `test:atspi-transport`; it remained a failing gate and was not added to the baseline. |
| `pnpm -s test:computer-use-run` | **PASS**, exit 0 | [Final log](raw/computer-use-run-final.log): scoped cancellation, same-run revocation, execution release, overlay ownership and related shared contracts. |
| `pnpm -s test:computer-use-recovery` | **PASS**, exit 0 | [Final log](raw/computer-use-recovery-final.log): legacy Windows contracts plus **18** delivery, batch and uncertainty cases. This script runs `computer-use-recovery-evidence-test.ts`. |
| `pnpm -s build` | **PASS**, exit 0 | [Final build log](raw/build-final.log), confirmed complete by the invoking process. The final renderer build finished in 30.47 s. A successful build is not a packaged application. |
| `pnpm -s pack:linux` | **FAIL**, exit 1 | [Packaging log](raw/pack-linux.log). `beforePack` failed while preparing the pinned OfficeCLI **1.0.143** Linux binary: `ERR_PROXY_TUNNEL`, tunnel establishment timed out after 5,000 ms. This was before the required package could be produced. |
| `pnpm -s verify:packaged -- --app-dir release/linux-unpacked` | **FAIL**, exit 1 | [Validator log](raw/verify-packaged.log): `release/linux-unpacked` did not exist. The actual packaged-executable worker probes therefore did not run. |
| `pnpm -s test:computer-use-linux` | **FAIL**, exit 1 | [Command log](raw/linux-gui-dev.log) and [runner report](raw/linux-gui-dev-runner-report.json): missing `WAYLAND_DISPLAY`. No fixture window or desktop input scenario started. |
| `pnpm -s test:computer-use-linux:packaged` | **FAIL**, exit 1 | [Command log](raw/linux-gui-packaged.log) and [runner report](raw/linux-gui-packaged-runner-report.json): missing `WAYLAND_DISPLAY`. The report's `packaged-main` field is the requested mode; it does **not** establish that a packaged main process started. |

The failed transport command reached a real private `dbus-daemon` startup attempt. Its exact error is retained inside the aggregate log: `Failed to start message bus: Failed to open socket: Operation not permitted`. Consequently, real wire behavior was **not validated** in this execution environment. Whether the full wire suite passes in an unrestricted graphical-user environment remains unestablished by this record.

The final classification audit passed with 283 headless, 48 GUI, 27 network and 1 dataset command, and no pending classification. The two Linux desktop acceptance commands are GUI tests. The D-Bus transport and guardian process tests are Linux headless tests; their classification does not turn them into desktop acceptance.

## Focused behavior coverage

These command results are included in the final aggregate log. Counts refer to the final suites' behavior cases, not additional top-level commands to add to 283.

| Suite | Cases | Evidence boundary |
| --- | ---: | --- |
| `test:atspi-driver` | 26 | Injected transport/client cases, including ignored-cancellation quarantine; no real accessibility-bus success. |
| `test:input-guardian` | 14 | Input ledger, queue, cancellation and cleanup behavior with controlled dependencies. |
| `test:input-guardian-process` | 2 | Actual child processes, IPC and SIGKILL ordering, using a private **fake ydotool** sink. No kernel or application input delivery claim. |
| `test:linux-native-backend` | 24 | Injected desktop/input dependencies, geometry, target/focus guards, held state and related behavior. |
| `test:linux-native-outcomes` | 12 | Explicit outcomes, uncertain mutations, failed capture, partial batches and same-task execution cleanup ordering. |
| `test:platform-computer-use` | 29 | Platform contracts and dependency/session discovery without a real desktop. |
| `test:linux-worker-packaging` | 7 | Validator behavior with injected child-process replies. These are not actual packaged-executable probes. |

## Development Electron worker evidence

The actual **development Electron 44.5.1** executable launched both built worker entry points with child-only `ELECTRON_RUN_AS_NODE=1` and `--handshake`. Both exited successfully without requesting a D-Bus, screenshot or input probe:

- [AT-SPI raw handshake](raw/atspi-worker-handshake.json): protocol 1, backend `linux-atspi`, embedded Node **24.21.0**, dbus-native **0.16.3**, `ready: true`.
- [Input guardian raw handshake](raw/input-guardian-handshake.json): protocol 1, backend `linux-atspi-input-guardian`, embedded Node **24.21.0**, `ready: true`.

The shell's separate Node version was 24.22.1. It was not substituted for the Electron runtime in these probes. These JSON files prove development worker startup under the tested Electron runtime; they do not prove a package exists, a graphical session is reachable, a real input was delivered, or an application outcome was verified.

Earlier dependency setup also completed pnpm 12.14.0 `install --lockfile-only --frozen-lockfile --ignore-scripts` online, with supply-chain checks for 1,074 entries. The initial offline attempt lacked registry metadata. No separate raw log of that setup check is archived here, and it is not counted as desktop acceptance.

## Acceptance status and provenance

There is **no accepted package and no package checksum** in this record. The missing package also prevents evidence of normal packaged startup, packaged D-Bus access, packaged input delivery, or workers launched from the actual package. Actual GTK/Electron fixtures, fractional scaling, and normal packaged-main GUI acceptance remain unperformed because the required desktop session is absent. Actual Windows desktop/distribution validation was not performed on this Linux executor; shared Windows behavior is covered only by the recorded headless contracts.

The implementation includes strict commands for those remaining gates, documented in [the Linux guide](../../docs/linux-computer-use.md). Their existence and source review do not constitute successful execution. Issue #14 must remain open until the missing real transport, package and desktop evidence is obtained.

The files under `raw/` are byte-for-byte copies of the selected final logs and reports, with their original paths and failure stacks retained. Historical checkpoint test logs were not relabeled as final. [SHA256SUMS](SHA256SUMS) covers these **evidence files only**, not an installer or application binary. Existing historical result JSONs and test/typecheck baselines were not edited for this evidence assembly.
