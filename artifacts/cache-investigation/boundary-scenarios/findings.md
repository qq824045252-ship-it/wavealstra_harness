# Prompt-cache invalidation: boundary scenarios and measurements

Follow-up to `artifacts/cache-investigation/screenshot-prefix-findings.md`.
That pass removed one history rewriter (`ageToolResultImages`, shipped 0.1.74)
and concluded no second per-request rewriter existed. This pass builds the
evidence that was missing:

1. an offline matrix that inspects the **real wire request** of many unusual
   flows (the previous regression test only covered screenshot history),
2. a **live** arm against the real Magpie gateway measuring provider-reported
   `cache_read` per request,
3. a read-only audit of the local gateway log for **real sessions**.

Repro:

```bash
pnpm -s test:cache-boundary-matrix                    # offline matrix, ~4 s, part of test:all
MYBUDDY_CACHE_LIVE=1 pnpm -s test:cache-live          # real gateway, opt-in (":" live" => NETWORK class)
pnpm -s cache:audit -- 7                              # real usage audit, read-only
```

Evidence: `out/diagnostics/cache-boundaries/prefix-matrix.json`,
`out/diagnostics/cache-boundaries/live-scenarios.json`,
`artifacts/cache-investigation/boundary-scenarios/usage-audit.json`.

## 1. Wire-level matrix (offline, real product stack)

Real `conversation-runtime` / `builtin-capabilities` / `EphemeralContextProjection`
extensions, real Pi loop, real Responses serializer. `fetch` throws, so nothing
leaves the machine. Each row compares every model call's serialized `input`
against the previous call, plus the non-input request fields.

| Scenario | Requests | Input prefix | Non-input |
| --- | --- | --- | --- |
| baseline tool loop | 4 | append-only | stable |
| screenshots across 3 turns | 9 | append-only | stable |
| steering message mid-turn | 4 | append-only | stable |
| abort, then continue | 14 | append-only | stable |
| thinking level changed | 2 | append-only | stable |
| resume session from disk | 7 | append-only | stable |
| tool activated mid-session | 3 | append-only | **`tools` changed** |
| explicit compaction | 6 | **1 break at item 1** | stable |
| memory capsule, 2 turns | 6 | **1 break at item 2** | stable |

Two findings that were not visible before:

- **A mid-session tool-list change rewrites `tools`, not the input array.** This
  project ships the default model compat (`supportsAdditionalTools: false`,
  `supportsToolSearch: false`), so `resolveTranscriptTools` sends
  `getCurrentTools(messages)` as the request's `tools`. Any add/remove/redeclare
  mid-session (MCP connect/disconnect, capability toggle, deferred tool loaded)
  therefore rewrites the request head — a full-prefix miss that a
  message-level detector cannot see.
- **The request-only capsule is a synthetic `user` item.** Wire shape:
  `{"role":"user","content":[{"type":"input_text","text":"本轮补充证据…"}]}`,
  inserted directly after the real user message (wire item 2 in turn 1). Within
  a turn it stays at that index, so continuations are append-only. At the next
  user turn it moves (turn 2: wire item 8) and the previous slot is gone, so the
  request diverges back at item 2 — everything the previous turn produced is
  unreachable for reuse.

Also verified: serializing one captured context twice, 120 ms apart, yields
byte-identical `input` and options. No clock, counter or random value enters the
request path.

The product has exactly three `pi.on("context")` handlers:
`conversation-runtime-extension` (deterministic projection of retired custom
records), `EphemeralContextProjection`, and its subagent copy. There is no third
per-request history rewriter.

## 2. Live measurements (real Magpie gateway, `codex/gpt-6.1-terra`)

3 user turns × 3 requests, fixture tool only. `read` = provider `cache_read`.

| Scenario | Cache hit | Turn-2 first request | Turn-3 first request |
| --- | --- | --- | --- |
| baseline, 3 runs | 95.0 / 89.3 / 81.9% | 5376 (97%), 4480 sometimes | 5632 (98%) |
| image tool results | 92.9 / 92.7 / 75.0% | 5376 or sporadic 0 | 5632 or sporadic 4480 |
| **memory capsule, 4 runs** | 71.6 / 77.0 / 83.3 / 90.4% | **4480 every run, diverges at item 2** | **4480 every run, diverges at item 8** |
| tool activated after turn 1 | 92.7 / 93.1% | **4480 once, wire stable** | recovers (5504+) |
| explicit compaction | 64.5 / 90.0% | 4480, diverges at item 0 | recovers |
| resume from disk | 89.5 / 92.7% | 5376 (97%) | 5632 (96%) |

Large-context arms (one ~16k-token tool result per turn) make the cost explicit:

| Large context | Hit | Reads per request |
| --- | --- | --- |
| no capsule | 66.4% | `0, 4480, **21248**, 21504, **37376**, 37504` |
| with capsule | 43.3% | `4480, 4480, **4480**, 21504, **4480**, 37504` |

