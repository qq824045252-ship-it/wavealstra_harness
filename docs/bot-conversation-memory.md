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

## Checks

- `pnpm -s test:bot-memory`: storage, provenance, scope isolation (including same-title correction/forget), replay, sensitive/opt-out filtering, disabled/cancelled behavior and L0/L1 deletion races.
- `pnpm -s test:bot-memory-runtime`: actual Durable foreground runtime, completion callback, restart/new conversation recall and request-only evidence withdrawal.
- `pnpm -s test:bot-memory-live`: isolated `pnpm dev` Electron UI and an actual model endpoint. Learns a synthetic safe fact, switches to another Bot and verifies that its real model receives no private fact, normally restarts Electron, starts a new conversation through UI and recalls it. It then corrects and forgets that fact through natural-language messages, verifies the active records and fresh-chat model replies, and checks that deleted facts are absent from subsequent provider requests. The test never calls the memory mutation API; only record reads are used as independent evidence. Superseding a fact may retain an explicit obsolete-value explanation; the check rejects a separate active old fact rather than treating any textual mention as a stale active value. Requires the configured local model endpoint and real desktop session; no production credentials/profile and no build/package.
