# Android model-task cache investigation — working evidence

Target: `local-1793579906915-0`, MyBuddy 0.1.62, session file `2026-11-02T00-38-27-671Z_01a199b1-7a56-7415-b47b-0cdd635c3fc0.jsonl`. All times below are Asia/Shanghai unless marked Z.

## Verified projection-position cause (2026-11-02 10:39)

A direct native upstream experiment seeded **the actual running MyBuddy's captured 159k-token history**, all existing tool definitions, and its real 1912-character memory capsule. Raw seed crossed only local CDP and child stdin in RAM; no plaintext seed file was created. A virtual `cache_probe` supplied generated tool results; no real tool executed and original task history did not change.

Both arms used the same original final account and correctly retained the first per-turn routing state. Each arm had a fresh logical turn/key. Base-field hashes stayed constant within each arm. The only structural difference was moving the capsule to the tail each request vs keeping its first position immediately after the diagnostic user message.

- Tail: input totals159039,162136,165291,168412; cache reads0,23168,23168,23168; shared prior input items210/211,213/214,216/217 (the old capsule position changes).
- Anchored: input totals159039,162138,165292,168414; reads0,158976,162048,165120; shared prior input items211/211,214/214,217/217 (the entire old request remains a prefix).
- All genuine tool calls, no real tool execution. This reproduces the original frozen23168 pattern and removes it by fixing placement in the SAME real context. Small synthetic cases did not capture this large-context behavior and cannot be used to dismiss this proven interaction.
- Data: `runtime-seed-projection-evidence.json`; command `PROJECTION_CONTROL=1 node runtime_seed_control.mjs` (historical evidence, do not rerun unnecessarily).

The missing `x-codex-turn-state` hypothesis was **NOT sufficient**: direct same-context state-drop and state-keep arms both plateaued at23168. Do not patch Magpie for this task based on that hypothesis. Source/doc protocol observations remain valid but unrelated to the demonstrated sufficient fix.

Root fix now delegated to `cache-code`, sharedtask task-1, write scopes only `src/main/agent/EphemeralContextProjection.ts` and `scripts/pi-autonomous-execution-test.ts`. Add actual Pi-loop prefix regression red-before-fix/green-after, keep one request-only capsule at a fixed position within the canonical user turn; preserve new-turn clearing, revocation and permission contracts. Lead handles review, gate, patch version, commit/push and accepted Windows package per standing release authorization. Do not stop at an unshipped fix.

## Earlier status (retained audit trail)

The precise backend implementation was not yet proven at the earlier checkpoint; the position experiment above is now the decisive case-specific causal evidence. No production source changes had been made before delegation.

A limited observer is installed on the actual, idle target session's `agent.streamFunction`. It records hashes, structure counts, response status and original provider usage, without prompt text, tool arguments, credentials or authorization headers. It restores the original function after 16 calls or 24 hours; installation was 2026-11-02T02:18:42Z. File: `runtime-watch-20261102.jsonl`. Source: `runtime_observer.js`. It does not change requests or add chat history. It has not yet observed normal user continuation. It must be verified with a local synthetic transport or inspected on subsequent actual calls.

A local Node inspector was temporarily enabled on actual MyBuddy main PID **47944**, executable `release/win-unpacked/MyBuddy.exe`, port **9229**. It was opened using `process._debugProcess(47944)`, without restarting the app. Temporary main-process globals: `__cacheInvestigationService` (AgentService reference), `__cacheInvestigationPayload` (raw captured payload — MUST DELETE before finishing), `__mybuddyCacheAudit` (observer controller; leave while bounded observer is wanted). Close the temporary inspector before finishing, using `process.mainModule.require('node:inspector').close()` after returning the final diagnostic result. Do not leave the raw payload global or debugger exposed indefinitely.

CDP helpers: `eval_main.mjs` reads a local diagnostic JS expression and returns only its selected JSON result; it checks that the target title names MyBuddy PID47944. `inspect_main.mjs` discovered AgentService via the actual `agent:prompt` IPC handler's `[[Scopes]]`, without invoking a prompt handler or changing a task. Global `require` is unavailable in this Electron main; use `process.mainModule.require`.

## Original task evidence

