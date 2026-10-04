# Origin Automation Reference

## Required control path on this machine

Normal MyBuddy workflows must use Broker V2:

```text
MyBuddy / Agent
   ↓
scripts/origin_tool.ps1
   ↓
Named Pipe: MyBuddyOriginBrokerV2
   ↓
scripts/origin_broker.ps1
   ↓
Origin.ApplicationCOMSI
   ↓
One long-lived broker-owned visible Origin instance
```

Protocol: `2`
Skill version: `1.1.0`

Do not create a fresh COM automation object for every action.

## Why the persistent broker is required

A reproducible Origin 2025b failure was observed on this machine:

1. An Origin process was already running.
2. Creating a short-lived `Origin.ApplicationSI` client spawned another `Origin64.exe -Embedding` process instead of reliably attaching to the existing session.
3. While the COM client stayed alive, the spawned Origin process remained stable.
4. Releasing the COM object caused that automation Origin process to disappear and refreshed Origin CrashRpt.

Therefore repeated one-shot COM calls produced the user-visible “Origin flashes/crashes on every invocation” behavior.

The normal automation path keeps one COM client alive and reuses it. Broker V2 owns one `Origin.ApplicationCOMSI` instance for its lifetime and exposes a local named-pipe API to MyBuddy.

## Forbidden default paths

Do not use these in normal analysis calls:

```powershell
New-Object -ComObject Origin.ApplicationSI
New-Object -ComObject Origin.ApplicationCOMSI
```

inside a short-lived shell command.

Also do not default to external `originpro`, `op.attach()`, or another per-request COM client. These are allowed only while explicitly diagnosing the automation layer.

## Broker V2 invariants

- Broker script: `scripts/origin_broker.ps1`
- Client script: `scripts/origin_tool.ps1`
- Named pipe: `MyBuddyOriginBrokerV2`
- Mutex: `Local\MyBuddyOriginBrokerV2`
- Protocol: `2`
- Broker owns one long-lived `Origin.ApplicationCOMSI` object.
- The Origin window is made visible.
- All normal actions reuse the same broker connection.
- Client verifies `brokerProtocol == 2` before treating a broker as healthy.
- The pipe ACL is restricted to the current Windows user.
- Requests are size-bounded.
- Generic LabTalk is analysis-only: obvious external-process, file-I/O, and window-close commands are rejected by the broker itself.
- If the COM object becomes disconnected, Broker V2 marks the state failed and exits instead of remaining as a permanently broken pipe server.

## Supported broker actions

Fixed deterministic actions:

```text
ping
capabilities
status
import
headers
stats
plot
corr
scatter
```

For Origin-native analysis not represented by a fixed action:

```text
labtalk
```

Use `labtalk` only for verified Origin-side scientific analysis / data transformation / visualization. Do not use it as a substitute for MyBuddy filesystem or process tools.

## Generic LabTalk safety boundary

Broker V2 blocks obvious commands that can escape the Origin analysis boundary, including:

- external process launchers (`cmd`, `powershell`, `wscript`, `cscript`, etc.)
- LabTalk `run` execution paths
- `shell` / `system`
- generic file import/export/save/delete/move/copy commands
- window-close commands

This is defense-in-depth. The Skill must still choose known Origin X-Functions and avoid destructive workbook edits unless the user requested them.

## File handling

When the user says not to let AI read/open the Excel source directly:

- Do not use pandas/openpyxl or file-content tools to inspect the source.
- Pass only the path into Origin.
- Use the dedicated broker `import` action, which calls Origin-native Excel import.
- Confirm `wks.nRows` and `wks.nCols` after import.
- Preserve the source file; analyze inside Origin.

Do not use generic `labtalk` for file import; Broker V2 intentionally blocks that path.

## Metadata-first analysis

Keep raw bulk data in Origin. Read only compact metadata/results needed for reasoning:

- row/column counts
- Long Name / Units / Comments / designations
- a small header row when Excel headers were imported as worksheet rows
- N, mean, SD, min/max, quantiles
- fit parameters and fit quality
- correlations / lags
- FFT / peak summaries
- segment counts or threshold diagnostics

Do not transfer whole columns to the model unless explicitly requested.

## Correlation helper behavior

The fixed `corr` action computes Pearson correlation inside Origin and uses a temporary worksheet column for the product term.

Broker V2 must:

- validate both columns exist
- reject zero-standard-deviation inputs
- require at least two paired valid samples
- restore the original worksheet column count in a `finally` path even if calculation fails

This prevents a failed correlation request from leaving a temporary column behind.

