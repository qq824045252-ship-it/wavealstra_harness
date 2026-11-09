# Bot attachments: implementation and evidence

Baseline: main 924a6a3, preserving the user's Issue 21 changes in 972bbee. No production profile, user database, security configuration, or packaged installation was changed. The separate media custom-model race fix is included as its own commit.

## Delivered

- Task chat and Bot share file selection, drop, clipboard-file handling and attachment chips. Bot keeps its own per-Bot persisted draft and request identity. A message can contain only attachments.
- The host validates and copies selected bytes to durable content-addressed files before accepting a new send. Missing/nonregular/oversize files are explicit rejections. Maximum 10 files, 25 MB per document, 12 MB per image, 50 MB total. Replayed requests retain their original copies even if the source file is removed.
- Message attachments are additive SQLite metadata, included in the send payload identity and recovered in history. No schema reset/version bump is required.
- Small UTF-8 text/code files are provided as actual model input (128 KiB/file, 256 KiB total). Other document formats remain durable file references for background parsing, explicitly not claimed as already parsed.
- Supported images are supplied as native image blocks to models declaring image input. Text-only models use the configured image-understanding provider; absence/failure is displayed explicitly. Unsupported image formats receive conversion guidance.
- Existing native submissions are reconciled before preparing attachments again, avoiding duplicate image-understanding calls during recovery.
- Background Work receives structured attachment references scoped to its input snapshot, independent of the 2,000-character goal field. Amendments preserve earlier attachments. Regular, partial and team execution paths use the same injection point.
- A confirmed attachment rejection preserves the editable draft and permits a corrected new send. An uncertain transport receipt still retries the original request identity.

## Actual Electron and online model verification

On Omarchy, isolated temporary HOME/profile, `pnpm dev`, actual Electron renderer/IPC/database/runtime; no production credentials copied.

Eight checks passed:

1. Dropping a file creates an attachment chip.
2. Removing the chip removes the attachment.
3. Attachment-only sending is enabled.
4. A clipboard text file's actual bytes reached the online DeepSeek V4.1 Flash model. It returned the nonce `BOT-FILE-94726`, present only in the file.
5. Sent attachments appear in conversation history.
6. Creating/switching to another Bot does not inherit the first Bot's draft attachment.
7. Pasting a PNG with a text-only model and no configured vision service shows a clear image-understanding error, without inventing visual content.
8. Closing and reopening the isolated app preserves attachment history.

Screenshots: [attachment-only](assets/bot-attachments-2026-11-09/attachment-only.png), [explicit image error](assets/bot-attachments-2026-11-09/nonvision-error.png), [restart](assets/bot-attachments-2026-11-09/restart.png).

### Verification boundary

An online native-vision attempt with the locally advertised GPT-6.1 Sol image-capable model returned HTTP 429 `usage_limit_reached`. Therefore successful semantic image recognition is **not verified**. Native image bytes and delegated-vision/failure paths are covered by automated tests, not claimed as successful online vision. Native file-picker interaction and every document format were not separately exercised in the actual app; picker ingress is shared with ordinary chat.

## Gates

- Typecheck: passed (including scripts, zero added errors).
- `test:bot-attachments`: passed; pure-attachment send, durable copies, deleted-source replay, identity conflicts, restart, file limits, text/native-image/fallback/error handling, long goals with 10 Work attachments and snapshot isolation.
- `test:bot-conversation-ui`: passed, including Bot draft isolation, attachment-only sends, late receipts and corrected rejection retries.
- `test:bot-work-phase2`: passed, including real Durable runtime delegation of persisted attachments.
- `test:media-capabilities-dom`: passed for the integrated custom-model race fix.
- Final full headless gate: **392 passed / 0 failed / 0 known / 0 regressions**, 2.9 minutes. This includes the final Work input-snapshot implementation, architecture contract registration, media fix and isolated port fixture.

No product build/package was performed. Headless checks are not described as full desktop/platform acceptance.

During integration, the full gate caught a missing registration of the new store state/action in the architecture contract; the additive contract was updated without relaxing existing keys. The gateway port test also assumed a production candidate was unused, which was false while a desktop app was running. Its fixture now allocates private ephemeral ports and still verifies ordered fallback, all-unavailable failure and direct binding; no user process was stopped and no failure baseline was added.
