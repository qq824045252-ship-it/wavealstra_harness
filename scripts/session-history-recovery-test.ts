import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    sm.appendMessage({ role: "user", content: `q${index}` });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `a${index}` }] });
  }
  return { cwd, file: sm.getSessionFile() };
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

  // 3) Structurally invalid but JSON-valid line: duplicate entry id makes Pi reject the source.
  // MyBuddy opens the largest readable prefix in a temp copy and still keeps the source untouched.
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
    assert.throws(() => SessionManager.open(session.file, undefined, session.cwd).buildContextEntries(), /Invalid array length|valid pi session/);
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
  const store = readFileSync(join(process.cwd(), "src/renderer/src/store/appStore.ts"), "utf8");
  assert.ok(chatView.includes("SessionHistoryRecoveryNotice"), "ChatView must surface session-file recovery diagnostics");
  assert.ok(store.includes("sessionRecovery: history.sessionRecovery"), "renderer Task must retain the recovery summary after hydration");
  console.log("session history recovery: PASS (bad tail, bad middle record, read-only fallback, source hash, temp cleanup, UI wiring)");
} finally {
  rmSync(root, { recursive: true, force: true });
}