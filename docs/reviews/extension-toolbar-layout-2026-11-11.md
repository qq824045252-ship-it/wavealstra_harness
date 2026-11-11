# Expanded sidebar toolbar alignment

## Scope

The supplied terminal capture stretched the seven tool icons across the widened panel, while the normal overview capture used a compact, evenly spaced rail. Both paths render `ArtifactPanel` / `ExtensionTopBar`; there is no separate Bot terminal toolbar to fork.

The shared navigation group now retains the normal 375px rail's 257px tool-group width. Additional panel space stays between the tools and the right-aligned expand/pin/close controls. Terminal and browser content still receive the existing wider canvas. No panel sizing, terminal ownership, browser IPC, or navigation actions changed.

At narrow widths the tool group scrolls instead of covering the window controls. The header accommodates the horizontal scrollbar. Mode changes reveal the active tool, keyboard focus reveals the focused tool, and resize keeps a focused tool visible before falling back to the active one.

## Verification

On Omarchy, using an independent clone, real visible `pnpm dev` Electron session, and temporary HOME/userData:

- `pnpm -s typecheck`: passed, including zero new script type errors.
- `pnpm -s test:extension-toolbar-dev`: passed. Normal Pi and Bot Pi Durable task fixtures exercise the production shared toolbar in overview, terminal, browser, expanded and restored states. At a 1600px viewport the panel changes from 375px to approximately 949px while the tool-group width stays approximately 257px and each icon's relative position stays within 1.1px of the normal rail.
- Real terminal tab creation, keyboard shell input, PTY output, switch to browser and reattach to the same PTY session: passed.
- Real browser address input, Enter navigation to a test-only loopback page, committed native navigation and hard refresh: passed. The test waits for navigation to commit before refreshing.
- 1024px, 760px and 600px layouts, all seven tools reachable by keyboard, active-tool reveal, focused inactive tool retained on actual narrow resize, expand/restore/pin/close, and toolbar scrollbar containment: passed.
- `pnpm -s test:terminal`, `pnpm -s test:browser-navbar-ui`, `pnpm -s test:visual-polish-ux`, and `node scripts/test-all.mjs --audit`: passed.
- Screenshots of the normal rail, expanded terminal/browser, live PTY, and narrow layouts were visually inspected locally. Reports and screenshots are generated under `out/diagnostics/extension-toolbar/`.

The desktop test uses CDP mouse/keyboard events against the actual production renderer, not OS-level input-driver certification. Task rows and transcript contents are isolated fixtures; terminal and browser IPC are real. No model request is required. This is Linux desktop acceptance, not Windows/macOS or packaged-app acceptance. No full regression suite or product build/package was run for this localized toolbar change.

## Integration

Rebased onto the ACP menu readability and Bot add-menu changes, preserving their CSS, test registrations, and isolated dev harness hooks. No production instance or user profile was modified.
