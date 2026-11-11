/** Mounted React behavior with controlled IPC receipts. No real account or network. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
const { window, document } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(document, "oninput", { configurable: true, value: null });
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(yes => { resolve = yes; });
  return { promise, resolve };
}
const ok = (data: any) => ({ ok: true, data, checkedAt: Date.now() });
const calls = { status: 0, search: 0, read: [] as string[], calendar: [] as any[] };
let statusRequest = deferred(), searchRequest = deferred(), bodyRequest = deferred(), calendarRequest = deferred();
Object.assign(window, { api: { googleWorkspace: {
  status: () => { calls.status++; return statusRequest.promise; },
  searchMail: () => { calls.search++; return searchRequest.promise; },
  readMail: ({ id }: { id: string }) => { calls.read.push(id); return bodyRequest.promise; },
  listEvents: (args: any) => { calls.calendar.push(args); return calendarRequest.promise; },
} } });
async function main() {
  const { createRoot } = await import("react-dom/client");
  const { default: MailboxPage, eventTime } = await import("../src/renderer/src/components/pages/MailboxPage");
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  const text = () => host.textContent ?? "";
  const button = (label: string) => {
    const match = [...host.querySelectorAll("button")].find(el => el.textContent === label);
    assert.ok(match, `missing button: ${label}`); return match;
  };
  const click = async (label: string) => { await act(async () => { button(label).dispatchEvent(new window.Event("click", { bubbles: true })); }); };
  const submit = async () => { await act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); }); };
  const resolve = async (request: ReturnType<typeof deferred>, data: any) => { await act(async () => { request.resolve(data); }); };
  await act(async () => { root.render(<MailboxPage />); });
  assert.equal(calls.status, 0); assert.equal(calls.search, 0); assert.equal(calls.read.length, 0); assert.equal(calls.calendar.length, 0);
  assert.ok(text().includes("不代表已连接"));
  await click("检查连接"); assert.equal(calls.status, 1);
  await click("Google 日历");
  await resolve(statusRequest, ok({ cliAvailable: true, gmail: { message: "STALE STATUS" }, calendar: { message: "STALE STATUS" } }));
  assert.ok(!text().includes("STALE STATUS"));
  await submit(); assert.equal(calls.calendar[0].days, 7); assert.match(calls.calendar[0].from, /^\d{4}-\d{2}-\d{2}$/);
  await resolve(calendarRequest, ok({ events: [], limited: false, timeZone: "Asia/Shanghai" }));
  assert.ok(text().includes("此范围内没有日程"));
  assert.equal(eventTime({ id: "d", title: "Holiday", start: "2026-11-11", end: "2026-11-13", allDay: true }, "Asia/Shanghai"), "全天 · 2026-11-11 至 2026-11-12");
  assert.equal(eventTime({ id: "d", title: "Holiday", start: "2026-11-11", end: "2026-11-12", allDay: true }, "Asia/Shanghai"), "全天 · 2026-11-11");
  assert.ok(eventTime({ id: "t", title: "Call", start: "2026-11-11T01:00:00Z", end: "2026-11-11T02:00:00Z", allDay: false }, "Asia/Shanghai").includes("09:00"));
  await click("Gmail 邮箱"); await submit();
  await resolve(searchRequest, { ok: false, error: { code: "auth_required", message: "需要登录", nextStep: "请先授权 Gmail" }, checkedAt: Date.now() });
  assert.ok(text().includes("请先授权 Gmail"));
  searchRequest = deferred(); await click("重试");
  const messages = ["one", "two"].map(id => ({ id, subject: id, from: "fixture@example.test", date: "2026-11-11", unread: false }));
  await resolve(searchRequest, ok({ messages, limited: true }));
  assert.ok(text().includes("仅显示部分结果"));
  const clickMail = async (index: number) => { await act(async () => { host.querySelectorAll(".workspace-message")[index].dispatchEvent(new window.Event("click", { bubbles: true })); }); };
  await clickMail(0); const oldBody = bodyRequest; bodyRequest = deferred(); await clickMail(1);
  await resolve(oldBody, ok({ id: "one", text: "STALE BODY", truncated: false }));
  assert.ok(!text().includes("STALE BODY"));
  const html = '<img src="https://tracker.invalid/pixel"><script>alert(1)</script>';
  await resolve(bodyRequest, ok({ id: "two", text: html, truncated: true }));
  assert.ok(text().includes(html)); assert.equal(host.querySelectorAll("img,script").length, 0);
  assert.ok(text().includes("正文已截断"));
  searchRequest = deferred(); await submit(); await click("Google 日历");
  await resolve(searchRequest, ok({ messages: [{ ...messages[0], subject: "STALE SEARCH" }], limited: false }));
  await click("Gmail 邮箱"); assert.ok(!text().includes("STALE SEARCH"));
  // Editing the query invalidates both the pending list and selected body.
  searchRequest = deferred(); await submit();
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "new query");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await resolve(searchRequest, ok({ messages: [{ ...messages[0], subject: "STALE EDIT" }], limited: false }));
  assert.ok(!text().includes("STALE EDIT"));
  searchRequest = deferred(); await submit(); await act(async () => { root.unmount(); });
  await resolve(searchRequest, ok({ messages, limited: false })); assert.equal(host.childNodes.length, 0);
  console.log("PASS Google Workspace UI: explicit reads, errors/retry, stale tab/query/selection/unmount, safe text, Shanghai/all-day");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
