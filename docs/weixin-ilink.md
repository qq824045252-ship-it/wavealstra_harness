# Personal Weixin iLink

Distinct from the WeChat official-account (MP) and WeCom channels. The QR workflow requires explicit approval to store persistent Bot access. The renderer receives only status and QR payload, never bot tokens. Credentials use Electron safeStorage with no plaintext fallback. Authorized users are explicitly allowlisted.

Implementation reference: Hermes Agent commit `72d4433130823f506081cc1189a923b5aa67dbf0`, `plugins/platforms/weixin/adapter.py`; Tencent `openclaw-weixin` protocol documentation (MIT notice in `third-party/openclaw-weixin-LICENSE.txt`). Uses iLink QR authentication, `getupdates` long polling and `sendmessage` with context tokens. This is not password login or a browser automation workaround.

## Safety and lifecycle

- Only HTTPS official iLink hosts are accepted; redirects are rejected. API and CDN response bodies are bounded.
- QR replacement/cancel aborts outstanding calls. Session-scoped cancellation cannot stop a later login.
- Inbound processing starts only after safe credential persistence. Allowlist checks, direct-message/type checks and message-ID dedup precede execution.
- Context tokens stay in memory, are per peer and are cleared on disconnect. They are not placed in task messages or event logs.
- Login-expired error stops polling and requires a new scan. Transient receive failures back off. Uncertain outbound delivery is never automatically retried.
- Adapter instances clear in-memory cursors/dedup on disconnect. The existing Gateway task identity remains the durable execution boundary. This adapter does not claim a durable replay journal.

## Current scope and validation

Text direct messages and replies are supported. Long replies are split at Unicode code-point boundaries into at most 4000 UTF-16 units per segment. Segments are sent serially; each requires a confirmed receipt before the next starts. An unknown receipt, transport failure or disconnect stops the remaining segments without automatic retry. Groups, autonomous notifications, typing indicators, rich messages and full attachment-to-agent routing are not implemented. AES/CDN media helpers exist but are not exposed as working attachment support. Long-poll processing is sequential for bounded backpressure.

Run `pnpm -s test:weixin-gateway`, `pnpm -s test:weixin-qr-integration`, `pnpm -s test:weixin-qr-ui` and `pnpm -s typecheck`. These are mocked/headless checks, not live Weixin account or real QR acceptance. No actual account was accessed during implementation. No build, packaging, commit or push is part of this change.
