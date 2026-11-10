# Team member → native subagent read/write verification

## Scope and fix

User approved new Bots defaulting to workspace read/write, native children inheriting the parent's available tools, and existing explicitly read-only Bots remaining read-only.

- New creation defaults to workspace files enabled. Explicit `false`, existing Bot rows and old pending creation requests retain their prior semantics; reopening the create dialog also restores the new default.
- Native subagent start/steer is same-task orchestration. Leaf tools still enter the host hook with the same task identity and are checked against Work scope, permission mode and file-tool workspace rules. External business delegation is unchanged.
- Default/auto children without an explicit role tool list inherit parent callable tools. Explicit role lists, deny rules, saved default `confirmTools`, readonly restrictions and recursion exclusions remain effective.
- No production data migration, no new per-action approval, no WorkService split, no crash injection.

## Confirmed pre-fix defect

A real DeepSeek team member attempted native `subagent` twice in default mode. Both calls were rejected because team plans provide workspace read/write scopes while the tool hook requested `delegate`; a read-only member was misleadingly labelled a scheduled/read-only recovery. No child read occurred. The member and owner correctly reported failure.

## Verification

| Check | Result |
|---|---|
| `pnpm -s typecheck` | PASS, scripts 0 new errors |
| `test:bot-create` | PASS; default write and explicit historical readonly |
| `test:bot-create-ui` | 31 PASS, including second creation and old pending request |
| `test:team-subagent-policy` | PASS; five concurrent native runtimes, actual temporary files, parent scope denial, readonly denial, identity separation, outside cwd rejection and truthful failure |
| `test:bot-work-team-service` | PASS; bounded parallel members and team lifecycle |
| `test:bot-work-team-access` | PASS; team/control identity separation |
| `test:subagent-cache-accounting` | PASS |
| `test:subagent-runs` | 50 PASS; corrected stale `0M` expectation to required `0.000M` |
| `test:bot-frontdoor:live --team-subagent` | PASS; real model + Electron dev UI + disk |

The native policy suite uses a deterministic model fixture, not an online model. The separate live suite used the actual local OpenAI-compatible DeepSeek V4.1 Flash provider, isolated HOME, and `auto` matching this computer's current user setting. It did not change the user's running profile.

The live task used one real member subagent call: `read evidence.txt → write child-output.txt → read back`, with an unpredictable marker absent from prompts. Both files were 28 bytes and identical. The test requires successful read/write tool receipts, not merely file existence or a shell substitute. The exact marker reached the member, owner and original Bot conversation. Expanded report content was visually inspected in Electron, including the task title, original content and byte/hash table.

Diagnostics separated the member's 9 requests (main + subagent) from the owner's 2 requests. Native cacheRead fields were present (member group 124800, owner group 12288); no fabricated zero values were inserted. This is identity/collection validation, not a new claim of a complete provider-billing audit.

Artifacts (local, not committed): `out/diagnostics/bot-team-subagent/live/report.json`, `provider-requests.json`, `team-subagent-result.png`.

## Limits

No full suite, packaged build, crash injection or production restart was performed. An initial live fixture incorrectly used a personal Bot directory as the team's cwd; it was corrected to the team's explicit workspace and rerun with strict successful read/write receipt assertions. The final pass is the workspace-correct run, not that initial attempt.
