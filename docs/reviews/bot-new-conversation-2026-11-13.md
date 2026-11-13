# New conversation archive boundary (2026-11-13)

Integrated onto main 41c35827 in an independent checkout. Only the conversation store archive action and its controlled regression change; header icons and parallel collaboration-record work remain untouched.

After host archive confirmation, the old transcript is retired immediately even if the following history request fails. Ordinary refresh and older-page flights are invalidated. A notification navigation started before the archive is invalidated unless a newer navigation was chosen meanwhile. A different conversation selected during archive IPC is not cleared. Missing host API or archive rejection preserves original unarchived content and reports failure. Work and drafts are retained; no persisted history is deleted.

Final checks (no Codex/esbuild): nine controlled archive/navigation scenarios, existing bot-conversation-ui, notification-routing with isolated SQLite, and full web/node/scripts typecheck passed. The notification race was found during independent review and fixed before submission. Tests use synthetic store/isolated data, not the user's active profile; no real desktop-click acceptance or full-suite pass is claimed.
