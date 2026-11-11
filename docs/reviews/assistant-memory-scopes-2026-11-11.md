# Assistant memory ownership implementation

Base: `2ac0101`, independent Omarchy development clone. No production profile, packaging, version bump, or crash injection.

## One kernel, explicit ownership

The existing Memory Kernel remains the only atom/evidence/revision/semantic store. New `team`, `conversation`, and `work` bindings extend existing `bot`, `global`, `project`, `workspace`, and legacy `task` scopes.

- Personal Bot: its private facts persist across conversations; each conversation has its own temporary facts.
- Team: team + current conversation + explicitly public facts. Technical executor/owner Bot identity does not import that member's private memories, including legacy teams without a team-ownership row.
- Work: persistent `workId`, current execution `taskId`, authoritative project, personal owner or team, explicitly shared public facts. Request hints cannot replace persisted ownership.
- Project: multiple bound Works can read project facts. Work may create project knowledge; it cannot rewrite another source's confirmed shared atom through a retained private binding.
- Public: only `metadata.publicShared === true` exposes global atoms to Bots/teams/Works. Legacy globals retain ordinary-task semantics and are not silently made public.

`AssistantMemoryScopes` owns the binding graph; `MemoryService`, lexical/hybrid recall, and context projection share it. Bounded preference and current-episode baselines supplement query recall. No second prompt-memory store or approval workflow was added.

## Capture, corrections, forgetting

Foreground `memory_remember` uses the current host-bound conversation and actual user wording. Temporary and explicit public requests route accordingly; automatic extraction uses the same provenance instead of accepting model-supplied IDs. Team turns keep the actual producing Bot in source evidence. Forget detaches the requested ownership, preserving other owners' bindings; correction of a shared atom creates an owned replacement rather than mutating other owners.

Work projections feed a facts-only `WorkMemoryCapture` adapter after the Work transaction commits. It writes current progress, current-revision/snapshot deliverables and unresolved items into the same Kernel. Proposed results remain labelled unverified; accepted results include evidence counts and do not imply whole-Work completion. A watch round does not close its lasting obligation. Startup catches up missed projections; memory failure does not stop Work.

Durable capture receipts prevent forgotten/detached or manually corrected summaries from being regenerated at restart. Raw authorization, credentials, tool arguments, and full transcripts are not copied into these summaries. This is a factual snapshot, not an LLM-generated confidence claim.

## Compatibility and UI

Schema version remains 36 because the existing application's version-mismatch path resets the database. The leaf `memory_scopes` table is expanded transactionally, preserving atom IDs, evidence, revisions, and unrelated tables. Legacy task memory receives an additional Work binding only with an unambiguous local-user execution mapping. Ambiguous/foreign/orphan mappings remain untouched. Migration receipts prevent a user-removed binding from being recreated.

Bot/team settings, current conversation, Work detail and bound project reuse `MemoryKernelExplorer`; no parallel inbox. Public management distinguishes explicitly shared records from legacy global records. Work projection carries the authoritative project ID, not a path-derived guess.

## Validation record

- Typecheck: passed (web, node, scripts; zero new script errors).
- Focused memory, scope, compatibility, real SQLite reopen, source suppression and UI fixtures: passed individually.
- Eight real-model foreground task types: passed via `--memory-scopes`, using `opendesign/deepseek-v4.1-flash-eco`, real dev Electron UI and isolated HOME. Cases: stock arithmetic, travel suggestions, meeting agenda, copy edit, unit conversion, checklist, packing table, punctuation correction. Actual request payloads and answers prove private isolation, temporary conversation boundaries, explicit public sharing, correction and forgetting.
- Nonfault aggregate: **416 passed / 0 failed / 0 known / 0 new regressions**, excluding the same 20 previously agreed fault-injection/recovery cases. No baseline relaxation.
- Eight native Work real-model scenarios are implemented as `--work-memory-scopes`; execution report follows separately and is not claimed by this implementation commit.

Initial validation exposed and repaired: disabled memory still exposing write tools with a misleading provenance error; delayed startup capture touching a closed database; duplicated React sibling key in Work detail; legacy test contracts assuming task-scoped Work memory. The first live fixture omitted `memoryEnabled`; it was corrected, not counted as a product pass.

Crash/fault-injection tests are intentionally deferred as requested. No physical-desktop or provider claims are inferred from headless fixture success. Test reports/provider requests remain local diagnostic artifacts and are not committed.
