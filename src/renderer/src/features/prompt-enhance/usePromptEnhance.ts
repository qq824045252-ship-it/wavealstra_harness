/**
 * usePromptEnhance：Prompt Enhance 统一状态机
 * （idle → enhancing → applied/error；enhancing → 取消 → idle）。
 *
 * 设计要点：
 * - 不持有文本状态：requestEnhance(text) 由调用方在触发时传入当前文本，hook 内部快照；
 *   返回时经 getCurrentText()（调用方注入）或 fingerprint 判定是否 stale；
 * - 不碰 btwStore/appStore：只接收 context 与当前文本，业务状态由调用方映射进 context；
 *   BTW 激活态由调用方经 isBtwActive 回调注入，requestEnhance 内部防御性拒绝；
 * - 防双击：inflightRef 同步锁（React 批量更新窗口内防连点双请求）+ requestSeqRef 代际
 *   （取消/新请求后使在途结果失效）；
 * - Esc 取消不真正 abort 底层请求，靠 requestId 代际防落地；
 * - context 的 taskId/projectId/spaceId 变化 → 清 undo/notice、使在途失效。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { beginAuxiliaryOperation } from "../auxiliary-operations";
import {
  buildFingerprint,
  canTriggerEnhance,
  resolveUndo,
  type EnhanceUndoState,
} from "./policy";
import {
  ENHANCE_FAILED_NOTICE,
  ENHANCE_NOTICE_DURATION_MS,
  ENHANCE_STALE_NOTICE,
  type EnhanceStatus,
  type PromptEnhanceContext,
} from "./types";

export interface UsePromptEnhanceOptions {
  /** 结果落地回调：调用方写回文本（setText 等）；apply 与 restore 都经它写回 */
  onApply: (text: string) => void;
  /** 读取当前文本的同步函数（stale 防护用）；缺省时文本比对退化为仅 fingerprint */
  getCurrentText?: () => string;
  /** 同步读取 BTW 是否激活（由调用方注入；hook 不直接依赖 btwStore）。
   *  缺省视为未激活；requestEnhance 内部据此防御性拒绝 BTW 态请求 */
  isBtwActive?: () => boolean;
}

export interface UsePromptEnhanceApi {
  status: EnhanceStatus;
  notice: string | null;
  undo: EnhanceUndoState | null;
  /** 触发增强：text 为调用时刻的当前文本（hook 内部做 snapshot） */
  requestEnhance: (text: string, modelId?: string) => void;
  /** 撤销：currentText 为调用时刻的当前文本（仍等于 applied 才恢复原文） */
  undoEnhance: (currentText: string) => void;
  cancelEnhance: () => void;
  reset: () => void;
}

