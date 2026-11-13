# Explicit manual Work archive (2026-11-13)

Applied independently reviewed patch SHA256 135500EAF30D660D5C5CDEB69E7653D2FA51F8C90A02E9361200D4297F271BA6 on main 01a3cfe7. Only explicit archive metadata places a Work in the archive list. Closed but unarchived succeeded/failed/cancelled/unsuccessful Works stay in the completed list for both personal and team views. Existing outcome labels remain distinct; completed placement does not assert success.

No data migration, archive-table rewrite or automatic cleanup. Existing explicit archives remain archived. Delete still requires manual archive and restore keeps the existing archive contract.

Passed using the existing non-esbuild TypeScript runner: bot-work-review-control (12 groups), bot-work-summary-query including four terminal outcomes across personal/team scope, reopen/manual-archive coverage and bounded SQL pagination/performance, archive-deletion regression, and complete web/node/scripts typecheck. Independent review passed. Running application and real user database were not touched. These tests do not constitute live desktop/full-suite acceptance.