- 38 native calls uniquely matched to Magpie usage/routing logs, including native session identity.
- 5.6-terra: 21 calls, input (uncached) 1,391,095; cacheRead 440,320. First cacheRead 0, next 20 fixed 22,016.
- 6.1-terra: 17 calls, input 2,103,402; cacheRead 370,688. First 0, next 16 fixed 23,168.
- All same final account SHA256 `6b3c67abbaec8a45af0d5e591fc626246558d867af06cafff69b93209599f62b`, same routing account ID hash `57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93`, HTTP200, one candidate/try/HTTP request each. No recorded retries or account changes.
- No explicit compaction, branch summary, image results or unpaired tools. 87 calls/87 results. Four user turns. Four runtime assembly hashes identical.
- Actual live state has 130 messages, same role/content/sections/toolsAdded hashes as all 130 persisted messages. `live-state-evidence.json` proves this at observation time, not every historical request.
- Memory was enabled in all four historical runtime assemblies. Recall timestamps within ~183–232ms of assembly are strong evidence of nonempty ephemeral memory, but original capsule text was not recorded.
- Current actual runtime offline capture produced exactly one request-only capsule, 1912 chars, and 210 input items (209 canonical + capsule). Cache key is the same session UUID-derived hash. The capture stopped before networking (`networkCalls=0`).
- Masking was NOT applied: all 38 routes lack `masked` and join to zero maskrec entries, while neighboring unrelated calls have mask entries. `masking_ms` is only scan time. In this exact gateway version, zero hits returns original body unchanged.
- Routing prompt estimates: system/tools ratio stable within calibration rounding, all visible tool identities/N stable. `prompt.turns = persisted user count + 1` for all38, consistent with one temporary tail capsule, not accumulating capsules. Estimated sizes are not byte hashes.

## Exact versions and source

Magpie running PID9292 at `C:/Users/servi/Documents/magpie-windows-amd64.exe`, version0.1.1788, Go build commit `833f51adcf4d880c8fd8683f71873bb16e86d74b`. It serves127.0.0.1:3425.

Public source was cloned to `magpie-source` and checked out at this exact commit; it is an analysis checkout, not the user's main repository. Its AGENTS/LESSONS/code standards apply inside it. Do not push this external repository unasked. The original `C:/Users/servi/Documents/GitHub/magpie` contains only the MyBuddy plugin.

Installed and packaged Pi adapters both version1.3.0; offline reconstruction through each yielded identical base-field hashes and no old input item differences for all38 calls. This reconstruction excludes historical request-only memory and gateway transformations.

Magpie files: `~/.config/magpie/usage.jsonl`, `routing/2026-11-02.jsonl`, `masking/2026-11-02.jsonl`. `~/.cache/magpie/calls-v15` was fully native-gob decoded (1174shards/1184frames/28680calls, CRC valid) and is only metadata/source-file offsets; it does not contain this target task's request bodies. There was no target request archive.

## Controlled live experiments (same provider/model, no actual tool execution)

All synthetic messages are generated records, not user content. Where historical context was used it was sent to the same already-configured upstream. Diagnostic replies were not appended to the original task, and no returned tools were executed.

1. Simple reply, append and moving-tail: both reached >99% cache after initial call. Too-small subsequent additions (<128 tokens) cannot assess continuing cache growth.
2. Virtual tool-loop, no thinking: both append-only and moving-tail read19328→22400→25472 as history grew. `live-tool-evidence.json`.
3. Genuine encrypted thinking + moving tail: read0→19328→22784→25984, genuine signatures and tool calls on all4 turns. Refutes projection×thinking as a sufficient cause. `live-reasoning-complete-evidence.json`. Append control contained inserted synthetic tool calls after the model directly answered; this limitation is recorded.
4. Initial historical partial replay used arbitrary lines10/14/18/22, which included incomplete tool groups. Its 30336 plateau is NOT valid root-cause evidence. Preserve but do not rely on it.
5. Exact model-call boundaries8/10/16/20, original key: read23168 at all4; same contents/new key read23296→28800→32000→47616. This initially suggested key-local state.
6. Interleaved original/new keys later refuted permanent bad-key interpretation: original key reached47616 repeatedly; freshV4/V7 had initial cold calls, suffix key hit47616. Do not claim key rotation fixes the root cause. `interleaved-key-evidence.json`.
7. ACTUAL running MyBuddy session pipeline, identical full request twice at10:08:49/54:
   - both exact outgoing body SHA256 `08fe49175da87425d14c424d591d5124854f75d8843437f6362b9dfe1c9e48cf`,667431bytes; same cache key and session/client header hashes; max_output_tokens128000 (Magpie Codex Prepare removes this before upstream).
   - first prompt158934, cached47616, uncached111318; second same prompt158934, cached158848, uncached86. Output5 each. Raw usage includes per-item attribution.
   - original state remained130 messages with unchanged full-state hash.
