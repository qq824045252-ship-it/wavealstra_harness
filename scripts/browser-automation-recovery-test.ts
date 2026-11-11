import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { BrowserAutomationService, BrowserAutomationError } from "../src/main/capabilities/BrowserAutomationService";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { PageCaptureError } from "../src/main/artifact/PageInspectionService";
import {
  browserAutomationRecoveryTarget,
  recordBrowserAutomationFailureRecovery,
  settleBrowserAutomationRecovery,
} from "../src/main/agent/BrowserAutomationFailureRecovery";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
const failures = new ExecutionFailureRepository(db);
const ctx = { taskId: "task", executionId: "exec", assistantMessageId: "msg" };
const bridge = { resolveContext: () => ctx, failures };

function hostWith(options: { url?: string; loadError?: Error; captureError?: Error; script?: (code: string) => unknown } = {}) {
  let url = options.url ?? "https://example.test/form";
  const sent: unknown[] = [];
  const wc = {
    isDestroyed: () => false,
    loadURL: async (target: string) => { if (options.loadError) throw options.loadError; url = target; },
    getURL: () => url,
    getTitle: () => "Fixture",
    executeJavaScript: async (code: string) => options.script?.(code) ?? ({ ok: true }),
    sendInputEvent: (event: unknown) => { sent.push(event); },
    capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") }),
  };
  const host = {
    attached: true,
    listTabs: () => [],
    inspectionWebContents: wc,
    get url() { return url; },
    navigateForAutomation: (target: string) => wc.loadURL(target),
    captureScreenshot: async ({ signal }: { signal?: AbortSignal }) => {
      if (signal?.aborted) throw new PageCaptureError("CANCELLED", "cancelled");
      if (options.captureError) throw options.captureError;
      return Buffer.from("png");
    },
  };
  return { host: host as any, wc, sent };
}

