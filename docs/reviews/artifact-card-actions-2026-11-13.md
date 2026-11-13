# Artifact card actions verification (2026-11-13)

Base: main c62c4e09. Implemented in an isolated integration checkout; running user checkout was not changed or restarted.

- Replaced three text actions with labelled icons; retained keyboard-native buttons, tooltips, pending guard and original IPC arguments.
- Preview is inside its selected file row. Row, selection and preview share an identity including execution binding, snapshot, digest and manifest.
- Independent review found a same-snapshot/different-binding ambiguity; fixed before publication and added a regression covering switching and removing the selected binding.

Final checks passed without Codex or esbuild:
- run-tsgo-ui-test: saved-file-actions-dom-test, bot-message-html-ui-test, work-file-card-ui-test.
- Full typecheck (web, node, scripts).
- Gateway binding controlled regression using the existing TypeScript memory loader.
- test-all --audit (classification only, not a full suite execution).
- git diff --check.

The first full typecheck found the pre-existing live cross-channel fixture still using connectedWorkIdentity after the binding API introduced connectionRevision. The test now obtains the actual connectedBindingIdentity and supplies its revision, retaining existing assertions and adding an identity assertion. No live model request was made.

Independent final review accepted BotWorkResult SHA256 0C36DDD6F44ED8CE5D3C1463C20610C47D42A6D51D96898F27019C2590AF6EEE and the same-snapshot regression SHA256 E58E0947A96F8CA5E68BBF5D1C73D54BB884F94D91C212B373513A1E1D489B61.

Limits: DOM fixtures deliberately stop before executing HTML. No new physical desktop/narrow-screen screenshot, successful preview-token release, live model or full-suite verification is claimed. Existing WorkFilePreview security implementation is unchanged.

## Preview icon toggle follow-up

Integrated on main 4eddb798. File-card preview icons now toggle their own preview directly, with aria-expanded and aria-controls. Card-controlled previews start expanded and omit the redundant internal expand/close controls. Other WorkFilePreview callers retain their previous default controls. Original snapshot identity, IPC and preview isolation are unchanged.

The three focused DOM scripts and full web/node/scripts typecheck passed on the integrated source without Codex/esbuild. Tests cover opening, repeated icon closure, reopening, binding switch and message-HTML source cards. This is not physical desktop/narrow-screen or live HTML execution acceptance; the running original application was untouched.
