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

## Follow-up hardening and live evidence

- Team foreground: eight real-model task types passed with two teams, a common owner and another member. Actual model requests excluded owner/member private memories and the other team's records; explicitly shared public records remained available. This is foreground-team evidence, not a claim of native multi-member Work execution.
- Work snapshots retain the latest six deliverables and prioritized open blockers with total counts. Manual correction/detachment is not overwritten. Personal Work memory uses its owner, not the currently executing member. Startup catch-up yields every twenty items and stops on disposal/authority change; one bad record does not block the remainder.
- Real native Work testing found two defects after five successful task types: private-word redaction removed the truthful proposed-result label; and the model recreated a forgotten preference as a negative constraint. Both were repaired with focused regressions. The full eight-type rerun passed after these fixes (details below).
- Forgetting now records only a scoped source-time boundary and an optional exact same-request exception, never the forgotten text. Persistent boundaries prevent old queued extraction or late-captured old messages from recreating deleted facts after a normal database reopen. Pure forget cannot create a negated replacement. Mixed “forget A, remember B” accepts only new B evidence; other owners' bindings remain unchanged.
- Legacy task-to-Work migration has a first-install cutoff so later deliberately task-local records are not silently promoted. Normal database-reopen and migration checks are not crash/fault injection.

This follow-up uses impacted memory/ownership/capture tests and type checks rather than mechanically repeating the foundational 416-test aggregate. No production profile or user data was modified by these isolated validations.

### Native Work eight-type final rerun

`BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --work-memory-scopes`: **passed, 8/8**, in a fresh temporary HOME. Inventory arithmetic, meeting agenda, suggested itinerary, copy editing, unit conversion, checklist, numeric sorting and ratio calculation each created a real native Work and ended `closed/succeeded` (30 native model calls total). Runtime request evidence and final deliverables confirmed learned preference, corrected preference, then absence of forgotten preference. All final memory snapshots belonged only to the exact Work, retained truthful proposal/acceptance labels, and were not silently copied to Bot-private memory. Actual Electron screenshot inspected.

Limits: this batch is memory validation, not full tool-permission validation. One result reported the pre-existing read-only command restriction; its explicit arithmetic result was correct. Same Work across multiple executions and project sharing have focused SQLite/contract coverage, not new real-model watch evidence in this batch. No native multi-member team execution or crash-injection success is claimed.

Final impacted checks: persistent forget watermark test, Bot memory (including newest-source ownership), assistant scopes, migration schema, Work capture, full typecheck and architecture (278/0) passed. Runner classification audit passed. Reports and provider payloads remain local; no credentials or user profiles committed.

Integration: the final patch was rebased without conflicts over team dispatch `9d0d410` and application-permission retirement `3ee1d6c`. After that integration, typecheck plus forget-watermark, Bot memory, assistant scopes, Work capture and foreground runtime-contract tests passed. The eight-type native live run above predates the permission-retirement rebase; it is not presented as a fresh permission-removal validation.

## Follow-up: native team members and standing Watch memory

Native team validation used the real Electron renderer, the configured local model transport and two separately created teams, with two members plus an owner per commission. Six different tasks passed: inventory arithmetic, meeting agenda, customer-service rewrite, unit conversion, record extraction and numeric sorting. This produced 18 independent native executions and 61 model requests. Assertions check each exact execution's team/public memory, absence of member-private/other-team memory, delivery back to the originating team conversation, Work-only summary ownership and automatic successful close. The screenshot `out/diagnostics/team-native-memory/live/team-native-memory-six-types.png` was visually inspected. No temporary subagents, crash injection or physical desktop input were exercised.

This exposed a real team-creation regression after permission retirement: new members correctly had empty legacy grants, but the shared team DTO still required at least one grant. The DTO now accepts an empty/defaulted compatibility array; real-schema UI tests and the actual two-team creation flow verify it. Member identity and dependency validation remain intact.

The first Watch attempt passed six initial real timer rounds, but exposed an explicit-correction bug: the prompt instructed the model to forget an obsolete preference during correction while the validator accepted only literal forget requests. The validator now accepts explicit current memory/preference corrections, not arbitrary article edits or negated instructions. Scoped ownership checks and regression tests remain enforced. The original test also selected admission time rather than actual submission time, falsely excluding queued executions that correctly used newer memory; the fixture now binds to submitted execution IDs and exact native requests.

A fresh-database reopen regression was fixed separately: the legacy-memory migration cutoff is now recorded on first initialization even when Work tables have not yet been created, rather than adding metadata on the next open. Bot creation/reopen, memory schema, ownership, correction and type checks passed. These changes were rebased onto `c17d530`; post-rebase typecheck, Bot creation and team-service tests passed.

The expanded Watch validation (six task types, three actual timer rounds, changed inputs, corrected and forgotten preference, persistent Work memory across execution tasks) is pending completion at this checkpoint. Initial-round evidence is not a claim that long-lived multi-round validation or 365-day uptime has passed.