Without the capsule, each new turn reuses the whole prior context and only the
newest tool result is uncached. With it, the new turn collapses to the header +
first user message: 17.1k and then 33.2k tokens re-billed at full price in a
6-request run. The collapse is worse than the divergence index predicts (turn 3
shared ~21k wire tokens but read only 4.5k) — the capsule behaves like a cache
barrier, not just a moved slot.

Two more observed effects, both independent of product code:

- **Sporadic `read=0`/`read=4480` with an identical wire.** Seen at session start
  (`0, 0` in one capsule run, `4480` in others) and once mid-run (`with-image`
  turn 2, `resume` request 5). Same token counts, same account: upstream
  write/read latency or checkpointing. This is also the unexplained
  "zero-cache fifth request" from the earlier investigation.
- **Run-to-run hit-rate variance is large** (baseline 81.9–95%), because a single
  sporadic reset on a 9-request run moves the average. The structural signature
  (turn-start read collapsing to the pre-capsule prefix) is deterministic;
  the aggregate percentage alone is not a reliable signal.

## 3. Real usage audit (last 7 days, read-only)

`~/.config/magpie/usage.jsonl`, sessions with ≥3 requests, `status=200`, grouped
by `native_session`. "Anchor reset" = read falls back to ≤35% of the previous
prompt while the prompt kept growing.

| Agent label | Sessions | Requests | Cache hit | Anchor resets | Tokens re-billed by resets |
| --- | --- | --- | --- | --- | --- |
| mybuddy | 24 | 440 | **77.5%** | 20 (6 sessions) | 1.22M |
| MyBuddy | 31 | 330 | 90.7% | 4 (3 sessions) | 0.18M |
| workbuddy | 1 | 45 | 95.6% | 2 (1 session) | 0.11M |
| dsh | 46 | 3007 | 96.5% | 88 (18 sessions) | 10.8M |
| pi | 3 | 405 | **99.2%** | 0 | 0 |

(The two MyBuddy spellings are separate writer labels in the gateway log; both
carry the same agent.)

Worst recorded MyBuddy session: **3.51M tokens re-billed** over 81 requests,
`0, 22016 × 20, 0, 23168 × 20, … 47616 × 5, 158848, …` — the read is pinned to a
fixed anchor for twenty consecutive requests while the prompt grows past 120k.
Other MyBuddy sessions show the same per-turn signature: `0, 25216, 26368,
26624, 0, 27008, …` and `…, 19712, 0, 28928, …, 19712, 19840, …, 19840, …`.

Plain `pi` sessions on the same gateway in the same week read 99.2% with zero
anchor resets, and `dsh` reaches 96.5%. The MyBuddy sessions also record 1-4
mid-session tool-declaration changes each, i.e. the `tools`-field boundary above
does occur in real work. The 22k/23k plateau is the capsule
barrier seen from the provider side: header + first user message is all that can
be reused.

## 4. Actionable conclusions

Ranked by measured cost:

1. **Per-turn memory/evidence capsule — the dominant loss.** Cost: the whole
   conversation body once per user turn (measured 33k tokens in a 6-request
   run; 3.5M in one real session). Options, increasing in change size:
   - keep the current design and accept the loss (status quo);
   - inject the capsule only on the first turn of a task, or when the prompt is
     small, so long tasks keep their cache;
   - persist the capsule as part of the user turn (append-only history, but
     durable, user-visible and accumulating);
   - replay prior capsules verbatim at their original slot (cache-friendly, but
     keeps stale private evidence in later requests until revocation, and grows
     the prompt).

   The current code cannot do better by moving the anchor: any per-turn
   request-only block that is absent from the next request ends the reusable
   prefix at that block's position.
2. **Mid-session tool-list changes — one full reset per change.** Recovers on the
   next request, but a session that toggles capabilities or connects MCP servers
   pays a full prompt each time. Needs `supportsAdditionalTools` /
   `supportsMidConvoSystemMessages` on the gateway path and a prompt that does
   not enumerate the active tool set.
3. **Compaction — one head rewrite by design**, append-only afterwards. No
   action.
4. **Upstream read latency on the first request(s)** — nothing client-side.

Verified safe, no action needed: steering, abort-and-continue, session
resume/restart, thinking-level changes, screenshot tool results across turns,
repeated serialization.

## 5. Boundaries of this evidence

- Synthetic 2x2 PNG images and a fixed fixture tool result; not a real coding
  task's tool output.
- The live and matrix arms use the same product extension stack, Pi loop and
  serializer as the app, but a fixture model/cwd; the audit reads gateway
  aggregates and cannot name the capsule for a historical session on its own.
  The matrix and live arms supply that mechanism.
- The 128-token cache-block rounding and the over-collapse after a capsule
  re-anchor are observed behaviour, not documented protocol.
