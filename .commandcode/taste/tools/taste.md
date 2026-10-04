- Uses Windows as primary development environment with PowerShell and Windows Terminal (`wt.exe`), plus WSL interop (bash available under `/mnt/c` paths). Confidence: 0.9

- On this Windows machine the default shell (cmd) does not support bash heredocs (`<<'EOF'`) for `git commit -F -`; multi-paragraph commit messages are passed via repeated `-m` flags instead. Confidence: 0.9

- Uses oh-my-posh for shell prompt theming and requires Nerd Fonts (MapleMono-NF-CN, CaskaydiaCove, MesloLGL) so that prompt glyphs render correctly. Confidence: 0.85

- Prefers user-scoped tool installation rather than system-wide/admin installs (fonts land in the user Fonts folder, modules checked via `Get-Module -ListAvailable`, no reliance on `C:\\Windows\\Fonts` system store). Confidence: 0.75

- Uses PowerShell helper modules alongside oh-my-posh (posh-git, Terminal-Icons, PSReadLine) and relies on the oh-my-posh init script being loaded from the PowerShell profile. Confidence: 0.7

- Communicates in Chinese (Simplified) across contexts — tool/environment troubleshooting as well as product/UI feature requests and code change discussions. Confidence: 0.97

- Runs oh-my-posh v29 (29.36.0) with streaming rendering explicitly disabled (`$global:_ompStreaming = $false`) to avoid PSReadLine History+ListView prediction being starved by the streaming `serve` background process抢占. Confidence: 0.85

- Codes in this project (mybuddy) in Simplified Chinese: UI strings, plan documents, comments and chat all in Chinese. Confidence: 0.97

- In mybuddy, "扩展浏览器" = the in-app extension panel browser (BrowserHost/BrowserView, right-side panel rendered at `panelMode === "browser"`); opening local HTML in it goes through `window.api.browser.open` with a `file:///` URL plus the store's `setBrowserUrl` (which flips the panel to browser mode). The OS browser is separately referred to as "系统浏览器". Confidence: 0.85

- Values a verified cross-cutting plan before coding on this repo (workspace context menu, BrowserHost, store, IPC, preload APIs), and wraps up with a `pnpm run typecheck` gate; implementation was confirmed against a written plan file. Confidence: 0.65

- For file-type-specific features, keeps the change scoped at the renderer level (e.g., matching `.html`/`.htm` via `menu.name`) and reuses existing helpers/icons/store actions rather than introducing new IPC or main-process hooks. Confidence: 0.7

- Diagnoses before committing messy working trees: distinguishes real code changes from line-ending noise (e.g., checking `git diff -w/--numstat/--ignore-space-at-eol` and `git ls-files --eol`), and normalizes CRLF→LF back to the repo's expected line endings rather than committing 10k+ lines of EOL churn. Confidence: 0.7

- Runs `pnpm run typecheck` as the gate before committing a batch of changes in mybuddy, and reports which feature-specific test scripts were added for the user to run afterwards. Confidence: 0.6

- Treats the auto-learned `.commandcode/taste/` preference files as regular tracked work: includes their updates in the commit (describing them as learning-preference records) rather than leaving them as untracked/stray changes. Confidence: 0.7
