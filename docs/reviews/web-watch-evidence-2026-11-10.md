# Public webpage watch evidence, 2026-11-10

Baseline: 7b372b8. Isolated Omarchy clone, temporary HOME, actual Electron dev renderer and opendesign/deepseek-v4.1-flash-eco. Production data, network settings and SSRF configuration were not changed.

## Implementation

Native Work projection now retains fetch_content receipts. Only a single matching HTTP(S) URL, successful HTTP 2xx (not 206), raw/readable output, no answer prompt, no images, no truncation, and exact returned character count can be complete web-content. Host extraction supplies the marker and HTTP status; model summaries and claimed hashes cannot supply proof. Readable means the full returned readable extraction, not proof that every dynamic element of a website loaded.

Failed or unsupported later fetch attempts invalidate earlier evidence for that source. Search results, multi-URL summaries, answer-mode output, metadata, partial output and missing HTTP status are not complete webpage evidence. Existing changes-only comparison and bounded stop-condition evidence can consume complete receipts. Browser reuse and special extractors without status remain unsupported rather than guessed complete. No automatic login or network bypass was added.

## Verification

- typecheck: passed, scripts zero new errors. Corrected only this clone's dependency links to its own shared source; no production dependency change.
- runtime-materials: passed; added complete webpage, 403/206/missing status, truncation, answer, metadata, failed request, mismatched URL, prompt and search negatives.
- work-team-watch-evidence: passed; complete webpage comparison, later failed fetch invalidates prior success, partial/search cannot prove equality.
- work-watch-goal: 31 checks passed.
- work-watch-supervision: passed (includes ordinary model failure fallback, no crash injection).
- web-access-extract-runtime: passed; actual HTML extraction pipeline with controlled HTTP response, raw/readable/abort and preserved HTTP status. This is a fixture, not live website success.
- Actual public example.com watch ran two minute-clock rounds before and after the change. Both results reached the original Bot conversation, remained active, then natural-language pause succeeded. Final state paused. Screenshot inspected on first run.

## Live source blocker, NOT a successful webpage acceptance

All actual fetch attempts failed: example.com resolved to fake-IP 198.18.0.8 and the product SSRF guard rejected it. Both readable/raw attempts produced native isError=true receipts, no page content. This is not Cloudflare and not an LLM quota error. Scheduling/failure reporting passed; webpage acquisition, real changed/unchanged comparison and web-based semantic completion remain unverified.

Read-only configuration check: normal app initialization defaults PI_CODING_AGENT_DIR to ~/.mybuddy. No web-search.json was found there, ~/.pi or ~/.config/pi. No credential values were printed. Default SSRF applies if production uses that normal profile; an externally overridden profile was not established. Do not infer a successful production fetch or change security settings from this test.

Reproduce: BOT_WORK_DEV_HEADLESS=1 BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash-eco pnpm -s test:bot-frontdoor:live --web-watch. Its passed status covers scheduling, return and pause only; inspect actual returned source errors. Artifacts for this run preceded the dedicated output path and are under out/diagnostics/bot-watch-goal/live/; future runs use bot-web-watch/live/.
