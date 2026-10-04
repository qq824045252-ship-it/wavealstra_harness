import type { BrowserHost } from "../browser/BrowserHost";
import { BrowserContentService } from "../browser/BrowserContentService";
import { PageCaptureError } from "../artifact/PageInspectionService";

export type BrowserExecAction =
  | "status"
  | "navigate"
  | "read"
  | "click"
  | "fill"
  | "press"
  | "screenshot";

export const BROWSER_AUTOMATION_ERROR_CODES = [
  "HOST_UNAVAILABLE", "INVALID_INPUT", "INVALID_URL", "INVALID_SELECTOR", "NAVIGATION_FAILED",
  "PAGE_UNAVAILABLE", "SCREENSHOT_EMPTY", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE",
  "FOCUS_FAILED", "EXECUTION_FAILED", "CAPTURE_TIMEOUT", "SURFACE_CHANGED",
] as const;
export type BrowserAutomationErrorCode = (typeof BROWSER_AUTOMATION_ERROR_CODES)[number];
export class BrowserAutomationError extends Error {
  constructor(public readonly code: BrowserAutomationErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "BrowserAutomationError";
  }
}

export interface BrowserExecInput {
  action: BrowserExecAction;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  maxChars?: number;
}
export interface BrowserExecOutput {
  action: BrowserExecAction;
  url?: string;
  title?: string;
  text?: string;
  detail?: string;
  screenshot?: Uint8Array;
}

function assertHttpUrl(raw: string): string {
  try {
    const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserAutomationError("INVALID_URL", "browser_exec 只允许 http(s) URL");
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw new BrowserAutomationError("INVALID_URL", `无效浏览器 URL：${raw}`, { cause: error instanceof Error ? error.message : String(error) });
  }
}

function requireShort(value: string | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new BrowserAutomationError("INVALID_INPUT", `${label} 不能为空`, { label });
  if (normalized.length > max) throw new BrowserAutomationError("INVALID_INPUT", `${label} 过长`, { label, max });
  return normalized;
}

function jsFailure(error: unknown, action: BrowserExecAction, url?: string): BrowserAutomationError {
  if (error instanceof BrowserAutomationError) return error;
  return new BrowserAutomationError("EXECUTION_FAILED", `浏览器 ${action} 执行失败：${error instanceof Error ? error.message : String(error)}`, { action, url });
}

export class BrowserAutomationService {
  private readonly content: BrowserContentService;

  constructor(private readonly host: () => BrowserHost | null) {
    this.content = new BrowserContentService(host);
  }

  get available(): boolean {
    return Boolean(this.host()?.inspectionWebContents);
  }

