# Mail and calendar are optional integrations

User direction: remove the fixed mail/calendar navigation destination and do not equate mail/calendar with Gmail/Google Calendar.

- Removed the fixed account-navigation item. Existing Google service, IPC, legacy page implementation, credentials and user data are not deleted or migrated.
- Removed automatic Google read/write tool and prompt injection from the foreground and the ordinary/Work Durable path.
- Explicitly selected MCP servers still use the existing native MCP transport. Selected connector skills retain the existing CLI-through-Work path. No new approval layer or parallel integration system is introduced.
- The retained built-in GWS implementation is **not** an MCP server or an automatically selectable native connector. This change does not pretend otherwise. Users choose their service's available MCP/connector through the existing plugins and Bot mounting UI.

## Evidence

- Typecheck: passed, scripts 0 added errors.
- Google tool test: unconfigured foreground has no vendor tools/prompts; actual local stdio MCP discovery/call succeeds for selected server, unselected server excluded. Existing GWS read tool receipts still tested directly.
- Google write tool test: passed; retained request identity/replay behavior unchanged.
- MCP mode test: passed, including 19 end-to-end config checks.
- Durable Bot test: passed, including native/codemode MCP discovery, invocation, resources, reopen and OAuth fixtures. Provider responses are fixtures, not a real external provider/account run.
- React account-navigation test: fixed mail/calendar destination absent, generic plugins destination present. Existing UI fixture requires the already available Monaco worker stub because it runs outside Vite; test script now supplies it.

Initial /tmp EDQUOT was avoided with a clone-local TMPDIR; no system setting was changed. No real mailbox/calendar mutations, application restarts, build/package or account-data changes were performed.
