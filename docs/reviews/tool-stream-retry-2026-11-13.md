# Tool-stream identity retry verification (2026-11-13)

Integrated reviewed candidate based on 02b87b61 onto main fdbe1b4c. The Pi patch adds only the exact anchored identity-ambiguity error to existing bounded request retry policy. It does not guess ambiguous fragments, dispatch partial error responses, broaden Work automatic recovery, or classify cancellation as retryable. Content-free identity diagnostics are request-scoped and bounded, with HMAC call identifiers and no arguments, tool names or message bodies.

## Actual patched dependency verification

A fresh ordinary source directory and node_modules were installed using project pnpm 12.14.0 with --offline --ignore-scripts --no-frozen-lockfile. 935 packages were reused locally, zero downloads. No junction to the user's dependencies was installed or modified. The generated node_modules/.pnpm/lock.yaml records pi-ai patch hash 08dcb7815a84d286f2b3120e101cd500f43b73cf7f34d2b4c465cb14a4450507. The tracked root pnpm-lock.yaml contains multiple YAML documents: package-manager configuration first, then the actual workspace dependency lock. Normal installation updated the pi-ai patch hash and dependent references in the latter; this generated lockfile is included, with no hand-written hash.

ESM resolution confirmed the independent installed pi-ai/dist/utils/retry.js contains the candidate rule. All following tests used that installed package directly, not the author's in-memory candidate loader:
- Durable success: 4 requests, exactly 2 effects (before/after preserved).
- Exhaustion: 3 requests, zero effects; cancellation: 1 request, zero effects.
- Actual own test-child process killed during persisted retry backoff, new process reopened the same SQLite/request: 4 total requests, exactly 2 effects, completed.
- Existing tool-call parser: 9 groups including ambiguous fragments rejected and distinct identities preserved.
- Bounded content-free identity tracing and Work automatic recovery regressions.
- Full web/node/scripts typecheck and test classification audit.

The independent review covered the six original frozen files. Crash recovery was subsequently added and executed directly; it is a synthetic protocol failure through the real Pi parser/Durable/SQLite path, not reproduction of the user's live upstream stream. No real model endpoint, user business tool effect, current profile or running app was touched. Existing running dependencies require a normal controlled dependency refresh before the patch becomes active there; pushing source alone does not update them.

Additional independent review accepted the crash probe and generated six-reference lock diff. The single-crash test does not independently prove retry-budget preservation across repeated crashes: its next attempt succeeds. Persistent attempt/checkpoint structure was reviewed statically; do not expand that test claim.
