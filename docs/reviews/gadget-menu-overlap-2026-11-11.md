# Gadget menu clipping and card layout

## Reproduction and cause

The supplied My Gadgets screenshot was reproduced in a visible, isolated `pnpm dev` Electron instance using a single Gadget and a long Chinese description. At 1600 × 980, only the first of six action items passed pointer hit-testing. The status badge grew to 47px and wrapped vertically.

- The absolutely positioned action menu was inside `.gadgets-panel-content`, whose `overflow-y: auto` clipped it at the short list boundary. Increasing z-index alone cannot escape this clip.
- The redesigned card markup was stacked only under `.task-gadgets-view`. Global/workspace pages retained the old horizontal flex layout, squeezing the status between the title/action row and description.

## Change

- Portal the Gadget action menu to the document body. Reuse `placeFixedMenu`, zoom-aware geometry, the existing outside/Escape dismissal hook, and existing menu styles.
- Measure after opening and on resize/content changes; flip above the trigger near the viewport bottom and constrain long menus with internal scrolling.
- Dismiss when the surrounding list scrolls, preserve internal menu scrolling, and restore trigger focus on Escape. Clear stale anchors when filtering/removing a row.
- Use the same stacked card layout in every Gadget scope, keep status labels on one line, and limit the nested scroll container to the task side panel. Global/workspace pages retain their existing outer scroll owner.

## Verification

- `pnpm -s typecheck`
- `pnpm -s test:gadget-blueprint`
- `node scripts/test-all.mjs --audit`
- `env -u ELECTRON_RUN_AS_NODE pnpm -s test:gadget-menu-dev`
- `git diff --check`

The new GUI test launches the real development application with disposable HOME, userData, database, workspace and Gadget files. It uses actual preload/IPC and Electron mouse/key input, not HTML-only fixtures. No model call, production data, existing task, production process, release output, version, or shortcut is changed.

Coverage: single and long lists; global/workspace/task scope; all menu items hit-tested at 1600, 1024, 760 and 600px widths; 125% CSS zoom; open-menu resize; dark mode; trigger toggle/reopen; Escape, outside click and list-scroll dismissal; edit/source/move/delete dialogs and Cancel; filtering/removing a row without reviving a stale menu. Screenshots and detailed geometry remain under `out/diagnostics/gadget-menu/`.

The full headless regression suite and packaging were deliberately not run for this localized renderer/layout change. This is development Electron acceptance, not packaged-app acceptance.
