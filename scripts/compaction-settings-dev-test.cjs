/** Actual app, isolated profile, no model calls or product build. */
process.env.COMPACTION_SETTINGS_DEV = '1';
require('./bot-settings-dev-test.cjs');
