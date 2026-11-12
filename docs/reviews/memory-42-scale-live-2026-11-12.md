# Issue 42: real foreground 5K / 10K supplement

## Fixed run and outcome

- Product baseline: `d70b74aa3d5d32772bc20947bc445f99b4f85c86`.
- Run: `2026-11-12T14-25-21-882Z`; real Windows Electron, fresh isolated profile, local Magpie `auto/deepseek-v4.1-flash`.
- Both scenarios passed; driver exit 0; `sourceDeltaFiles=[]`.
- Two independent personal Bots contain 5,000 and 10,000 active synthetic L1 facts. The exact target is created first, followed by unrelated newer records. Records are created through product memory IPC in batches of 250, not learned from a model conversation.
- Each foreground prompt names only its unique target key, not its answer. Actual provider transcripts prove a `memory_search` call and the retrieved answer. Separate Bots prevent the first answer contaminating the second case. This does not rely on prior original dialogue.

| Scope size | Target key | Actual returned value | Seed elapsed | Foreground turn elapsed | Provider requests |
|---:|---|---|---:|---:|---:|
| 5,000 | SCALE5000QZVXNEEDLE | 23.718406 | 17,327 ms | 9,976 ms | 2 |
| 10,000 | SCALE10000QZVXNEEDLE | 61.930257 | 38,391 ms | 9,245 ms | 2 |

Foreground duration includes model inference and tool continuation; it is **not pure retrieval latency**. Four requests total, no repetition of the earlier nine-case batch.

## Reproduction and evidence

`BOT_FRONTDOOR_MODEL=auto/deepseek-v4.1-flash pnpm exec node scripts/bot-frontdoor-live-test.cjs --memory-correctness --memory-scale-only`

The runner writes `report.json`, provider request transcripts, launch/end source fingerprints and `memory-scale-live.png` under `out/diagnostics/memory-40-42/live/<timestamp>/`. Scenario source is `scripts/memory-scale-live-scenario.cjs`; it rejects a non-isolated home. Product source is unchanged by this supplement.

First attempt `2026-11-12T14-23-24-228Z` failed during fixture setup because one large IPC loop exceeded the driver's 20-second CDP evaluate deadline. No successful retrieval is claimed for that attempt. The retained failed report is separate; the final runner limits each seed evaluate to 250 records. This is a fixture adjustment, not a product search fix.

## Latest-main applicability and boundaries

Read-only comparison against `bf7e35176edfe6a1806c8c96b6154e5501397618` found no change to the exercised query candidate discovery, ranking, repository or semantic retrieval implementation. MemoryService changes since the run are confined to peer-memory extraction eligibility, not search; BotMemorySource/ExtractionPolicy changes concern peer-source ingestion. The recorded run remains on its stated baseline, not relabeled as a new-head run.

The earlier service/SQLite boundary, scope/revocation, ranking, controlled semantic and 10K-vector performance evidence remains in the acceptance map and integration report. **Actual embedding-model quality remains untested**, explicitly separate from real LLM/provider use here. The issue requires this distinction, not treating stored synthetic vectors as real embedding evaluation. No full repository regression, release build or packaging is claimed.
