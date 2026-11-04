/**
 * 终端 renderer 侧接线助手（纯逻辑，可单测）
 *
 * - createInputForwarder：xterm onData → window.api.terminal.input 的转发器。
 *   这是 P0 输入链路的关键一环（曾缺失导致「host 测试全绿但终端无法输入」），
 *   提取为纯函数以便回归测试直接覆盖。
 * - createBoundedWriter：term.write 大输出安全水位，防止渲染线程持续落后时
 *   IPC 队列 + write 队列无界积压。正常量级不会触发（主进程已有 25ms/64KB
 *   batching 兜底）。
 */

/**
 * 会话失效哨兵（restart/终止等场景）：truthy（可被输出守卫拦截）但永不匹配真实 UUID。
 * sessionIdRef 为 null 表示「未 attach 的回放窗口」（接受一切 data 以不丢回放），
 * 为哨兵表示「已失效」（丢弃一切旧会话事件）。
 */
export const TERMINAL_SESSION_INVALID = "__invalid-session__";

export interface InputForwarderTarget {
  /** 当前终端 owner（null = 未就绪）；taskId / workspaceId 二选一 */
  getOwner(): { taskId?: string; workspaceId?: string; terminalId?: string } | null;
  /** 当前会话（null/"" = 未 attach 的回放窗口；哨兵 = 已失效，均不转发） */
  getSessionId(): string | null;
  sendInput(req: { taskId?: string; workspaceId?: string; terminalId?: string; sessionId: string; data: string }): void;
}

/**
 * xterm onData 回调：owner/sessionId 未就绪或已失效时丢弃。
 * 主进程同样按 sessionId 拒绝旧会话输入，这里只是提前拦截。
 * 通过 getter 读取实时 ref，天然跟随任务/会话切换。
 */
export function createInputForwarder(target: InputForwarderTarget): (data: string) => void {
  return (data: string) => {
    const owner = target.getOwner();
    const sessionId = target.getSessionId();
    const taskId = owner?.taskId?.trim();
    const workspaceId = owner?.workspaceId?.trim();
    const terminalId = owner?.terminalId?.trim();
    if ((!taskId && !workspaceId) || !sessionId || sessionId === TERMINAL_SESSION_INVALID) return;
    target.sendInput({
      ...(taskId ? { taskId } : { workspaceId }),
      ...(terminalId ? { terminalId } : {}),
      sessionId,
      data,
    });
  };
}

export interface BoundedWriter {
  write(data: string): void;
  /** 尚未解析完成的字节数（UTF-16 长度近似） */
  pendingBytes(): number;
}

/**
 * term.write 安全水位：pending 超过 maxPendingBytes 后丢弃后续数据（仅告警一次），
 * 避免无界积压；每次 write 的完成回调扣减计数，队列排空后自动恢复。
 */
export function createBoundedWriter(
  write: (data: string, cb?: () => void) => void,
  maxPendingBytes = 8 * 1024 * 1024,
  onDrop?: () => void,
): BoundedWriter {
  let pending = 0;
  let warned = false;
  return {
    write(data: string): void {
      if (pending > maxPendingBytes) {
        if (!warned) {
          warned = true;
          onDrop?.();
        }
        return;
      }
      pending += data.length;
      write(data, () => {
        pending = Math.max(0, pending - data.length);
      });
    },
    pendingBytes(): number {
      return pending;
    },
  };
}
