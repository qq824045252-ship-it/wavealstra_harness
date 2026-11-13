# Notification activation candidate — 2026-11-13

Integrated onto main 86fa6d925e5ef6d40d5afad1fc9e19bf335b1bce from the independently reviewed candidate based on 2ed684c8. Existing UI and clarification changes were retained by three-way application. The running original workspace was not updated.

## Implemented
- Persist notification targets independently of notification-center visibility.
- Use the notification identity to open the exact source conversation or Work, preserving drafts.
- Share activation handling between the notification center and desktop notifications; peek and acknowledge clicks only after processing. A failed target no longer blocks the next click.
- Add profile-bound Windows protocol activation, strict UUID parsing, escaped toast XML and a bounded development-launch handoff.

## Verified on integrated source
- `pnpm -s test:notification-activation`: PASS; controlled ports/VM, no Windows registration.
- `pnpm -s test:notification-routing`: PASS; actual isolated SQLite plus production navigation store and delivery helper, including bad A followed by good B, disposal, and acknowledgement failure.
- `node scripts/test-all.mjs --audit`: PASS. This audits classification, not the full test suite.
- Web and main-process type checks passed. Full typecheck initially failed on three pre-existing strict errors in `scripts/bot-clarification-team-test.ts` from the integration baseline; these are not notification-test passes. The fixture was then repaired without deleting its assertions and full web/main/scripts typecheck passed (zero baseline/new errors).
- Independent read-only candidate review found no definite blocking defect.

The Node 24 TypeScript loader transforms `.ts` in memory and uses the existing test guard; it does not invoke esbuild, support TSX, or replace type checking. Its API is experimental.

## Explicitly not verified
Actual Windows toast hot/cold clicks, competing development launchers, asynchronous startup-failure recovery, and packaged application behavior remain unverified. A profile-specific protocol does not make Electron's automatic shared shortcut/COM registration independent. No real user notification registration was changed during these controlled tests. This commit must not be described as Windows end-to-end acceptance.

Issue #45 was closed separately by user decision; its isolated runtime materials and unobserved-banner result are not part of this candidate or its acceptance claim.

## Clarification fixture correction found during integration
The team handoff test had an unconditional return before its completion and source-safety assertions. Removing it exposed a real fixture failure: it was treating a member result as an owner completion and using the ordinary Work continuation plan for a team. The corrected test advances the production team scheduler through member settlement, owner dispatch/settlement, and owner report publication. Its controlled reviewer selects the frozen member target and quotes the actual member deliverable; it asserts a pending semantic-missing recovery for that member plus the owner completion state. Future/changed/revoked-source assertions now execute rather than being skipped. The repaired team test passed. No product completion guard was relaxed.
The in-memory loader now also resolves missing local `.js` imports to their existing `.ts` source, matching the project's TypeScript ESM source convention; it does not replace existing `.js` files or transform dependencies.
