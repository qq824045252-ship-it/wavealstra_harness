import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import vm from "node:vm";
import { notificationLauncherSource, notificationProtocol, notificationToastXml, parseNotificationActivation, WindowsNotificationActivation, type NotificationLaunchContext } from "../src/main/platform/notification-activation";

const base: NotificationLaunchContext = {
  appName: "MyBuddy", execPath: "C:\\App Dir\\electron.exe", appPath: "C:\\repo with spaces", home: "C:\\isolated home",
  userData: mkdtempSync(join(tmpdir(), "notification-activation-test-")),
  entry: "C:\\repo with spaces\\out\\main\\index.js", packaged: false,
  rendererUrl: "http://127.0.0.1:5199", environment: { HOME: "C:\\isolated home", PI_CODING_AGENT_DIR: "C:\\isolated home\\.mybuddy" },
};
const id = "01234567-89ab-cdef-0123-456789abcdef";
const scheme = notificationProtocol(base), uri = `${scheme}://open/${id}`;
assert.equal(notificationProtocol(base), scheme);
assert.notEqual(notificationProtocol({ ...base, userData: base.userData + "-other" }), scheme);
assert.equal(parseNotificationActivation(uri, scheme), id);
for (const value of [uri + "?path=C:/evil", uri + "/", uri + "#x", uri.replace("open/", "execute/"), uri.replace(scheme, "https"), `${scheme}://open/../../run`, `${scheme}://open/%30${id.slice(1)}`]) assert.equal(parseNotificationActivation(value, scheme), null);
const xml = notificationToastXml(scheme, id, '<a "x">&', "body's");
assert(xml.includes('activationType="protocol"'));
assert(xml.includes('&lt;a &quot;x&quot;&gt;&amp;'));
assert(xml.includes("body&apos;s"));
assert.throws(() => notificationToastXml(scheme, "invalid", "x", "y"));
const calls: unknown[][] = [], received: string[] = [];
const app = { isDefaultProtocolClient: () => false, setAsDefaultProtocolClient: (...args: unknown[]) => { calls.push(args); return true; } };
const activation = new WindowsNotificationActivation(app, base, id => received.push(id), "windows");
assert.equal(activation.accept(["ignored", uri]), true);
assert.deepEqual(received, [id]);
activation.toast(id, "Title", "Body"); activation.toast(id, "Again");
assert.equal(calls.length, 1);
assert.deepEqual(calls[0], [scheme, base.execPath, [join(base.userData, "notification-activation.cjs")]]);
assert.equal(readFileSync(join(base.userData, "notification-activation.cjs"), "utf8"), notificationLauncherSource(base, scheme));
assert.equal(new WindowsNotificationActivation(app, base, () => assert.fail(), "linux").toast(id, "x"), undefined);
const packageCalls: unknown[][] = [];
const packaged = { ...base, packaged: true, home: userInfo().homedir, environment: {} };
new WindowsNotificationActivation({ ...app, setAsDefaultProtocolClient: (...args: unknown[]) => { packageCalls.push(args); return true; } }, packaged, () => {}, "windows").toast(id, "packaged");
assert.deepEqual(packageCalls[0], [notificationProtocol(packaged), base.execPath, [`--user-data-dir=${base.userData}`]]);
assert.throws(() => new WindowsNotificationActivation(app, { ...base, packaged: true }, () => {}, "windows").toast(id, "bad profile"));

async function launch(mode: "running" | "cold" | "vite", value = uri, exists = true, handoffAge?: "stale" | "live") {
  const events: unknown[][] = []; const env: Record<string, string> = { USERPROFILE: "C:\\real user" };
  if (mode === "vite") { env.MYBUDDY_NOTIFICATION_DEV_RESTART = scheme; env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5199"; }
  const files = new Map<string,string>(); let startToken = "";
  if (handoffAge) files.set(join(base.userData,"notification-launch-queue","handoff.json"), JSON.stringify({pid:5678,token:"previous",expiresAt:Date.now()+(handoffAge==="stale"?-1000:10000)}));
  const fakeProcess = { kill: () => { if(!handoffAge) throw new Error("not alive"); }, argv: [base.execPath, "launcher.cjs", value], env, pid: 1234, execPath: base.execPath, chdir: (p: string) => events.push(["cwd", p]) };
  const app = { on: () => {}, releaseSingleInstanceLock: () => events.push(["release"]), setName: () => {}, requestSingleInstanceLock: () => mode !== "running", exit: (code: number) => events.push(["exit", code]), setPath: (...args: unknown[]) => events.push(["path", ...args]), setAppPath: (p: string) => events.push(["appPath", p]) };
  const fakeFs = { existsSync: () => exists, openSync: () => 7, closeSync: () => {}, mkdirSync: () => {},
    writeFileSync: (p:string,v:string) => files.set(p,v),
    readFileSync: (p:string) => { if(!files.has(p)) throw Error("missing"); return files.get(p); },
    unlinkSync: (p:string) => files.delete(p), readdirSync: () => [...files.keys()].map(p=>path.basename(p)),
  };
  const spawn = (...args: unknown[]) => { events.push(["spawn", ...args]); startToken=(args[2] as {env:Record<string,string>}).env.MYBUDDY_NOTIFICATION_START_ID; new vm.Script((args[1] as string[])[1]); const child = new EventEmitter() as EventEmitter & { unref(): void }; child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; };
  vm.runInNewContext(notificationLauncherSource(base, scheme), {
    setInterval: (callback: () => void) => { queueMicrotask(() => { files.set(join(base.userData,"notification-launch-queue","handoff.json"),JSON.stringify({pid:1234,token:startToken})); callback(); }); return 1; }, clearInterval: () => {},
    process: fakeProcess, __filename: "C:\\profile\\notification-activation.cjs", URL, AbortSignal,
    require: (name: string) => {
      if (name === "electron") return { app, dialog: { showErrorBox: (...args: unknown[]) => events.push(["error", ...args]) } };
      if (name === "node:fs") return fakeFs;
      if (name === "node:path") return path;
      if (name === "node:child_process") return { spawn };
      assert.equal(name, base.entry); events.push(["load", name, env.HOME, env.USERPROFILE]); return {};
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  return events;
}
async function run() {
  const hot = await launch("running");
  assert(!hot.some(e => e[0] === "load" || e[0] === "spawn"));
  assert(hot.some(e => e[0] === "exit" && e[1] === 0));
  const warm = await launch("vite");
  assert(warm.some(e => e[0] === "load" && e[2] === base.home && e[3] === base.home));
  assert(!warm.some(e => e[0] === "spawn"));
  const cold = await launch("cold");
  assert(cold.some(e => e[0] === "spawn"));
  assert(!cold.some(e => e[0] === "load"));
  assert(cold.some(e => e[0] === "exit" && e[1] === 0));
  const stale = await launch("cold", uri, true, "stale");
  assert(stale.some(e => e[0] === "spawn"), "a reused PID from an expired handoff cannot block cold launch");
  const transferring = await launch("cold", uri, true, "live");
  assert(!transferring.some(e => e[0] === "spawn" || e[0] === "load"));
  assert(transferring.some(e => e[0] === "release"));
  const invalid = await launch("vite", uri + "?execute=evil");
  assert.deepEqual(invalid, [["exit", 1]]);
  const missing = await launch("cold", uri, false);
  assert(missing.some(e => e[0] === "error"));
  assert(!missing.some(e => e[0] === "spawn" || e[0] === "load"));
  console.log("notification activation: URI/profile/XML/registration/warm and cold launcher boundaries passed (controlled ports, no OS registration)");
}
void run();
