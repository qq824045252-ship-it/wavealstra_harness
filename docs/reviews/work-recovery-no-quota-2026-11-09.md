# Work recovery and quota removal delivery

Base: main `af4390b`. Implementation commits: `0461342`, Bot deletion integration `333fd3e`, and the final review follow-up containing this report.

## Delivered

- Remove Work quota services, contracts, controls, enforcement and new-database quota storage. Provider usage remains telemetry, not an admission limit. Remove the Bot “待你决定” navigation.
- Persist targeted standalone Work recovery. Preserve original workspace, execution mode, source event, completed outputs and effect identity. Do not replay completed writes. A failed recovery without new progress becomes a read-only result-gathering pass, then a truthful unsuccessful outcome rather than an endless retry or a user retry-approval gate. Persistent watch duties remain active.
- Preserve successful artifacts after terminal failures; error-only text is not a proposed deliverable. Do not duplicate the recovered report through its synthetic recovery subitem.
- Fix web text extraction to use the official `linkedom/worker` entry, avoiding the optional canvas load.
- Integrate Bot deletion with atomic Work ownership handoff and conversation/cache removal, preserving historical closed Work.

## Verification

- `pnpm -s typecheck`: pass (scripts 0 errors).
- Final `pnpm -s test:all`: **396 passed, 0 failed, 0 known, 0 regressions**, 2.7 minutes.
- Standalone recovery regression: 13 scenarios, including original-output retention, root tasks without subitems, ancestry, handoff, source read-only/offline restrictions, watch survival, same-identity legacy quota dispatch recovery and no unsafe effect replay.
- Real Electron `pnpm dev`, isolated temporary profile: actual Bot composer → local HTTP model fixture → native write → injected HTTP 400 → automatic continuation reads the existing report → result visible once. Existing file written once, original workspace retained, real question reply persisted through IPC. Screenshots visually inspected. Tabs are 对话 / 进行中 / 已结束; quota controls are absent.
- This GUI run uses CDP input and a deterministic local model fixture, **not** an online weather model or physical keyboard/AT-SPI acceptance.
- Earlier integration run exposed a missing explicit store-contract registration for `forgetDeletedBot`; fixed without changing frozen legacy keys. That run also had a gateway journal 5-second timeout. Its standalone 18 checks and the final full run passed; no timeout increase, baseline exclusion or product change was used to hide it.
- Independent static review found no remaining blocking issue in the delivered standalone recovery scope.

## Explicit remaining work

- [Issue #24](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/24): existing database quota tables/columns and raw audit history remain inert; destructive retirement was not performed. No user database was opened or rebuilt. Fresh databases contain no quota schema. See `docs/bot-work-no-quota.md` for exact compatibility behavior.
- [Issue #25](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/25): team-member dependency-aware recovery is separate from the tested standalone continuation path and is not claimed complete.
- Live public weather fetch validation was blocked by this host's fake-IP DNS destination/SSRF boundary; no network protection was bypassed. Controlled extraction and recovery tests passed.
- The user's running source/profile was not updated or restarted by this delivery. Source publication does not imply the running app has adopted it.
