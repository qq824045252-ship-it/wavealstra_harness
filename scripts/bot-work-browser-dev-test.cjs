/** Reuse the isolated pnpm dev lifecycle and actual delegated-task smoke. */
process.env.BOT_WORK_BROWSER_DEV = '1';
require('./bot-settings-dev-test.cjs');
