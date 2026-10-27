import assert from "node:assert/strict";
import { shouldRemainResidentAfterClose } from "../src/main/platform/tray/residency";

const base = {
  closeToTray: true,
  trayAlive: false,
  trayUnavailable: false,
  quitting: false,
};

// Windows / macOS（degradedResidency=false）：只有托盘真的创建成功才驻留
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: false, trayAlive: true }), true);
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: false, trayUnavailable: true }), false);
// Linux（degradedResidency=true）：StatusNotifier 创建失败时仍驻留，避免误杀后台任务
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: true, trayAlive: true }), true);
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: true, trayUnavailable: true }), true);
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: true, trayUnavailable: true, closeToTray: false }), false);
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: true, trayUnavailable: true, quitting: true }), false);
// 没有托盘又没有降级策略 → 不驻留（否则窗口消失后无法恢复）
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: true }), false);
assert.equal(shouldRemainResidentAfterClose({ ...base, degradedResidency: false }), false);

console.log("tray-residency: ok");
