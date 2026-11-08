# Team scoped read verification repair — 2026-11-08

Base: `9f2966c70b0e02de7bf3f337ed58df54d6aff70b`.

## Defect and repair

The trusted `wc`/`stat`/`ls -l` adapter acquired a conservative host read lease to prevent concurrent managed writers without hashing a raced pathname. Team resource authorization only accepted file/directory resources and rejected this safe adapter as opaque host access.

The adapter now persists host-authored `readVerification` root/target metadata. Team authorization accepts only the exact local-host/scoped-read-verification/read tuple with this metadata and no pathname fingerprint fields. It checks the registered workspace identity, exact execution root, canonical target, active member, current read scope and target whitelist. Generic host reads/writes, missing metadata, alternate keys and out-of-workspace targets remain denied.

The host read lease still excludes all managed writers. Target metadata is not an observed file fingerprint or an overwrite authorization. The existing FD-bound system executor still verifies symlinks, file type and inode identity before execution. No new shell capability, external connection or desktop control is granted.

## Verification

- Typecheck: passed (web/node/scripts, zero new errors).
- Team service: passed, including missing/incorrect metadata, wrong root, outside target, symlink escape, read-scope revocation, target-whitelist revocation and replaced workspace.
- Native team: passed using actual Pi execution, SQLite storage and Linux system `wc -c`, `stat`, `ls -l` against a real file. Member read-only write denial and outside read denial remain enforced. Sequential members, owner synthesis, restart identity and no replay were checked. Root/target metadata survives reopen; no path fingerprint or live/quarantined lease is left behind.
- Team access, team approval native, React team UI, resource gate and resource settlement focused suites: passed.
- Architecture graph: passed, baseline unchanged.
- All 79 default scripts selected by `--filter=work`: passed, zero failures or regressions. This is focused aggregate coverage, not the full default suite.

## Electron presentation check

Current `pnpm dev` opened the retained isolated native-team database. Bot -> Native successor -> active Work -> details displayed all three member/owner executions as ended awaiting review, owner summary ready, and three proposed deliverables; the alpha result expanded normally. This checks presentation of actual native fixture execution, not a UI-initiated end-to-end team task.

After importing this fixture into the dev host, budget reconciliation reported a missing admitted request; successful full UI acceptance/closure is therefore **not claimed**. A card also retained the old owner in its pending-member text after handoff; this was handed off for separate team-lifecycle investigation and is not established as a new product regression by this fixture alone.

The native test uses a local deterministic model, not an online provider. Linux verification commands are platform-scoped; existing non-Linux team coverage remains runnable without claiming a system-command backend there. No user Work or data is modified. Full packaged application, online-model collaboration and cross-platform GUI acceptance are not claimed.
