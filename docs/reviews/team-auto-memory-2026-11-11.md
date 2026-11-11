# Team conversation automatic memory

## Change

- Removed the team-only exclusion at the successful foreground completion transaction. The existing adapter records verified receipt/message pointers with the actual team ID and queues the existing single writer.
- Explicitly required the extractor's existing retention/sensitivity JSON classifications and distinguished a no-tool reply request from no-save/conversation-only wording. Strict missing-classification, sensitivity, evidence and scope filters remain unchanged.
- No synthetic Task, extra memory store, approval flow, or background Work was introduced.

## Verification

Final isolated Omarchy desktop Electron (`pnpm dev`, no build/package), actual `opendesign/deepseek-v4.1-flash` gateway model: **PASS**.

Two UI-created teams, one owner and one member Bot, eight fresh team conversations and eight distinct task types:

- 库存算术: PASS.
- 半日行程: PASS.
- 会议议程: PASS.
- 客服改写: PASS.
- 单位换算: PASS.
- 出门清单: PASS.
- 装箱表格与共享事实: PASS.
- 标点校对与共享事实: PASS.

Both team preferences were learned from completed ordinary conversation through L0/L1, with exact user/assistant source pointers and no direct `memory_remember` call. Every task checked actual provider request contents as well as replies: owner/member private markers and the other team's marker were absent. Explicit public memory was available to both teams.

After all eight normal tasks, natural-language team forgetting removed the team preference. A fresh real-model request did not receive or reproduce the deleted marker. The other team, personal Bot records and explicitly shared public fact remained intact. The final Electron screenshot was visually inspected.

Focused checks passed:

- `pnpm run typecheck`
- `pnpm run test:bot-memory-runtime`
- `pnpm run test:bot-memory`
- `pnpm run test:bot-memory-forget-watermark`
- `pnpm run test:bot-history-context`
- `pnpm run test:memory-assistant-scopes`
- `pnpm run test:bot-team-conversation`

Runtime coverage includes successful team completion, L0/L1 ownership, replay, fresh conversation, no approval candidates and noncompleted statuses. Source-deletion and explicit-forget races are deterministic tests. Missing retention/sensitivity remains fail-closed. Existing persistent watermark tests cover reopen, delayed capture and new authorized relearning in all four scopes.

## Evidence and limits

Reproduce: `TMPDIR="$PWD/out/tmp" pnpm run test:bot-frontdoor:live --team-auto-memory` (create the directory first). Final local artifacts: `out/diagnostics/team-auto-memory/live/report.json`, `provider-requests.json` and `team-memory-eight-types.png`.

Initial attempts exposed shared `/tmp` quota exhaustion and automatic seed extraction being skipped; neither was counted as a successful eight-task run. The final run used repository-local temporary HOME/userData and the clarified extraction contract. Production profiles, credentials, running tasks and the original checkout's untracked files were untouched.

This validates ordinary team conversation memory, not a full suite, background team-member execution, native desktop input or crash recovery. No crash/fault injection, package or installation was performed. Automatic extraction remains selective/asynchronous and may omit uncertain material; a completed chat reply is not a durable-save receipt.
