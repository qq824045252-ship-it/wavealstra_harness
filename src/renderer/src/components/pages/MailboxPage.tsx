import { useEffect, useRef, useState } from "react";
import type { GoogleWorkspaceResult, GoogleWorkspaceStatus, GoogleMailSummary, GoogleCalendarEvent } from "@shared/google-workspace";
import "./MailboxPage.css";

function workspaceApi() {
  if (!window.api?.googleWorkspace) throw new Error("Google Workspace IPC unavailable");
  return window.api.googleWorkspace;
}

type Receipt<T> = { loading: boolean; result?: GoogleWorkspaceResult<T> };
/** Every request belongs to a view generation. Editing, switching and leaving invalidate it. */
function useReceipt<T>() {
  const generation = useRef(0);
  const [receipt, setReceipt] = useState<Receipt<T>>({ loading: false });
  useEffect(() => () => { generation.current++; }, []);
  const clear = () => { generation.current++; setReceipt({ loading: false }); };
  const run = async (request: () => Promise<GoogleWorkspaceResult<T>>) => {
    const current = ++generation.current;
    setReceipt({ loading: true });
    let result: GoogleWorkspaceResult<T>;
    try { result = await request(); }
    catch { result = { ok: false, error: { code: "service_error", message: "请求未完成，请检查本地服务后重试。" }, checkedAt: Date.now() }; }
    if (current === generation.current) setReceipt({ loading: false, result });
  };
  return { ...receipt, run, clear };
}
function ReceiptState<T>({ receipt, retry }: { receipt: Receipt<T>; retry: () => void }) {
  if (receipt.loading) return <p role="status">正在等待 gws 查询结果…</p>;
  const result = receipt.result;
  if (!result) return null;
  if (!result.ok) return <div className="workspace-error" role="alert"><p>{result.error.message}</p>{result.error.nextStep && <p>{result.error.nextStep}</p>}<button className="btn" onClick={retry}>重试</button></div>;
  return <p className="workspace-note" role="status">查询已返回 · {new Date(result.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（上海时间）</p>;
}
function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
export function eventTime(event: GoogleCalendarEvent, timeZone: string): string {
  if (event.allDay) {
    // Google uses an exclusive end date for all-day events. Never shift via local time.
    const last = new Date(`${event.end.slice(0, 10)}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    const end = Number.isNaN(last.getTime()) ? "" : last.toISOString().slice(0, 10);
    return `全天 · ${event.start.slice(0, 10)}${end && end !== event.start.slice(0, 10) ? ` 至 ${end}` : ""}`;
  }
  const format = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  };
  return `${format(event.start)} – ${format(event.end)}`;
}
export default function MailboxPage(): React.JSX.Element {
  const [tab, setTab] = useState<"mail" | "calendar">("mail");
  const [query, setQuery] = useState("in:inbox");
  const [from, setFrom] = useState(todayShanghai);
  const [days, setDays] = useState(7);
  const [selected, setSelected] = useState<GoogleMailSummary | null>(null);
  const status = useReceipt<GoogleWorkspaceStatus>();
  const mail = useReceipt<{ messages: GoogleMailSummary[]; limited: boolean }>();
  const body = useReceipt<{ id: string; text: string; truncated: boolean }>();
  const calendar = useReceipt<{ events: GoogleCalendarEvent[]; limited: boolean; timeZone: string }>();
  const check = () => { void status.run(() => workspaceApi().status()); };
  const search = () => { body.clear(); setSelected(null); void mail.run(() => workspaceApi().searchMail({ query, limit: 20 })); };
  const read = (message: GoogleMailSummary) => { setSelected(message); void body.run(() => workspaceApi().readMail({ id: message.id })); };
  const list = () => { void calendar.run(() => workspaceApi().listEvents({ from, days })); };
  const switchTab = (next: typeof tab) => { status.clear(); mail.clear(); body.clear(); calendar.clear(); setSelected(null); setTab(next); };
  const messages = mail.result?.ok ? mail.result.data.messages : [];
  const events = calendar.result?.ok ? calendar.result.data.events : [];
  return <div className="page-scroll"><div className="page-container workspace-page">
    <div className="page-title">邮箱和日历</div>
    <div className="page-sub">通过本机 gws 读取 Gmail 和 Google Calendar</div>
    <section className="workspace-panel" aria-label="连接检查">
      <div className="workspace-heading"><strong>Google Workspace</strong><button className="btn" disabled={status.loading} onClick={check}>检查连接</button></div>
      <p className="workspace-note">安装 gws 不代表已连接。此页不会自动登录或读取账户；点击检查或查询后，以实际返回结果为准。</p>
      <ReceiptState receipt={status} retry={check} />
      {status.result?.ok && <><p>gws：{status.result.data.cliAvailable ? "已找到" : "未找到"}</p><p>Gmail：{status.result.data.gmail.message}</p><p>日历：{status.result.data.calendar.message}</p></>}
    </section>
    <div className="workspace-tabs" role="tablist" aria-label="邮箱与日历">
      <button id="workspace-mail-tab" role="tab" aria-selected={tab === "mail"} aria-controls="workspace-mail" className={`btn ${tab === "mail" ? "primary" : ""}`} onClick={() => switchTab("mail")}>Gmail 邮箱</button>
      <button id="workspace-calendar-tab" role="tab" aria-selected={tab === "calendar"} aria-controls="workspace-calendar" className={`btn ${tab === "calendar" ? "primary" : ""}`} onClick={() => switchTab("calendar")}>Google 日历</button>
    </div>
    {tab === "mail" ? <section id="workspace-mail" role="tabpanel" aria-labelledby="workspace-mail-tab">
      <form className="workspace-query" onSubmit={e => { e.preventDefault(); search(); }}><label>搜索邮件<input type="search" value={query} placeholder="in:inbox 或 from:person@example.com" onChange={e => { setQuery(e.target.value); mail.clear(); body.clear(); setSelected(null); }} /></label><button className="btn primary" disabled={mail.loading || !query.trim()}>查询邮件</button></form>
      <ReceiptState receipt={mail} retry={search} />
      {!mail.result && !mail.loading && <p className="workspace-note">输入 Gmail 搜索条件并查询。只读取邮件，不会修改已读状态。</p>}
      {mail.result?.ok && messages.length === 0 && <p>没有符合条件的邮件。</p>}
      {mail.result?.ok && mail.result.data.limited && <p className="workspace-note">仅显示部分结果，请缩小搜索范围。</p>}
      <div className="workspace-mail-grid"><div className="workspace-mail-list">{messages.map(message => <button key={message.id} className={`workspace-message ${selected?.id === message.id ? "selected" : ""}`} aria-pressed={selected?.id === message.id} onClick={() => read(message)}><strong>{message.unread ? "未读 · " : ""}{message.subject || "（无主题）"}</strong><span>{message.from}</span><span>{message.date}</span></button>)}</div>
        {selected && <article className="workspace-panel workspace-mail-body" aria-label="邮件正文"><h3>{selected.subject || "（无主题）"}</h3><p className="workspace-note">{selected.from} · {selected.date}</p><ReceiptState receipt={body} retry={() => read(selected)} />{body.result?.ok && <><pre>{body.result.data.text || "（无可显示正文）"}</pre>{body.result.data.truncated && <p className="workspace-note">正文已截断。</p>}</>}</article>}
      </div>
    </section> : <section id="workspace-calendar" role="tabpanel" aria-labelledby="workspace-calendar-tab">
      <form className="workspace-query" onSubmit={e => { e.preventDefault(); list(); }}><label>开始日期<input type="date" required value={from} onChange={e => { setFrom(e.target.value); calendar.clear(); }} /></label><label>范围<select value={days} onChange={e => { setDays(Number(e.target.value)); calendar.clear(); }}><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option></select></label><button className="btn primary" disabled={calendar.loading || !from}>查询日程</button></form>
      <p className="workspace-note">日期按 Asia/Shanghai（上海时间）查询；默认主日历。</p>
      <ReceiptState receipt={calendar} retry={list} />
      {!calendar.result && !calendar.loading && <p className="workspace-note">选择日期范围后查询日程。</p>}
      {calendar.result?.ok && <><p className="workspace-note">显示时区：{calendar.result.data.timeZone}</p>{events.length === 0 && <p>此范围内没有日程。</p>}{calendar.result.data.limited && <p className="workspace-note">仅显示部分日程，请缩小日期范围。</p>}{events.map(event => <article className="workspace-panel" key={event.id}><h3>{event.title || "（无标题）"}</h3><p>{eventTime(event, calendar.result?.ok ? calendar.result.data.timeZone : "Asia/Shanghai")}</p>{event.location && <p>地点：{event.location}</p>}{event.description && <p className="workspace-event-description">{event.description}</p>}</article>)}</>}
    </section>}
    <p className="workspace-note workspace-footer">需要起草邮件或创建日程？请在对话中说明具体需求，并以工具实际回执为准。当前 gws 不支持发送邮件；本页仅提供只读查询。</p>
  </div></div>;
}
