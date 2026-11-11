import { useEffect, useRef, useState } from "react";
import type { GoogleWorkspaceResult, GoogleWorkspaceStatus, GoogleMailSummary, GoogleCalendarEvent } from "@shared/google-workspace";
import type { GoogleWorkspaceWriteResult, GoogleWrittenEvent, GoogleCreateEventRequest, GoogleUpdateEventRequest } from "@shared/google-workspace-write";
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
  const writer = useWorkspaceWriter();
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
    <div className="page-sub">通过本机 Google 授权连接 Gmail 和 Google Calendar</div>
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
    <div className="workspace-heading"><button className="btn" disabled={!!writer.draft} onClick={() => writer.open("mail")}>撰写邮件</button><button className="btn" disabled={!!writer.draft} onClick={() => writer.open("event")}>新建日程</button></div>
    <WorkspaceWriter writer={writer} />
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
      {calendar.result?.ok && <><p className="workspace-note">显示时区：{calendar.result.data.timeZone}</p>{events.length === 0 && <p>此范围内没有日程。</p>}{calendar.result.data.limited && <p className="workspace-note">仅显示部分日程，请缩小日期范围。</p>}{events.map(event => <article className="workspace-panel" key={event.id}><h3>{event.title || "（无标题）"}</h3><button className="btn" disabled={!!writer.draft} onClick={() => writer.edit(event.id)}>编辑日程</button><p>{eventTime(event, calendar.result?.ok ? calendar.result.data.timeZone : "Asia/Shanghai")}</p>{event.location && <p>地点：{event.location}</p>}{event.description && <p className="workspace-event-description">{event.description}</p>}</article>)}</>}
    </section>}
    <p className="workspace-note workspace-footer">发送邮件或保存日程会实际修改 Google 账户。填写草稿、查询和取消不会发送；请以实际回执为准。</p>
  </div></div>;
}

function workspaceWriteApi() {
  if (!window.api?.googleWorkspaceWrite) throw new Error("Google Workspace write IPC unavailable");
  return window.api.googleWorkspaceWrite;
}

