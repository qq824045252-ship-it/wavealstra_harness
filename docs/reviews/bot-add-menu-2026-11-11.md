# Bot add menu parity

## Changes

- Reused the ordinary `InputAddMenu` for all nine entries, including consultation, task references, conversation-file references and external Agent selection.
- Fixed the artificial 280px minimum menu-height reservation. The menu follows the actual plus button with an 8px gap; narrow screens use a bounded submenu with a back button instead of an offscreen cascade.
- Conversation files are scoped to the current Bot/team history. Task references use the existing shared prompt builder; file references become actual attachments. Generated context is hidden in user message/reply text.
- Consultation, external Agent and references are one-message selections. The outgoing request is immutable for retries. Editing a rejected request restores references without duplicating them as direct attachments.
- Selected consultation uses the existing durable consultation runner. Selected external Agent uses the existing ACP runtime, one task per request, cancellation and unavailable-agent errors. Successful selected-tool evidence is checked in persisted paginated entries rather than the truncated presentation snapshot.
- Host-created ACP tasks are hydrated immediately and linked from the Bot reply, so pending approvals remain accessible. Hydration excludes already-persisted text deltas and respects runtime disposal.

## Verification

- Actual Electron pointer/keyboard interaction with the production Bot page/store: nine menu items, 1100/640/530/500/360px widths, anchoring, bounded submenus, back navigation, all selector callbacks, readiness/conflict feedback, original send context, one-shot reset, Bot/team isolation and external-task navigation.
- Actual `pnpm dev` application with isolated HOME, native preload/IPC, and a deterministic local HTTP provider: 1280/640/360px, menu placement, Escape dismissal, native send and completed reply. No product build/package or production profile mutation.
- `pnpm -s typecheck`.
- Focused regressions: `test:bot-attachments`, `test:bot-conversation-ui`, `test:bot-settings`, `test:bot-work-foreground-contract` (includes selected runtime and long-history tests), `test:app-store-runtime`, `test:acp-runtime`, `test:acp-desktop-hydration`, `test:acp-permission-policy`, `test:app-permission-ui-removal`, `test:durable-consult`, `test:multi-model-consult`, `test:consult-selection`.
- Test classification audit and `git diff --check`.

This acceptance uses local provider/ACP fixtures for deterministic execution paths. It is not a live-model acceptance claim. No full headless/GUI aggregate was run: risk-focused tests cover the changed composer, reference, ACP, consultation, persistence and runtime-lifecycle boundaries.

Generated screenshots and dev report are under `out/tests/bot-add-menu-*.png` and `out/diagnostics/bot-add-menu/dev/` (not committed).
