export const DIMAGENT_DEBUG_SKILL_ID = "dimagent-debug";

export const DIMAGENT_DEBUG_SKILL_MD = `---
name: dimagent-debug
description: Evidence-first debugging inspired by DimAgent. Trigger for reproducible bugs, UI interaction failures, inconsistent tests, runtime-only failures, and "works here but not there" issues. Reproduce before patching; use control experiments; distrust contradictory tests until the harness is verified; make the smallest root-cause fix; replay the original path after the change.
display_name: DimAgent Debug
version: 1.0.0
---

# DimAgent Debug

Use this skill when the user asks to fix a bug, especially a UI/interaction bug, a runtime-only failure, a flaky/inconsistent test, or a case where one entry path works and another does not.

The goal is not to generate many hypotheses. The goal is to obtain enough runtime evidence that the eventual patch explains the observed failure.

## Core rule

**Reproduce first. Patch only after the evidence points to a root cause.**

A plausible code smell is not a root cause. A green test is not proof that the user's bug is fixed. A failing test is not proof that the test itself is valid.

## Workflow

### 1. Establish reality

Before changing code, confirm the thing being inspected is the thing the user is actually running when that distinction matters.

Check only what is relevant, for example:

- current repository / branch / commit / dirty state;
- running process and executable when stale binaries are plausible;
- build/output timestamps when the user may be running an old artifact;
- current runtime, feature flag, config, or route when multiple paths exist.

Do not turn this into ceremony. Skip checks that cannot affect the bug.

### 2. Read the narrow implementation and form a provisional hypothesis

Read the smallest code region that owns the failing behavior and the nearest working analogue.

You may form an early hypothesis, but do not patch merely because it looks convincing. State it internally as provisional and design a reproduction that can falsify it.

### 3. Reproduce with the highest useful fidelity

Choose the most direct method that is both realistic and inspectable.

Preferred order for MyBuddy UI bugs:

1. Use \`runtime_probe\` with \`mark\` before an interaction when runtime errors/state changes may matter.
2. Use \`ui_exec\` for MyBuddy Renderer / embedded browser / Artifact surfaces.
3. Use \`runtime_probe read\` after the interaction to collect only new console/runtime/navigation/process evidence.
4. Use a real-window or framework interaction test when it gives more deterministic observability than live UI operation.
5. Use \`computer_exec\` only when the behavior crosses into native desktop UI (Windows UIA / Linux AT-SPI), focus, desktop coordinates, file pickers, or other surfaces that \`ui_exec\` cannot see.

For non-UI bugs, use the narrowest executable reproduction: failing unit/integration test, CLI command, request, process state, or runtime log.

For a UI reproduction, prefer semantic locators (role/name/text/test id) over brittle coordinates. Use coordinates only as a desktop fallback.

### 4. Run a control experiment

When a nearby path is expected to work, test it.

Examples:

- broken center button vs working header button;
- broken route vs working sibling route;
- failing input shape vs known-good input shape;
- one scroll child sizing rule vs another;
- current build vs freshly rebuilt binary.

A useful control removes whole classes of causes. If both paths call the same native picker and only one click path fails, the picker backend is probably not the primary fault.

### 5. Treat contradictory evidence as a test of the experiment

If reality and the test disagree, do not immediately trust either one.

Audit the reproduction itself for:

- persistent queues not consumed between checks;
- stale cache/state from a previous control;
- reused fixtures or IDs;
- asynchronous work not awaited;
- focus/overlay/hit-testing differences;
- wrong process, wrong build, wrong target window;
- selector matching a hidden or duplicate element;
- a green assertion that observes leftover state instead of the action just performed.

A false-positive test is itself evidence about the harness, not evidence that the product works.

### 6. Inspect framework/dependency source when semantics matter

If the root cause depends on framework behavior, read the exact locked/installed version rather than relying on memory.

Examples: layout measurement, scroll range computation, event dispatch, focus behavior, Electron/WebContents semantics, queue lifetime, caching, or lifecycle ownership.

Use dependency source only to resolve a concrete semantic question raised by the reproduction.

### 7. State the root cause as an explanation

Before editing, the root-cause statement should explain:

- why the reported path fails;
- why the control path works (if there is one);
- why the observed runtime/test evidence looks the way it does.

If the explanation cannot account for the evidence, keep investigating.

### 8. Make the smallest root-cause patch

Change only what is required to remove the demonstrated cause.

Do not mix in cleanup, style changes, broad refactors, dependency upgrades, or speculative hardening unless they are required for the fix.

### 9. Replay the original path

After the patch, repeat the same reproduction that failed before.

For UI bugs, replay the same user-visible interaction with \`ui_exec\` or the same real interaction harness. Do not substitute a compile success for replaying the behavior.

Then run the smallest relevant regression test/build/typecheck set needed to establish that the patch did not break adjacent behavior.

### 10. Report evidence, not confidence language

Final handoff should distinguish:

- **Before:** what was actually observed failing;
- **Control:** what comparison narrowed the cause, if used;
- **Root cause:** the mechanism that explains the evidence;
- **Patch:** the minimal change made;
- **After:** the same path succeeding after the patch;
- **Regression checks:** exact relevant tests/builds run;
- **Residual risk:** only concrete remaining uncertainty.

## Tool guidance

### \`runtime_probe\`

Use as the runtime evidence recorder around an interaction. A typical sequence is:

\`runtime_probe mark -> ui_exec action -> wait_for (if needed) -> runtime_probe read(after_sequence=marker)\`

Prefer \`levels=["warning","error"]\` or focused \`kinds\` when the event stream is noisy. \`status\` also reports renderer PID, URL/title, loading/crash state, document focus, and the currently focused element. The probe is bounded and read-only; it does not replace a real reproduction.

### \`ui_exec\`

Use for MyBuddy-owned web surfaces.

Useful sequence:

\`snapshot -> find/inspect -> click/fill/press/scroll -> wait_for -> snapshot/screenshot\`

For a click bug, prefer \`click\` because it follows the real Electron input path instead of JavaScript \`element.click()\`.

Targets:

- \`app\`: MyBuddy main Renderer;
- \`browser\`: embedded browser WebContentsView;
- \`artifact\`: Artifact preview WebContentsView.

### \`computer_exec\`

Use as a fallback for native desktop surfaces (Windows UIA, Linux AT-SPI) or desktop-level behavior that Renderer inspection cannot observe. Linux has no overlay, so \`attach_app\` there only locks the target window (no highlighted frame).

Start read-only when possible: \`active_window\`, \`list_windows\`, \`screenshot\`, \`ocr_window\`. Use \`attach_app\` to lock an app window once and pass \`app_session_id\` afterwards; the overlay then frames that window instead of the monitor. Focus/mouse/keyboard operations can have broad side effects and should be used only when needed for the reproduction. Agent-facing \`computer_exec\` automatically enforces Observe -> Act -> Verify for side effects, keeps the post-action window observation, and performs at most one bounded recovery for stale observations/focus/read-only host failures; \`capture_after\` is opt-in (pass \`capture_after: true\` when you need a screenshot as proof). Use \`actions: [...]\` to run 1–8 window-scoped input steps in one tool call (sequential, stops on the first error) instead of paying one model turn per click; steps support click_count/modifiers/hold_ms, drag steps/duration_ms, scroll notches, key_down/up and paste_text. For accessibility-empty Chromium/Qt/Tauri apps use \`ocr_window\` (local OCR: Windows OCR / OCR_NPU_CLI, or tesseract on Linux; client-DIP text boxes). For actions with a concrete expected result, pass \`expected_outcomes\` (for example \`target_closed\`, \`new_window\`, \`target_foreground\`, \`control_present\`, or \`control_absent\`). A semantic outcome failure means the action ran but the intended result was not proven; re-observe and re-plan instead of treating a successful screenshot as success. Treat recovery guidance as the next observation strategy; never loop the same failing action blindly.

### terminal / code / filesystem tools

Use them to inspect source, process/build state, run the smallest reproduction, edit the minimal patch, and run relevant regression checks.

Do not replace a user-visible reproduction with source reading when the application is available and the bug is interaction-dependent.

## Anti-patterns

Do not:

- edit first and "verify" afterward;
- list many generic hypotheses without trying to falsify them;
- claim a bug is fixed because typecheck/build passes;
- claim the product is correct because a test is green when the live behavior disagrees;
- keep broadening the patch after the demonstrated cause is fixed;
- use desktop coordinate clicking when \`ui_exec\` can identify and operate the element deterministically;
- use \`computer_exec\` for destructive or unrelated desktop actions.

## Example pattern

User: "The middle Open button does nothing."

A good debugging loop is:

1. inspect the empty state and identify the center Open button;
2. click it through the real interaction path and confirm no picker-related state/change occurs;
3. click the header Open button as a control and confirm that path works;
4. if a test unexpectedly says the center path passed, inspect the test harness for persistent state before trusting the result;
5. compare the two handlers/IDs only after the behavioral difference is proven;
6. patch the specific cause;
7. replay the center button interaction;
8. run the focused regression test and build.

This is the default shape, not a rigid script. Adapt the evidence source to the bug.
`;
