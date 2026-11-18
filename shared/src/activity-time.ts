/**
 * 「最后活动时间」的唯一规则（Task.updatedAt / tasks.updated_at / 侧栏相对时间）。
 *
 * 这个字段同时承担四种角色：内容时间、排序键、侧栏文案、缓存身份。只要任何一处自己
 * 「发明」一个值，另外三处就跟着错。历史事故：durable 实时占位行用 `turnStartedAt ?? 0`
 * 当 createdAt，渲染层把「最后一条消息的 createdAt」直接当任务时间，侧栏于是显示
 * 「20774 天」（= epoch 0 到今天的天数），而数据库里一直是对的。
 *
 * 所以写这个字段必须经过本模块：
 *   1. isActivityTime          —— 什么算「真实的时刻」：有限且为正的毫秒时间戳。
 *                                 0 / 负数 / NaN / Infinity 都不是时刻，是缺失的伪装。
 *   2. activityTimeOrUndefined —— 「不知道」必须显式表达，绝不兜成一个数。
 *   3. latestActivityTime      —— 一组候选里最新且有效的那个。
 *   4. advanceActivity         —— 只允许前进；非法候选永远不能获胜。
 *
 * 显示层拿到 undefined 必须走未知态（「—」），不得对它做算术（算术出来的天数毫无意义）。
 */

/** `Date.now()` 量级的毫秒时刻：有限且为正。epoch 0 与负数代表「没有时间」，不是 1970 年。 */
export function isActivityTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 有效时刻，或 undefined（明确的「未知」）。不做取整、不做兜底。 */
export function activityTimeOrUndefined(value: unknown): number | undefined {
  return isActivityTime(value) ? value : undefined;
}

/** 一组候选里最新且有效的时间；全部无效时 undefined。 */
export function latestActivityTime(...candidates: readonly unknown[]): number | undefined {
  let latest: number | undefined;
  for (const candidate of candidates) {
    if (!isActivityTime(candidate)) continue;
    if (latest === undefined || candidate > latest) latest = candidate;
  }
  return latest;
}

/**
 * 推进一个已存的活动时间：候选值合法且严格更新才前进，否则保持原值。
 *
 * 两个值都不可用时返回 `now`——调用方（落库/排序/显示）都需要一个真实时刻，
 * 而「此刻」永远比 1970 更接近事实。只有在**确实没有任何可用值**时才用它。
 */
export function advanceActivity(
  previous: unknown,
  candidate: unknown,
  now: number = Date.now(),
): number {
  const next = activityTimeOrUndefined(candidate);
  const current = activityTimeOrUndefined(previous);
  if (next === undefined) return current ?? now;
  if (current === undefined) return next;
  return next > current ? next : current;
}