import { useCallback, useLayoutEffect, useRef } from "react";
import { useAppStore } from "@/store/appStore";
import { durableMessageToChatMessage } from "@/store/app/messages/historyMapper";
import { mergeHistoryWindow, prependScrollTop } from "@/lib/historyWindow";

/**
 * 「更早历史」的无缝前插控制器（桌面端）。
 *
 * 负责请求生命周期、游标推进、作废令牌与滚动补偿；ChatView 只保留「什么时候请求」与渲染。
 * 补偿不采用「先记高度、后写一次 scrollTop」的裸写法：前插块里的图片 / SVG / 字体
 * 会在之后的帧里继续长高，一次补偿不够，必须盯住原首条消息把它按回原位。
 *
 * 不变量：
 * 1. 同一时刻最多一个请求（loadingRef），游标只朝更早推进；
 * 2. 回到底部 / 换任务后，飞行中的响应因令牌作废而丢弃；
 * 3. 补偿与守卫的写入是唯一滚动写入口（applyProgrammaticScrollTop）；
 * 4. 用户一旦自己滚动（scrollTop 偏离写入值），守卫立即放手。
 */

/** 距顶部不足该距离视为「已在顶上」，继续上滚即读取更早历史 */
const EARLIER_EDGE_PX = 48;
/** 一次上拉手势会打出几十个 wheel 事件：冷却挡住惯性连翻多页 */
const EARLIER_GESTURE_COOLDOWN_MS = 250;
/** 补偿守卫的最长帧数（约 0.65s）：足够覆盖图片解码与字体回填 */
const GUARD_FRAMES = 40;

type PrependAnchor = {
  element: HTMLDivElement;
  taskId: string;
  top: number;
  height: number;
  firstMessageId?: string;
  firstMessageOffset: number;
};

/** 视口首条消息（DOM 顺序）及其在滚动容器内的偏移：前插补偿的视觉锚点 */
function firstVisibleMessage(element: HTMLElement): { id: string; offset: number } | undefined {
  const node = element.querySelector<HTMLElement>('[id^="msg-"]');
  if (!node) return undefined;
  return {
    id: node.id.slice("msg-".length),
    offset: node.getBoundingClientRect().top - element.getBoundingClientRect().top,
  };
}

export function useEarlierHistory(options: {
  taskId: string | undefined;
  /** 还能向更早读取的游标；undefined = 没有更早历史 */
  cursor: number | undefined;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 全组件唯一的 scrollTop 写入口（带程序滚动防护） */
  applyProgrammaticScrollTop: (top: number) => void;
}): { requestEarlier: () => void; clearWindow: () => void } {
  const { taskId, cursor, scrollRef, applyProgrammaticScrollTop } = options;
  const loadingRef = useRef(false);
  const cooldownRef = useRef(0);
  /** 作废令牌：回到底部 / 换任务后 +1，飞行中的响应回来时据此丢弃 */
  const tokenRef = useRef(0);
  const anchorRef = useRef<PrependAnchor | null>(null);
  const historyWindow = useAppStore((state) => state.tasks.find((task) => task.id === taskId)?.historyWindow);

  const clearWindow = useCallback((): void => {
    tokenRef.current += 1;
    useAppStore.setState((state) => ({
      tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, historyWindow: undefined } : task)),
    }));
  }, [taskId]);

  // 换任务即作废：上一个任务的历史块不能留到下一个任务的视图里
  useLayoutEffect(() => {
    tokenRef.current += 1;
    anchorRef.current = null;
    return () => {
      tokenRef.current += 1;
      useAppStore.setState((state) => ({
        tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, historyWindow: undefined } : task)),
      }));
    };
  }, [taskId]);

  const requestEarlier = useCallback((): void => {
    const element = scrollRef.current;
    const target = cursor;
    if (loadingRef.current || !taskId || target === undefined || !element) return;
    if (element.scrollTop >= EARLIER_EDGE_PX) return;
    if (Date.now() < cooldownRef.current) return;
    cooldownRef.current = Date.now() + EARLIER_GESTURE_COOLDOWN_MS;
    const token = tokenRef.current;
    loadingRef.current = true;
    void (async () => {
      try {
        if (!window.api?.agent) throw new Error("主进程 Agent API 未就绪");
        const history = await window.api.agent.loadTaskHistory(taskId, target);
        if (history.historyError) throw new Error(history.historyError);
        const page = history.page;
        // 令牌 / 游标 / 世代任一变化都丢弃该块：它属于已经被替换掉的视图
        if (token !== tokenRef.current) return;
        const state = useAppStore.getState();
        const row = state.tasks.find((task) => task.id === taskId);
        const loaded = row?.historyWindow;
        const currentCursor = loaded?.epoch === row?.durable?.epoch ? loaded?.before : row?.durable?.historyBefore;
        if (!page || state.activeTaskId !== taskId || row?.durable?.epoch !== page.epoch || currentCursor !== target) return;
        // 服务端回同一条游标 = 已经到底：别再拿同一个空页打成死循环
        if (page.before === target) return;
        const first = firstVisibleMessage(element);
        anchorRef.current = {
          element,
          taskId,
          top: element.scrollTop,
          height: element.scrollHeight,
          firstMessageId: first?.id,
          firstMessageOffset: first?.offset ?? 0,
        };
        useAppStore.setState((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId
            ? {
                ...task,
                historyWindow: {
                  epoch: page.epoch,
                  seed: task.historyWindow?.seed ?? target,
                  before: page.before,
                  messages: mergeHistoryWindow(
                    [history.messages.map(durableMessageToChatMessage), task.historyWindow?.messages ?? []],
                    [],
                  ),
                },
              }
            : task)),
        }));
      } catch (error) {
        // 失败保持静默：下一次上拉即可重试，不在消息区插入提示条打断阅读。
        console.warn("[ChatView] 加载更早消息失败", error);
      } finally {
        loadingRef.current = false;
      }
    })();
  }, [cursor, scrollRef, taskId]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || anchor.taskId !== taskId || !historyWindow) return;
    anchorRef.current = null;
    const element = anchor.element;
    if (scrollRef.current !== element) return;
    applyProgrammaticScrollTop(prependScrollTop(anchor.top, anchor.height, element.scrollHeight));
    const id = anchor.firstMessageId;
    if (!id) return;
    let expected = element.scrollTop;
    let frames = 0;
    let frame = requestAnimationFrame(function guard(): void {
      if (scrollRef.current !== element || Math.abs(element.scrollTop - expected) > 2) return;
      const node = document.getElementById(`msg-${id}`);
      if (!node) return;
      const drift = node.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.firstMessageOffset;
      if (Math.abs(drift) > 1) {
        applyProgrammaticScrollTop(element.scrollTop + drift);
        expected = element.scrollTop;
      }
      frames += 1;
      if (frames < GUARD_FRAMES) frame = requestAnimationFrame(guard);
    });
    return () => cancelAnimationFrame(frame);
  }, [historyWindow, taskId, scrollRef, applyProgrammaticScrollTop]);

  return { requestEarlier, clearWindow };
}
