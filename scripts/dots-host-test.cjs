const assert = require("node:assert/strict");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { run } = require("./desktop-dev-harness.cjs");
const soak = require("./dots-host-soak.cjs");
const controlledNotifications = process.argv.includes("--controlled-notifications");
const desktopNotifications = controlledNotifications || process.argv.includes("--desktop-notifications");

run(async env => {
  const { home, out, evaluate, getOwnedElectronPids, report } = env;
  const profile = path.join(home, ".mybuddy");
  const ownerPath = path.join(profile, ".mybuddy-owner.json");
  const owner = () => JSON.parse(readFileSync(ownerPath, "utf8"));
  const first = owner();
  assert.deepEqual(getOwnedElectronPids(), [first.pid]);
  const secondEntry = path.join(home, "second-profile.cjs");
  const stopResident = path.join(home, "stop-resident");
  writeFileSync(secondEntry, [
    'const { app } = require("electron")',
    'for (const event of ["activate","second-instance"]) app.on(event, (_event, args) => console.log("HOST-FIXTURE-ACTIVATE", event, args))',
    'const { Notification } = require("electron")',
    'const showNotification = Notification.prototype.show',
    'const controlled = ' + controlledNotifications,
    'const clickFile = ' + JSON.stringify(path.join(home, "click-notification")),
    'let delivered',
    'Notification.prototype.show = function(...args) { console.log("HOST-FIXTURE-NOTICE", this.title); this.once("click", () => console.log("HOST-FIXTURE-NOTICE-CLICK")); if (controlled) { delivered=this; return; } return showNotification.apply(this,args); }',
    'if (controlled) setInterval(() => { if(delivered && require("node:fs").existsSync(clickFile)) { require("node:fs").unlinkSync(clickFile); delivered.emit("click"); } }, 100)',
    'app.on("browser-window-created", () => console.log("HOST-FIXTURE-WINDOW", new Error().stack))',
    ...(soak.enabled ? ['setInterval(() => console.log("HOST-FIXTURE-PULSE"), 2000)'] : []),
    'const stopFile = ' + JSON.stringify(stopResident),
    'const runnerPid = ' + process.pid,
    'const watch = setInterval(() => {',
    '  let gone = false',
    '  try { process.kill(runnerPid, 0) } catch (error) { gone = error.code === "ESRCH" }',
    '  if (gone || require("node:fs").existsSync(stopFile)) { clearInterval(watch); app.quit(); }',
    '}, 250)',
    'app.setPath("userData", ' + JSON.stringify(path.join(home, "other-electron-profile")) + ')',
    'require(' + JSON.stringify(path.join(out, "dev-output/main/index.js")) + ')',
  ].join("\n"));
  const isolated = {
    ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: profile,
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local/share'),
  };
  delete isolated.ELECTRON_RUN_AS_NODE;
  const attempt = await promisify(execFile)(require("electron"), [secondEntry], {env: isolated, timeout: 20000, windowsHide: true});
  assert.match(attempt.stderr + attempt.stdout, /MyBuddy 数据目录已由另一宿主/);
  assert.equal(owner().token, first.token);
  const oldTask = await evaluate("window.api.dots.open()");
  await soak.schedule(evaluate, oldTask.id);
  const taskId = "resident-recovery-target";
  const operation = "resident-recovery-input";
  await evaluate("window.api.db.upsertTask(" + JSON.stringify({id:taskId, title:"宿主接管测试", welcomeMode:"general", updatedAt:Date.now()}) + ")");
  await env.restart(async () => {
    // Test the actual SQLite writer mutex with a separate client after the original host exits.
    const mutex = new Database(path.join(profile, ".mybuddy-writer-lock.sqlite"), {timeout: 0, fileMustExist: true});
    try { mutex.exec("BEGIN EXCLUSIVE"); mutex.exec("ROLLBACK"); } finally { mutex.close(); }
    const localDb = path.join(profile, "app.db");
    const seed = new Database(localDb, {fileMustExist: true});
    const request = {taskId, userMessageId:operation, assistantMessageId:"resident-test-reply", text:"宿主离线后的恢复测试"};
    try {
      seed.prepare(`INSERT INTO dots_delegations(operation_id,task_id,source_message_id,title,created_at,updated_at,request_json,space_id,cwd)
        SELECT ?,id,?,title,?,?,?,space_id,cwd FROM tasks WHERE id=?`)
        .run(operation, "resident-test-question", Date.now(), Date.now(), JSON.stringify(request), taskId);
    } finally { seed.close(); }
    report.seededPresentationFacts.push("A persisted pending delegation with no native admission, as after interruption before dispatch.");
    const resident = spawn(require("electron"), [secondEntry, "--resident-host"], {env:isolated, windowsHide:true, stdio:["ignore","pipe","pipe"]});
    const stopped = once(resident, "exit");
    let logs = "", lastPulse = Date.now(), createdWindow = false, online = false;
    const collect = data => {
      const diagnostic = data.toString().replace(/^HOST-FIXTURE-PULSE\r?\n/gm, "");
      if (diagnostic) appendFileSync(path.join(out, "resident.log"), diagnostic);
      logs = (logs + data).slice(-16384);
      if (data.toString().includes("HOST-FIXTURE-PULSE")) lastPulse = Date.now();
      if (logs.includes("HOST-FIXTURE-WINDOW")) createdWindow = true;
      if (logs.includes("[ResidentHost] online")) online = true;
    };
    resident.stdout.on("data", collect);
    resident.stderr.on("data", collect);
    const observation = new Database(localDb, {readonly: true, fileMustExist: true});
    try {
      const deadline = Date.now() + 45000;
      let row;
      while (Date.now() < deadline) {
        if (resident.exitCode !== null) throw Error("Resident exited early: " + logs.slice(-1600));
        row = observation.prepare("SELECT status,text FROM dots_delegations WHERE operation_id=?").get(operation);
        if (row?.status === "completed" || row?.status === "failed") break;
        await delay(120);
      }
      assert.equal(row?.status, "completed", JSON.stringify(row) + logs.slice(-1600));
      assert.match(row.text, /OK/);
      assert.equal(owner().pid, resident.pid);
      assert(online);
      assert(!createdWindow);
      await soak.observe({ home, out, report, db: observation, owner, pid: resident.pid, taskId: oldTask.id,
        health: () => ({ createdWindow, exitCode:resident.exitCode, signalCode:resident.signalCode, heartbeatAgeMs:Date.now() - lastPulse }) });
      if (desktopNotifications && soak.enabled) {
        const residentLog = readFileSync(path.join(out, "resident.log"), "utf8");
        assert.match(residentLog, /HOST-FIXTURE-NOTICE 自动化执行失败/);
        assert.match(residentLog, /HOST-FIXTURE-NOTICE 自动化已完成/);
        assert(!createdWindow, "OS notification delivery opened a resident window");
        if (controlledNotifications) {
          writeFileSync(path.join(home, "click-notification"), "trigger notification click");
          const deadline = Date.now() + 5000;
          while (!createdWindow && Date.now() < deadline) await delay(100);
          assert(createdWindow && logs.includes("activateDesktopNotification"), "explicit notification click did not request the interface");
          report.actualControlChecks.push("Completion and failure notifications reached the controlled desktop presenter with no window. An explicit click then opened the interface.");
        } else report.actualControlChecks.push("Native completion and failure notifications were presented while the resident stayed windowless.");
      }
    } finally {
      observation.close();
      writeFileSync(stopResident, "stop");
      const timeout = setTimeout(() => resident.kill(), 30000);
      try {
        const [code] = await stopped;
        assert.equal(code, 0, "resident stopped cleanly: " + logs.slice(-1600));
      } finally { clearTimeout(timeout); }
    }
  });
  const successor = owner();
  assert.deepEqual(getOwnedElectronPids(), [successor.pid]);
  assert.notEqual(first.token, successor.token);
  assert.equal((await evaluate("window.api.dots.open()")).id, oldTask.id);
  report.actualControlChecks.push("A second Electron main using different userData and the same app.db exits normally, leaves the active host unchanged, and a windowless resident successor recovers an unadmitted Dots request before restoring the foreground.");
}, { name: "dots-host", fixtureModel: soak.fixtureModel, settings: {notificationPreferences:{desktopEnabled:desktopNotifications}}, watchRenderer: false, isolatedDependencyCache: true });
