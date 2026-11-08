# Hermes-style gateway transport integration

Reference: NousResearch/hermes-agent commit `72d4433130823f506081cc1189a923b5aa67dbf0`, including `gateway/platforms/event.py`, `base.py`, `ADDING_A_PLATFORM.md` and the provider plugins. This is an original TypeScript adaptation of the shared boundary and selected transports, not a vendored Python runtime or a complete Hermes feature port.

## Shared boundary and native execution

All nine adapters register through `GatewayPlatformRegistry`. Authenticated transport callbacks become a normalized event containing the platform, public account digest, channel/chat/thread source, sender, message ID, text, receive time and actual capabilities. Registration binds the producer to its adapter and rejects duplicate IDs, spoofed sources, disconnected/unidentified accounts, and inconsistent notification destinations. Dynamic Feishu/WeCom capabilities reflect the selected socket or legacy callback mode.

The registry serializes execution in each existing native conversation. Slack retains its native task/thread identity; other providers retain their existing chat identity. Different chats remain concurrent. Admission is bounded to 64 pending messages per conversation and 1024 globally. Each queued message and reply rechecks both account identity and the opaque transport generation, including same-account reconnects. Failure of one turn does not poison later turns. This queue is in-memory, not a durable inbox or replay mechanism.

GatewayService still owns policy, existing native session routing, AgentService execution, project hooks, selected model and UI events. No extra bot runtime, personality, database schema or new session isolation is introduced. Internal transport metadata and credentials do not become model instructions. Credential-bearing socket providers are activated only after their policy and encrypted configuration have been saved; failed persistence disconnects the transport. Feishu/WeCom legacy configurations are encrypted before restoring transport. The old WeChat public-account and Telegram credential handling is otherwise unchanged.

## Implemented transports

| Channel | Transport | Scope and limits |
| --- | --- | --- |
| Feishu | Official SDK WebSocket or existing authenticated webhook | Text and existing Work notifications; SDK reconnect is bounded by the connection lifecycle. Real SDK long-duration outage/exit acceptance remains unverified. |
| WeCom | Smart Robot WebSocket or existing encrypted callback | Smart Robot replies use the inbound request ID; autonomous Work notifications remain callback-only. |
| WeChat public account | Encrypted HTTP callback | Existing public-account behavior, distinct from personal Weixin. |
| Telegram | Long polling | Reply thread/topic is preserved, including HTML fallback. Existing native session grouping remains unchanged. No unnecessary HTTP listener is started. |
| Slack | Socket Mode | Existing durable journal, native thread sessions and real channel history. |
| DingTalk | Stream socket | Existing acknowledgements, account checks and reconnect handling. Temporary reply webhooks are not Work targets. |
| Discord | Gateway socket | Existing resume/reconnect/queue and allowlist behavior. No autonomous Work sender. |
| QQ | Official bot WebSocket and dedicated QR authorization | Explicit credential-enrollment approval, owner allowlist and safeStorage. Not personal QQ. |
| Weixin | Personal iLink long polling and dedicated QR authorization | Text direct messages, context-token replies, owner allowlist and safeStorage. Distinct from MP/WeCom. |

Capabilities describe implemented behavior, not theoretical provider APIs. Socket/polling-only channels do not open the local webhook server. Existing callback configurations remain supported.

## Not implemented or not verified

This does not complete the entire Hermes feature set. General attachment-to-agent routing, full media support, typing/edit streaming, slash commands, pairing UX, interactive approvals, a universal durable inbox/outbox, standalone daemon, voice and plugin-owned setup/factory registration remain outside this increment. Weixin groups and autonomous notifications are unsupported. Its low-level media helpers are not advertised as agent attachment support. Core service configuration still contains provider-specific registration and setup.

No global retries or automatic fallback sends are introduced. Ambiguous delivery must not rerun a tool-bearing agent turn. Provider authentication and protocol acknowledgements remain each adapter's responsibility. Generation checks supplement, rather than replace, those checks.

## Verification and licenses

Headless tests cover provider protocols, encrypted persistence, activation ordering, spoofed sources, bounded FIFO/cross-chat concurrency, failure recovery, same-account replacement, stale replies and QR cancel/replace/UI flows. These tests use fixtures and do not prove live account authentication, real QR acceptance, provider availability or desktop rendering. No production build or packaging is run as part of this work.

Hermes and Tencent notices are retained under `docs/third-party/`, which is included in the packaging file list. SDK dependency licenses remain with their installed packages.
