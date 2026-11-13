# Gateway configuration UI acceptance — 2026-11-13

Base: `c19ba8bf` (preserves the message HTML export change).

## First batch
- QQ/Weixin connection state is separate from enrollment state. Restored connections are collapsed; managing them does not display an idle enrollment message.
- All channel cards can collapse. Explicit expansion survives routine status refresh; a newly established connection collapses the card.
- Seven credential-based channels have official setup links and ordered instructions. Feishu/WeCom show only fields for the selected mode. Existing stored configuration is preserved.
- Old status requests cannot replace newer results; late configuration reads cannot overwrite edited drafts; canceled QQ/Weixin polling cannot restore an old authorization result.
- Bindings appear after channel setup. This batch does not change binding service behavior.

## Verification on the integrated base
PASS: `tsc -p tsconfig.node.json --noEmit`, `tsc -p tsconfig.web.json --noEmit`.
PASS using `scripts/run-gateway-ui-test.mjs`: `qq-qr-ui-test.tsx`, `weixin-qr-ui-test.tsx`, `gateway-connected-ui-test.tsx`, `gateway-channel-ui-test.tsx`, `gateway-qr-race-ui-test.tsx`, `gateway-setup-guide-test.ts`.
PASS: `node scripts/test-all.mjs --audit` (classification only, not a full test run).

Tests use controlled DOM/IPC fixtures. No real external account was enrolled, no user configuration was altered, and no package/build was produced. Feishu/DingTalk automatic registration and binding-management changes are separate follow-up batches; this report does not certify them.
