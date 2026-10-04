/**
 * BTW（临时上下文分支）共享策略常量。
 *
 * 主进程 startBtw 的硬闸门与 renderer/测试共用同一份常量，避免两处漂移。
 * BTW 会话为瞬时会话：正常路径由 renderer 显式 close 销毁；renderer 异常退出后
 * 由主进程 keepalive 超时回收。上限是最后一道防泄漏防线，不允许无限增长。
 */
export const BTW_MAX_SESSIONS = 5;

/**
 * 是否允许新建 BTW 会话。
 * @param activeCount 当前活跃会话数
 * @param alreadyExists 该 btwId 已存在（重启同 id 时视为替换，不占新名额）
 */
export function canStartBtwSession(activeCount: number, alreadyExists: boolean): boolean {
  return alreadyExists || activeCount < BTW_MAX_SESSIONS;
}
