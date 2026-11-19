import { setTimeout as delay } from "node:timers/promises";
import type { BrowserTabInfo } from "../../../shared/browser-tabs";
import type { BrowserHost, BrowserPageHost } from "../../browser/BrowserHost";
import { AutomationScope } from "../AutomationScope";
import type { BrowserExecInput, BrowserExecOutput } from "../BrowserAutomationService";
import { browserConditionsScript, type BrowserCondition } from "./BrowserConditions";
import { bindBrowserDocument, BrowserDocumentContextError } from "./BrowserDocumentContext";
import { withBrowserDom } from "./BrowserDom";

interface LoginRequest {
  host: BrowserHost;
  taskId: string;
  tab: BrowserTabInfo;
  input: BrowserExecInput;
  signal?: AbortSignal;
  observationSlot: string;
  withSurface<T>(scope: AutomationScope, page: BrowserPageHost, operation: () => Promise<T>): Promise<T>;
  execute: (input: BrowserExecInput) => Promise<BrowserExecOutput>;
  onLoginRequired?: () => void;
}

// Only a challenge kind leaves the document. Autofilled credentials can use the
// normal submit button. While the user types, keep their tab until the form goes away.
function challengeScript(requireEmpty: boolean, input: BrowserExecInput): string {
  return withBrowserDom(`(() => {
    const visible = el => el.checkVisibility({visibilityProperty:true,opacityProperty:true}) && el.getClientRects().length > 0;
    const fields = __mbDom.all('input').filter(el => visible(el) && !el.disabled && !el.readOnly && (!${requireEmpty} || !el.value));
    const custom = ${input.challenge ? `__mbDom.one(${JSON.stringify(input.selector)})` : "null"};
    if (custom && visible(custom)) {
      if (${input.challenge === "qr"} && custom.matches('img,svg,canvas,[role="img"]')) return 'qr';
      if (${input.challenge === "code"} && fields.includes(custom)) return 'code';
    }
    const hint = el => [el.autocomplete,el.name,el.id,el.placeholder,el.getAttribute('aria-label'),...Array.from(el.labels || [], l => l.textContent)].join(' ');
    if (fields.some(el => /one-time-code|verification.?code|one.?time.?code|\\botp\\b|验证码|校验码|动态码/i.test(hint(el)))) return 'code';
    if (fields.some(el => el.type === 'password')) return 'password';
    const qr = __mbDom.all('img,svg,canvas,[role="img"]').some(el => visible(el) &&
      /qr.?code|二维码/i.test([el.id,el.getAttribute('class'),el.getAttribute('alt'),el.getAttribute('aria-label')].join(' ')));
    const instructions = document.body?.innerText || '';
    if (qr && /扫码|扫描.{0,12}二维码|scan.{0,24}(?:code|sign in|log in)/i.test(instructions)) return 'qr';
    return null;
  })()`);
}

function hasPositiveMarker(conditions: BrowserCondition[]): boolean {
  return conditions.every(c => c.kind !== "value") && conditions.some(c => {
    if (c.kind === "state") return c.state === "visible";
    if (c.kind === "text") return Boolean(c.value.trim());
    if (c.kind === "url") return c.match !== "contains" && /^https?:\/\//i.test(c.value);
    return c.kind === "count" && c.count > 0;
  });
}

/** One short, read-only sample, independent of the time a user spends signing in. */
async function sample(page: BrowserPageHost, script: string, request: LoginRequest, frameId?: string, budget?: AutomationScope): Promise<unknown> {
  const wc = page.inspectionWebContents;
  if (!wc || wc.isDestroyed() || wc.isLoadingMainFrame()) return undefined;
  const generation = page.captureVersion;
  const scope = budget ?? new AutomationScope(request.signal, 3000);
  try {
    const evaluate = async () => {
      const frame = frameId ? await bindBrowserDocument(wc, frameId, request.observationSlot, scope) : undefined;
      try {
        const value = await scope.run(() => frame ? frame.evaluate(script) : wc.executeJavaScript(script));
        return generation === page.captureVersion && page.inspectionWebContents === wc ? value : undefined;
      } finally { frame?.dispose(); }
    };
    const hasViewport = await scope.run(() => wc.executeJavaScript("innerWidth > 0 && innerHeight > 0"));
    return hasViewport ? await evaluate() : await request.withSurface(scope, page, evaluate);
  } catch (error) {
    request.signal?.throwIfAborted();
    if (wc.isDestroyed() || wc.isLoadingMainFrame() || generation !== page.captureVersion || error instanceof BrowserDocumentContextError) return undefined;
    throw error;
  } finally { if (!budget) scope.close(); }
}