export function usePromptEnhance(
  context: PromptEnhanceContext,
  options: UsePromptEnhanceOptions,
): UsePromptEnhanceApi {
  const [status, setStatus] = useState<EnhanceStatus>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<EnhanceUndoState | null>(null);

  // —— 同步镜像：异步回调内读取，避免 stale 闭包 ——
  const statusRef = useRef(status);
  statusRef.current = status;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const contextRef = useRef(context);
  contextRef.current = context;
  const onApplyRef = useRef(options.onApply);
  onApplyRef.current = options.onApply;
  const getCurrentTextRef = useRef(options.getCurrentText);
  getCurrentTextRef.current = options.getCurrentText;
  const isBtwActiveRef = useRef(options.isBtwActive);
  isBtwActiveRef.current = options.isBtwActive;

  // —— 并发护栏 ——
  /** 请求代际：取消/新请求后使在途结果失效（过期结果丢弃） */
  const requestSeqRef = useRef(0);
  /** 单飞锁（同步判定）：state 批量更新窗口内的连点由 ref 挡住第二次请求 */
  const inflightRef = useRef(false);
  /** 触发时快照：sourceText（getCurrentText 缺省时的文本比对退路） */
  const sourceRef = useRef("");
  /** 通知 6s 定时器 */
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** cancelled 瞬时态归位 idle 定时器 */
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  /**
   * notice 短生命周期：6s 自动消失。
   * error/cancelled 为瞬时展示态：到期后归位 idle（✨ 按钮恢复，可再次增强）。
   */
  const scheduleNoticeExpiry = useCallback(() => {
    clearNoticeTimer();
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
      setStatus((s) => (s === "error" || s === "cancelled" ? "idle" : s));
    }, ENHANCE_NOTICE_DURATION_MS);
  }, [clearNoticeTimer]);

  /** 使在途请求失效（代际 + 释放单飞锁） */
  const invalidateInflight = useCallback(() => {
    requestSeqRef.current += 1;
    inflightRef.current = false;
  }, []);

  /**
   * Esc 取消：置 cancelled、清 notice/undo、使在途结果失效
   * （不真正 abort 底层请求，靠 requestId 代际防落地）。
   * cancelled 为瞬时态：下一拍自动归位 idle（状态机 enhancing → 取消 → idle）。
   */
  const cancelEnhance = useCallback(() => {
    if (statusRef.current !== "enhancing") return;
    invalidateInflight();
    clearNoticeTimer();
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setNotice(null);
    setUndo(null);
    setStatus("cancelled");
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setStatus((s) => (s === "cancelled" ? "idle" : s));
    }, 0);
  }, [clearNoticeTimer, invalidateInflight]);

  /** 彻底复位：清状态 + 使在途失效 + 清理定时器 */
  const reset = useCallback(() => {
    invalidateInflight();
    clearNoticeTimer();
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    setStatus("idle");
    setNotice(null);
    setUndo(null);
  }, [clearNoticeTimer, invalidateInflight]);

  const requestEnhance = useCallback(
    (text: string, modelId?: string): void => {
      // 同步单飞锁：state 批量更新窗口内的连点由 ref 挡住（防双击双请求）
      if (inflightRef.current) return;
      const reqContext = contextRef.current;
      const source = text ?? "";
      // 防御性门控：按钮可用性由调用方 canTriggerEnhance 控制，这里用真实内部状态
      // 再挡一层——重复请求（statusRef 仍在 enhancing）/ BTW 激活 / 空文本 / 无可信执行环境
      if (
        !canTriggerEnhance({
          text: source,
          context: reqContext,
          enhancing: statusRef.current === "enhancing",
          btwActive: isBtwActiveRef.current?.() ?? false,
        })
      ) {
        return;
      }
      // 触发时快照 sourceText 与指纹
      const fingerprint = buildFingerprint(reqContext, source);
      const reqId = ++requestSeqRef.current; // 新请求使旧的立即失效
      inflightRef.current = true;
      sourceRef.current = source;
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      setUndo(null);
      setNotice(null);
      clearNoticeTimer();
      setStatus("enhancing");

      void (async () => {
        try {
          const enhanceApi = window.api?.enhance?.prompt;
          if (!enhanceApi) throw new Error("enhance bridge unavailable");
          const operation = await beginAuxiliaryOperation("prompt-enhance", { context: reqContext, source, modelId });
          const res = await enhanceApi({
            requestId: operation.requestId,
            surface: reqContext.surface,
            input: source,
            ...(reqContext.taskId ? { taskId: reqContext.taskId } : {}),
            ...(reqContext.projectId ? { projectId: reqContext.projectId } : {}),
            ...(reqContext.spaceId ? { spaceId: reqContext.spaceId } : {}),
            ...(reqContext.mode ? { mode: reqContext.mode } : {}),
            ...(reqContext.tag ? { tag: reqContext.tag } : {}),
            ...(reqContext.expertId ? { expertId: reqContext.expertId } : {}),
            ...(modelId ? { modelId } : {}),
          });
          if (reqId !== requestSeqRef.current) return; // 已取消/被新请求取代：过期结果丢弃
          const enhanced = res?.text?.trim();
          if (!enhanced) throw new Error("empty enhance result");
          // stale 防护：返回时 sourceText 或指纹已变化 → 不落地（保留当前输入）
          const liveText = getCurrentTextRef.current?.() ?? sourceRef.current;
          const liveFingerprint = buildFingerprint(contextRef.current, liveText);
          if (liveText !== source || liveFingerprint !== fingerprint) {
            inflightRef.current = false;
            setStatus("idle");
            setNotice(ENHANCE_STALE_NOTICE);
            scheduleNoticeExpiry();
            return;
          }
          // apply：调用方写回文本 + 记录 undo（applied 不弹 toast，✨ + 恢复原文即反馈）
          onApplyRef.current(enhanced);
          operation.complete();
          setUndo({ original: source, applied: enhanced });
          inflightRef.current = false;
          setStatus("applied");
        } catch (err) {
          if (reqId !== requestSeqRef.current) return;
          console.error("[prompt-enhance] request failed:", err);
          inflightRef.current = false;
          setStatus("error");
          setNotice(ENHANCE_FAILED_NOTICE);
          scheduleNoticeExpiry();
        }
      })();
    },
    [clearNoticeTimer, scheduleNoticeExpiry],
  );

  /** 一步撤销：仅当当前文本仍等于 applied（用户未再编辑）时恢复原文 */
  const undoEnhance = useCallback(
    (currentText: string): void => {
      const u = undoRef.current;
      if (!u) return;
      const resolution = resolveUndo(u, currentText);
      if (resolution.kind === "noop") return;
      if (resolution.kind === "blocked") {
        setNotice(resolution.message);
        scheduleNoticeExpiry();
        return;
      }
      // restore：经 onApply 写回原文
      onApplyRef.current(resolution.text);
      setUndo(null);
      setNotice(null);
      clearNoticeTimer();
    },
    [clearNoticeTimer, scheduleNoticeExpiry],
  );

  // 上下文变化（taskId/projectId/spaceId）：清 undo/notice、使在途失效——
  // 任务 A 的结果绝不可能落入任务 B
  useEffect(() => {
    invalidateInflight();
    clearNoticeTimer();
    setUndo(null);
    setNotice(null);
    setStatus((s) => (s === "enhancing" ? "idle" : s));
    // 只响应环境锚点变化；mode/tag/preset 等由返回时的 fingerprint 比对兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.taskId, context.projectId, context.spaceId]);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    };
  }, []);

  return {
    status,
    notice,
    undo,
    requestEnhance,
    undoEnhance,
    cancelEnhance,
    reset,
  };
}
