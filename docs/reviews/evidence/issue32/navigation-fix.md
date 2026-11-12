# Final renderer navigation and time-card checks

The target-owner collaboration Work link used to close the collaboration immediately and schedule the actual Work navigation with requestAnimationFrame. A held-frame Electron regression reproduced the failure: collaboration absent, Work detail absent, no getWork call, and two pending frame callbacks. The before result is `navigation-held-frame-before.json`.

BotWorkspacePage now closes collaboration and opens the Work in the same event. It skips the ordinary Back restoration and copies the saved source return target into the Work return target. No backend, model driver or execution behavior changed. Late animation frames cannot put focus back into the source conversation over the opened Work.

The natural default-throttling isolated fixture remained visibilityState=visible and passed the old implementation. Therefore this report proves the suspended-frame defect through deterministic frame holding; it does not claim to have reproduced an OS-level occlusion transition. The live instance belongs to the separate live acceptance agent.

BotCollaborationView time cards and execution duration now use the same current Work binding start/end. Missing current Work endpoints stay unrecorded even when earlier relation endpoints exist. The recorded end card never substitutes the clock. A running duration can use the clock. The acceptance-to-first-start duration is labeled first queue, separate from current execution duration.

Final evidence:

- `navigation-ui-final.log` and `navigation-ui-final-result.json`: passed actual isolated Electron suite. Includes target owner with an empty personal conversation, a closed owned Work absent from loaded summary pages, opening it while all animation frames are held, retaining Work focus after held frames resume, and returning to personal conversation.
- The result records current binding card times 1970-01-01T00:00:03.200Z and 1970-01-01T00:00:08.200Z while old relation start/end remain 2.2s and 5.2s. It also records both missing current binding endpoints as `未记录`.
- `out/tests/bot-collaboration-wide.png`: current binding's distinct recorded endpoints.
- `out/tests/bot-collaboration-current-times-missing.png`: current binding endpoints are unrecorded despite old relation endpoints, visually inspected.
- `navigation-typecheck.log`: full typecheck passed with zero new script errors.
- Legacy `test:bot-call-thread` and `test:bot-conversation-ui` passed after the navigation change.

An additional `test:bot-work-conversation-desktop` invocation produced startup output but no completed stage output and remained pending. Its fixture uses awaited animation-frame transitions, but the exact blocked expression was not instrumented. It was not accepted as passed. Only its owned Electron main PID 25172 was stopped after checking its exact script command and parent PID 38084; the command exited -1. No user app process or live acceptance instance was stopped.

Final renderer file SHA-256 values:

- BotWorkspacePage.tsx: 0b7f7df9260144e9b3fd08b800bc45082b63da55599bd5250a95d908a3ec8ca6
- BotCollaborationView.tsx: 4759b57fc3674bb6dc5317019c1cc46e59eb3738bbb911890c208bc30d9cf832

These renderer changes follow the frozen live-model core and do not invalidate its executed model tasks. The final live renderer check must use these files or their corresponding source digest.
