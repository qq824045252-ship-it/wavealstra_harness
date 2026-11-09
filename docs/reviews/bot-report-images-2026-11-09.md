# Bot report image recovery

## Cause and implementation

Bot feedback rendered Markdown without an image task scope. The report's referenced screenshots were not registered in the Artifact Domain. Raw Windows paths also lost the backslash before `.mybuddy` during Markdown parsing.

- Resolve only persisted host feedback through its originating user/conversation, Work, execution binding, intent revision and input snapshot. Do not infer a task from the active sidebar, current owner, filename, or report wording.
- Snapshot referenced workspace PNG/JPEG/GIF/WebP files after feedback commits. History reads recover older reports lazily. Use existing Artifact Domain storage and message references, without a schema reset or a Work acceptance transition.
- Each report owns immutable snapshot bytes. Later overwrites, deletion of the source, restart, and repeated history reads do not change a captured report.
- Keep lexical/canonical workspace boundaries, reject symlink escapes and nonregular files, use nonblocking/no-follow reads and verify file identity/stability. Bound reads to 16 MiB per image and 32 image destinations per report.
- Rewrite only host-resolved image destinations to versioned artifact URLs before Markdown parsing. Preserve message text in storage. Support relative/absolute/file URLs, Chinese names, balanced parentheses, and reference-style images.
- Give Bot messages an explicit descriptor/source scope. Original-image preview, close and retry remain within the message and do not change the active Task. Raw file URLs and foreign artifact IDs remain blocked.

## Checks

- `pnpm -s typecheck`
- `pnpm -s test:bot-report-images`: real temporary SQLite/filesystem, legacy metadata recovery, new feedback capture, immutable bytes and restart, invalid/missing images, exact-binding rejection, traversal/junction rejection, FIFO rejection, concurrent idempotency, no Work-state mutation, no image base64 over render IPC.
- `pnpm -s test:bot-report-images-ui`: actual React/Markdown rendering with Windows paths, parentheses/reference syntax, correct artifact URL, original preview/close, image-error retry, no active-task fallback, foreign protocol URL rejection, repeated rendering. Uses linkedom, not a desktop pixel/decode test.
- Existing image-cache, scroll-follow and Work-feedback checks are retained. Full-gate results and desktop verification are reported separately; unavailable environment prerequisites are not passes.

No production build, package, version bump, real model task, or live-profile database rewrite is part of these tests.
