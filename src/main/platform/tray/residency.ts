/**
 * 关窗后主进程是否继续跑提醒 / cron / Gateway。
 * 纯逻辑：由平台行为提供 `degradedResidency`，不在这里判断平台。
 * - 托盘存活 → 驻留；
 * - 托盘失败：Linux（degradedResidency=true）仍驻留，避免误杀后台任务；Windows/macOS 正常退出，
 *   避免窗口消失后无法恢复（再次启动会命中单实例锁并恢复窗口）。
 */
export interface TrayResidencyInput {
  /** 托盘不可用时是否仍驻留（Linux=true，Windows/macOS=false）。 */
  degradedResidency: boolean;
  closeToTray: boolean;
  trayAlive: boolean;
  trayUnavailable: boolean;
  quitting: boolean;
}

export function shouldRemainResidentAfterClose(input: TrayResidencyInput): boolean {
  if (input.quitting || !input.closeToTray) return false;
  if (input.trayAlive) return true;
  return input.degradedResidency && input.trayUnavailable;
}
