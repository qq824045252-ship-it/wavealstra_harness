# Hermes-style Gateway transport integration

Updated: 2026-11-08. The implementation remains an original TypeScript adaptation of selected Hermes transports and boundaries. The comparison reference is NousResearch/hermes-agent `72d4433130823f506081cc1189a923b5aa67dbf0`; this is not a vendored Python runtime or a complete Hermes feature port. The current hardening review is [Gateway reliability review](reviews/gateway-hardening-2026-11-08.md).

## Responsibilities and native execution

All nine adapters register through `GatewayPlatformRegistry`. An authenticated callback becomes an event with platform, verified public account digest, channel/chat/thread source, sender, message ID and implemented capabilities. The producer is bound to the registered adapter; spoofed channel IDs, unverified accounts and inconsistent notification targets are rejected.

The components have separate responsibilities:

| Component | Responsibility |
| --- | --- |
| `GatewayService` | Provider construction, saved configuration, explicit QR enrollment, activation, policy and application events |
| `GatewayRouter` | Current allowlist checks, native task/turn identity, project ingestion, selected model, native execution and reply preparation |
| `GatewayRateLimiter` / `BoundedTTLCache` | Runtime dedupe and bounded fixed-lifetime storage, without full-map scanning or sorting |
| `GatewayLifecycleManager` | Single-flight webhook listener start/stop, port fallback, bounded request bodies and async error containment |
| `GatewayPlatformRegistry` | Provenance, per-session serialization, durable admission/recovery and reply delivery |
| `GatewayDeliveryJournal` | SQLite Inbox/Outbox, immutable input/answer records, bounded retention, retry state and crash recovery |
| `GatewaySecrets` / provider credentials / route credentials | Renderer masking, OS-encrypted credential storage and shared outbound redaction |

Native execution still belongs to `AgentService` / Pi Durable. No second execution runtime is introduced. Slack retains its native task/thread grouping; other providers retain the existing account-scoped chat identity. Queue keys are fixed-position JSON arrays, not objects or delimiter-concatenated IDs. Execution is bounded to 64 pending entries per native conversation and 1024 in the process; different conversations remain concurrent. Adapter-specific admission and provider limits also apply.

## Durable admission and recovery

The desktop host enables the SQLite journal by default. `GatewayServiceOptions.durableInbox: false` is an explicit memory-only embedding/fixture option. Slack keeps its existing pre-ACK `SlackGatewayJournal` and chunk-aware outbox; it does not acquire a second competing delivery ledger.

For other channels, accepted materialized inputs commit to `gateway_inbox` **before the registry's execution queue**. A stable key binds channel, verified account, chat and provider message ID; an ID-less input receives a locally generated identity that survives recovery. Original text, sender, notification target, reply route and attachment hashes are preserved. A repeat cannot replace accepted content. Attachments must still match the bounded Gateway media cache, size, filename hash and SHA-256 before native execution; missing or changed files block the input rather than silently dropping its attachments.

DingTalk and HTTP callback adapters await the journal's `accepted` promise before successful protocol acknowledgement. Polling adapters advance only after the appropriate acceptance path. ACK failure and execution failure are different states. A transport may detach completion after durable acceptance, but both promises have rejection observers and failures remain visible to the owning transport.

This is a guarantee about **inputs accepted by this Gateway**, not a claim that all provider events are recoverable before download/validation/admission. Discord/QQ transport sequence state, arbitrary offline history backfill, and provider-side redelivery guarantees are separate concerns. Media preparation that has not reached durable admission is not represented as an accepted durable message.

The auxiliary tables are created idempotently without increasing `CURRENT_DATABASE_SCHEMA_VERSION`. This repository intentionally backs up and resets incompatible schema versions; an additive transport journal must not reset existing native sessions or erase their receipts.

| Stored state | Recovery behavior |
| --- | --- |
| `pending` input | Re-enter the original conversation queue under the same verified account and current allowlist |
| `running` with native receipt support | Use the original stable identity to obtain an existing native receipt, or submit if the crash preceded native admission; Pi's tool recovery/unknown rules continue to apply |
| `running` without native receipt support | Preserve `unknown`; do not replay a potentially effectful handler |
| Answer saved / reply pending | Send the saved answer through the authenticated route, without invoking the Agent again |
| Provider explicitly proves “not sent” | Retry with bounded backoff when classified retryable; stop after five attempts by default |
| Send was in flight at crash, partial message sent, lost/malformed receipt | Preserve `unknown`; stop automatic resend |
| Expired route, changed account, revoked user, invalid attachment | Preserve a blocked or pending record and surface its status; do not redirect to another recipient |
| Completed receipt | Suppress the duplicate before native execution, including after process restart |

