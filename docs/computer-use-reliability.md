# Computer Use reliability: 2026-11-03

## Root causes and scope

Real task sessions were inspected read-only. The SerialPortTool task “帮我把项目跑起来” did produce real application screenshots and normal terminal events. Other recent MyBuddy task sessions exposed concrete harness failures: `snapshot:120` was returned as a locator but later passed to `querySelectorAll`; `ui_exec(target=app)` selected `__MYBUDDY_COMPUTER_USE_CONTROLS__`; conflicting `action=list_windows` and `actions=[...]` ran the batch against a dummy PID. These are orchestration and contract defects, not evidence that native input is universally broken.

The historical optional-parameter serialization problem had already been corrected separately. This change rejects contradictory modes at runtime too, before window lookup or input. The exact cause of every historical residual overlay cannot be reconstructed from terminal events alone. Native reproduction confirmed the cancelled settlement path skipped cleanup when cleanup depended on notification lifecycle emission.

## Changed contracts

- App UI automation binds the main BrowserWindow explicitly. Creating a CU overlay or another BrowserWindow cannot change `target=app`.
- UI snapshots return actual CSS references attached to exact DOM nodes. Reordering preserves identity; replacing a node, navigating, or taking a new snapshot invalidates old references. Ambiguous, disabled and covered elements fail before clicking.
- CU lifetime belongs to the execution. Settlement, abort, session release and disposal release it independently of notifications. A late old-turn completion cannot close a new turn. Nested scopes cannot resurrect a user-cancelled run.
- Windows operations serialize entire observe/act/verify transactions. Cancelled queued input never reaches the desktop. A partial batch reports the completed steps and is never replayed as a whole.
- Changes to HWND identity, PID, class, client geometry or DPI invalidate observations. Recovery must obtain fresh evidence before sending input; it cannot remove `observation_id` and replay old coordinates, including when a focus retry coincides with a DPI change.
- A captured screenshot is reported as captured. Successful input is `executed`; business success is `verified` only when explicit `expected_outcomes` pass.
- Windows UIA inspection defaults to depth 10 instead of 6. `max_depth` can reach 32 and is passed through inspect/find/invoke/set. Actions bind the exact control runtime ID seen in their preview. Incomplete searches still cannot claim that a name is unique.

## Which interaction path is used?

| Surface | Structured path | Fallback |
| --- | --- | --- |
| MyBuddy renderer, embedded browser, Artifact | `ui_exec`: DOM, role/name, CSS references, Electron input events | screenshot |
| Windows applications | `computer_exec`: UI Automation control tree, runtime ID/automation ID, Invoke/Value patterns | OCR, screenshot and client coordinates |
| Canvas or applications without usable accessibility controls | exposed application API where available | visual observation and coordinate input |

UIA is returned as structured JSON, not XML. Coordinates are an input method; vision and UIA are observation/targeting methods. They can be combined. Client-DIP coordinates from a matching window screenshot must not be confused with desktop physical pixels. The Linux backend remains CUL and retains its explicitly unsupported operations; Windows acceptance does not prove Wayland behavior.

## Regression coverage

| Command | What it proves |
| --- | --- |
| `pnpm -s test:computer-use-boundaries` | contradictory/empty/oversized requests have no Host effects; stale size/DPI/PID/class rejects singles and batches; title changes remain valid; truthful screenshot verification; old-turn isolation; nested cancellation; queued cancellation; partial batch failure; three simultaneous eight-step batches do not interleave |
| `pnpm -s test:computer-use-behavior` | real Electron snapshot-to-click round trip; reorder/replacement/navigation; ambiguity/disabled/occluded targets; Unicode fill and Ctrl+A; cancellation; native border and controls hide on normal/aborted/error settlement without notification listeners |
| `pnpm -s test:computer-automation-windows` | actual Windows UIA and physical input, DIP screenshots, stale window identity, host cancellation, in-flight crash and restart |
| `pnpm -s test:computer-use-overlay` | actual border, hittable Stop, click-through areas, waiting phase and scoped Stop |
| `pnpm -s test:computer-use-agent-desktop` | real AgentService and Responses tool wire: CU → main-app DOM snapshot/click while overlays exist → truncated then deeper native UIA inspection/invocation → screenshot → final; cancellation while provider is held; provider EOF after CU; both native windows hidden |

The last test scripts only the model endpoint; it does not replace the AgentService, native host, adapters or overlay. It uses an isolated HOME/userData with fake credentials. Set `MYBUDDY_DESKTOP_EXECUTABLE` to a packaged `MyBuddy.exe` to run the same chain against the actual distribution; the test verifies the packaged main bundle hash against the built source. `MYBUDDY_CU_TEST_OUT` selects the diagnostics directory. Native desktop tests must run sequentially to avoid competing for focus.

These checks intentionally assert visible effects and terminal cleanup, not only returned tool success. They cover deterministic regression mechanisms, not arbitrary model planning or every third-party application's accessibility implementation.
