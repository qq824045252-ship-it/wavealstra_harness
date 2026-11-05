# Linux desktop input repair — 0.1.98

Validated 2026-11-05 (Asia/Shanghai). Development and scoped checks ran on the repair based on main `adf3863`; the final package was rebuilt and revalidated after fast-forwarding to `eff49db`. The acceptance and AT-SPI worker hashes are identical across those runs. Scope: Linux AT-SPI pointer bounds and the existing Linux desktop-input acceptance. No full suite, unrelated feature suites, Windows tests or system configuration changes were run.

## Root cause and repair

On this Hyprland 0.57.0 / native Wayland session, eDP-1 is 2160×1440 with scale 1.6 (1350×900 logical). Electron 44.5.1 exports a logical 900×700 native frame but a physical 1440×1120 DocumentWeb subtree. The old frame-level proof incorrectly certified descendant pixel extents as logical coordinates. Pointer events reached the document body rather than the target; the original strict click count was 0 instead of 5.

The driver now establishes a document coordinate domain using both full viewport dimensions and the observed compositor scale. A button's raw `324,285,257,78` rectangle becomes logical `202.5,178.125,160.625,48.75`; the actual DOM rectangle was approximately `202.656,178.486,160,48`. Native ancestors and pixel document descendants receive hit-test points in their own units. Raw extents and coordinate proof metadata remain available. Before reusing a control, the driver rereads the document viewport and rejects changed proof.

Only a single complete document viewport is certified. Unknown, contradictory, partial or nested document mappings retain semantic operations but do not enable coordinate input. DOM geometry is diagnostic evidence only, never an input locator. The real hardware run establishes this single fractional-scale display; it does not claim live multi-monitor or rotated-display coverage.

The existing GUI acceptance also needed corrections once clicks stopped blocking it:

- Recognize the actual editable/focusable Electron Text contract and verify full Unicode through both AT-SPI and application readback. No synthetic FocusedText pattern is introduced.
- Record trusted pointer targets, raw key events and focus transitions. Pair held keys by physical `event.code`: this desktop emitted `Shift/ShiftLeft` down and `CapsLock/ShiftLeft` up. Different codes cannot clear one another, and blur does not clear held state. Original held/release assertions remain intact.
- Trigger the partial-batch geometry test through independent Hyprland resize and verify its actual geometry. BrowserWindow.setSize is a Wayland client request and did not establish that prerequisite. The original first-key/second-key/cleanup assertions remain intact.

## Checks actually run

| Check | Result |
| --- | --- |
| `pnpm -s test:atspi-driver` | PASS, 45 behavior checks; includes 16 new mixed-domain/bounds-proof regressions |
| `pnpm -s test:linux-native-backend` | PASS, 25 checks |
| `pnpm -s test:linux-native-outcomes` | PASS, 12 checks |
| Scoped TypeScript check of atspi-driver-test.ts and computer-use-linux-smoke.ts and their imports | PASS |
| Fixture offline physical-key event replay | PASS: real Shift→CapsLock release, different codes, repeats, dual Shift and blur behavior |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:computer-use-linux` | PASS, all 23 real-desktop checks |
| `pnpm -s pack:linux` | PASS, including afterPack payload gate and packaged AT-SPI/input-guardian handshakes |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:computer-use-linux:packaged` | PASS, all 23 checks in the normal packaged main process |
| Scoped `git diff --check` | PASS |

Both real-desktop runs received exactly 5 clicks and 1 double-click. Requested long press was observed for about 383 ms (development) and 385 ms (packaged). GTK and Electron Chinese/Unicode paths passed. Held input, scroll, timed drag, global logical coordinates, stale objects, focus targeting, queued cancellation, partial-batch rejection, interrupted-hold cleanup, worker loss and application restart all passed.

Cold-start capture/OCR/legacy-backend calls were zero. The separately requested optional capture-failure test made one failed capture and preserved exactly one received click. All GUI fixtures and packaged startup used isolated HOME/userData.

## Retained evidence and package

[Condensed acceptance evidence](acceptance-summary.json) retains test statuses, click evidence, runtime identity and raw-report hashes. [Packaged runner report](packaged-runner-report.json) is an unchanged copy of the successful runner record. It establishes version 0.1.98, `processType=browser`, `nodeMode=false`, renderer startup and execution of acceptance in the same packaged main-process PID.

Local full raw reports (not committed):

- `out/tests/linux-computer-use/2026-11-05T02-43-28-221Z-dev/acceptance-report.json`
- `out/tests/linux-computer-use/2026-11-05T02-56-12-867Z-packaged/acceptance-report.json`
- Initial click failure: `out/tests/linux-computer-use/2026-11-05T02-22-35-465Z-dev/acceptance-report.json`
- Physical-key release diagnosis: `out/tests/linux-computer-use/2026-11-05T02-37-58-467Z-dev/acceptance-report.json`

Accepted local package: `release/linux-unpacked/mybuddy`. The whole directory is required. Node 24.21.0, Electron 44.5.1, dbus-native 0.16.3.

| Package component | SHA-256 |
| --- | --- |
| resources/app.asar | `003347759a05d5803b072fde3f4ef4b61ff40f9cdf45d48770c64a8eb0d8612e` |
| resources/app.asar.unpacked/out/main/atspi-worker.cjs | `d5eb953573056f8d293a9860086176ffac4b97b6317c6090fb14e71484e3716b` |
| mybuddy | `9155dd17c16f0edeaadb74db4fd91e2730511cca83e8b130d59bab57aa4d4e4b` |

The runner records the same acceptance and worker hashes for development and packaged runs. The executable hash alone identifies Electron, so app.asar and worker hashes are also recorded. No application data or user shortcuts were changed.
