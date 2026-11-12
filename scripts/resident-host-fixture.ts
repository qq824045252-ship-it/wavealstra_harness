import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { WorkNotificationHost } from "../src/main/agent/work/WorkNotificationHost";
import { ResidentLifecycle } from "../src/main/host/ResidentLifecycle";
import { LOCAL_USER_ID, DEFAULT_BOT_ID } from "../src/shared/bot-work";

const root = process.env.RESIDENT_FIXTURE_HOME;
if (!root) throw new Error("isolated fixture home required");
app.setPath("userData", join(root, "electron"));
const trace = (event: string, data: Record<string, unknown> = {}) => appendFileSync(join(root, "trace.jsonl"), JSON.stringify({ event, pid: process.pid, ...data }) + "\n");
let ready = false;
let db: AppDatabase;
let authority: WorkHostAuthority;
let host: WorkNotificationHost;
let closing = false;
const lifecycle = new ResidentLifecycle({ argv: process.argv, packaged: true, executable: process.execPath, appPath: app.getAppPath(),
  enabled: () => true, quit: () => app.quit(), relaunch: args => app.relaunch({ args }),
  closeInterface: () => { for (const win of BrowserWindow.getAllWindows()) win.destroy(); }, log: trace });
const show = () => { if (ready) { const win = new BrowserWindow({ show: false }); void win.loadURL("data:text/html,<title>Resident fixture UI</title>"); trace("ui-opened"); } };
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else app.on("second-instance", show);
app.on("window-all-closed", () => {});
const server = createServer((request, response) => {
  if (request.url === "/handoff") lifecycle.exitInterface();
  if (request.url === "/stop") lifecycle.stop();
  if (request.url === "/close-ui") lifecycle.exitInterface();
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ pid: process.pid, resident: lifecycle.resident, authority: authority?.isAuthority(), windows: BrowserWindow.getAllWindows().length,
    workId: db?.connection.prepare("SELECT work_id FROM works ORDER BY created_at LIMIT 1").get(),
    notification: db?.connection.prepare("SELECT delivery FROM work_notifications WHERE notification_id='resident-original'").get() }));
});
app.whenReady().then(() => {
  if (!locked) return;
  db = new AppDatabase(join(root, "app.db"));
  const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots });
  authority = new WorkHostAuthority(db.connection, `fixture:${process.pid}`);
  if (!authority.start().ok) throw new Error("double authority");
  const rival = new WorkHostAuthority(db.connection, `rival:${process.pid}`);
  if (rival.acquire().ok) throw new Error("rival acquired live lease");
  if (!existsSync(join(root, "seeded"))) {
    const created = works.createWork({ kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS }, {
      operationId: "resident-original", title: "Original persisted Work", inputSnapshotId: "resident-input", ownerBotId: DEFAULT_BOT_ID,
      authorization: DESKTOP_USER_GRANTS, criteria: [{ text: "Delivery survives client exit" }] });
    if (!created.ok) throw new Error(created.message);
    works.repo.insertNotification({ notificationId: "resident-original", workId: created.work.workId, semanticKey: "resident-original",
      kind: "handoff", title: "Original Work delivery", intentRevision: created.work.intentRevision, stateVersion: created.work.stateVersion,
      delivery: "pending", attemptCount: 0, createdAt: Date.now() });
    writeFileSync(join(root, "seeded"), created.work.workId);
    trace("original-work-created", { workId: created.work.workId });
  }
  host = new WorkNotificationHost(works, { isAuthority: () => authority.isAuthority(), intervalMs: 50,
    channels: () => [{ channel: "fixture", deliveryGuarantee: "best-effort-unqueryable", supportsIdempotencyKey: false, supportsReceiptQuery: false,
      send: ({ notification }) => { trace("external-effect", { notificationId: notification.notificationId, workId: notification.workId });
        return { ok: true, receipt: `receipt:${notification.notificationId}` }; } }] });
  ready = true;
  if (lifecycle.resident) host.start();
  else show();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address === "object" && address) writeFileSync(join(root, "state.json"), JSON.stringify({ pid: process.pid, port: address.port, resident: lifecycle.resident }));
    trace("ready", { resident: lifecycle.resident });
  });
});
app.on("before-quit", event => {
  if (!ready || closing) return;
  event.preventDefault(); closing = true;
  void (async () => { await host.close(); authority.stop(); db.close(); server.close(); trace("writers-closed"); lifecycle.afterCleanup(); app.quit(); })();
});