type DraftFields = { to: string; cc: string; subject: string; body: string; title: string; start: string; end: string; allDay: boolean; timeZone: string; description: string; location: string; attendees: string; notifyAttendees: boolean };
type WriteDraft = { kind: "mail" | "event"; fields: DraftFields; operationId: string; base?: GoogleWrittenEvent; editId?: string; busy?: boolean; loading?: boolean; error?: string; result?: GoogleWorkspaceWriteResult<{ id: string }>; conflict?: boolean };
// Keep an unresolved intent across page navigation. Never persist message content to disk.
let retainedDraft: WriteDraft | null = null;
let writeGeneration = 0;
const writeListeners = new Set<(draft: WriteDraft | null) => void>();
const blankFields = (): DraftFields => ({ to: "", cc: "", subject: "", body: "", title: "", start: "", end: "", allDay: false, timeZone: "Asia/Shanghai", description: "", location: "", attendees: "", notifyAttendees: false });
const operationId = () => crypto.randomUUID();
function addresses(value: string): string[] {
  if (!value.trim()) return [];
  const values = value.split(/[,;\n]/).map(item => item.trim());
  if (values.some(item => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(item))) throw new Error("请输入有效邮箱地址，多个地址用逗号分隔。");
  return [...new Set(values)];
}
function fieldsFor(event: GoogleWrittenEvent): DraftFields {
  return { ...blankFields(), title: event.title, start: event.start, end: event.end, allDay: event.allDay, timeZone: event.timeZone || "Asia/Shanghai", description: event.description || "", location: event.location || "", attendees: event.attendees.join(", ") };
}
const eventKeys = ["title", "start", "end", "allDay", "timeZone", "description", "location", "attendees"] as const;
function useWorkspaceWriter() {
  const [draft, render] = useState<WriteDraft | null>(retainedDraft);
  useEffect(() => { writeListeners.add(render); render(retainedDraft); return () => { writeListeners.delete(render); }; }, []);
  const set = (value: WriteDraft | null) => { retainedDraft = value; for (const listener of writeListeners) listener(value); };
  const open = (kind: WriteDraft["kind"]) => { if (retainedDraft) return; writeGeneration++; set({ kind, fields: blankFields(), operationId: operationId() }); };
  const dismiss = () => { if (retainedDraft?.busy) return; writeGeneration++; set(null); };
  const change = <K extends keyof DraftFields>(key: K, value: DraftFields[K]) => {
    const current = retainedDraft;
    if (!current || current.busy || current.loading || current.result?.ok || (current.result && !current.result.ok && current.result.error.outcome === "unknown")) return;
    set({ ...current, fields: { ...current.fields, [key]: value }, operationId: current.result ? operationId() : current.operationId, result: undefined, error: undefined });
  };
  const load = async (id: string, preserve: boolean) => {
    const previous = retainedDraft;
    if (previous?.busy || previous?.loading) return;
    const generation = ++writeGeneration;
    set({ ...(previous || { kind: "event", fields: blankFields(), operationId: operationId() }), editId: id, loading: true, error: undefined });
    try {
      const result = await workspaceWriteApi().getEvent({ id, calendar: previous?.base?.calendar });
      if (generation !== writeGeneration) return;
      if (!result.ok) { set({ ...retainedDraft!, loading: false, error: `${result.error.message} ${result.error.nextStep || ""}` }); return; }
      const fields = fieldsFor(result.data);
      if (preserve && previous?.base) {
        const old = fieldsFor(previous.base);
        for (const key of eventKeys) if (previous.fields[key] !== old[key]) Object.assign(fields, { [key]: previous.fields[key] });
        fields.notifyAttendees = previous.fields.notifyAttendees;
      }
      set({ kind: "event", fields, editId: id, base: result.data, operationId: operationId(), loading: false });
    } catch { if (generation === writeGeneration) set({ ...retainedDraft!, loading: false, error: "无法读取最新日程，请重新查询。" }); }
  };
  const submit = async () => {
    const current = retainedDraft;
    if (!current || current.busy || current.loading || current.conflict || current.result?.ok || (current.result && !current.result.ok && current.result.error.outcome === "unknown")) return;
    let request: () => Promise<GoogleWorkspaceWriteResult<{ id: string }>>;
    try {
      const f = current.fields;
      if (current.kind === "mail") {
        const to = addresses(f.to), cc = addresses(f.cc);
        if (!to.length || !f.subject.trim() || !f.body.trim()) throw new Error("请填写收件人、主题和正文。");
        if (/[\r\n]/.test(f.subject)) throw new Error("主题不能包含换行。");
        const args = { operationId: current.operationId, to, cc, subject: f.subject, body: f.body };
        request = () => workspaceWriteApi().sendMail(args);
      } else {
        if (current.editId && !current.base) throw new Error("请先读取最新日程。");
        const attendees = addresses(f.attendees);
        if (!f.title.trim() || !f.start || !f.end) throw new Error("请填写标题、开始和结束时间。");
        if (f.allDay) {
          const valid = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
          if (!valid(f.start) || !valid(f.end) || f.end <= f.start) throw new Error("全天日程使用 YYYY-MM-DD，结束日期不包含当天且必须晚于开始日期。");
        } else if (![f.start, f.end].every(v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v))) || Date.parse(f.end) <= Date.parse(f.start)) throw new Error("请输入带时区偏移的时间，结束时间必须晚于开始时间。");
        try { new Intl.DateTimeFormat("en", { timeZone: f.timeZone }); } catch { throw new Error("请输入有效 IANA 时区，例如 Asia/Shanghai。"); }
        if ((attendees.length || current.base?.attendees.length) && !f.notifyAttendees) throw new Error("此日程有参与者，请选择通知参与者后保存。");
        // RFC3339 requires seconds; accept minute-precision typing without sending an invalid API value.
        const timestamp = (value: string) => f.allDay ? value : value.replace(/(T\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/, "$1:00$2");
        const args: GoogleCreateEventRequest = { operationId: current.operationId, title: f.title, start: timestamp(f.start), end: timestamp(f.end), allDay: f.allDay, timeZone: f.timeZone, description: f.description, location: f.location, attendees, notifyAttendees: f.notifyAttendees };
        if (current.base) {
          const update: GoogleUpdateEventRequest = { operationId: current.operationId, id: current.base.id, calendar: current.base.calendar, etag: current.base.etag, notifyAttendees: f.notifyAttendees };
          const old = fieldsFor(current.base);
          let changed = false;
          for (const key of eventKeys) if (f[key] !== old[key]) { Object.assign(update, { [key]: args[key] }); changed = true; }
          if (!changed) throw new Error("尚未修改日程。");
          request = () => workspaceWriteApi().updateEvent(update);
        } else request = () => workspaceWriteApi().createEvent(args);
      }
    } catch (error) { set({ ...current, error: (error as Error).message }); return; }
    const generation = writeGeneration;
    set({ ...current, busy: true, error: undefined, result: undefined });
    let result: GoogleWorkspaceWriteResult<{ id: string }>;
    try { result = await request(); }
    catch { result = { ok: false, error: { code: "unknown_outcome", message: "结果尚未确认，请先查询邮箱/日历核实", outcome: "unknown" }, checkedAt: Date.now() }; }
    if (generation === writeGeneration) set({ ...current, busy: false, result, conflict: !result.ok && result.error.code === "conflict" });
  };
  return { draft, open, dismiss, change, submit, edit: (id: string) => { if (!retainedDraft) void load(id, false); }, reload: () => { if (retainedDraft?.editId) void load(retainedDraft.editId, true); } };
}
function WorkspaceWriter({ writer }: { writer: ReturnType<typeof useWorkspaceWriter> }) {
  const d = writer.draft;
  if (!d) return null;
  const unknown = d.result && !d.result.ok && d.result.error.outcome === "unknown";
  const locked = !!(d.busy || d.loading || d.result?.ok || unknown);
  const input = (key: keyof DraftFields, label: string, placeholder?: string, multiline = false) => <label>{label}{multiline ? <textarea name={key} value={String(d.fields[key])} onChange={e => writer.change(key, e.target.value)} /> : <input type="text" name={key} value={String(d.fields[key])} placeholder={placeholder} onChange={e => writer.change(key, e.target.value)} />}</label>;
  return <form className="workspace-panel workspace-compose" aria-label={d.kind === "mail" ? "撰写邮件" : "编辑日程表单"} onSubmit={e => { e.preventDefault(); void writer.submit(); }}>
    <h3>{d.kind === "mail" ? "撰写邮件" : d.editId ? "编辑日程" : "新建日程"}</h3>
    <fieldset disabled={locked}>
      {d.kind === "mail" ? <>{input("to", "收件人 To（逗号分隔）")}{input("cc", "抄送 Cc（可选）")}{input("subject", "主题")}{input("body", "正文（纯文本）", undefined, true)}</> : <>
        {input("title", "日程标题")}
        <label className="workspace-checkbox"><input name="allDay" type="checkbox" checked={d.fields.allDay} onChange={e => writer.change("allDay", e.target.checked)} />全天</label>
        {input("start", "开始", d.fields.allDay ? "2026-11-11" : "2026-11-11T09:00:00+08:00")}{input("end", d.fields.allDay ? "结束日期（不包含当天）" : "结束", d.fields.allDay ? "2026-11-12" : "2026-11-11T10:00:00+08:00")}{input("timeZone", "时区")}{input("location", "地点（可选）")}{input("description", "描述（纯文本，可选）", undefined, true)}{input("attendees", "邀请参与者邮箱（逗号分隔；编辑时保留现有名单）")}
        <label className="workspace-checkbox"><input name="notifyAttendees" type="checkbox" checked={d.fields.notifyAttendees} onChange={e => writer.change("notifyAttendees", e.target.checked)} />通知参与者：发送邀请或日程变更通知（包括被移除的参与者）</label>
      </>}
    </fieldset>
    {d.loading && <p role="status">正在读取最新日程…</p>}
    {d.busy && <p role="status">正在提交，请勿重复操作。离开页面不会撤销提交。</p>}
    {d.error && <p role="alert">{d.error}</p>}
    {d.result?.ok && <p role="status">{d.kind === "mail" ? "邮件已发送" : "日程已保存"} · ID：{d.result.data.id}</p>}
    {d.result && !d.result.ok && <div role="alert"><p>{unknown ? "结果尚未确认，请先查询邮箱/日历核实" : d.result.error.message}</p>{d.result.error.nextStep && <p>{d.result.error.nextStep}</p>}</div>}
    {d.conflict && <button className="btn" type="button" disabled={d.loading} onClick={writer.reload}>重新读取最新日程（保留修改）</button>}
    {!!d.editId && !d.base && !d.loading && <button className="btn" type="button" onClick={writer.reload}>重新读取日程</button>}
    <div className="workspace-heading"><button className="btn primary" disabled={locked || d.conflict || (!!d.editId && !d.base)}>{d.kind === "mail" ? "发送邮件" : d.editId ? "保存日程修改" : "创建日程"}</button><button type="button" className="btn" disabled={d.busy} onClick={writer.dismiss}>{unknown ? "关闭待核实草稿" : d.result?.ok ? "完成" : "取消"}</button></div>
  </form>;
}
