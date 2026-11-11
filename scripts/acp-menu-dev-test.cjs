/** Reuse the isolated actual-app dev launcher, not a packaged or renderer-only fixture. */
process.env.ACP_MENU_DEV = '1';
require('./bot-settings-dev-test.cjs');
