/** Isolated full-app Electron acceptance; no build, real terminal/browser IPC. */
process.env.EXTENSION_TOOLBAR_DEV = '1';
require('./bot-settings-dev-test.cjs');
