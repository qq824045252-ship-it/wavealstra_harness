import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { pageInspectionService } from "../src/main/artifact/PageInspectionService";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, type BrowserExecInput, type BrowserExecOutput } from "../src/main/capabilities/BrowserAutomationService";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";

interface ToolResult { isError?: boolean; details?: unknown; }
interface RegisteredTool { name: string; execute(id: string, params: BrowserExecInput, signal: AbortSignal, update?: (event: { details?: { waitingForInput?: boolean } }) => void): Promise<ToolResult> }
const profileChild = process.argv.includes("--login-profile-fixture");
const root = profileChild ? process.env.LOGIN_FIXTURE_ROOT! : mkdtempSync(join(tmpdir(), "browser-handoff-tool-"));
app.setPath("home", root); app.setPath("userData", join(root, "profile"));
app.on("window-all-closed", () => {});
const guard = setTimeout(() => { console.error("browser login/renewal test timed out"); app.exit(1); }, 60_000);
let entries = 0;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const path = new URL(req.url!, "http://fixture.local").pathname;
  if (path === "/remember") {
    entries++;
    res.writeHead(303, { "Set-Cookie": "fixture_auth=yes; Max-Age=3600; Path=/; HttpOnly", Location: "/orders" }).end();
  } else if (path === "/orders" && req.headers.cookie?.includes("fixture_auth=yes")) {
    res.end("<main id='orders'>订单 123</main><button>登录</button>");
  } else if (path === "/entry") {
    res.end("<a href='/remember'>登录</a>");
  } else if (path === "/account-choice") {
    res.end("<input type='password'><button>登录</button><a href='/remember'>Continue as Alice</a>");
  } else if (path === "/popup-entry") {
    res.end("<a href='/qr' target='_blank'>Sign in</a>");
  } else if (path === "/qr") {
    res.end("<p>请扫码登录</p><canvas aria-label='二维码'></canvas>");
  } else if (path === "/password" || path === "/code") {
    res.end("<form action='/remember'><input " + (path === "/password" ? "type='password'" : "autocomplete='one-time-code'") + " required><button>登录</button></form>");
  } else {
    res.end("<button id='login'>Sign in</button><p id='status'>Signed out</p><script>document.querySelector('#login').onclick=e=>{document.querySelector('#status').textContent=e.isTrusted?'Signed in':'untrusted'}</script>");
  }
});
let win: BrowserWindow | undefined;

function output(result: ToolResult): BrowserExecOutput {
  assert(result.details && typeof result.details === "object" && "action" in result.details);
  return result.details as BrowserExecOutput;
}

