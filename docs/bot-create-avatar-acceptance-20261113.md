# Bot creation avatar acceptance — 2026-11-13

Integrated on `1505e756`, preserving HTML export, Gateway and Work ownership changes.

New Bot creation accepts an avatar draft before the Bot exists. Creation persists Bot identity and avatar atomically; request replay preserves later edits rather than rewriting them. Invalid assets roll back creation. Canceling an asynchronous import keeps the imported resource in the avatar library without silently changing the closed draft. Reload/retry after a lost creation receipt retains the original request identity and avatar choice.

PASS on the integrated source: full node/web TypeScript checks; real SQLite atomic creation/rollback/idempotency test; draft avatar DOM test; full creation-dialog DOM test with delayed import and lost receipt/reload; existing complete avatar DOM regression; test classification audit. The fixture catalog size is synthetic and does not represent generated production assets. No additional avatar assets were generated. Native file dialogs, pixel layout and packaging remain separate from these tests.
