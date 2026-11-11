# Follow-up: local browser preview and remaining diagnostic failures

## Confirmed product mismatch

Three actual failures were `browser_exec` navigating a generated local HTML file.
Manual BrowserHost opening already supports local file URLs, but automation rejected
all non-HTTP URLs. This led agents to launch external headless browsers; later
screenshot-file write denial is observed, though its OS-level cause is unproven.

Automation now uses the same sandboxed BrowserHost for existing regular local files.
Tool guidance explicitly explains local HTML preview/screenshot support. Network-share
file URLs, directories, missing files and executable URL schemes remain invalid.
There is no arbitrary JavaScript tool added and no change to Electron security settings.

## Verification

- Typecheck and browser-automation-recovery passed (including local encoded paths,
  invalid URL preflight without navigation, directories, network shares and schemes).
- Actual isolated Electron on Omarchy: local HTML with Chinese/space/# filename,
  navigate/read/click and nonempty colored screenshot passed using
  `pnpm -s test:browser-screenshot-electron --local-preview-only`.
- The complete existing screenshot suite passed hidden/inspector/blocker cases but
  timed out awaiting the minimized case. A concurrently started focused run also
  timed out on screenshot; after the original fixture exited, an independent focused
  rerun passed. The full GUI suite is NOT claimed passing. No model test was run.
- No production profile, data, checkout or running instance was modified.

## Remaining historical failures: not all resolved

- Windows "trusted read backend unavailable": current main no longer calls
  `withWorkShellRead` in production (only its focused test does); requires deployment
  verification rather than adding another parallel Windows authorization layer.
- One workspace write rejection is historical policy behavior, not evidence the
  latest deployment still blocks it. Do not erase the original record.
- `grep`/`rg` no-match can be an expected nonzero exit; a command result alone does
  not establish failed user intent. Do not globally translate exit code 1 to success.
- `rsync` absent, Python SyntaxError/NameError/invalid openpyxl import, exact edit text
  mismatch, unsupported ERP pagination and missing work_team_create criteria are
  distinct task/model/tool-contract failures, not a single permission issue.
- Office CLI/file-write denial and stale desktop observation/focus need targeted
  runtime evidence before altering OS settings or retrying actions. No such changes
  were made in this patch.
