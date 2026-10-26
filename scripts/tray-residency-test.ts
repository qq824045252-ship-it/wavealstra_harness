import assert from "node:assert/strict";
import { shouldRemainResidentAfterClose } from "../src/main/tray-residency";

const base = {
  closeToTray: true,
  trayAlive: false,
  trayUnavailable: false,
  quitting: false,
};

assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "win32", trayAlive: true }), true);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "linux", trayAlive: true }), true);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "win32", trayUnavailable: true }), false);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "linux", trayUnavailable: true }), true);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "linux", trayUnavailable: true, closeToTray: false }), false);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "linux", trayUnavailable: true, quitting: true }), false);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "darwin", trayUnavailable: true }), false);
assert.equal(shouldRemainResidentAfterClose({ ...base, platform: "linux" }), false);

console.log("tray-residency: ok");
