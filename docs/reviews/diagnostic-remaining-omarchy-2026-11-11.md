# Remaining diagnostic signatures: Omarchy runtime check

Scope: isolated checkout and new fixture files on Omarchy, no Vivion testing,
no production database or instance modification. This is direct tool/runtime
verification, not real-model task acceptance. No Windows fix claim is made.

## Actual Office writes

Installed vendor OfficeCLI 1.0.160 was used directly (not available on shell PATH).
For each of system temporary storage (Python selected `/var/tmp`), checkout-local
fixture storage, and Chinese + space directory names:

1. `officecli create <new fixture.xlsx> --json` exited 0.
2. `officecli set <fixture.xlsx> /Sheet1/A1 --prop value=诊断回读42 --json` exited 0
   (the actual fixture value included a separating space).
3. Python ZIP integrity check passed; independent XML readback contained the value.

All three passed. This establishes Linux file-write/readback capability, not the
cause of Windows OfficeCLI TEMP/OneDrive access denials. No ACLs were changed.

## Actual command signatures

Seven direct shell checks: grep match (0), grep no match (1), missing command (127),
Python syntax error (1), Python undefined name (1), missing input file (1), installed
rsync version (0). All matched expected exit/status and stderr signatures. Therefore
nonzero is not itself a permission finding. In particular, no-match cannot justify
claiming an entire goal failed, while code 1 must not be globally treated as success.
Linux has rsync; its Windows availability remains unverified.

## Actual Electron interaction

`test:computer-use-behavior --interaction-only` passed eight runtime cases:
- target is not confused with an extra control window;
- duplicate controls are rejected;
- element identity survives DOM reordering;
- stale/replaced nodes are invalidated;
- disabled/occluded targets do not claim clicks;
- Unicode fill and real Ctrl+A input events;
- cancelled wait terminates;
- navigation invalidates prior locators.

`test:computer-use-recovery` also passed (record/recovery contracts; this is not a
physical Windows HWND-focus test). The new focused switch stops before unrelated
overlay lifecycle checks; the default test path is unchanged.

## Explicit unresolved boundaries

The full Electron behavior suite failed waiting for two overlay windows to become
visible. It is not reported passing. The focused eight-case run above passed
independently. This does not establish the Windows stale-observation/focus report
is fixed or validate native cross-application focus on Linux.

An initial test profile under `/tmp` produced Chromium cache-creation failures and
GPU-process exits. `df` reported 3.1 GiB free and 64% of inodes free at inspection,
so "disk full" is unsupported. Using a new test-owned TMPDIR under the isolated
checkout avoided that error. No system settings or existing cache were changed.
The exact `/tmp` subprocess cache cause remains unproven.

Windows TEMP/OneDrive denial, Windows native focus, and generated Python/task code
errors remain distinct follow-ups. No production behavior patch was justified by
these Linux results; only the focused test entry and this evidence were added.
