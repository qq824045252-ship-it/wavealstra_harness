# Linux Computer Use: AT-SPI and Hyprland

This document describes the Linux implementation introduced for [issue #14](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/14). The backend identifier is `linux-atspi`. The supported desktop is **Omarchy / Hyprland / native Wayland**. Windows continues to use its existing UIA backend and its existing coordinate contract.

The Linux driver uses the application's Electron/TypeScript/Node stack. It does not install another language runtime or a native Electron addon. Controls come from AT-SPI; windows, focus, layout and cursor position come from Hyprland. Input edges use `ydotool`. The old CUL dependency, MCP subprocess, binary override and indicator are removed from current execution/build paths. Historical reports under `artifacts/` are preserved as historical evidence.

**Code and a successful payload check are not a completed desktop acceptance.** The evidence section below distinguishes checks actually run from required checks that the execution environment cannot run. Keep issue #14 open until the required real desktop and packaged desktop evidence is available.

## Capability boundaries

| Capability | Source and execution | Meaning of availability / failure |
| --- | --- | --- |
| Application/window discovery | Hyprland `clients`, `activewindow`, monitors; AT-SPI application/frame objects | A supported session and installed `hyprctl` are only static prerequisites. IPC and actual window objects must still be read. |
| Accessibility tree | Current user's session D-Bus → `org.a11y.Bus.GetAddress()` → separate accessibility bus | Missing bus service, failed connection, no exported application tree, an empty exported tree, a truncated query and a missing target have different diagnostics. |
| Semantic controls | `Action.DoAction`, `EditableText.SetTextContents`, supported `Value` operations | The exact bus/object/window reference is checked. D-Bus acceptance by itself does not establish the user's intended outcome. |
| Text readback | AT-SPI Text / EditableText / Value and explicit outcome checks | A matching value can verify a write. A readback error is not evidence that the target closed successfully. |
| Reliable control bounds | AT-SPI screen/window extents reconciled with fresh compositor client geometry | Missing, ambiguous, stale or contradictory units/origins prevent coordinate input. Semantic operations can remain available. |
| Window control | Hyprland focus and supported move/resize dispatch interfaces, with readback | Handles stay opaque `0x…` strings. Unsupported compositor/version behavior produces an error. |
| Pointer | Hyprland logical movement and actual `cursorpos`; ydotool button/wheel edges | The compositor's observed position must match before a button is pressed. No absolute ydotool-position calibration or screenshot initialization is used. |
| Keyboard and text input | ydotool key edges; AT-SPI semantic writing where selected; explicit UTF-8 Wayland clipboard transfer | A reachable daemon/socket and a healthy input guardian are required. Chinese and Unicode are tested at the application. Unknown partial outcomes are not replayed. |
| Screenshot | Independent `grim` provider, only on explicit screenshot or `capture_after` request | A missing or failed provider does not disable semantic or input capabilities. This is visible-region observation, not background window capture or a locator. |
| Activity feedback / Stop | Hyprland phase notices and the existing task/run coordinator | Notifications do not prove that input succeeded. Linux does not claim Windows-style window highlighting. |

GNOME, KDE, other Wayland compositors and X11 are not alternate native backends in this implementation. There is no XWayland fallback that advertises itself as native Wayland. An application that exposes no usable accessibility tree, application interface or reliable bounds may be unsupported. Arbitrary Canvas/custom-drawn controls are not promised discoverable.

`status()` is synchronous and lightweight. It reads cached diagnostics and their timestamps; it does not start a screenshot or perform blocking desktop probes. `refreshDiagnostics()` checks the actual session and individual capabilities. Capability records distinguish `available` from `verified` and include a reason/time. A library or executable existing on disk is not proof of a working desktop, input daemon or application bridge.

## Runtime and ownership

The implementation stays inside `src/main/platform/computer-use/linux/`. Common services call the same `ComputerUseBackend` / `computer_exec` contracts. Additive geometry, capability and lifecycle metadata does not change Windows' default physical-coordinate interpretation.

The AT-SPI worker is built to `out/main/atspi-worker.cjs`. It bundles the pinned `dbus-native@0.16.3` package and its pure JavaScript dependencies. The package's declared Node minimum is `>=22.12.0`; the application requires **Node >=24.0.0**. The build records the actual installed library version in `linux-computer-use-runtime.json`. The packaged probe checks the Node version from the **packaged Electron executable**, not `node -v` from the user's PATH.

The worker launches with `process.execPath` and `ELECTRON_RUN_AS_NODE=1` in the child environment only. The parent application's environment is not changed. Worker IPC has a versioned handshake, bounded requests, cancellation and abnormal-exit handling. Connections are persistent; a reconnection obtains a new identity generation. No mutating request is silently retried after timeout, disconnect or worker failure.

An independent `input-guardian.cjs` child serializes input dispatch and tracks the keys/buttons that this driver owns. Registration and the actual down edge belong to that same child queue, so a main-process crash cannot occur between a separate ledger acknowledgement and an untracked down edge. Explicit up removes the relevant entry; parent IPC loss triggers idempotent up cleanup after in-flight commands settle. This covers loss of the main process, where a main-process `finally` cannot run. It does not make kernel/device/daemon outages disappear: cleanup failure is reported, fresh input is blocked until recovery, and the driver never claims that a timed-out remote input was undone.

Successful `key_down` / `mouse_down_client` returns do **not** release held state. The owner is the task/run. State lasts until explicit up or the task/session cleanup boundary. Failure, cancellation, session release and shutdown release only the recorded owner state. Other tasks cannot silently inherit held keys. Modifier wrappers avoid releasing a modifier that the same task was already holding.

Observe/act/verify operations and batches share a serial transaction queue. Cancellation is checked before a queued transaction reaches the desktop. A partial batch reports its completed steps; the remaining steps do not run. A backend, worker or caller must never replay the entire batch to recover from an uncertain step.

## AT-SPI discovery, references and bounded queries

The driver calls `org.a11y.Bus.GetAddress()` on the current user's **session bus** at `/org/a11y/bus`, then connects to the returned accessibility bus. Searching the session bus for every accessible control is not a replacement for this discovery step. Unix filesystem and Linux abstract socket addresses are supported using Node's native Unix socket transport; FD transport is disabled. This does not implement PipeWire/libei interfaces that require Unix file descriptors.

Application PID, accessible frame identity, the compositor window census, structural relationships and compatible geometry are used to establish a unique window binding. A similar title or PID by itself does not authorize selecting a target. Multiple windows with the same title/PID must either have an unambiguous mapping or be rejected. An exact compositor handle does not magically make an ambiguous accessibility tree safe.

A control reference binds at least the accessibility-bus connection generation, bus name, object path, target window and observation identity. It is not an index into a global last-tree array. Reference lifetimes and event-driven invalidation cover removed/rebuilt controls, owner changes, application exits/restarts, window changes and bus loss. Before an action, the driver checks the target again. An old observation must be reacquired; callers must not drop `observation_id` and reuse its old coordinates.

Tree traversal has depth, node and elapsed-time budgets, with bounded concurrency. Queries return `truncated` and diagnostics rather than implying the first page is complete. Unique-control decisions cannot be inferred from an incomplete search. Text reads are bounded too. Event subscriptions are scoped to the bus lifetime and removed when the connection closes.

## Coordinate contract

| Coordinate space | Contract |
| --- | --- |
| AT-SPI screen extents | Raw structured extents; usable only when the root/client mapping and units agree with the current compositor observation. |
| AT-SPI window extents | Relative to the accessible window; reconciled with the same client's dimensions and origin before publishing bounds. |
| Parent extents | Distinct from screen/window coordinates; never silently treated as either. |
| `click_client` / `clientBoundsDip` | Client-local DIP/logical coordinates; Linux preserves that public contract with explicit logical provenance. |
| Hyprland global geometry | Logical compositor coordinates. A global point is not multiplied by a selected monitor's scale. |
| Output pixels | Per-output physical dimensions, scale and transform; rotation and fractional scale are handled per output. |
| Screenshot pixels | Separate observation metadata. They do not create or repair an automatic input target. |

Window handles remain strings even when they look like numbers. Hyprland geometry has `coordinateSpace: "hyprland-logical"`, a layout identity and an observation time. Windows geometry omits this additive discriminator and retains the existing physical-screen default. Logical control bounds are not mislabeled as `screenBoundsPhysical`.

The client origin, CSD/frame decorations, window-relative AT-SPI coordinates and output scaling are separate facts. If the driver cannot reconcile them, bounds are unavailable; there is no guessed offset or `scale=1` fallback. `(0,0)` and negative global origins are valid locations, not generic signs of invalid data. Empty rectangles and contradictions are invalid.

Coordinate input carries a recent observation and rechecks the window identity, geometry, layout and actual foreground window immediately before injection. Window movement, resizing, layout changes and target reconstruction invalidate stale evidence. A move is followed by compositor cursor readback. Long presses first position the pointer. Drags send an interpolated trajectory over a real duration; one teleport is not a drag.

The headless geometry fixtures cover mixed/fractional scales, negative origins, output transforms, multiple displays and layout change. The GUI report records the displays actually present. Synthetic fixtures do not establish that those hardware configurations were tested.

## System and graphical-session prerequisites

The application must run as the logged-in desktop user and inherit that user's `WAYLAND_DISPLAY`, `HYPRLAND_INSTANCE_SIGNATURE`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`. Do not launch it from an unrelated root/service D-Bus session and assume it can see the user's application tree.

On the target Arch/Omarchy system the relevant packages are `at-spi2-core`, Hyprland/`hyprctl`, `ydotool` with a functioning `ydotoold` and user-accessible input socket/device permissions, plus `wl-clipboard` for clipboard text. `grim` is optional and only needed for explicit screenshot observation. The live GTK acceptance fixture additionally uses `zenity`; the Electron fixture uses the repository's pinned Electron runtime. Driver runtime code does not depend on Zenity or a test fixture being installed.

Probe the actual daemon/socket; a stale socket pathname or a CLI binary on PATH does not establish readiness. The ydotool non-input diagnostic and the guardian handshake are separate from proving that an application received an event. Exact socket/service setup depends on the desktop installation; retain the actual dependency error instead of reporting every failure as “Wayland unsupported.”

Chromium/Electron must export its accessibility tree. The application already requests renderer accessibility on Linux; the fixture explicitly enables accessibility support and records the bridge conditions. The GTK fixture runs with `NO_AT_BRIDGE=0` and `GTK_A11Y=atspi`. These are conditions under which the tests run, not a claim that every application exports a complete tree by default.

## Failure interpretation

| Symptom / evidence | Meaning and next action |
| --- | --- |
| No `org.a11y.Bus`, no session address or bus connection error | Check the launching user/session and accessibility bus service. Do not compensate with a screenshot locator. |
| Application absent from the accessible desktop | Verify its accessibility bridge/settings and query budget. Distinguish this from an exported but empty frame. |
| Ambiguous frame/window match | Refresh both structural and compositor observations; use exact identities. Do not choose the closest title. |
| `STALE_OBSERVATION`, rebuilt object or different bus generation | Reobserve and resolve a new target. Do not replay a previous action automatically. |
| Bounds unavailable or contradictory | Use an explicitly supported semantic action, or report that this target's coordinate capability is unavailable. |
| `ydotoold` unavailable / socket refused | Fix the actual daemon, socket and permissions, then refresh diagnostics. File existence alone is insufficient. |
| Cursor readback differs from requested point | Reject button injection. Inspect layout/compositor behavior; do not calibrate by taking a screenshot. |
| D-Bus action accepted, but readback fails | Execution may have occurred; verification is unknown. An absent readback is not proof of successful close/submit. |
| Cancelled/timed-out mutation | First inspect the current result. The remote application may already have processed the request. |
| Optional `capture_after` fails | Preserve the already-executed action and report the capture error separately. Do not resubmit the input. |
| Unsupported compositor / XWayland target | Report the explicit support boundary. Do not claim a fallback is native Wayland. |

## Build, packaging and acceptance commands

Run from the repository root with the pinned pnpm version. Keep unrelated working-tree changes intact. The normal release workflow in `AGENTS.md` still applies.

```sh
pnpm -s typecheck
pnpm -s test:platform-computer-use
pnpm -s test:atspi-driver
pnpm -s test:atspi-transport
pnpm -s test:linux-native-backend
pnpm -s test:linux-native-outcomes
pnpm -s test:input-guardian
pnpm -s test:input-guardian-process
pnpm -s test:linux-worker-packaging
pnpm -s test:all
pnpm -s pack:linux
pnpm -s verify:packaged -- --app-dir release/linux-unpacked
```

`build:linux-computer-use` emits the AT-SPI worker, input guardian, runtime manifest and acceptance assets. `electron.vite.config.ts` invokes the same builder during application builds. Worker assets are unpacked in the distribution. The payload validator starts the shipped workers using the actual packaged Electron executable, checks their handshake and embedded Node version, and rejects a leftover legacy backend payload. It does not capture the screen or assert desktop access.

On the **real Hyprland user graphical session**, run the GUI suites sequentially:

```sh
pnpm -s test:computer-use-linux
pnpm -s test:computer-use-linux:packaged
```

The packaged form launches the normal packaged application with isolated HOME/userData and checks its main-process identity, renderer readiness, version and inherited graphical-session environment. The runner then imports the bundled acceptance entry through that isolated process's local inspector and awaits its exported promise. D-Bus, input and worker creation therefore run inside that same normal packaged main process; the report checks its PID, executable, browser process type and absence of `ELECTRON_RUN_AS_NODE`. A separate Electron fixture runtime must match the package's Electron version; the report records both. The development command runs the suite using the development Electron executable in Node mode and records that different runtime context explicitly.

For another package location or fixture runtime:

```sh
node scripts/run-linux-computer-use.cjs \
  --app-dir /absolute/path/linux-unpacked \
  --fixture-electron /absolute/path/electron \
  --report-dir /absolute/path/acceptance-evidence
```

The GUI gate uses disposable windows/profiles and exact owned identities. It verifies GTK semantic writes/submit output and Electron semantic, pointer, keyboard, Unicode, scrolling, timed drag, held-state, stale-object/window, duplicate-window, focus, application restart and worker-loss behavior through application-side state/events. A partial batch must retain the first received key and suppress the second after geometry changes. Queue cancellation and cancellation/timeout during a real held press must release owned input without replay. The cold workflow forces the screenshot provider to fail and intercepts attempted screenshot/OCR/legacy commands; the recorded call counts must remain zero. A later, separately labeled explicit `capture_after` failure test expects one failed capture and exactly one received input.

The live gate requires an actual fractional-scale output. It moves only its owned Electron fixture onto that output, rereads its monitor/scale and verifies that the fixture fits before running the input sequence there. The report records actual monitor dimensions/scale/transform and the fixture's observed placement. It does not reconfigure the user's displays automatically. A machine without this configuration cannot produce a full fractional-scale acceptance pass.

Default reports go to `out/tests/linux-computer-use/<timestamp>-<dev|packaged>/`:

- `runner-report.json`: mode, binary/asset hashes, prerequisite failure or exit, normal packaged-startup identity and proof that acceptance ran inside the same main process.
- `acceptance-report.json`: each executed assertion, exact runtime/display facts, capture/OCR counters and errors.
- `packaged-startup.log`, Electron/GTK fixture logs: execution evidence where that part actually ran.

`test:computer-use-linux` and `test:computer-use-linux:packaged` are explicitly GUI tests. Windows-only GUI suites remain Windows-only. `test:atspi-transport` is a Linux headless **real D-Bus wire fixture**; it starts isolated daemons/services and is not evidence of an actual GTK/Wayland session. `test:input-guardian-process` is a Linux headless child-process lifecycle fixture, including parent death; its fake input sink is not evidence of kernel/desktop delivery. A missing graphical session or a forbidden D-Bus socket is a nonzero failure, not `SKIP` with a successful exit. No test baseline should be expanded to hide these failures.

## Final integration evidence

Version **0.1.93** was checked on 2026-11-04 UTC / 2026-11-05 Asia/Shanghai against an implementation based on `21e9ce5aa7bb55429990fc1251fa52c63e65eb64`. The [final validation record and retained raw evidence](../artifacts/issue-14-linux-native/validation.md) distinguish completed checks from blocked acceptance.

| Check | Final observed result |
| --- | --- |
| Typecheck | **PASS**. Web/main checks passed; the scripts ratchet reported 176 historical errors against 188 baseline entries, with **0 new errors**. No baseline was expanded. |
| Default headless gate | **FAIL, exit 1**: 283 commands, **282 passed / 1 failed**. `test:atspi-transport` failed because private `dbus-daemon` socket creation returned `Operation not permitted`. No real D-Bus wire pass is claimed. |
| Focused behavior suites | AT-SPI driver **26**, guardian **14**, guardian real-process cases **2**, native backend **24**, native outcomes **12**, platform **29**, packaging validator **7**. Guardian process cases use a private fake ydotool sink and are not real desktop input evidence. |
| Shared execution/recovery contracts | **PASS**. Coordinator/run suite passed; recovery evidence passed the legacy Windows cases plus **18** delivery/batch/uncertainty cases. |
| Final application build | **PASS, exit 0**. This produced development build output, not an accepted distribution. |
| Development worker handshakes | **PASS** using actual Electron **44.5.1**, embedded Node **24.21.0**. Both workers returned the expected protocol/backend identity; AT-SPI reported dbus-native **0.16.3**. No bus, screenshot or input probe was performed by these handshakes. |
| Linux packaging | **FAIL, exit 1** during preparation of pinned OfficeCLI **1.0.143**: proxy tunnel timeout after 5,000 ms. No accepted Linux application directory or package checksum was produced. |
| Actual packaged payload validation | **FAIL, exit 1**: `release/linux-unpacked` was absent. Actual packaged Electron/worker probes did not run. |
| Development and packaged GUI commands | Both **failed with exit 1** at missing `WAYLAND_DISPLAY`. No GTK/Electron fixture, normal packaged main process, or desktop input scenario started. |
| Actual desktop / fractional scale / packaged desktop | **Not performed**. These remain acceptance blockers; issue #14 is not ready to close on this evidence. |

The final classification audit passed: 283 headless, 48 GUI, 27 network, 1 dataset and no pending classification. The archive contains the final command logs, both GUI prerequisite reports, exact development worker handshakes and checksums of those evidence files. These checksums are not package hashes. Earlier pinned-lock verification passed online without disabling pnpm's supply-chain policy; no separate raw setup log was retained. Windows desktop/distribution validation remains separate from the headless Windows contracts recorded here.

## Protocol sources

- [AT-SPI bus discovery](https://github.com/GNOME/at-spi2-core/blob/main/bus/README.md)
- [Official AT-SPI D-Bus XML interfaces](https://github.com/GNOME/at-spi2-core/tree/main/xml)
- [Component extents and coordinate types](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/doc-org.a11y.atspi.Component.html)
- [Action interface](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/doc-org.a11y.atspi.Action.html)
- [EditableText interface](https://gnome.pages.gitlab.gnome.org/at-spi2-core/devel-docs/doc-org.a11y.atspi.EditableText.html)
- [Pinned dbus-native v0.16.3](https://github.com/sidorares/dbus-native/tree/v0.16.3)
- [Hyprland hyprctl](https://wiki.hypr.land/configuring/core/advanced-configuration/using-hyprctl/) and [dispatchers](https://wiki.hypr.land/configuring/core/dispatchers/)

The implementation was checked against these primary-source files at Hyprland **v0.56.2**:

- [HyprCtl JSON fields and stable window identity](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/debug/HyprCtl.cpp)
- [Monitor rotation, scaling and rounded logical dimensions](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/output/Monitor.cpp)
- [Lua window addresses and goal geometry](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/lua/objects/LuaWindow.cpp)
- [Lua dispatcher arguments](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/lua/bindings/LuaBindingsDispatchers.cpp)
- [Lua REPL return formatting](https://github.com/hyprwm/Hyprland/blob/v0.56.2/src/config/lua/ConfigManager.cpp)

This source review does not establish that the execution environment has that compositor or that a dispatch ran successfully. Compositor commands must also be checked against the version recorded by the actual acceptance machine. Documentation from another version is not proof that a local dispatch is supported.
