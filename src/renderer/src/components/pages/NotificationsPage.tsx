import { useEffect, useRef, useState } from "react";
import {
  IconAlert, IconBell, IconCheck, IconChevronLeft, IconChevronRight, IconClock, IconFolderKanban,
  IconSearch, IconSettingsGear, IconTrash, IconZap, type IconProps,
} from "@/components/common/icons";
import { useDesktopNavigate } from "@/components/desktop/DesktopSection";
import { useAppStore } from "@/store/appStore";
import { notificationTarget, type NotificationDto, type NotificationListRequest, type NotificationType } from "@shared/notification";
import "./notifications-page.css";

const PAGE_SIZE = 50;
const TYPES = {
  "task.completed": { label: "任务完成", icon: IconCheck },
  "task.failed": { label: "任务失败", icon: IconAlert },
  "task.action_required": { label: "待处理", icon: IconAlert },
  "reminder.due": { label: "到期提醒", icon: IconClock },
  "automation.completed": { label: "自动化完成", icon: IconZap },
  "automation.failed": { label: "自动化失败", icon: IconZap },
  "project.attention": { label: "项目提醒", icon: IconFolderKanban },
  "runtime.failed": { label: "运行异常", icon: IconAlert },
} satisfies Record<NotificationType, { label: string; icon: (props: IconProps) => React.JSX.Element }>;

const CATEGORIES = [
  { label: "全部", types: undefined },
  { label: "待处理", types: ["task.action_required"] },
  { label: "任务", types: ["task.completed", "task.failed", "task.action_required"] },
  { label: "自动化", types: ["automation.completed", "automation.failed", "reminder.due"] },
  { label: "项目", types: ["project.attention"] },
  { label: "系统", types: ["runtime.failed"] },
] as const satisfies readonly { label: string; types?: readonly NotificationType[] }[];

const timeFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
type Cursor = NonNullable<NotificationListRequest["before"]>;

