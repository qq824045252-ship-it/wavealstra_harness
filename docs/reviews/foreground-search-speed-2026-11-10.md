# Foreground search: quick sources, explicit verification

Base: `4929600`. Ordinary `web_search` now returns attributed search snippets without an implicit second page-fetch + model-assessment pipeline. `evidenceMode: "verify"` explicitly requests that pipeline, subject to the existing source-verification setting. `includeContent` still explicitly fetches pages; `source_check` remains the claim-verification tool. Snippets and provider answers are never relabelled as verified pages.

- No credentials/configuration are changed. The settings checkbox now describes permission for *on-demand* verification, not automatic verification of every query.
- Configured unavailable providers remain visible as “未发起请求” diagnostics and do not consume request slots. Local availability discovery is concurrent, abortable, and bounded by 2 seconds and the remaining overall deadline.
- Each query receives a fixed share of remaining request slots, including its fallback candidates. Insufficient capacity reduces provider coverage visibly instead of rejecting all queries. The overall request limit is not increased.
- Original-page and assessment progress are separately emitted; result details include `postSearchTiming`. Empty/invalid assessment JSON is reported with stop reason and character count, not repaired into invented evidence.

## Validation

- `pnpm -s typecheck`: pass, scripts 0 new errors.
- `test:multi-search`: 19 behavior cases passed, including bounded/abortable probes, missing Codex without misattributing Tavily, fair multi-query/fallback limits, quick mode with verification setting enabled, explicit verification with missing pages, cancellation, partial failures, and citation validation.
- `test:search-source-address`: 20 passed.
- `test:web-access-capability`: 26 passed.
- `test:bot-work-foreground-contract`: passed (87 invalid inputs and target-resolution checks).
- `test:bot-frontdoor:live --search`: real remote model + isolated `pnpm dev` Bot UI passed. No configured search credentials exist on this Omarchy profile, so this validates **empty-source failure paths only**, not live search-provider throughput. Single query 6.472s, two-query batch 6.720s, explicit verification 5.976s; each involved two model requests, zero provider HTTP requests, and no Work creation. Manual reading of model replies confirmed absent sources/unfinished verification were disclosed. The multi-query reply separately labelled a remembered Node.js URL as unverified memory, not a search result.

Actual live search API before/after latency remains unmeasured on Omarchy. Do not compare the empty-source measurements above with the earlier Vivion 50–68s calls as a speedup claim. Existing desktop fixture explicitly requests verification now; it was not rerun here. No full suite, crash injection, packaging, version bump, production profile change, or Vivion restart was performed.
