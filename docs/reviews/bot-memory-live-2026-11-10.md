# Bot memory live validation — 2026-11-10

Baseline: `810c7b2`. Isolated Omarchy clone, temporary HOME/userData, production data unchanged.

## Real model and real UI

`test:bot-memory-live` passed in 179 seconds using the configured local model gateway and `opendesign/deepseek-v4.1-flash`, not a mock model. Electron `pnpm dev` UI sent the natural-language requests.

- Remembered a synthetic stable test identifier and brief Chinese response preference as Bot-private L1 facts.
- A second Bot received neither the private fact nor the first Bot's conversation and did not fabricate recall.
- A new conversation after an ordinary Electron restart recalled the persisted identifier. Conversation IDs remained distinct.
- Natural-language correction replaced the old identifier. A further new conversation recalled only the new identifier.
- Natural-language forget invoked the real memory tool. The next conversation received neither identifier and answered that it did not know.
- No Work was created for these foreground memory interactions.

Artifacts (local generated outputs): `out/diagnostics/bot-memory/live/report.json` and `memory.png`. The final UI screenshot was visually inspected.

## Management gap fixed

The Memory settings browser omitted Bot scope and rendered raw Bot IDs. Added **Bot 私人记忆**, readable Bot names, and an optional exact Bot filter. Filtering is applied in SQL before pagination, not to an already truncated UI list. The existing edit/delete/detail functionality remains shared. Switching back to all scopes removes the exact Bot restriction.

Validation: `typecheck`, `test:memory-ui`, `test:bot-memory`, `test:bot-memory-runtime` passed. Native tests cover disabled memory, cancelled/running turns, sensitive-source rejection, replay, source-deletion races and cross-Bot forget rejection. UI tests cover switching Bots and restoring all scopes.

The hidden Wayland fixture could not capture screenshots and did not resize its viewport. A separate visible Electron fixture with isolated userData was used to verify actual 1280px/light and 540px/dark layouts and capture screenshots. Both were visually inspected; these fixtures use simulated records, unlike the real-model test above.

## Boundaries

- Team conversations currently exclude personal Bot memory context/tools; team/shared memory is not validated or implemented by this change.
- The global memory setting controls capture and recall; it is not a per-Bot enable switch.
- A passing synthetic-fact scenario is evidence for this path, not a guarantee that every model will extract every preference correctly.
- No crash injection, production restart, packaging, or full regression suite was performed.