  async execute(input: BrowserExecInput, signal?: AbortSignal): Promise<BrowserExecOutput> {
    if (signal?.aborted) throw new DOMException("浏览器操作已取消", "AbortError");
    const host = this.host();
    const wc = host?.inspectionWebContents;
    if (!host || !wc) throw new BrowserAutomationError("HOST_UNAVAILABLE", "MyBuddy 浏览器尚未挂载");
    if (input.action === "status") {
      return { action: input.action, url: host.url || undefined, detail: host.url ? "ready" : "idle" };
    }
    if (input.action === "navigate") {
      const target = assertHttpUrl(requireShort(input.url, "url", 2_000));
      try {
        await host.navigateForAutomation(target, signal);
        return { action: input.action, url: wc.getURL(), title: await wc.getTitle() };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new BrowserAutomationError("NAVIGATION_FAILED", `浏览器导航失败：${target}`, {
          targetUrl: target,
          currentUrl: safeUrl(wc),
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (input.action === "read") {
      let page;
      try { page = await this.content.getCurrentPage(); }
      catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!page) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "浏览器没有可读取的页面", { currentUrl: safeUrl(wc) });
      const max = Math.max(1_000, Math.min(100_000, Math.round(input.maxChars ?? 30_000)));
      return { action: input.action, url: page.url, title: page.title, text: page.text.slice(0, max) };
    }
    if (input.action === "screenshot") {
      if (!host.url) throw new BrowserAutomationError("PAGE_UNAVAILABLE", "浏览器没有可截图的页面");
      try {
        const screenshot = await host.captureScreenshot({ signal });
        return { action: input.action, url: host.url, title: wc.getTitle(), screenshot };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof PageCaptureError && error.code !== "CANCELLED") {
          throw new BrowserAutomationError(error.code, error.message, { currentUrl: host.url });
        }
        if (error instanceof BrowserAutomationError) throw error;
        throw jsFailure(error, input.action, host.url);
      }
    }

    const selector = requireShort(input.selector, "selector", 1_000);
    if (input.action === "click") {
      let result: { ok?: boolean; code?: string; error?: string; tag?: string; text?: string };
      try {
        result = await wc.executeJavaScript(`(() => {
          let el; try { el = document.querySelector(${JSON.stringify(selector)}); }
          catch (e) { return { ok: false, code: "INVALID_SELECTOR", error: "invalid selector: " + String(e) }; }
          if (!el) return { ok: false, code: "SELECTOR_NOT_FOUND", error: "selector not found" };
          el.scrollIntoView({ block: "center", inline: "center" });
          if (!(el instanceof HTMLElement)) return { ok: false, code: "ELEMENT_NOT_CLICKABLE", error: "element is not clickable" };
          el.click();
          return { ok: true, tag: el.tagName, text: (el.innerText || el.getAttribute("aria-label") || "").slice(0, 200) };
        })()`, true) as typeof result;
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!result?.ok) throw browserResultError(result, input.action, selector, safeUrl(wc));
      return { action: input.action, url: wc.getURL(), detail: `${result.tag ?? "element"}: ${result.text ?? ""}`.trim() };
    }
    if (input.action === "fill") {
      const text = input.text ?? "";
      if (text.length > 100_000) throw new BrowserAutomationError("INVALID_INPUT", "text 过长", { max: 100_000 });
      let result: { ok?: boolean; code?: string; error?: string };
      try {
        result = await wc.executeJavaScript(`(() => {
          let el; try { el = document.querySelector(${JSON.stringify(selector)}); }
          catch (e) { return { ok: false, code: "INVALID_SELECTOR", error: "invalid selector: " + String(e) }; }
          if (!el) return { ok: false, code: "SELECTOR_NOT_FOUND", error: "selector not found" };
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLElement && el.isContentEditable)) {
            return { ok: false, code: "ELEMENT_NOT_EDITABLE", error: "selector is not an editable element" };
          }
          el.focus();
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = ${JSON.stringify(text)};
          else el.textContent = ${JSON.stringify(text)};
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)} }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        })()`, true) as typeof result;
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!result?.ok) throw browserResultError(result, input.action, selector, safeUrl(wc));
      return { action: input.action, url: wc.getURL(), detail: `已填写 ${selector}` };
    }
    if (input.action === "press") {
      const key = requireShort(input.key, "key", 60);
      let focus: { ok?: boolean; code?: string; error?: string };
      try {
        focus = await wc.executeJavaScript(`(() => {
          let el; try { el = document.querySelector(${JSON.stringify(selector)}); }
          catch (e) { return { ok: false, code: "INVALID_SELECTOR", error: "invalid selector: " + String(e) }; }
          if (!(el instanceof HTMLElement)) return { ok: false, code: el ? "FOCUS_FAILED" : "SELECTOR_NOT_FOUND", error: el ? "element cannot receive focus" : "selector not found" };
          el.focus();
          if (document.activeElement !== el) return { ok: false, code: "FOCUS_FAILED", error: "element did not receive focus" };
          return { ok: true };
        })()`, true) as typeof focus;
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      if (!focus?.ok) throw browserResultError(focus, input.action, selector, safeUrl(wc));
      try {
        wc.sendInputEvent({ type: "keyDown", keyCode: key });
        wc.sendInputEvent({ type: "keyUp", keyCode: key });
      } catch (error) { throw jsFailure(error, input.action, safeUrl(wc)); }
      return { action: input.action, url: wc.getURL(), detail: `已向 ${selector} 发送按键 ${key}` };
    }
    throw new BrowserAutomationError("INVALID_INPUT", `不支持的 browser_exec action：${String(input.action)}`);
  }
}

function safeUrl(wc: BrowserHost["inspectionWebContents"]): string | undefined {
  try { return wc?.getURL() || undefined; } catch { return undefined; }
}

function browserResultError(
  result: { code?: string; error?: string } | null | undefined,
  action: BrowserExecAction,
  selector: string,
  currentUrl?: string,
): BrowserAutomationError {
  const allowed = new Set<BrowserAutomationErrorCode>(["INVALID_SELECTOR", "SELECTOR_NOT_FOUND", "ELEMENT_NOT_CLICKABLE", "ELEMENT_NOT_EDITABLE", "FOCUS_FAILED"]);
  const code = allowed.has(result?.code as BrowserAutomationErrorCode) ? result!.code as BrowserAutomationErrorCode : "EXECUTION_FAILED";
  return new BrowserAutomationError(code, result?.error || `浏览器 ${action} 执行失败`, { action, selector, currentUrl });
}