try {
  const unavailable = new BrowserAutomationService(() => null);
  await assert.rejects(unavailable.execute({ action: "status" }),
    (error: unknown) => error instanceof BrowserAutomationError && error.code === "HOST_UNAVAILABLE");
  const hostError = new BrowserAutomationError("HOST_UNAVAILABLE", "not mounted");
  const clickInput = { action: "click" as const, selector: "#save" };
  assert(recordBrowserAutomationFailureRecovery(bridge, clickInput, hostError));
  const hostFailure = failures.list("task").find((item) => item.causeCode === "browser-host-unavailable")!;
  assert.equal(hostFailure.target, "browser:click:surface");
  assert.equal(hostFailure.sideEffects, "none");

  const invalid = hostWith();
  const invalidService = new BrowserAutomationService(() => invalid.host);
  await assert.rejects(invalidService.execute({ action: "navigate", url: "file:///tmp/x" }),
    (error: unknown) => error instanceof BrowserAutomationError && error.code === "INVALID_URL");
  assert.equal(recordBrowserAutomationFailureRecovery(bridge, { action: "navigate", url: "file:///tmp/x" }, new BrowserAutomationError("INVALID_URL", "bad")), false,
    "bad Agent URL input must not create a user recovery notice");

  const previewDir = mkdtempSync(join(tmpdir(), "browser-local-url-"));
  try {
    const previewPath = join(previewDir, "本地 preview #1.html");
    writeFileSync(previewPath, "<title>local preview</title>");
    const previewUrl = pathToFileURL(previewPath).href;
    const navigated = await invalidService.execute({ action: "navigate", url: previewUrl });
    assert.equal(navigated.url, previewUrl, "encoded local preview uses the same browser host");
    for (const bad of [pathToFileURL(previewDir).href, "file://network-share/private.html", "javascript:alert(1)", "data:text/html,not-a-file"]) {
      await assert.rejects(invalidService.execute({ action: "navigate", url: bad }),
        (error: unknown) => error instanceof BrowserAutomationError && error.code === "INVALID_URL");
      assert.equal(invalid.wc.getURL(), previewUrl, "invalid URL does not disturb current preview");
    }
  } finally { rmSync(previewDir, { recursive: true, force: true }); }

  const nav = hostWith({ loadError: new Error("ERR_CONNECTION_RESET") });
  const navService = new BrowserAutomationService(() => nav.host);
  let navError: BrowserAutomationError | undefined;
  try { await navService.execute({ action: "navigate", url: "https://example.test/next" }); }
  catch (error) { if (error instanceof BrowserAutomationError) navError = error; else throw error; }
  assert.equal(navError?.code, "NAVIGATION_FAILED");
  const navInput = { action: "navigate" as const, url: "https://example.test/next" };
  assert(recordBrowserAutomationFailureRecovery(bridge, navInput, navError));
  const navFailure = failures.list("task").find((item) => item.causeCode === "browser-navigation-failed")!;
  assert.equal(navFailure.phase, "execute");
  assert.equal(navFailure.sideEffects, "unknown");
  settleBrowserAutomationRecovery(bridge, navInput, { action: "navigate", url: "https://example.test/next", title: "Next" });
  assert(failures.list("task").find((item) => item.id === navFailure.id)?.resolvedAt, "same target URL success establishes final navigation state");

  const refused = hostWith({ loadError: new Error("ERR_CONNECTION_REFUSED (-102) loading localhost") });
  await assert.rejects(new BrowserAutomationService(() => refused.host).execute({ action: "navigate", url: "http://127.0.0.1:50878/?v=2" }),
    (error: unknown) => error instanceof BrowserAutomationError && error.code === "NAVIGATION_FAILED"
      && error.message.includes("ERR_CONNECTION_REFUSED") && error.message.includes("gadget_open")
      && (error.details as { reason?: string }).reason === "local-server-unavailable",
    "refused preview explains the dead local server and recovery without an external browser");

  const missing = hostWith({ script: () => ({ ok: false, code: "SELECTOR_NOT_FOUND", error: "selector not found" }) });
  const missingService = new BrowserAutomationService(() => missing.host);
  let missingError: BrowserAutomationError | undefined;
  try { await missingService.execute(clickInput); }
  catch (error) { if (error instanceof BrowserAutomationError) missingError = error; else throw error; }
  assert.equal(missingError?.code, "SELECTOR_NOT_FOUND");
  assert(recordBrowserAutomationFailureRecovery(bridge, clickInput, missingError));
  const missingFailure = failures.list("task").find((item) => item.causeCode === "browser-selector-not-found")!;
  assert.equal(missingFailure.phase, "observe");
  assert.equal(missingFailure.sideEffects, "none");
  settleBrowserAutomationRecovery(bridge, clickInput, { action: "click", url: "https://example.test/form", detail: "button" });
  assert(failures.list("task").find((item) => item.id === missingFailure.id)?.resolvedAt);
  assert(failures.list("task").find((item) => item.id === hostFailure.id)?.resolvedAt, "restored browser surface clears host-unavailable for that action");

  const exploding = hostWith({ script: () => { throw new Error("renderer crashed during click"); } });
  const explodingService = new BrowserAutomationService(() => exploding.host);
  let execError: BrowserAutomationError | undefined;
  try { await explodingService.execute(clickInput); }
  catch (error) { if (error instanceof BrowserAutomationError) execError = error; else throw error; }
  assert.equal(execError?.code, "EXECUTION_FAILED");
  assert(recordBrowserAutomationFailureRecovery(bridge, clickInput, execError));
  const uncertain = failures.list("task").find((item) => !item.resolvedAt && item.causeCode === "browser-execution-failed")!;
  assert.equal(uncertain.sideEffects, "unknown");
  assert.equal(uncertain.target, "browser:uncertain:url=https%3A%2F%2Fexample.test%2Fform");
  settleBrowserAutomationRecovery(bridge, clickInput, { action: "click", url: "https://example.test/form", detail: "success" });
  assert.equal(failures.list("task").find((item) => item.id === uncertain.id)?.resolvedAt, undefined,
    "later click success must not erase an uncertain earlier click without fresh observation");
  settleBrowserAutomationRecovery(bridge, { action: "read" }, { action: "read", url: "https://example.test/form", text: "fresh page evidence" });
  assert(failures.list("task").find((item) => item.id === uncertain.id)?.resolvedAt,
    "fresh read of the same page reconciles uncertain side effects so the Agent can re-plan from actual state");

  const pressMissing = hostWith({ script: () => ({ ok: false, code: "SELECTOR_NOT_FOUND", error: "selector not found" }) });
  const pressService = new BrowserAutomationService(() => pressMissing.host);
  await assert.rejects(pressService.execute({ action: "press", selector: "#missing", key: "Enter" }),
    (error: unknown) => error instanceof BrowserAutomationError && error.code === "SELECTOR_NOT_FOUND");
  assert.equal(pressMissing.sent.length, 0, "missing press target must never send the key to whichever element currently has focus");

  const pressOk = hostWith({ script: () => ({ ok: true }) });
  const pressOkService = new BrowserAutomationService(() => pressOk.host);
  await pressOkService.execute({ action: "press", selector: "#field", key: "Enter" });
  assert.equal(pressOk.sent.length, 2, "verified focus sends exactly keyDown/keyUp");

  const beforeInvocationErrors = failures.list("task").length;
  const captured = await new BrowserAutomationService(() => hostWith().host).execute({ action: "screenshot" });
  assert.equal(Buffer.from(captured.screenshot!).toString(), "png", "screenshot must use the shared BrowserHost owner");
  const timeoutService = new BrowserAutomationService(() => hostWith({ captureError: new PageCaptureError("CAPTURE_TIMEOUT", "timed out") }).host);
  await assert.rejects(timeoutService.execute({ action: "screenshot" }), (error: unknown) => error instanceof BrowserAutomationError && error.code === "CAPTURE_TIMEOUT");
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(timeoutService.execute({ action: "screenshot" }, cancelled.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(recordBrowserAutomationFailureRecovery(bridge, clickInput, new BrowserAutomationError("INVALID_SELECTOR", "bad css")), false);
  assert.equal(recordBrowserAutomationFailureRecovery(bridge, { action: "fill", selector: "#x" }, new BrowserAutomationError("INVALID_INPUT", "text too long")), false);
  assert.equal(failures.list("task").length, beforeInvocationErrors);

  assert.equal(browserAutomationRecoveryTarget({ action: "navigate", url: "example.test/a" }), "browser:navigate:url=https%3A%2F%2Fexample.test%2Fa");
  assert.equal(browserAutomationRecoveryTarget({ action: "click", selector: "#save" }, { currentUrl: "https://example.test/a" }),
    "browser:click:url=https%3A%2F%2Fexample.test%2Fa|selector=%23save");

  const builtin = await readFile("src/main/capabilities/builtin-capability-extension.ts", "utf8");
  const assembler = await readFile("src/main/agent/SessionExtensionAssembler.ts", "utf8");
  assert(builtin.includes("settleBrowserAutomationRecovery(bridge.browserRecovery, input, result)"));
  assert(builtin.includes("recordBrowserAutomationFailureRecovery(bridge.browserRecovery, input, error)"));
  assert(assembler.includes("browserRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures }"));

  console.log("browser automation recovery: PASS (typed errors, safe press targeting, navigation reconciliation, selector preflight, uncertain-side-effect re-observation, invocation filtering, main-session wiring)");
} finally { db.close(); }
