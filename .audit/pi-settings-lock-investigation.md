# Pi settings lock contention investigation

Date: 2026-11-05, Windows, Pi 1.3.0.

The investigation was performed by the lead without delegating to AI subagents. The original reported integration failure was a worker's EPERM when creating a Pi settings lock directory. The independent probe reproduced the same error shape; it did not use a model provider or launch MyBuddy subagents.

## Mechanism and evidence

`SettingsManager.create/reload` reads through `FileSettingsStorage.withLock`, which acquires an exclusive `proper-lockfile` directory even for reads. Separate worktree working directories still share the global agent directory and `settings.json.lock`. The dependency's `acquireLockSyncWithRetry` formerly retried ELOCKED only. A Windows mkdir EPERM escaped immediately. `assertModelAdmission` reads the settings error queue and refuses the model invocation.

Before patch, `.audit/pi-settings-lock-probe.mjs` observed:
- One reader: 5,340 reloads, no errors.
- Two readers: 2,522 and 2,415 reloads; one mkdir EPERM on the shared settings.json.lock.

This establishes that concurrent native settings reads are sufficient to reproduce the failure. It does not identify the precise Windows kernel or security-software operation that produced EPERM.

## Change

Extended the existing pi-coding-agent pnpm patch. Only Windows EPERM with syscall=mkdir and path equal to the current settings file's `.lock` directory joins the existing bounded retry path. The original maximum of ten attempts and 20ms spacing remains unchanged. Persistent failure still enters the native settings error queue. Other paths/syscalls and EACCES are not retried by this new condition. Existing dependency patches were preserved. Install lifecycle scripts were disabled.

## Verification and limit

- `pnpm -s test:pi-settings-lock`: PASS. Deterministic tests cover transient recovery, exact path/syscall classification, preservation of original settings, and persistent failure at the existing attempt bound.
- `pnpm -s test:subagent-pstack-execution`: PASS, including parallel real Pi workers against the local provider fixture.
- Post-patch probe: one reader 4,766 reloads without errors; two readers 2,972 and 2,033 reloads, no EPERM but one ELOCKED from exhausting the existing retry budget.

The fix closes the observed EPERM retry gap. It does not establish starvation-free locking under sustained hot-loop contention. The probe is diagnostic and intentionally reports errors without acting as a pass/fail gate.

No full-suite rerun, application build, package validation, publication, or shortcut update was performed in this investigation. Unrelated working-tree changes were preserved.
