# Message HTML recovery — 2026-11-13

Adds an explicit action to completed Bot replies containing complete top-level HTML documents. The renderer sends message identity and document index, never HTML text or a destination. The host reads the current persisted message, validates user/Bot/conversation, user-facing origin, team authority, assistant/completed state and revision, then extracts the original complete document. Existing message content and history remain unchanged.

The generated snapshot is a copy of message source, not a newly completed Work artifact. Existing isolated-protocol preview and explicit external-open/save-as actions are reused; the preview permits page scripts and is not claimed to block all external navigation; no HTML is executed during extraction or export. Both parser and host bounds apply; host output is at most 8 MiB UTF-8. Explicit export cannot override arbitrary files. Fully written/synced pending content is exclusively linked to a digest filename. Interrupted writes can retry; verified same-inode pending links left after publication can be recovered, while unknown hard links and damaged existing files are rejected.

Verification on isolated candidate, without Codex or esbuild:
- `test:bot-message-html-service`: PASS, real SQLite and production authorization method; full >16K multibyte/CRLF content, identity/version/role/state/scope failures, original message preservation, duplicate retry, existing artifact action compatibility, oversized multibyte rejection, interrupted-write retry, post-publication recovery, unknown-hardlink rejection, tamper non-overwrite.
- `test:message-html-ui`: PASS, explicit export lifecycle, duplicate click prevention, compact UI and no HTML execution.
- `test:saved-file-actions-ui`: PASS, existing three actions preserved.
- Complete typecheck and suite classification audit run separately; audit is not a full-suite result.

The DOM runner supplies a throwing Monaco worker placeholder because this test does not open a code editor; it does not claim browser/worker/layout verification. Real user's saved GPUI HTML was inspected read-only by the frontend reviewer; no original message or user file was changed. Full live-model and new real desktop click acceptance are not claimed by these checks.