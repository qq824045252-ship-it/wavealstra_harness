# OfficeCLI bounded write diagnostic

## Change

The [bundled probe](../../scripts/skill-governance/payload/officecli/scripts/probe-write.cjs)
accepts an existing absolute task workspace and the already-configured
`MYBUDDY_OFFICECLI` executable. It creates a unique test directory, then runs at
most five commands: version, create XLSX, write A1, fresh-process A1 readback and
validate. Commands have a 10-second timeout and 64-KiB output limit. Any failure
stops the probe. There is no PATH fallback, binary copy/update, TEMP change,
permission change, resident process or retry of the original denied operation.

Exit 0 alone is insufficient: mutations/validation must return JSON success;
a regular nonempty ZIP file must exist on disk, the write must change its hash,
and the fresh-process readback must match the exact A1 token. The report keeps
exit codes, signals, timeout/spawn errors, bounded stdout/stderr, binary hash,
sample hash and evidence paths. Report-save failure makes the CLI fail rather
than claiming that evidence was delivered.

The skill now describes Access denied as an observed rejection, not a proven
ACL, lock or OneDrive cause. It explicitly separates this sample probe from final
artifact acceptance, pagination/layout checks and historical interrupted tools.
Existing installed user skills remain preserved. The helper is present in the
repository and newly seeded skill packages; this change does not silently update
an existing user skill or install anything on Windows.

## Focused verification

- `test:officecli`: 19 Node behavior/integrity tests pass, plus skill discovery,
  permission filtering, disabled-copy preservation and payload checks.
- The helper is required by the packaged skill asset validator; missing helper
  assets fail verification.
- Real bounded subprocess tests cover exit 7/stderr, output overflow and timeout.
  These are test-only child processes, not app crash/recovery injection.
- `typecheck`: web, node and scripts pass; no new script errors.
- `git diff --check`: pass.
- Optional vendor smoke in the isolated clone: **SKIP**, build-time binary absent.
  No package build, GUI acceptance, full headless regression or real-model run.

See [behavior tests](../../scripts/officecli-write-probe.test.cjs).

## Real Omarchy observation during implementation

Date: 2026-11-11, 11:11 UTC. Existing vendor OfficeCLI **1.0.160** was used in place,
with inherited temporary-directory settings. Binary SHA-256:
`baa084b64ec634bd9d41a0592db3ed85f11658b358bab898679537ea7f3e73a9`.

| Step | Exit | Evidence |
| --- | --- | --- |
| version | 0 | `1.0.160` |
| create XLSX | 0 | JSON success, on-disk sample present |
| set A1 | 0 | JSON success, on-disk bytes changed |
| fresh-process readback | 1 | `Error: Disk quota exceeded : '/tmp/tmpDhy3vN.tmp'` |
| validate | not run by probe | Stopped at first failure |

The probe correctly returned **failed**, retained its JSON report and sample,
and did not retry or redirect temporary storage. The retained sample was 4,373
bytes, SHA-256 `0134ed814c9f241df8be03436682e7d39f0d81a6ea162df123df193af7986913`.
This was not a successful end-to-end write/readback acceptance. The final exact
cell and JSON-result checks were subsequently covered by the focused tests.

This Linux result does **not** explain or close the earlier Windows Access denied
incident. There was no Windows run, no production app/database modification, and
no clearing of historical interruption records. It establishes why a successful
create, set, or ordinary filesystem touch cannot alone certify the Office chain.
