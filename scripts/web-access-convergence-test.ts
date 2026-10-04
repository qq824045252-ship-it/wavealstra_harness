/**
 * WebAccess/Browser 架构收敛测试（A：PageInspectionService；B：WebResourceResolver）。
 * 纯 node（无 Electron；DebuggerLike/PageWebContentsLike 全部 mock 注入）。
 * 必须经 scripts/test-guard.mjs 执行。
 */
import {
  PageInspectionService,
  type DebuggerLike,
  type PageWebContentsLike,
} from "../src/main/artifact/PageInspectionService";
import {
  isBrowserPageMatch,
  normalizePageUrl,
  resolveWebFetchStrategy,
} from "../src/main/browser/WebResourceResolver";
import { BrowserContentService } from "../src/main/browser/BrowserContentService";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

// ---------- Mock Debugger ----------
class MockDebugger implements DebuggerLike {
  attached = false;
  commands: string[] = [];
  messageListeners: Array<(event: unknown, method: string, params: unknown) => void> = [];
  detachListeners: Array<(event: unknown, reason: string) => void> = [];

  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  isAttached(): boolean {
    return this.attached;
  }
  async sendCommand(method: string): Promise<unknown> {
    this.commands.push(method);
    if (method === "DOM.getOuterHTML") return { outerHTML: "<div id='x' class='a b'>hello world</div>" };
    if (method === "DOM.describeNode") return { node: { nodeId: 7, localName: "div", attributes: ["id", "x", "class", "a b"] } };
    if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    return {};
  }
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    if (event === "message") this.messageListeners.push(listener as never);
    if (event === "detach") this.detachListeners.push(listener as never);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void): unknown {
    if (event === "message") this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    if (event === "detach") this.detachListeners = this.detachListeners.filter((l) => l !== listener);
    return this;
  }
  removeAllListeners(): unknown {
    this.messageListeners = [];
    this.detachListeners = [];
    return this;
  }
  emitDetach(reason: string): void {
    for (const l of this.detachListeners) l(null, reason);
  }
  emitMessage(method: string, params: unknown): void {
    for (const l of this.messageListeners) l(null, method, params);
  }
}

function makeWc(
  dbg: DebuggerLike,
  pageText = "rendered body text",
  url = "https://example.com/page",
  destroyed = false,
): PageWebContentsLike {
  return {
    debugger: dbg,
    executeJavaScript: async (code: string) => (code.includes("body") ? pageText : "Example"),
    getURL: () => url,
    isDestroyed: () => destroyed,
  };
}