export async function runBrowserLogin(request: LoginRequest): Promise<BrowserExecOutput> {
  const { input, host, taskId, tab, signal } = request;
  if (input.verifyTabId && input.verifyTabId !== tab.id && input.verifyTabId !== tab.openerTabId) {
    throw new Error("登录结果只能在登录标签或其直接来源标签中核验");
  }
  if (!input.url || !/^https?:\/\//i.test(input.url) || !input.expect?.length || !hasPositiveMarker(input.expect)) {
    throw new Error("login 需要原业务 http(s) 地址及登录后的可见控件、文字或准确 URL");
  }
  const origin = new URL(input.url).origin;
  const verifyTabId = input.verifyTabId ?? tab.id;
  const verificationPage = host.getTabHost(verifyTabId);
  if (!verificationPage || !host.listTabs().some(t => t.id === verifyTabId && t.taskId === taskId)) throw new Error("业务标签已关闭");
  const urlOnly = input.expect.every(c => c.kind === "url");
  const noLoginPrompt = withBrowserDom(`!__mbDom.all('button,a,[role=button],[role=link]').some(el =>
    el.checkVisibility({visibilityProperty:true}) && /^(?:登录|立即登录|sign in|log in|login)$/i.test((el.innerText||el.getAttribute('aria-label')||'').trim()))`);
  const checkScript = `location.origin === ${JSON.stringify(origin)} && (${browserConditionsScript(input.expect)}).every(row => row.matched)`
    + (urlOnly ? ` && !(${challengeScript(true, input)}) && (${noLoginPrompt})` : "");
  const automatic = new AutomationScope(signal, input.timeoutMs);
  let humanWaiting = false;
  const verified = async () => {
    signal?.throwIfAborted();
    if (host.getTabHost(verifyTabId) !== verificationPage) throw new Error("原业务标签已关闭，请重新打开目标页");
    return sample(verificationPage, checkScript, request, undefined, humanWaiting ? undefined : automatic);
  };
  let authTabId = tab.id;
  let frameId = input.frameId;
  let click: BrowserExecOutput | undefined;
  let observeUntil = Date.now() + 1500;
  const originalTabs = new Set(host.listTabs().map(t => t.id));
  const result = (status: "confirmed" | "inspect", detail: string): BrowserExecOutput => {
    signal?.throwIfAborted();
    if (status === "confirmed" && host.getTaskTab(taskId)?.id === authTabId) host.setTaskTab(taskId, verifyTabId);
    return {
      action: "login", tabId: status === "confirmed" || !host.getTabHost(authTabId) ? verifyTabId : authTabId,
      openedTabId: click?.openedTabId, sourceTabId: click?.sourceTabId,
      outcome: click?.outcome ?? { dispatch: "not_started", effect: "none" }, login: { status }, detail,
    };
  };
  // Never replay a click while waiting for a redirect, a popup, or a person.
  try {
    for (;;) {
      automatic.check();
      if (await verified() === true) return result("confirmed", "业务页已就绪，可以继续原任务");
      if (click && authTabId === tab.id && !click.openedTabId) {
        const children = host.listTabs().filter(t => t.taskId === taskId && t.openerTabId === tab.id && !originalTabs.has(t.id));
        if (children.length === 1) {
          authTabId = children[0]!.id;
          frameId = undefined;
          click = { ...click, openedTabId: authTabId, sourceTabId: tab.id };
        }
      }
      const authPage = host.getTabHost(authTabId);
      if (!authPage) return result("inspect", "登录窗口已关闭，请读取业务页");
      const challenge = await sample(authPage, challengeScript(true, input), request, frameId, automatic);
      if (!click && challenge !== undefined) {
        if (!/^https?:\/\//i.test(authPage.url)) return result("inspect", "请等登录页加载后检查当前标签");
        const page = await request.execute({ action: "read", tabId: authTabId, frameId, timeoutMs: Math.max(100, automatic.remaining) });
        const ready = await verified();
        if (ready === true) return result("confirmed", "业务页已就绪，可以继续原任务");
        if (ready !== false) return result("inspect", "业务页正在切换，请等待页面就绪后继续");
        const controls = page.elements?.filter(el => el.visible && !el.disabled && (el.role === "button" || el.role === "link"));
        const accounts = controls?.filter(el => /^(?:一键登录|continue as .+|继续使用.{1,80}(?:登录|账号|帐户|账户))$/i.test(el.label.trim()));
        const entries = accounts?.length ? accounts : !challenge && controls?.filter(el => /^(?:登\s*录|立即登录|sign in|log in|login)$/i.test(el.label.trim()));
        if (entries && entries.length === 1 && !page.elementsTruncated) {
          automatic.check();
          click = await request.execute({ action: "click", tabId: authTabId, frameId, selector: entries[0]!.selector, timeoutMs: Math.max(100, automatic.remaining) });
          observeUntil = Date.now() + 1500;
          if (click.openedTabId) { authTabId = click.openedTabId; frameId = undefined; }
          continue;
        }
        if (!challenge || accounts && accounts.length > 1) return result("inspect", "请观察当前页，选择本次任务需要的登录入口");
      }
      if (challenge === "password" || challenge === "qr" || challenge === "code") {
        automatic.check();
        const release = host.showLoginChallenge(authTabId, challenge);
        try {
          humanWaiting = true;
          request.onLoginRequired?.();
          let goneSince: number | undefined;
          for (;;) {
            if (await verified() === true) return result("confirmed", "已核验登录结果，继续原任务");
            const current = host.getTabHost(authTabId);
            const remaining = current && await sample(current, challengeScript(false, input), request, frameId);
            if (remaining) goneSince = undefined;
            else goneSince ??= Date.now();
            if (goneSince && Date.now() - goneSince >= 1500) return result("inspect", "验证步骤已变化，请读取业务页或下一步登录界面后继续");
            await delay(350, undefined, { signal });
          }
        } finally { release(); }
      }
      if ((click || challenge === undefined) && Date.now() < observeUntil) {
        await delay(100, undefined, { signal });
        continue;
      }
      return result("inspect", "请观察当前页、弹窗或 iframe 后继续，已派发的点击不可盲目重放");
    }
  } catch (error) {
    // A failed read after a confirmed click must retain its receipt.
    if (click && !signal?.aborted) return result("inspect", `登录点击已派发，请只读核对页面：${String(error)}`);
    throw error;
  } finally { automatic.close(); }
}
