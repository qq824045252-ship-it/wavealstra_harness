# Closed Work redo successor verification (2026-11-13)

Integrated three reviewed files from base 02b87b61 onto main 9d44d3e0 with a three-way merge. Preserved the newer deleted-participant admission boundary. No running user checkout or database was changed.

An explicit user redo request can create an independent successor collaboration for a closed Work, after querying the current identity/version guard and citing the current request excerpt. Previous records remain intact; repeated operations/restarts resolve the same successor. Receipt failures after durable outbox creation and concurrent retries are covered. Cancelling the old collaboration does not cancel its successor.

Passed via existing TypeScript memory runner: the original collaboration suite plus actual foreground work_create registration, target workspace/authorization/provenance, stable retries, separate private-conversation source, missing/stale guards, peer rejection, failed-accept restart and concurrent acceptance. Deleted-participant admission regression and full web/node/scripts typecheck also passed. Independent review accepted the frozen candidate and test.

Limits: request meaning remains model-interpreted. The receiving Bot reads the old Work to plan the redo; this does not automatically copy every original body and attachment. The controlled tests prove admission/creation/idempotence, not a fresh real-model end-to-end execution or real business side effects. No Codex or esbuild testing was used.
