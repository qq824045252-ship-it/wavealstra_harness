/** Reuse the isolated pnpm dev lifecycle; run Phase 5's real controls and read-back. */
process.env.BOT_WORK_DEV_PHASE5 = '1';
require('./bot-work-phase3-dev-test.cjs');
