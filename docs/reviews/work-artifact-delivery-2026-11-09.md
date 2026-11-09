# Work generated-file delivery and runtime recovery

Baseline: `db67d4e32928600da26424ce67a829c2d38f82fc`.

## Root causes and changes

- Queued/placed inputs returned `running` before scanning durable evidence. Explicit host artifact receipts are now projected during execution, and preserved in an additive `work_generated_artifacts` table. They do not create an accepted criterion or premature final deliverable.
- Shell/Python output was not discoverable without structured evidence. `register_artifact` verifies a specific regular file within the bound workspace, records exact input/native-call provenance and creates a content-hashed immutable snapshot under that runtime's artifact directory. Successful native write/edit calls register automatically. Shell users are instructed to register immediately after creating an intended output. Arbitrary commands and workspace contents are not guessed or swept.
- Repeated call recovery is idempotent inside the durable commit. Same-name versions have distinct hashes; terminal delivery references the snapshots rather than mutable source paths. Existing native inbox settlement still emits one stable result proposal for repeated terminal observations.
- Work details show generated files before completion, allow opening the saved version, preserve source location, and report opening failures. Generation does not imply validation or completion.
- A persisted `running` binding is not current host liveness. The projection now reports recovering/running/waiting/interrupted from this host's Pi scheduler inspection. Foreground history reads no longer consume the startup resume obligation. Reopened paused sessions resume the original receipt only under existing lifecycle/authority checks, never by resubmitting a business action.

## Verification

- Typecheck: web, node and scripts, zero errors.
- Result inbox regression: 16 cases, including running-file visibility, restart, failed terminal retention, cross-Work identity and exactly one terminal proposal.
- React UI regression: 29 cases.
- Real Electron component fixture: saved-version target, recovering status and open failure feedback; screenshot `out/tests/work-artifact-desktop.png`.
- Real Pi native and Code Mode execution with deterministic provider: actual shell creates HTML, host registers a snapshot while running, provider aborts, stopped projection retains snapshot, and reopen recovers the same receipts.
- Snapshot tests: path confinement, symlinks, missing files, same-name overwrite/source deletion, 160 KiB multi-chunk fidelity, corrupted snapshot rejection and concurrent same-call deduplication.
- Real isolated host-process kill/reopen: persisted successful file effect is not repeated; unknown unsafe effect is not blindly replayed. Startup foreground-read and post-session-failure recovery paths are covered.

These fixtures do not claim a live online model, full application UI end-to-end acceptance, Windows acceptance, or repair of existing user Work records. Deployments require their own checks. No production data, schema version, application version, approval policy, or user credentials were changed. The additive table and journal triggers do not reset the database.

## Limits

A shell-created file that was never registered before host failure cannot be attributed safely after the fact by scanning a shared directory. The file remains on disk; historical Work records are not silently rewritten. Snapshot storage is retained with the native runtime store. Full suite status is recorded in the delivery report; no baseline entries were added or relaxed.
