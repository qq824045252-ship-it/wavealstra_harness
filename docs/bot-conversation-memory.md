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

## Lifecycle and privacy

- Cancelled, failed, running and duplicate replies do not create new L0 sources.
- Memory disabled means no capture, search or automatic context. In-flight extraction checks the current setting before commit.
- Restart uses the existing processing-to-retryable recovery and failed-turn retry budget. Manual extraction/retry can process Bot sources without fabricating Task rows.
- Existing L0 deletion prevents in-flight extraction from writing from deleted sources. Existing L1 deletion also invalidates any extraction already running in that scope, avoiding recreation of the just-deleted fact.
- New conversations keep the same private Bot facts. Other Bots/users cannot retrieve them through this adapter.
- This change does not extend or alter Bot/conversation deletion behavior. Existing memory settings retain their original forget/source-delete controls.
- L2/L3 remain the existing manually generated, approved project/workspace/global derived views. This patch does not add Bot L2/L3 generation or another approval screen.

## Checks

- `pnpm -s test:bot-memory`: storage, provenance, scope isolation, replay, sensitive/opt-out filtering, disabled/cancelled behavior and L0/L1 deletion races.
- `pnpm -s test:bot-memory-runtime`: actual Durable foreground runtime, completion callback, restart/new conversation recall and request-only evidence withdrawal.
- `pnpm -s test:bot-memory-live`: isolated `pnpm dev` Electron UI and an actual model endpoint. Learns a synthetic safe fact, starts a new conversation through UI, recalls it, deletes it through the existing memory API and verifies its absence from subsequent provider requests. Requires the configured local model endpoint and real desktop session; no production credentials/profile and no build/package.
