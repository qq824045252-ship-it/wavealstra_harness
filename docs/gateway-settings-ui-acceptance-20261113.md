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

## Second batch: saved personal-assistant bindings

Base: `2e3f3b99`. Adds a saved binding list with edit, unbind and refresh; disconnected channels and missing/inactive Bots remain manageable. Recent sender suggestions are scoped to the authenticated connection identity. Changing account invalidates an editing session. Binding writes are serialized and read current settings inside the queue, then validate connection generation before a synchronous binding-only write.

PASS on the integrated candidate: full node/web TypeScript checks; binding validation/concurrent update/generation tests; Slack current/old/unknown connection identity tests; binding-management DOM tests; test classification audit. These are controlled fixtures, not a live external account acceptance. The second batch contains no Feishu/DingTalk automatic registration changes.

## Third batch: Feishu / DingTalk registration

Base: `cf8ccfa7`. Empty channels offer official robot-creation QR onboarding first, with an existing-application manual option. Existing saved configurations are not replaced by registration. Explicit creation/persistent-credential consent is required; credentials remain in the main process and are encrypted at rest. Feishu support is mainland Feishu, not international Lark. DingTalk requires enterprise/robot/allowed-user identity completion where the official response does not supply it.

PASS: full node/web TypeScript checks; official-protocol fixtures and registration state-machine tests; registration component DOM test; single-card DOM integration (including status-before-result ordering and manual-connect/disconnect preservation); extracted production GatewayService-method race/identity/persistence tests; existing generic channel and binding DOM tests; test classification audit.

Independent UI review found and fixed early status-driven unmount before registration completion, and missing saved-config state after manual connection. Regression coverage was added for both. The protocol/service tests use fixtures and do not establish live official platform acceptance. No real platform account or app was created during this work. Packaging/full-suite/real-provider QR acceptance were not run.