async function main(): Promise<void> {
  console.log("== A. PageInspectionService：attach/detach/生命周期 ==");
  {
    const svc = new PageInspectionService();
    const dbg = new MockDebugger();
    const wc = makeWc(dbg);

    const s1 = svc.acquire(wc, "test-a");
    assert(s1.isAttached === false, "acquire 后未 attach");
    await s1.attach(dbg);
    assert(s1.isAttached && dbg.isAttached(), "attach 成功");
    assert(
      dbg.commands.filter((m) => ["DOM.enable", "CSS.enable", "Overlay.enable"].includes(m)).length === 3,
      "enable DOM/CSS/Overlay",
    );

    const s2 = svc.acquire(wc, "test-a");
    assert(s1 === s2, "同 owner 重复 acquire 返回同一 session（防双 attach）");
    assert(svc.sessionCount === 1, "session 计数 1");

    await s2.attach(dbg);
    assert(dbg.commands.filter((m) => m === "DOM.enable").length === 1, "重复 attach 幂等");

    let detachedReason: string | null = null;
    s2.onDetached = (r) => (detachedReason = r);
    dbg.emitDetach("target_closed");
    assert(detachedReason === "target_closed" && s2.isAttached === false, "detach 事件通知 + 状态清理");

    svc.release(wc, "test-a");
    assert(svc.sessionCount === 0, "正确 owner release 后计数 0");
    const s3 = svc.acquire(wc, "test-c");
    assert(s3 !== s1 && !s3.isDisposed, "release 后可重新 acquire 新 session（新 owner）");
    svc.release(wc, "test-c");
  }

  console.log("== A. PageInspectionService：disposed 拒绝 + inspect/selection ==");
  {
    const svc = new PageInspectionService();
    const dbg = new MockDebugger();
    const wc = makeWc(dbg);
    const s = svc.acquire(wc, "test-d");
    s.dispose();
    let rejected = false;
    try {
      await s.attach(dbg);
    } catch {
      rejected = true;
    }
    assert(rejected, "disposed session 拒绝 attach");

    const s2 = svc.acquire(wc, "test-e");
    await s2.attach(dbg);
    await s2.setInspectMode();
    assert(dbg.commands.some((m) => m === "Overlay.setInspectMode"), "setInspectMode 开启");
    let selection: unknown = null;
    s2.onSelection = (p) => (selection = p);
    dbg.emitMessage("Overlay.inspectNodeRequested", { backendNodeId: 3 });
    await new Promise((r) => setTimeout(r, 10));
    assert(selection !== null, "inspectNodeRequested → selection 解析");
    if (selection) {
      const sel = selection as { tagName: string; text: string };
      assert(sel.tagName === "div" && sel.text.includes("hello world"), "selection 含 tagName/text");
    }
    svc.release(wc);
  }

  console.log("== A. PageInspectionService：页面快照 ==");
  {
    const svc = new PageInspectionService();
    const wc = makeWc(new MockDebugger(), "  rendered   body   text  ", "https://example.com/page");
    const snap = await svc.getPageSnapshot(wc);
    assert(snap !== null && snap.url === "https://example.com/page", "快照 URL");
    assert(snap !== null && snap.text.includes("rendered"), "快照正文");
    assert(snap !== null && snap.title === "Example", "快照 title");
    const destroyed = makeWc(new MockDebugger(), "", "https://x.com", true);
    assert((await svc.getPageSnapshot(destroyed)) === null, "已销毁 wc → null");
  }

  console.log("== A. PageInspectionService：owner 语义（P2-2） ==");
{
  const svc = new PageInspectionService();
  const dbg = new MockDebugger();
  const wc = makeWc(dbg);

  const sA = svc.acquire(wc, "owner-a");
  const sA2 = svc.acquire(wc, "owner-a");
  assert(sA === sA2, "同 owner 重复 acquire 幂等");
  assert(svc.ownerOf(wc) === "owner-a", "owner 记录正确");

  // 不同 owner 冲突 → 拒绝
  let conflict = false;
  try {
    svc.acquire(wc, "owner-b");
  } catch (e) {
    conflict = e instanceof Error && e.message.includes("owner-a");
  }
  assert(conflict, "不同 owner 冲突 → 明确拒绝（防双 owner 踩踏）");

  // 错误 release（owner 不匹配）→ 不删除 B 的 session
  let warned = false;
  const origWarn = console.warn;
  console.warn = () => {
    warned = true;
  };
  svc.release(wc, "owner-b");
  console.warn = origWarn;
  assert(svc.sessionCount === 1 && warned, "错误 owner release → warn 且不误删他人 session");

  // 正确 release → 清空；之后可重新 acquire
  svc.release(wc, "owner-a");
  assert(svc.sessionCount === 0, "正确 owner release 清空");
  const sC = svc.acquire(wc, "owner-c");
  assert(sC !== sA && !sC.isDisposed, "release 后新 owner 可 acquire");
  svc.release(wc, "owner-c");

  // destroyed 语义：detach 事件后业务方 release（此处直接模拟回收路径）
  const sD = svc.acquire(wc, "owner-d");
  await sD.attach(dbg);
  dbg.emitDetach("target_closed");
  assert(sD.isAttached === false, "detach 事件后 session 状态清理");
  svc.release(wc, "owner-d");
  assert(svc.sessionCount === 0, "destroyed/detach 后可靠回收");
}

console.log("== P2-导航竞态：BrowserContentService.tryBrowserReuse 二次 URL 校验 ==");
{


  // 模拟：首次匹配基于 host.url=pageA；快照读取时导航到 pageB（getURL 返回 pageB）
  let currentSnapshotUrl = "https://example.com/pageB";
  const fakeHost = {
    url: "https://example.com/pageA",
    inspectionWebContents: {
      debugger: new MockDebugger(),
      executeJavaScript: async () => "pageB body",
      getURL: () => currentSnapshotUrl,
      isDestroyed: () => false,
    },
  };
  const svc = new BrowserContentService(() => fakeHost as never);
  const r1 = await svc.tryBrowserReuse("https://example.com/pageA", true);
  assert(r1.strategy === "browser-reuse" && r1.page === null, "导航竞态：快照 URL 与请求不一致 → page:null（降级 HTTP）");
  // 无竞态：快照 URL 与请求一致 → 返回 page
  currentSnapshotUrl = "https://example.com/pageA";
  const r2 = await svc.tryBrowserReuse("https://example.com/pageA", true);
  assert(r2.page !== null && r2.page.url === "https://example.com/pageA", "无竞态：快照 URL 匹配 → 返回浏览器内容");
  // 开关关闭 → http-fetch
  const r3 = await svc.tryBrowserReuse("https://example.com/pageA", false);
  assert(r3.strategy === "http-fetch" && r3.page === null, "开关关闭 → http-fetch");
}
console.log("== B. WebResourceResolver：策略与 URL 匹配 ==");
  {
    assert(isBrowserPageMatch("https://example.com/page", "https://example.com/page") === true, "同 URL 命中");
    assert(isBrowserPageMatch("https://example.com/page#section", "https://example.com/page") === true, "hash 忽略");
    assert(isBrowserPageMatch("https://example.com/page?q=1", "https://example.com/page?q=2") === false, "query 不同不命中（保守）");
    assert(isBrowserPageMatch("https://example.com/other", "https://example.com/page") === false, "路径不同不命中");
    assert(isBrowserPageMatch("https://evil.com/page", "https://example.com/page") === false, "跨源不命中");
    assert(normalizePageUrl("https://a.com/x#h").endsWith("#h") === false, "normalize 去 hash");

    assert(resolveWebFetchStrategy({ url: "https://example.com/page", browserUrl: "https://example.com/page", browserReuseEnabled: true }) === "browser-reuse", "命中浏览器复用");
    assert(resolveWebFetchStrategy({ url: "https://example.com/other", browserUrl: "https://example.com/page", browserReuseEnabled: true }) === "http-fetch", "URL 不匹配 → http-fetch");
    assert(resolveWebFetchStrategy({ url: "https://example.com/page", browserUrl: "https://example.com/page", browserReuseEnabled: false }) === "http-fetch", "开关关闭 → http-fetch");
    assert(resolveWebFetchStrategy({ url: "https://example.com/page", browserUrl: null, browserReuseEnabled: true }) === "http-fetch", "浏览器不可用 → http-fetch");
    assert(resolveWebFetchStrategy({ url: "https://example.com/page", browserUrl: "https://example.com/page#x", browserReuseEnabled: true }) === "browser-reuse", "浏览器 URL 带 hash 仍命中");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});


