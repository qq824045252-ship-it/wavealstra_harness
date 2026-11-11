# Bot foreground memory

## The missing connection

`DurableBotService` already projects completed ordinary task turns into the existing L0/L1 pipeline via `AgentService`. The independent `BotConversationService` previously exposed only `memory_search`. It neither captured completed conversation sources nor injected recalled facts. Stored native chat history is not cross-conversation memory.

## Current path

1. The foreground assistant completion transaction captures one L0 source pointer through `BotConversationMemory` and `MemoryPipelineManager`. The source is the actual `bot_conversations.conversation_id`, authenticated receipt and user/assistant message IDs. No synthetic Task or second memory store is created.
2. L0 does not duplicate user, assistant, tool or attachment contents. Known secret/private/opt-out messages are excluded. The original message remains only in the ordinary Bot conversation.
3. The existing `AgentService.memoryWriteQueue` reads completed user messages transiently after validating their receipt, user, Bot, conversation and message identities. It uses the configured Bot model/default model, the existing retry states and source-existence guards.
4. Extraction must label a candidate `retention: "stable"` and `sensitivity: "none"`, include exact user evidence, and pass deterministic secret/identifier checks. Short-lived progress, questions, risks, procedures and unsupported model guesses are not learned by this adapter. The L1 evidence contains only the supporting quote, never the complete mixed message. Model classification is conservative but is not a proof that all possible sensitive phrases can be recognized.
5. Candidates use the existing reconciler. Scope is forcibly the current Bot's private namespace; no global, project or team promotion. Unsupported/conflicting candidates are rejected instead of adding an approval workflow.
6. Every provider request receives a freshly selected, bounded active L1 context (6 KB budget, at most 12 atoms). `memory_search` uses the same Bot/user and enabled checks. Evidence is request-only and is not appended to the native transcript.
7. Learning runs asynchronously. A slow or failed extraction cannot delay the next foreground message or close the chat. A just-sent fact may not be available to another new conversation until extraction completes.

## Explicit forget in the foreground

The foreground exposes `memory_forget` alongside `memory_search`. A natural-language forget request searches the current Bot's records and deletes the exact selected records through the existing `MemoryService.forget` path before reporting completion. The host validates the current durable request, the user's literal forget quote, enabled Bot/user identity and every record's private scope; a mixed foreign-scope batch fails before any deletion. No Work or approval card is created. The returned count describes committed deletion, including idempotent already-absent records. Chat history is not deleted by this operation.

Previously the model saw only a search tool and told the user it could not delete; the asynchronous stable-fact extractor could also skip a forget directive as a one-off request. Forget now has a direct execution receipt rather than depending on post-reply extraction. Bot post-reply extraction rejects forget candidates, so a completed exact deletion cannot trigger a second fuzzy deletion of a similar remaining record; other memory scopes retain their existing behavior. Remember/correct still use the asynchronous extraction path, so do not promise those are persisted before completion.

## Lifecycle and privacy

- Cancelled, failed, running and duplicate replies do not create new L0 sources.
- Memory disabled means no capture, search or automatic context. In-flight extraction checks the current setting before commit.
- Restart uses the existing processing-to-retryable recovery and failed-turn retry budget. Manual extraction/retry can process Bot sources without fabricating Task rows.
- Existing L0 deletion prevents in-flight extraction from writing from deleted sources. Existing L1 deletion also invalidates any extraction already running in that scope, avoiding recreation of the just-deleted fact.
- New conversations keep the same private Bot facts. Other Bots/users cannot retrieve them through this adapter.
- This change does not extend or alter Bot/conversation deletion behavior. Existing memory settings retain their original forget/source-delete controls.
- L2/L3 remain the existing manually generated, approved project/workspace/global derived views. This patch does not add Bot L2/L3 generation or another approval screen.

## Query-aware historical references

Foreground evidence also reads relevant completed turn pairs from earlier conversations in the same personal Bot or the current team, owned by the same user. This is a separate, request-only historical reference, not stable user memory: assistant answers remain attributed, potentially incorrect source material, never instructions or authority. The current request supplies the query and source timestamp. No additional model call or transcript copy is created.