8. Hypothetical next user layout through same actual runtime at10:11:27, no actual history append: prompt159081, cached47616, uncached111465, output5. Thus exact repeat success does NOT establish normal next-turn recovery. `runtime-next-turn-evidence.json`.
9. Genuine commentary+encrypted reasoning+tools, both synthetic arms:
   - append-only read[0,19584,0,26112]
   - moving-tail read[0,0,3968,25984]
   - each real toolUse, real commentary phase and thinking signature; no tools actually executed.
   - ALL8 rejoined gateway audit: same original account, each one try and one HTTP request, HTTP200.
   - hence no visible account switch/retry explains these intermittent misses. But per-request prefix hashes were not recorded in this particular experiment; source construction is append-only for that arm. Do not overstate wire proof.
   - `live-commentary-evidence.json`, `live-experiment-selected.json`.

Other sessions in the exact original timeframe (including this DSH session) had growing cache under the same final account. This refutes global account/model outage, not per-session or per-backend routing/cache-state issues. Some MyBuddy short session IDs may be tests or workers, not independent user tasks.

## Strong new hypothesis being investigated

Missing **per-turn backend routing state** (`x-codex-turn-state`) is a specific protocol gap:
- Official Codex **rust-v0.163.0** (same installed native CLI0.163.0) client.rs282–309 requires capturing the first returned x-codex-turn-state and replaying it on all retries/continuations within the SAME logical user turn; reset at next turn and when auth owner changes. Reusing across turns violates the client/server contract. Main client.rs315–341 says the same.
- Current Pi1.3 has no turn-state handler. Magpie exact source `gateway/codex_backend.go1668–1673` intentionally filters incoming state because it belongs to the original account; `gateway/gateway.go4965` only forwards Content-Type/Request-Id/X-Request-Id responses; provider/codex_request.go sessionHeaders only sets session-id/thread-id. No account-scoped state store has been found.
- Need first prove the real upstream emits this header; official issue30536 reports cases where it does not. Merely reading support in client source is NOT proof that this backend emits it.
- Need controlled A/B with a true SAME-turn tool continuation and same final account to measure whether preserving returned state fixes the observed misses. Do not implement cross-turn/account/model caching of this opaque header.
- Community cjzyypok/codex-turn-state-cache caches by auth+model for1h, not thread/turn, contradicting official scope. Do not copy its policy.

A minimal direct-upstream header probe was written under `magpie-source/cmd/cache-header-probe/main.go`, using the exact provider's existing signing code, asserting the final account hash equals the target, asserting HTTPS chatgpt.com endpoint, and emitting only header names/state presence/hash and usage. It does not print credentials or body. It uses a single tiny synthetic request. Running background job **pwsh-243054d4e0aa42ea** (`go run ./cmd/cache-header-probe`); COLLECT IT. It may need existing module downloads/compile. If it returns no state, consider a second correctly scoped request with official x-codex-turn-metadata turn_id, based on source evidence, not blind retries. Do not change sign-ins or any production gateway config.

## Pending work and cleanup

- Collect direct header probe job.
- Teammate `projection-proof` investigating official header scope/source/tests and community code (must wait for required teammate results).
- Only modify production code once the missing-state mechanism is runtime-proven. If a gateway fix is needed it belongs to Magpie; do not blindly change MyBuddy prefix or add retries/key rotation.
- Verify installed bounded observer with a synthetic transport (no network), explicitly mark such records or avoid confusing them with real usage.
- Delete raw captured payload/service globals and close temporary Node inspector. Keep only bounded observer controller if wanted; its stop function restores original stream method.
- Refresh SVG/report to verified findings; old `diagrams/android-task-cache.svg` depicts the now-refuted sufficient memory-tail hypothesis and must not be presented as the root cause.
- Preserve unrelated modified tracked artifacts in main checkout. No app feature source changed, so no release/commit/push yet.
