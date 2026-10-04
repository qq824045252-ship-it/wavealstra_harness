import { useEffect, useRef, useState } from "react";
import { useBtwStore } from "@/store/btwStore";
import { useAppStore } from "@/store/appStore";
import MessageItem from "./MessageItem";
import { IconChevronDown, IconChevronUp, IconStop, IconX } from "@/components/common/icons";

/**
 * BTW 临时问答面板（位于正常 message-scroll 与 ChatInput 之间，虚拟列表之外）。
 *
 * 三种形态：
 * - 状态条：active 但尚未发出首轮（或折叠时面板头部的常驻信息）；
 * - 展开面板：started && !collapsed（含 header/body/footer，body 内部滚动 + 高度上限）；
 * - 折叠条：started && collapsed（仅一行摘要 + 展开/关闭）。
 * 折叠与关闭互不影响生成：折叠只收面板，生成由主进程 BTW 会话继续。
 */
export default function BtwPanel({
  overlayOpen = false,
  pendingMainItems = false,
}: {
  /** 更高层弹层（+ 菜单/模型/权限等）是否打开：Esc 必须优先由弹层消费，不抢关 BTW */
  overlayOpen?: boolean;
  /** 主 Composer 里存在待发附件/引用（进入 BTW 前已挂载）；仅提示，不拦截 */
  pendingMainItems?: boolean;
}): React.JSX.Element | null {
  const active = useBtwStore((s) => s.active);
  const collapsed = useBtwStore((s) => s.collapsed);
  const started = useBtwStore((s) => s.started);
  const starting = useBtwStore((s) => s.starting);
  const messages = useBtwStore((s) => s.messages);
  const streaming = useBtwStore((s) => s.streaming);
  const error = useBtwStore((s) => s.error);
  const notice = useBtwStore((s) => s.notice);
  /** BTW 激活期间暂停消费的主线草稿（退出 BTW 后自动注入主 composer） */
  const composerDraft = useAppStore((s) => s.composerDraft);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 滚动跟随状态机：接近底部才自动跟随；用户上滚后暂停；滚回底部恢复 */
  const [followBottom, setFollowBottom] = useState(true);

  // 展开面板时恢复底部跟随（预期用户想看最新内容）
  useEffect(() => {
    if (!collapsed) setFollowBottom(true);
  }, [collapsed]);

  // 新回复出现 / streaming 增量时，仅在接近底部时自动滚底（不打断向上阅读）
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || collapsed) return;
    if (followBottom) el.scrollTop = el.scrollHeight;
  }, [
    messages.length,
    messages[messages.length - 1]?.blocks?.length,
    messages[messages.length - 1]?.finalBlocks?.length,
    collapsed,
    followBottom,
  ]);

  if (!active) return null;

  const close = (): void => useBtwStore.getState().close();
  const toggleCollapsed = (): void => useBtwStore.getState().toggleCollapsed();
  const abort = (): void => useBtwStore.getState().abort();
  const bringBack = (): void => useBtwStore.getState().bringBackToComposer();
  const roundCount = Math.max(1, messages.filter((m) => m.role === "user").length);

  /** 用户滚动时更新跟随状态：距底部 48px 内恢复跟随，上滚则暂停 */
  const handleBodyScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    setFollowBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const statusBar = (
    <div className="btw-status-bar" role="status">
      <span className="btw-status-label">BTW · 临时对话，不进入主线</span>
      {starting && <span className="btw-status-streaming">启动中…</span>}
      {streaming && <span className="btw-status-streaming">生成中…</span>}
      {error && <span className="btw-status-error" title={error}>{error}</span>}
      {composerDraft && (
        <span className="btw-status-pending" title="导入/带回的内容将在退出 BTW 后同步到主输入框">主线草稿待同步</span>
      )}
      {pendingMainItems && (
        <span className="btw-status-pending" title="这些内容属于主线发送；BTW 仅文本">附件/引用待退出 BTW 后随主线发送</span>
      )}
      <span className="input-spacer" />
      {started && (
        <button type="button" className="btw-status-btn" onClick={toggleCollapsed} title={collapsed ? "展开" : "折叠"}>
          {collapsed ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
        </button>
      )}
      <button type="button" className="btw-status-btn" onClick={close} title="关闭并销毁（不保存）" aria-label="关闭 BTW">
        <IconX size={13} />
      </button>
    </div>
  );

  // 未发首轮：只有状态条（输入框上方）
  if (!started) return statusBar;

  // 折叠态：一行摘要条（notice/error/草稿提示同样可见）
  if (collapsed) {
    return (
      <div className="btw-collapsed-bar">
        <button type="button" className="btw-collapsed-main" onClick={toggleCollapsed} title="展开 BTW 面板">
          <span className="btw-status-label">BTW · {roundCount} 轮临时对话 · 不保存</span>
          {starting && <span className="btw-status-streaming">启动中…</span>}
          {streaming && <span className="btw-status-streaming">生成中…</span>}
          {error && <span className="btw-status-error" title={error}>{error}</span>}
          {notice && <span className="btw-panel-notice">{notice}</span>}
          {composerDraft && <span className="btw-status-pending">主线草稿待同步</span>}
          {pendingMainItems && (
            <span className="btw-status-pending" title="这些内容属于主线发送；BTW 仅文本">附件待主线发送</span>
          )}
        </button>
        <span className="input-spacer" />
        <button type="button" className="btw-status-btn" onClick={toggleCollapsed} title="展开" aria-label="展开 BTW 面板">
          <IconChevronUp size={13} />
        </button>
        <button type="button" className="btw-status-btn" onClick={close} title="关闭并销毁（不保存）" aria-label="关闭 BTW">
          <IconX size={13} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="btw-panel"
      onKeyDown={(e) => {
        // 仅 BTW 面板语境内的 Esc 关闭；更高层 overlay 打开时让事件继续传播
        // （由弹层自行关闭），保证一次 Esc 只关一层
        if (e.key === "Escape") {
          if (overlayOpen) return;
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="btw-panel-header">
        <span className="btw-panel-title">BTW</span>
        <span className="btw-panel-sub">临时问答 · 不影响主对话</span>
        {streaming && (
          <button type="button" className="btw-stop-btn" onClick={abort} title="停止 BTW 生成">
            <IconStop size={12} /> 停止
          </button>
        )}
        <span className="input-spacer" />
        {error && <span className="btw-status-error" title={error}>{error}</span>}
        {notice && <span className="btw-panel-notice">{notice}</span>}
        <button type="button" className="btw-status-btn" onClick={toggleCollapsed} title="折叠" aria-label="折叠 BTW 面板">
          <IconChevronDown size={14} />
        </button>
        <button type="button" className="btw-status-btn" onClick={close} title="关闭并销毁（不保存）" aria-label="关闭 BTW">
          <IconX size={14} />
        </button>
      </div>
      <div className="btw-panel-body" ref={bodyRef} onScroll={handleBodyScroll}>
        {messages.map((msg) => (
          <MessageItem key={msg.id} message={msg} btw />
        ))}
        {streaming && (
          <div className="btw-streaming-hint">正在生成…（BTW 为临时只读会话，不进入主线）</div>
        )}
      </div>
      <div className="btw-panel-footer">
        <span className="btw-footer-hint">默认只读 · 关闭即销毁</span>
        <span className="input-spacer" />
        <button
          type="button"
          className="btw-bring-back-btn"
          onClick={bringBack}
          title="把最后一条有效结论填入主输入框（可编辑后发送，不直接写入主对话）"
        >
          带回主线
        </button>
      </div>
    </div>
  );
}
