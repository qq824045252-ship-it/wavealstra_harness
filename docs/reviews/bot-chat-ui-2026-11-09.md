# Bot conversation UI: real streaming and shared composer

Baseline: main `de3341a616f74e95fae80f9c5bc23ec80ac40f1d`. Version stays 0.1.108.

## Scope

This change improves Bot conversation presentation. It does not remove or change resource isolation, approval policy, or the separate Issue #21 work.

- Connect native runtime snapshots to Bot message events. The persisted native input's `botRequestId` is retained through history projection; only assistant text belonging to that exact foreground request is published.
- Persist full-text frames at a bounded 80 ms cadence. Database revisions reject duplicate/out-of-order frames, and ordinary history reads repair disconnected renderers. Cancellation rejects later running frames; failures preserve the partial reply.
- Both ordinary ChatInput and Bot use the same controlled ChatComposer textarea/toolbar implementation, including sizing, focus/ref, composition/IME, keyboard and paste hooks. Their adapters keep their own identity, drafts, stop action and business behavior.
- The Bot transport currently accepts text, not ordinary Task attachments/MCP/skills. Unsupported controls are not shown as pretend capabilities; ordinary Task controls remain unchanged.
- Render Markdown through the same component from the first text frame. Long replies keep their beginning readable; upward scrolling pauses following. The explicit latest-message action follows asynchronous Markdown layout via ResizeObserver.
- Add a visible stop control and a direct new-conversation confirmation. Starting a new conversation archives existing chat and preserves Work. Secondary header actions move into a compact menu, keeping the Bot name visible at narrow widths.
- Stop targets the running request before a later queued request. Late archive completion is checked against the originating Bot before changing the current page.

## Verification

- `pnpm -s typecheck`: PASS, scripts 0 errors.
- `test:bot-work-phase2`: PASS, actual native runtime with segmented model fixture; multiple running text frames precede completion and revisions increase.
- `test:bot-conversation-ui`: PASS, wrong Bot/request, old/duplicate frames, archived conversation and terminal cancellation.
- `test:bot-workspace`: PASS, shared input, new conversation controls, running-before-queued stop selection and existing workspace presentation.
- `test:chat-composer-ui`: PASS, mounted React controlled input/ref, height limits, IME/229, Enter/Shift+Enter delegation, paste, toolbar and unmount.
- `test:mcp-composer-focus`: 9/9 PASS; existing ordinary input menu focus behavior.
- `test:ipc-channel-inventory` and test suite classification audit: PASS.
- Full default headless suite: 400 passed, 0 failed, 0 known failures, 0 new regressions. Final layout corrections are additionally rechecked with typecheck and affected UI suites.

## Real desktop evidence

Omarchy / Wayland, actual Electron dev instance with a temporary HOME and isolated profile. Online model: local Magpie transport to `opendesign/deepseek-v4.1-flash`. No real application credentials were copied; no production database was modified. These are frontend conversation tests, not tool execution or business Work acceptance.

A real long-response run produced its first >30-character body at 5.256 seconds, 99 distinct text lengths while running, and completed at 28.327 seconds. Markdown was formatted in the first text frame rather than flashing raw source. The stop test held at 55 characters after four seconds and remained stopped after application restart. Switching Bots preserved independent drafts. Actual 800/640/390-pixel windows had no horizontal overflow; the narrow header retained the complete test Bot name and primary controls.

Additional live checks exercise Shift+Enter, archive cancellation, actual new conversation, reading-position retention, explicit latest-message following and history restoration after renderer reload. Local diagnostic captures are retained in the `wavealstra-bot-chat-ui-*result*` temporary test directories on the test machine.

## Limits

No production build/package or version upgrade was requested or run. Windows/macOS, touch keyboards, full OS IME candidate interaction, every ordinary Task attachment flow, and Remote/Gateway conversation streaming are not claimed as newly validated by this change. The native desktop Bot foreground stream is the scope. New-conversation UI does not delete earlier records or cancel existing Work.
