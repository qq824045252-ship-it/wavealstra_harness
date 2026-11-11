# Bot consultation and scoped history acceptance, 2026-11-11

## Fault and repair

A natural question about another Bot's learning previously had no real recipient-dispatch path in the foreground tool set. The caller could search old Work summaries but never contacted the named Bot. There was consequently no recipient reply or exchange-state record for the UI to display.

Personal foreground conversations now have read-only `bot_list` / `bot_ask` consultation. Each actual recipient uses its own configured identity/model in a separate durable runtime. An additive exchange record drives the source conversation's expandable message count, participants, question, original reply and lifecycle state. No synthetic user turn is written into the recipient inbox, and no Work is fabricated. Team conversations cannot use this private route to read members' personal histories.

Ordinary historical Q&A is distinct from permanent user memory. Scoped references require a valid completed receipt and exact L0 source, respect sensitive/temporary/forget filters, and are recomputed for every provider request. The peer-only recent mode samples at most three pairs within the host-bounded day (maximum 24 hours). It does not claim a complete learning log. Neither history nor L1 search content is copied into persistent tool results.

## Verified code and integration

- Peer implementation and memory v2 were kept in separate commits. Final peer/history code: `3dc2b15`, based on browser integration `f6b90e7`.
- Rebase conflicts were limited to additive package/test registration. Both suites were retained.
- Read-only review covered team/private boundaries, pause/cancel/shutdown, replay, empty-model replies and withdrawal of deleted or disabled memory. Findings were fixed and regression-tested before acceptance.

## Acceptance results

On `3dc2b15`, an isolated Linux `pnpm dev` Electron instance and a real `opendesign/deepseek-v4.1-flash` model passed all six task types, with 30 actual provider requests:

1. Today's learning from ordinary Q&A, with no corresponding long-term fact.
2. Arithmetic.
3. Translation.
4. Code explanation.
5. Concept comparison.
6. Study planning.

The last two ran concurrently. The run observed queued/running/completed states, verified original recipient replies in the source UI, verified no target-inbox impersonation or synthetic Work, and verified durable records after reload. Screenshots were captured from the actual Electron page and visually inspected. Input used the real page through CDP; this does not certify native OS input.

The memory integration was independently tested on `0023eef`: all eight real-model categories passed, including three conversation-only wording variants, with 61 actual requests in 479 seconds. Its 12 relevant product/test files were byte-identical to `3dc2b15`. This establishes the memory boundary on identical code, not a separate full-app or Windows certification.

On the rebased final code, typecheck, test-classification audit and these 11 targeted regressions passed: bot-peer-calls, bot-history-context, bot-call-thread, bot-conversation-ui, bot-active-requests, bot-reply-segments, bot-team-conversation, bot-memory, bot-memory-runtime, durable-bot and bot-settings.

## Limits

No full all-tests result is claimed. No packaging, Windows acceptance or installed-user-instance restart was performed. All model fixtures and profile data were synthetic and isolated; production records were inspected read-only for diagnosis. The feature is a read-only Bot consultation, not audio calling or arbitrary cross-Bot execution. Historical recall is bounded and requires existing L0 provenance; it does not retroactively invent uncaptured records.