Sources require matching original messages, authenticated receipts and an existing exact L0 pointer. Deleted messages, receipts or L0 sources disappear on the next provider request; old conversations never captured by the memory pipeline are intentionally unavailable. Scope and conversation forget watermarks invalidate older sources. Both sides pass the conservative sensitive-text filter; conversation-only and opt-out wording excludes the source conversation. Disabled memory disables this retrieval too.

`botMemoryConversationOnly` is the shared boundary for direct remember, automatic extraction, pure-forget capture, and historical retrieval. It covers natural Chinese forms such as `仅本会话有效`, `只在这个对话中使用`, and `仅此会话有效`, plus explicit new-conversation restrictions and English chat/session-only forms. A model-supplied `global` or `stable` classification cannot override that user boundary. Ambiguous matching remains conservative, so some history may be omitted rather than shared across conversations.

Selection is lexical and conservative: named Latin terms or at least two Chinese bigrams, newest first, with newer explicit corrections suppressing older matches. Limits are 300 candidate pairs, 300 inspected restriction rows / 64,000 inspected characters across source conversations (fail closed when exhausted), three references, and 6,000 output characters in addition to the existing stable-memory budget. This is not exhaustive semantic search; long, very old, paraphrased, or sensitive discussions may not be returned. `memory_search` still returns stable records only; it does not silently change its result shape.

## Checks

- `pnpm -s test:bot-history-context`: deterministic recall, source identity, isolation, correction, privacy, deletion, forget, disabled state and budgets.
- `pnpm -s test:bot-history-context:live`: independent real-model acceptance cases through the isolated composer.

- `pnpm -s test:bot-memory`: storage, provenance, scope isolation (including same-title correction/forget), replay, sensitive/opt-out filtering, disabled/cancelled behavior and L0/L1 deletion races.
- `pnpm -s test:bot-memory-runtime`: actual Durable foreground runtime, completion callback, restart/new conversation recall and request-only evidence withdrawal.
- `pnpm -s test:bot-memory-live`: isolated `pnpm dev` Electron UI and an actual model endpoint. Learns a synthetic safe fact, switches to another Bot and verifies that its real model receives no private fact, normally restarts Electron, starts a new conversation through UI and recalls it. It then corrects and forgets that fact through natural-language messages, verifies the active records and fresh-chat model replies, and checks that deleted facts are absent from subsequent provider requests. The test never calls the memory mutation API; only record reads are used as independent evidence. Superseding a fact may retain an explicit obsolete-value explanation; the check rejects a separate active old fact rather than treating any textual mention as a stale active value. Requires the configured local model endpoint and real desktop session; no production credentials/profile and no build/package.

## Read-only peer consultations

Personal Bot conversations can contact another active Bot owned by the same user through `bot_list` and `bot_ask`. The recipient answers in its own isolated Durable runtime; source messages display the actual persisted question, original reply, and queued/running/completed/failed/cancelled/unknown state. A peer exchange is not a new user message in the recipient inbox, does not create a Work, and cannot write memory or recursively contact another Bot. Team conversations cannot use this personal consultation path to read members' private conversations or memory.

The recipient's `history_read` uses the same source/privacy filters above. Related references retain lexical relevance. A `today` request is a bounded sample (at most three pairs) between the host's local day start and the persisted call timestamp, with a hard 24-hour maximum. Only this peer path may include the recipient's current personal conversation; ordinary foreground evidence still excludes its verified current conversation. Model arguments cannot select owners, Bots, teams, timestamps or conversation IDs. Both `history_read` and peer `memory_search` persist selection receipts only; actual reference contents are re-read for each provider request, so deletion and disabling memory withdraw them rather than leaving old tool-result copies.

Checks: `pnpm test:bot-peer-calls`, `pnpm test:bot-call-thread`, and `pnpm test:bot-peer-calls:live` (six distinct real-model task types through isolated Electron, including ordinary Q&A recall with no long-term fact, concurrent calls, visible original replies and reload durability).