## Signal-vs-baseline workflow

Do not infer physical meaning from labels alone. If `Base Signal` and `Baseline` are present, analyze inside Origin:

```text
DeltaSignal = Base Signal - Baseline
AbsDelta    = abs(DeltaSignal)
```

Candidate state channels such as Current, Conductance, Capacitance, Frequency, Density, Process Temperature and Core Temperature must be tested rather than assumed.

Useful checks:

1. Distribution / quantiles / histogram of the candidate discriminator.
2. Whether there are distinct clusters or a defensible threshold gap.
3. Time alignment between candidate state changes and signal excursions.
4. Conditional statistics of `DeltaSignal` under candidate states.
5. Global and segmented/local relationships.

A weak global correlation does not rule out an intermittent or time-local relationship. A hard threshold should only be proposed when both the data separation and physical interpretation support it.

## Known failure modes

- Short-lived COM automation clients can spawn a new `-Embedding` Origin and crash it on COM release on this machine.
- External `originpro` may create hidden `-Embedding` Origin processes.
- `ApplicationSI` can fail to attach to the intended manual Origin instance even though it is intended for shared-instance automation.
- Multiple stale automation processes make target selection ambiguous.
- A stale Broker V1 process may remain alive until manually ended or Windows restarts; Broker V2 does not connect to its pipe.
- `from_file()` / Data Connector can establish a connector while leaving zero imported rows if selection/import behavior is incomplete.
- `Execute(...) == True` does not prove visible success; verify Origin-side state.

## Runtime note

Only Origin 2025b is installed under `C:\Program Files\OriginLab\Origin2025b` on this machine. The reproduced flash/crash behavior is therefore not explained by an obvious second installed Origin version.

If Origin also crashes outside automation, separately verify Origin updates/repair and Microsoft Visual C++ 2015–2022 Redistributables. Do not conflate general Origin startup problems with the one-shot COM teardown failure above.


#### PowerShell quoting rules for `-Script` (read before inlining)

`-Script` is passed through the PowerShell command line, so quoting failures are the #1 silent-breakage source. Rules:

- **Preferred for anything non-trivial: write the LabTalk to a UTF-8 file first, then pass `-ScriptFile`.** The file content is read verbatim; quotes, `$`, newlines and CJK text never touch the shell parser. No caller-side escaping at all.
- Inline `-Script` value must be wrapped in **single quotes** (`'...'`). Single-quoted strings protect `$`, double quotes and backslashes.
- LabTalk itself delimits strings with **double quotes** and escapes an embedded quote as `\"` (C-style, Origin-native). Inside a pwsh single-quoted `-Script` value these stay literal, e.g.
  `-Script 'string __t$ = "KF(ppm) \"raw\" value";'`.
- **Never escape double quotes with backslashes for the benefit of PowerShell** — `\"` is a C/JSON convention, not pwsh. pwsh only recognises backtick (`` ` ``) or doubled quotes inside double-quoted strings; an unescaped `"` closes the string early and the leftover text is misread as another parameter (e.g. `HeaderRow`).
- A LabTalk script containing a literal single quote cannot be inlined cleanly in a single-quoted pwsh string; use `-ScriptFile`.

Recommended invocation for scripts with quotes/`$`/newlines/CJK:

```text
1. write LabTalk script to <workspace>\analysis.lt   (UTF-8, no BOM)
2. origin_tool.ps1 -Action labtalk -ScriptFile "<abs path>\analysis.lt" -Vars 'a,b,r,n' [-Strs 's$']
```

Fixed helpers (`stats`, `corr`, `smooth`, etc.) never need this — only generic `labtalk` does.

Examples of Origin-native operations:

```text
smooth     -> smoothing / Savitzky-Golay
fft1       -> FFT / PSD
stft       -> time-frequency analysis
corr1      -> cross-correlation
cohere     -> coherence
fitLR      -> linear regression
fitMR      -> multiple regression
fitpoly    -> polynomial regression
fitexp     -> exponential fitting
pkFind     -> peak detection
nlfitpeaks -> multiple peak fit
normalize  -> normalization / standardization
reducerows -> reduce large datasets
levelcrossing -> threshold crossing positions
plotxy     -> XY plotting
```

Note: `origin_tool.ps1 -Action labtalk` accepts either `-Script '<inline>'` or `-ScriptFile '<path>.lt'` (UTF-8 file, read verbatim — bypasses all PowerShell quoting). For any script containing quotes, `$`, `%`-variables, newlines or CJK, use `-ScriptFile` (see the quoting rules above).
