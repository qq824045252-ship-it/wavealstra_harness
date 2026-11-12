# #43 integrated real-model acceptance and Windows path follow-up

## Fixed run

Product base `a2b9c8d089c743a0d13344b99f726e5c6b327aa1`; runner-only isolation adjustment. Run `2026-11-12T16-55-04-866Z`, source digest `807c1840b191cbed7042e784ee0e1606b2fb283b804d8af0eee49db91aeff9f1`; `sourceDeltaFiles=[]`. Actual Windows Electron dev, isolated HOME/database/profile, both Bots use local Magpie `opendesign/deepseek-v4.1-flash-eco`.

| Category | Result | Elapsed |
| --- | --- | --- |
| Arithmetic | passed; B direct answer, no Work | 34.2 s |
| Translation | passed; B direct answer, no Work | 26.1 s |
| CSV | passed; unique B Work, file total 166, A return | 102.9 s |
| Code repair | passed; actual empty/nonempty Node checks, B file, A return | 149.9 s |
| Structured extraction | passed; exact fixture fields, B file, A return | 120.4 s |
| Offline HTML | failed; B execution/return deadline expired, Work still active | 336.9 s including initial A acceptance |

The B decision/execution/return deadline remained 300 seconds. No deadline extension, artifact relocation or successful rerun is claimed. Five successes do not close the six-case acceptance requirement. Final driver exit was 1; owned fixture processes were cleaned up. The user development app was not stopped.

## Confirmed failure mechanism

Provider request history shows the HTML Work executing Bash `pwd && ls -la`. Git Bash returned `/tmp/bot-frontdoor-live-4qbx2i/recipient-43`, corresponding to its Windows temporary directory. The model passed that POSIX absolute path to native `write`, which resolved it as `C:\tmp\bot-frontdoor-live-4qbx2i\recipient-43\water-cycle.html` instead. Actual misplaced file: 11,070 bytes, SHA-256 `26ea574cf09cf09eb15bec5b6e2d2eb4270514021757d15651ce078a9466156c`. Bash then could not read it in the real workspace and began searching. The expected target workspace had no HTML at the deadline.

This is a cross-tool Windows path namespace mismatch, not evidence that B ingress failed: B had a persisted foreground request, created its own single Work, and ran real tools. No existing open Issue specifically names this mismatch; it was found during #43 acceptance.

## Narrow correction and focused verification

Native read/write/edit/register_artifact now translate a Windows POSIX path only after the **same ExecutionEnv** reports its real Bash cwd and cygpath native cwd, and these agree with the existing native workspace. Only a path inside that exact verified alias is translated. Prefix collisions, traversal out of that workspace, unknown global aliases and symlink/junction escape are rejected explicitly rather than silently guessed. C:/ paths, UNC and ordinary relative paths retain original behavior. Linux/macOS are unchanged. The existing native tool and artifact checks still execute; no second filesystem or global mount table was added.

`test:bash-native-workspace-path` first reproduces the original native resolution mismatch, then performs actual Git Bash/native write-edit-read and Bash cat, followed by real artifact registration. It also checks traversal, prefix mismatch, a real external junction, shell metacharacters as literal filenames, failed mapping, read @ prefix, native/UNC/relative preservation, and non-Windows no-op behavior. Passed, alongside typecheck, existing durable-artifact-registration and durable-tool-policy. These tests use real local tools with an explicit API fixture, not a model or GUI.

HTML and the six-case batch must be rerun after this correction; no model rerun is claimed here. Full regression is deferred until related fixes are integrated.

## Test-only startup adaptation

Two earlier runs failed before model traffic (`16-51-05-935Z`, `16-52-38-489Z`): native esbuild output writes were denied, including an independent fresh cache directory. A minimal build probe confirmed native write:true failed while write:false plus Node filesystem writes succeeded. Loading the original checkout's same-hash dependency produced the same denial.

The frontdoor runner now uses a per-run Vite cache. Optional `BOT_LIVE_NODE_WRITE=1` passes identical esbuild inputs with write:false and writes returned bytes using Node inside that cache only, rejecting escaped output paths. No shared dependency, product Vite configuration, OS permissions or security settings changed. This enabled the real run above; it is not a product fix or a claim that startup in an ordinary installation is broken.

Evidence retained locally under `out/diagnostics/issue32/live/2026-11-12T16-55-04-866Z`: report, per-case progress, provider requests, launch fingerprint, screenshot and dev log. No real user memory/account data were used.