function requestNotice() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 15_000;
  while (!await predicate()) {
    assert(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

void (async () => {
  let db: AppDatabase | undefined;
  try {
    await app.whenReady();
    if (profileChild) {
      const base = process.env.LOGIN_FIXTURE_ORIGIN!;
      win = new BrowserWindow({ show: false });
      const host = new BrowserHost(); host.attach(win);
      const browser = new BrowserAutomationService(() => host);
      const context = { taskId: "restart-task" };
      const path = process.env.LOGIN_FIXTURE_PATH!;
      if (path === "orders") {
        await until(() => host.loginRenewalStatus(base)?.state === "cookie_extended", "restored profile must renew before opening any task page");
        const firstExtension = host.loginRenewalStatus(base)!.lastExtendedAt!;
        await until(() => (host.loginRenewalStatus(base)?.lastExtendedAt ?? 0) > firstExtension, "site application must complete its own silent refresh when HEAD is unavailable");
        await until(() => Date.now() > Number(process.env.LOGIN_FIXTURE_FIRST_EXPIRY), "original session must expire");
      }
      if (path === "recover") await until(() => host.loginRenewalStatus(base)?.state === "checked", "the site's stored refresh grant should restore the expired access cookie");
      const opened = await browser.execute({ action: "navigate", url: base + (path === "recover" ? "orders" : path) }, undefined, context);
      const result = await browser.execute({ action: "login", tabId: opened.tabId, url: base + "orders",
        expect: [{ kind: "state", selector: "#orders", state: "visible" }] }, undefined, context);
      assert.equal(result.login?.status, "confirmed");
      assert.equal(result.outcome?.dispatch, path === "entry" ? "dispatched" : "not_started");
      if (path === "orders") {
        await until(() => host.loginRenewalStatus(base)?.state === "sign_in_required", "revocation must stop background renewal");
        assert.equal(host.loginRenewalStatus(base)?.nextAttemptAt, undefined);
      }
      host.dispose(); win.destroy(); clearTimeout(guard); app.quit(); return;
    }
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    win = new BrowserWindow({ show: true, width: 900, height: 650 });
    await win.loadURL("data:text/html,isolated browser handoff tool fixture");
    const host = new BrowserHost(); host.attach(win);
    host.setBounds({ x: 80, y: 80, width: 700, height: 500 }); host.show();
    const browser = new BrowserAutomationService(() => host);
    db = new AppDatabase(":memory:");
    db.upsertTask({ id: "task-a", title: "Browser handoff", updatedAt: Date.now() });
    const interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
    const context = { taskId: "task-a", executionId: "execution-a", assistantMessageId: "message-a" };
    const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    for (const key of ["web", "vision", "imageGeneration", "videoGeneration", "speechToText", "textToSpeech", "subagent", "multiModelConsult", "diagnostics", "ocr"] as const) {
      if (config[key]) config[key].enabled = false;
    }
    config.execution.codeExecutionEnabled = false; config.execution.terminalEnabled = false;
    const store = new BuiltinCapabilityStore(join(root, "capabilities.json")); store.write(config);
    const runtime = new BuiltinCapabilityRuntime({ store, credentials: { has: () => false, get: () => null, set: () => { throw Error("no credentials"); }, clear: () => {} } });
    const registered: RegisteredTool[] = [];
    createBuiltinCapabilityExtension({ taskId: "task-a", taskRoot: root, nativeExecution: true, runtime, browser,
      browserHandoff: (request, key, signal) => interactions.requestDurable(context, request, { key, signal }),
      artifactService: () => null, getProducerMessageId: () => "message-a", getIsolationLevel: () => "none",
    })({ registerTool: tool => { if (tool.name === "browser_exec") registered.push(tool as unknown as RegisteredTool); } } as unknown as ExtensionAPI);
    const tool = registered.find(value => value.name === "browser_exec"); assert(tool);
    const signal = new AbortController().signal;
    const opened = output(await tool.execute("open-call", { action: "navigate", url }, signal));
    assert(opened.tabId);
    let settled = false;
    const waiting = tool.execute("handoff-call", { action: "handoff", tabId: opened.tabId, reason: "login" }, signal)
      .then(result => { settled = true; return result; });
    for (let i = 0; i < 100 && !interactions.listByTask("task-a").some(item => item.status === "pending"); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const question = interactions.listByTask("task-a").find(item => item.status === "pending"); assert(question);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(settled, false, "registered browser tool must wait for actual user answer");
    assert.equal(host.activeTabId, opened.tabId, "handoff presents exact retained tab");
    const guessed = await tool.execute("guessed-resume", { action: "resume", tabId: opened.tabId, token: "model-guessed", expect: [{ kind: "text", selector: "#status", value: "Signed in" }] }, signal);
    assert.equal(guessed.isError, true, "model cannot self-assert handoff completion");
    const page = host.getTabHost(opened.tabId)?.inspectionWebContents; assert(page);
    const rect = await page.executeJavaScript("(() => {const r=document.querySelector('#login').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()") as { x: number; y: number };
    const inspector = pageInspectionService.sessionFor(page, "browser-host"); assert(inspector?.isAttached);
    await inspector.protocolCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await inspector.protocolCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await until(() => page.executeJavaScript("document.querySelector('#status').textContent === 'Signed in'"), "trusted login click must reach the fixture");
    assert.equal(interactions.respond(question.id, true).ok, true);
    const handed = output(await waiting); assert(handed.handoff?.token);
    const resumed = output(await tool.execute("resume-call", { action: "resume", tabId: opened.tabId, token: handed.handoff.token,
      expect: [{ kind: "text", selector: "#status", value: "Signed in" }] }, signal));
    assert.equal(resumed.handoff?.status, "confirmed");
    assert.equal(resumed.businessResult?.status, "passed");
    const replay = await tool.execute("resume-replay", { action: "resume", tabId: opened.tabId, token: handed.handoff.token,
      expect: [{ kind: "text", selector: "#status", value: "Signed in" }] }, signal);
    assert.equal(replay.isError, true, "resume token is one-shot");
    console.log("PASS registered browser_exec + real interaction service + trusted login input + verified one-shot resume");

    const account = url + "orders";
    const expect: NonNullable<BrowserExecInput["expect"]> = [{ kind: "state", selector: "#orders", state: "visible" }];
    async function navigate(path: string) {
      const { tabId } = output(await tool!.execute("navigate-" + path, { action: "navigate", url: url + path }, signal));
      assert(tabId);
      return tabId;
    }
    function login(id: string, tabId: string, extra: Partial<BrowserExecInput> = {}, runSignal = signal, required?: () => void) {
      return tool!.execute(id, { action: "login", tabId, url: account, expect, ...extra }, runSignal,
        event => { if (event.details?.waitingForInput) required?.(); });
    }
    const entry = await navigate("entry");
    const [first, duplicate] = await Promise.all([login("one-click", entry), login("duplicate", entry)]);
    const oneClick = output(first);
    assert.equal(oneClick.login?.status, "confirmed", JSON.stringify({ oneClick, entries, page: host.getTabHost(entry)?.url }));
    assert.equal(entries, 1);
    assert.equal(duplicate.isError, true);
    assert.equal(await navigate("orders"), entry, "reopening the redirected URL keeps its original task tab");
    const entryPage = host.getTabHost(entry)!.inspectionWebContents!;
    await entryPage.executeJavaScript("sessionStorage.setItem('workspace','fixture workspace')");
    assert.equal(await navigate("another-business-path"), entry, "a new path on the verified site reuses the task's authenticated tab");
    assert.equal(await entryPage.executeJavaScript("sessionStorage.getItem('workspace')"), "fixture workspace");
    const otherTask = await browser.execute({ action: "navigate", url: account }, signal, { taskId: "other-task" });
    const reused = await browser.execute({ action: "login", tabId: otherTask.tabId, url: account, expect }, signal, {
      taskId: "other-task", onLoginRequired: () => assert.fail("shared session must not prompt"),
    });
    assert.equal(reused.login?.status, "confirmed");
    assert.equal(reused.outcome?.dispatch, "not_started");
    assert.equal(entries, 1);
    assert.equal((await login("foreign-verify", entry, { verifyTabId: otherTask.tabId })).isError, true);
    const choice = await navigate("account-choice");
    const chosen = output(await login("saved-account", choice, {}, signal, () => assert.fail("saved identity should take precedence over the password form")));
    assert.equal(chosen.login?.status, "confirmed");
    assert.equal(entries, 2);
    console.log("PASS ordinary login click, redirected tab reuse and authenticated navigation from another task");

    for (const kind of ["password", "code"] as const) {
      const tabId = await navigate(kind);
      const required = requestNotice();
      const pending = login(kind, tabId, {}, signal, required.resolve).then(async value => {
        const result = output(value);
        assert.equal(result.login?.status, "confirmed");
        return output(await tool!.execute("continue-" + kind, { action: "read", tabId: result.tabId, mode: "text" }, signal)).text;
      });
      await required.promise;
      assert.equal(host.getTaskTab("task-a")?.loginChallenge, kind);
      assert.equal((await tool.execute("busy-" + kind, { action: "screenshot", tabId }, signal)).isError, true);
      const authPage = host.getTabHost(tabId)!.inspectionWebContents!;
      await authPage.executeJavaScript("document.querySelector('input').value='fixture-only'; document.forms[0].requestSubmit()");
      assert.match((await pending)!, /订单 123/);
      assert.equal(host.getTaskTab("task-a")?.loginChallenge, undefined);
    }
    const opener = await navigate("popup-entry");
    const qr = requestNotice();
    const pendingQr = login("popup-qr", opener, {}, signal, qr.resolve);
    await qr.promise;
    const popup = host.listTabs().find(tab => tab.openerTabId === opener)!;
    assert.equal(popup.loginChallenge, "qr");
    await host.getTabHost(opener)!.inspectionWebContents!.loadURL(account);
    host.closeTab(popup.id);
    const qrResult = output(await pendingQr);
    assert.equal(qrResult.login?.status, "confirmed");
    assert.equal(qrResult.tabId, opener);
    const codeTab = await navigate("code");
    const stop = new AbortController();
    const cancelled = await login("cancel-login", codeTab, {}, stop.signal, () => stop.abort());
    assert.equal(cancelled.isError, true);
    assert.equal(host.listTabs().find(tab => tab.id === codeTab)?.loginChallenge, undefined);
    const urlOnly = new AbortController();
    const blockedAtSameUrl = await login("same-url-code", codeTab, { url: url + "code", expect: [{ kind: "url", value: url + "code" }] },
      urlOnly.signal, () => urlOnly.abort());
    assert(urlOnly.signal.aborted && blockedAtSameUrl.isError, "a matching URL with a visible verification form cannot confirm login");
    assert.equal(interactions.listByTask("task-a").some(item => item.status === "pending"), false);
    await entryPage.session.cookies.remove(account, "fixture_auth");
    await until(() => host.loginRenewalStatus(account)?.state === "sign_in_required", "deleting the login cookie must disarm the profile timer");
    assert.equal(host.loginRenewalStatus(account)?.nextAttemptAt, undefined);
    console.log("PASS password, OTP and popup QR hand back to the original task automatically; cancellation releases the tab");
    const restartRoot = mkdtempSync(join(tmpdir(), "browser-login-restart-"));
    let token = 0, expires = 0, originalExpiry = 0, signedIn = 0, renewed = 0, siteRefreshes = 0, freshRead = false;
    let recoverMode = false;
    const rolling = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      const issue = () => {
        const seconds = recoverMode && req.url === "/authenticate" ? 2 : 6;
        expires = Date.now() + seconds * 1000;
        res.setHeader("Set-Cookie", `sid=${++token}; HttpOnly; Path=/; Max-Age=${seconds}`);
      };
      if (req.url === "/entry") return void res.end("<a href='/authenticate'>登录</a>");
      if (req.url === "/authenticate") {
        signedIn++; issue(); originalExpiry = expires;
        return void res.writeHead(303, { Location: "/orders" }).end();
      }
      if (req.url === "/") return void res.end("<script>fetch('/site-refresh', {method:'POST',headers:{'x-fixture-grant':localStorage.fixtureGrant || ''}})</script>");
      const validGrant = recoverMode && req.headers["x-fixture-grant"] === "fixture-only" && !req.headers.cookie;
      if (req.url === "/site-refresh" && req.method === "POST" && (validGrant || req.headers.cookie === `sid=${token}` && Date.now() < expires) && !freshRead) {
        siteRefreshes++; issue(); return void res.end();
      }
      if (req.url !== "/orders" || freshRead || Date.now() >= expires || req.headers.cookie !== `sid=${token}`) {
        return void res.writeHead(401).end();
      }
      if (req.method === "HEAD") {
        if (recoverMode) return void res.end();
        if (renewed) return void res.writeHead(405).end();
        renewed++; issue(); return void res.end();
      }
      if (Date.now() > originalExpiry) freshRead = true;
      res.end("<main id='orders'>订单 123</main>" + (recoverMode ? "<script>localStorage.fixtureGrant='fixture-only'</script>" : ""));
    });
    await new Promise<void>(resolve => rolling.listen(0, "127.0.0.1", resolve));
    try {
      const addr = rolling.address(); assert(addr && typeof addr !== "string");
      async function launchProfile(profileRoot: string, path: string) {
        await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--login-profile-fixture"], {
          windowsHide: true, timeout: 25_000,
          env: { ...process.env, LOGIN_FIXTURE_ROOT: profileRoot, LOGIN_FIXTURE_ORIGIN: siteOrigin,
            LOGIN_FIXTURE_PATH: path, LOGIN_FIXTURE_FIRST_EXPIRY: String(originalExpiry) },
        });
      }
      const siteOrigin = `http://127.0.0.1:${addr.port}/`;
      await launchProfile(restartRoot, "entry"); await launchProfile(restartRoot, "orders");
      assert.equal(signedIn, 1); assert.equal(renewed, 1); assert(siteRefreshes >= 1); assert(freshRead);
      console.log("PASS restart restored the timer, HEAD and site-owned JS rotated HttpOnly sessions, protected read survived original expiry, revocation stopped renewal");
      recoverMode = true; freshRead = false;
      const lateRoot = mkdtempSync(join(tmpdir(), "browser-late-restart-"));
      await launchProfile(lateRoot, "entry");
      const beforeRecovery = siteRefreshes;
      await until(() => Date.now() > originalExpiry + 500, "let the access cookie expire while the app is closed");
      await launchProfile(lateRoot, "recover");
      assert.equal(signedIn, 2); assert.equal(siteRefreshes, beforeRecovery + 1); assert(freshRead);
      console.log("PASS late restart recovered with the site's own stored grant after its access cookie expired while closed");
    } finally { rolling.close(); }
    win.destroy(); db.close(); server.close(); clearTimeout(guard); app.exit(0);
  } catch (error) {
    console.error(error); win?.destroy(); db?.close(); server.close(); clearTimeout(guard); app.exit(1);
  }
})();