Each send rechecks current account, lifecycle generation and sender authorization. Reconnecting to the same public account may reconstruct a sender from the original saved route; it may not reuse a stale transport closure or switch to another account. Runtime session ordering survives errors because settled queue tails consume their rejection while the delivery result remains observable.

The journal defaults to 10,000 unresolved inputs, 100,000 completed receipts and 30 days of completed-receipt retention. Unresolved records are not silently evicted to make space; admission applies backpressure. These are bounded operational windows, not an infinite exactly-once guarantee.

## Reply routes and provider boundaries

| Channel | Implemented transport and durable reply route | Limits that remain |
| --- | --- | --- |
| Feishu | Official SDK WebSocket or authenticated webhook; original chat/message/thread route | Real SDK long-duration outage and account acceptance remain unverified |
| WeCom | Smart Robot WebSocket or encrypted callback; callback user/group route can be reconstructed | Smart Robot request-bound replies cannot be assumed valid after connection loss; blocked results remain visible |
| WeChat public account | Authenticated/encrypted HTTP callback; original openid | Platform customer-service window and provider rejection still apply; distinct from personal Weixin |
| Telegram | Long polling; original chat/reply/topic route | No persistent provider update cursor or arbitrary offline backfill; bounded retry does not resend already sent chunks |
| Slack | Socket Mode with existing journal, native threads, history and reply chunks | Maintains its existing independent transport journal and recovery semantics |
| DingTalk | Stream; validated, expiring session webhook encrypted with OS storage | Recovery is only possible before capability expiry; a temporary webhook is not an autonomous Work target |
| Discord | Gateway socket; original channel/message/reference mode and stable nonce | No independent durable Gateway sequence/backfill subsystem or autonomous Work sender |
| QQ | Official bot WebSocket; original group/C2C recipient, message ID and expiry | Passive reply windows still apply; not a personal QQ protocol |
| Weixin iLink | Personal direct-message polling; bounded context tokens and OS-encrypted, expiring reply capability | Groups and autonomous Work notifications remain unsupported; expired capabilities need new authenticated context |

Temporary reply capabilities are encrypted with a versioned `safeStorage` codec and bound to the account, original message and destination. They are never plaintext route fields, model instructions or diagnostic content. Without the host codec, standalone adapters retain only bounded runtime reply context and do not claim restart restoration of those secrets.

Public leaf-adapter capability declarations describe the adapter itself. The registry adds `durableInbound` to normalized events when its journal is enabled. Media capability remains `inbound`, not `bidirectional`; transport durability does not imply outgoing file or interactive-card support.

## Credentials, policy and output

All nine channels persist configured secrets with OS encryption, including the previously plaintext Telegram and public-account fields. Existing supported plaintext provider configuration is sealed before transport restoration. Secure storage unavailability or Linux `basic_text` prevents credential persistence/restoration; there is no plaintext fallback. Renderer configuration readback returns placeholders. Dedicated QQ/Weixin QR authorization and the explicit persistent-access enrollment gate remain unchanged.

`GatewaySecrets` applies configured-secret and common credential-pattern redaction to normal answers, error answers, Work notification text and stored/broadcast Gateway events. Long-running turns retain a bounded snapshot of their original credentials through later rotations. Provider-specific redaction remains defense in depth. Authentication headers used to talk to the provider are not altered.

Policy is checked again for recovery and immediately before an outbox send. An old accepted input or notification target cannot grant access after its sender has been removed from the current allowlist. Reply failures do not manufacture a new Work, new task, recipient, or cross-platform fallback.

## Remaining feature and validation boundaries

The preceding media increment implemented bounded attachment ingress for Feishu, WeCom smart mode, Telegram, Slack, DingTalk, Discord, QQ and Weixin. It did not implement universal outgoing attachments, STT/transcoding, typing/edit streaming, slash commands, interactive approvals, a standalone daemon or all Hermes plugins. Public-account media and Weixin groups remain unsupported. Capability details are recorded in [the Hermes comparison](hermes-gateway-parity.md).

Headless fixtures verify protocol handling, SQLite recovery, reply classification, encrypted routes, provenance, authorization and native receipt reuse. They do not establish real account login, QR acceptance, Windows/Omarchy filesystem behavior, long-duration outages, physical device reconnects or a packaged release. No product build/pack is part of this hardening task. The exact executed gates and environment failures are recorded in the linked review.

Hermes and Tencent notices remain under `docs/third-party/`, included in the packaging file list; installed SDKs retain their own licenses.