export default function NotificationsPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const navigate = useDesktopNavigate();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>(CATEGORIES[0]);
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const api = window.api?.notification;
  const before = cursors.at(-1);

  useEffect(() => {
    if (!api) {
      setError("通知服务暂不可用");
      return;
    }
    let disposed = false;
    let revision = 0;
    const refresh = (knownUnread?: number) => {
      const current = ++revision;
      if (knownUnread !== undefined) setUnread(knownUnread);
      void Promise.all([
        api.list({ types: category.types, unreadOnly, query, before, limit: PAGE_SIZE + 1 }),
        knownUnread === undefined ? api.unreadCount() : knownUnread,
      ]).then(([rows, count]) => {
        if (disposed || revision !== current) return;
        setItems(rows);
        setUnread(count);
      }).catch(() => {
        if (!disposed && revision === current) setError("加载通知失败，请重试");
      });
    };
    const unsubscribe = api.onChanged(event => refresh(event.unreadCount));
    refresh();
    return () => { disposed = true; unsubscribe(); };
  }, [api, before, category, query, reload, unreadOnly]);

  const changePage = (next: Cursor[]) => {
    setCursors(next);
    setItems(null);
    setError(null);
    setConfirmClear(false);
    list.current?.scrollTo(0, 0);
  };
  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const rows = items?.slice(0, PAGE_SIZE) ?? [];
  const hasNext = (items?.length ?? 0) > PAGE_SIZE;
  const reset = () => {
    setCategory(CATEGORIES[0]);
    setUnreadOnly(false);
    setQuery("");
    changePage([]);
  };

  return <section id="desktop-notifications" className="notifications-page" aria-labelledby="notifications-title">
    <header className="notifications-header">
      <div className="notifications-title">
        <button type="button" className="icon-btn" aria-label="返回上一模块" title="返回上一模块" onClick={onBack}><IconChevronLeft size={18} /></button>
        <h1 id="notifications-title">通知中心</h1>
      </div>
      <div className="notifications-actions">
        <label className="notifications-search">
          <IconSearch size={15} />
          <input aria-label="搜索通知" placeholder="搜索标题或正文" value={query} maxLength={160}
            onChange={event => { changePage([]); setQuery(event.target.value); }} />
        </label>
        <button type="button" className="notifications-control" disabled={!api || !unread || busy}
          onClick={() => { if (api) void mutate(api.markAllRead); }}><IconCheck size={15} /> 全部已读</button>
        <button type="button" className="icon-btn" title="通知设置" aria-label="通知设置"
          onClick={() => void navigate?.(() => useAppStore.getState().setSettingsOpen(true, "notifications"))}><IconSettingsGear size={16} /></button>
        <button type="button" className="icon-btn" title="清空通知" aria-label="清空通知" disabled={!api || busy}
          onClick={() => setConfirmClear(value => !value)}><IconTrash size={16} /></button>
      </div>
    </header>
    <div className="notifications-toolbar">
      <div className="notifications-categories" role="group" aria-label="通知分类">
        {CATEGORIES.map(item => <button key={item.label} type="button" aria-pressed={category === item}
          onClick={() => { if (item !== category) { changePage([]); setCategory(item); } }}>{item.label}</button>)}
      </div>
      <button type="button" className="notifications-control" aria-pressed={unreadOnly}
        onClick={() => { changePage([]); setUnreadOnly(!unreadOnly); }}>仅未读 <span>{unread}</span></button>
    </div>
    {confirmClear && <div className="notifications-feedback" role="group" aria-label="清空通知确认">
      <span>清空所有已读和未读通知？</span>
      <button type="button" className="notifications-control" onClick={() => setConfirmClear(false)}>取消</button>
      <button type="button" className="notifications-control notifications-danger" disabled={busy}
        onClick={() => {
          setConfirmClear(false);
          if (api) void mutate(api.dismissAll);
        }}>确认清空</button>
    </div>}
    {error && <div className="notifications-feedback" role="alert">
      <span>{error}</span><button type="button" className="notifications-control"
        onClick={() => { setError(null); setReload(value => value + 1); }}>重试加载</button>
    </div>}
    <div className="notifications-list" ref={list} aria-label="通知列表" aria-busy={items === null && !error}>
      {items === null ? !error && <p className="notifications-empty" role="status">正在加载通知…</p> : rows.length === 0 ?
        <div className="notifications-empty"><IconBell size={26} />
          <p>{query || category.types ? "没有符合条件的通知" : unreadOnly ? "没有未读通知" : "暂无通知"}</p>
          {(query || category.types || unreadOnly) && <button type="button" className="notifications-control" onClick={reset}>查看全部</button>}
        </div> : <ul>{rows.map(item => {
          const meta = TYPES[item.type] ?? { label: "通知", icon: IconBell };
          const Icon = meta.icon;
          const contents = <>
            <span className="notifications-indicator" aria-label={item.readAt == null ? "未读" : undefined} />
            <span className="notifications-type-icon" aria-hidden="true"><Icon size={17} /></span>
            <span className="notifications-copy">
              <strong>{item.title}</strong>
              {item.body && <span className="notifications-body">{item.body}</span>}
              <span className="notifications-meta">
                <span className="notifications-type">{meta.label}</span>
                <time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString("zh-CN")}>{timeFormat.format(item.createdAt)}</time>
              </span>
            </span>
          </>;
          const target = notificationTarget(item);
          return <li key={item.id} className="notifications-row" data-level={item.level} data-unread={item.readAt == null}>
            {target ? <button type="button" className="notifications-open"
              onClick={() => { if (api) void api.activate(item.id).catch(cause => setError(String(cause))); }}>{contents}<IconChevronRight size={15} /></button> :
              <div className="notifications-open">{contents}</div>}
            <div className="notifications-row-actions">
              {item.readAt == null && <button type="button" className="icon-btn" aria-label={`标为已读：${item.title}`} title="标为已读" disabled={busy}
                onClick={() => { if (api) void mutate(() => api.markRead(item.id)); }}><IconCheck size={15} /></button>}
              <button type="button" className="icon-btn" aria-label={`删除通知：${item.title}`} title="删除通知" disabled={busy}
                onClick={() => { if (api) void mutate(() => api.dismiss(item.id)); }}><IconTrash size={15} /></button>
            </div>
          </li>;
        })}</ul>}
    </div>
    {(cursors.length > 0 || hasNext) && <footer className="notifications-pagination" aria-label="通知分页">
      <button type="button" className="notifications-control" disabled={!cursors.length || items === null} onClick={() => changePage(cursors.slice(0, -1))}><IconChevronLeft size={14} /> 上一页</button>
      <span>第 {cursors.length + 1} 页</span>
      <button type="button" className="notifications-control" disabled={!hasNext} onClick={() => {
        const last = rows.at(-1);
        if (last) changePage([...cursors, { createdAt: last.createdAt, id: last.id }]);
      }}>下一页 <IconChevronRight size={14} /></button>
    </footer>}
  </section>;
}
