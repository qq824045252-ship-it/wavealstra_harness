# Work ownership and team recycle acceptance — 2026-11-13

Integrated on `333c33cb`, preserving earlier HTML, Gateway state/binding/registration changes.

- Legacy unowned team records remain accessible under their owning personal Bot instead of a separate historical-team sidebar.
- Removed records remain excluded from personal activity; formal team ownership is not reassigned.
- Deleted formal teams and their Work records remain manageable through the team recycle entry in both settings paths.
- Opening a recycled Work closes its parent management dialog first, so the destination is not obscured.

PASS on integrated source: complete node/web TypeScript checks; bot-work-summary-query (owner isolation, SQL pagination and 50,000-row fixtures); bot-work-team-service (creation restrictions, replay, cancellation/recovery and preserved historical results); actual BotTeamManagement DOM click regression. The latter is a controlled DOM fixture, not complete Electron desktop acceptance. No user Work or team data was deleted or migrated.
