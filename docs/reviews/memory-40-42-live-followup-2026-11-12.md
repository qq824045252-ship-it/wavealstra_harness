# Memory live acceptance follow-up (2026-11-12)

## Actual execution and preserved failures

The real Windows Electron development app ran from the isolated integration checkout, using a fresh HOME and explicit Electron userData. All inference was forwarded to local Magpie `auto/deepseek-v4.1-flash`; the catalog declared context 1048000 and output 328000, used unchanged. No real user memory was read or modified. Both runs below had an empty source-file delta between launch and completion.

1. Run `2026-11-12T13-07-01-682Z`: initial actual memory creation failed. Three provider requests included four `memory_remember` calls rejected by the host. Root cause was the opt-out regex treating the substring `别保存` inside `分别保存` as a prohibition. It was not a credential-shaped marker or provider outage. The original completed reply, tool calls and receipts remain in the isolated diagnostic report and Durable store.
2. Run `2026-11-12T13-13-06-410Z`: six distinct UI tasks executed, 18 actual provider requests. Initial memory creation, negative reminder, quotation explanation, hypothetical question, and precise A deletion passed. New-conversation recall failed: B's search result included A in its original broad evidence excerpt, so the model mentioned the forgotten A value again. A's L1 row was correctly absent; this is evidence-projection resurrection, not failure to delete that row. Request 15's tool result is the direct evidence. A later test setup failed to wait for the newly created Bot sidebar row, so cases 7 and 8 did not execute. This batch is failed, not a partial acceptance claimed as all green.

The opt-out fix distinguishes the distributive adverb from genuine prohibitions. Actual capture/remember tests cover `分别保存`, `分别记住`, `请别保存`, `千万别记住`, `不要保存` and English `do not save`. Fourteen correctness groups, schema and forgetting tests passed; typecheck passed. Evidence projection and source invalidation require the additional correction and retest described in the final result below.

No real embedding-model quality or operating-system toast validation is implied by this report. Bulk L1 fixture setup is explicitly separate from facts learned by the model.
