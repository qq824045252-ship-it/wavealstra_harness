/** Full-app Electron acceptance, isolated profile and actual Gadget IPC. */
process.env.GADGET_MENU_DEV = '1';
require('./bot-settings-dev-test.cjs');
