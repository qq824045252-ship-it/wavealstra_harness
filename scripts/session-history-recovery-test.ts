import { userMessage, assistantMessage } from "./test-pi-messages";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAppStoreModule } from "./read-app-store-source";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadTaskHistoryFromSession } from "../src/main/agent/session-history";

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function makeSession(root: string, label: string, turns = 2): { cwd: string; file: string } {
  const cwd = join(root, `${label}-work`);
  const dir = join(root, `${label}-sessions`);
  const sm = SessionManager.create(cwd, dir);
  for (let index = 1; index <= turns; index += 1) {
    sm.appendMessage(userMessage(`q${index}`));
    sm.appendMessage(assistantMessage([{ type: "text", text: `a${index}` }]));
  }
  const file = sm.getSessionFile();
  assert(file, "Fixture session was not persisted");
  return { cwd, file };
}
function recoveryDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("mybuddy-session-recovery-")));
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-session-history-recovery-test-"));
try {
  // 1) Malformed tail: Pi can read the valid records, MyBuddy must surface the warning.
  {
    const session = makeSession(root, "tail", 2);
    appendFileSync(session.file, '{"type":"message","id":"broken-tail"');
    const before = hash(session.file);
    const history = loadTaskHistoryFromSession(session.file, session.cwd);
    assert.equal(history.messages.length, 4);
    assert.equal(history.sessionFile, session.file);
    assert.equal(history.sessionRecovery?.kind, "corrupt-records");
    assert.equal(history.sessionRecovery?.invalidRecords, 1);
    assert.equal(history.sessionRecovery?.tailOnly, true);
    assert.equal(hash(session.file), before, "tail recovery must never rewrite/truncate the original JSONL");
  }

  // 2) Malformed middle record: valid later records remain readable and the warning is not tail-only.
  {
    const session = makeSession(root, "middle", 2);
    const lines = readFileSync(session.file, "utf8").trimEnd().split(/\r?\n/);
    lines.splice(3, 0, "{broken-middle");
    writeFileSync(session.file, `${lines.join("\n")}\n`, "utf8");
    const before = hash(session.file);
    const history = loadTaskHistoryFromSession(session.file, session.cwd);
    assert.equal(history.messages.length, 4);
    assert.equal(history.sessionRecovery?.kind, "corrupt-records");
    assert.equal(history.sessionRecovery?.tailOnly, false);
    assert.equal(history.sessionRecovery?.firstInvalidLine, 4);
    assert.equal(hash(session.file), before, "middle-record recovery must preserve the exact damaged original");
  }

  // 3) Structurally invalid but JSON-valid line: a duplicate entry id forms a parent cycle.
  // Probe Pi in a bounded child: this version walks the cycle until OOM rather than
  // throwing a catchable RangeError. Never let a dependency probe exhaust the test host.
  // The production recovery assertions below still exercise the actual safe reader.
  {
    const beforeDirs = recoveryDirs();
    const session = makeSession(root, "fallback", 2);
    const lines = readFileSync(session.file, "utf8").trimEnd().split(/\r?\n/);
    const previous = JSON.parse(lines[1]!);
    const last = JSON.parse(lines.at(-1)!);
    last.id = previous.id;
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(session.file, `${lines.join("\n")}\n`, "utf8");
    const before = hash(session.file);
    const probe = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
      import { SessionManager } from "@earendil-works/pi-coding-agent";
      const manager = SessionManager.open(process.argv[1], undefined, process.argv[2]);
      process.stdout.write("PROBE_READY\\n");
      try { manager.buildContextEntries(); }
      catch (error) {
        if (/Invalid array length|valid pi session/.test(String(error))) process.exit(42);
        throw error;
      }
    `, session.file, session.cwd], { encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 });
    assert.match(probe.stdout ?? "", /PROBE_READY/, "upstream probe must reach the corrupt fixture before its bound");
    const boundedFailure = probe.status === 42
      || (probe.signal === "SIGABRT" || process.platform === "win32" && probe.status === 134) && /heap out of memory|Allocation failed/.test(probe.stderr ?? "")
      || (probe.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    assert.ok(boundedFailure, `corrupt upstream traversal must reject or hit its isolated bound: status=${probe.status}, signal=${probe.signal}, error=${probe.error?.message}`);
    const history = loadTaskHistoryFromSession(session.file, session.cwd);
    assert.equal(history.sessionFile, session.file, "temporary recovery path must never escape into Task history");
    assert.equal(history.sessionRecovery?.kind, "read-only-fallback");
    assert.ok((history.sessionRecovery?.invalidRecords ?? 0) >= 1);
    assert.ok(history.messages.length >= 3, "readable prefix must preserve earlier conversation history");
    assert.equal(hash(session.file), before, "fallback must not rewrite the structurally damaged source");
    const afterDirs = recoveryDirs();
    assert.deepEqual([...afterDirs].filter((name) => !beforeDirs.has(name)), [], "temporary recovery directory must be cleaned in finally");
  }

  const chatView = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/ChatView.tsx"), "utf8");
  const taskActivation = readAppStoreModule("commands/taskActivation.ts");
  assert.ok(chatView.includes("SessionHistoryRecoveryNotice"), "ChatView must surface session-file recovery diagnostics");
  assert.ok(taskActivation.includes("sessionRecovery: history.sessionRecovery"), "renderer Task must retain the recovery summary after hydration");
  console.log("session history recovery: PASS (bad tail, bad middle record, read-only fallback, source hash, temp cleanup, UI wiring)");
} finally {
  rmSync(root, { recursive: true, force: true });
}
