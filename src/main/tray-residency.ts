/**
 * 关窗后主进程是否继续跑提醒 / cron / Gateway。
 * Windows：只有托盘真的创建成功才驻留（失败则正常退出，避免窗口消失后无法恢复）。
 * Linux：托盘成功时同样驻留；StatusNotifier 创建失败时仍驻留，避免误杀后台任务。
 * 没有图标时，再次启动会命中单实例锁并恢复窗口。
 */
export function shouldRemainResidentAfterClose(input: {
  platform: NodeJS.Platform;
  closeToTray: boolean;
  trayAlive: boolean;
  trayUnavailable: boolean;
  quitting: boolean;
}): boolean {
  if (input.quitting || !input.closeToTray) return false;
  if (input.trayAlive) return true;
  return input.platform === "linux" && input.trayUnavailable;
}
