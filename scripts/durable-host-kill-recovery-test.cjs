/**
 * 真实宿主强杀 / 恢复实测（Durable Bot + 进程内 subagent）。
 *
 * 为什么是这个脚本：
 * - scripts/durable-session-recovery-test.ts 用注入式 MemoryStorage 在**同一个进程内**制造失败；
 *   scripts/execution-restart-recovery-test.ts 直接构造 DB 行。两者都不回答"真实宿主被强杀后
 *   子会话能否继续、已落盘写入是否被重放"。
 * - 本脚本用真实 Electron 主机（本仓库当前 dev 构建产物 out/）+ 真实 Durable JSONL + 真实
 *   subagent 子会话，按**可观测的产品状态**决定何时强杀，杀的是本轮自己启动并已核对身份的 PID。
 *
 * 模型端点是本地确定性 fixture（与 scripts/durable-bot-desktop-test.cjs 同一手法）：隔离 profile
 * 不允许读取真实账号凭据，因此本脚本只对宿主/存储/子会话/文件事实下结论，不声称验证真实模型行为。
 *
 * 用法：
 *   node scripts/durable-host-kill-recovery-test.cjs --scenario baseline
 *   node scripts/durable-host-kill-recovery-test.cjs --scenario checkpoint
 *   node scripts/durable-host-kill-recovery-test.cjs --scenario effect
 *   node scripts/durable-host-kill-recovery-test.cjs --scenario all
 * 产物：out/host-kill-recovery/<scenario>/{results.json,provider-trace.jsonl,timeline.json,host-*.log}
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const net = require("node:net");

const root = path.resolve(__dirname, "..");
const harness = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const TASK_PREFIX = "KILLRECON";
const CHILD_MARKER = "KILLRECON_CHILD";
const FILES = 20;
const CHECKPOINTS = [5, 10, 15, 20];

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function fileFact(file) {
  if (!fs.existsSync(file)) return { path: file, exists: false };
  const stat = fs.statSync(file);
  const bytes = fs.readFileSync(file);
  return { path: file, exists: true, bytes: bytes.length, sha256: sha(bytes), mtimeMs: stat.mtimeMs, mtime: new Date(stat.mtimeMs).toISOString() };
}

/** 只按精确 PID 操作；动作前核对命令行与创建时间，防 PID 复用。 */
function processFacts(pid) {
  if (!pid) return null;
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{pid=$p.ProcessId;ppid=$p.ParentProcessId;name=$p.Name;created=$p.CreationDate.ToUniversalTime().ToString('o');cmd=$p.CommandLine} | ConvertTo-Json -Compress } else { 'null' }`;
  try {
    const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim();
    return out === "null" ? null : JSON.parse(out);
  } catch { return null; }
}

function descendants(pid) {
  const script = `$all = Get-CimInstance Win32_Process; $out = @(); $frontier = @(${pid}); while ($frontier.Count -gt 0) { $next = @(); foreach ($f in $frontier) { $kids = $all | Where-Object { $_.ParentProcessId -eq $f }; foreach ($k in $kids) { $out += [pscustomobject]@{pid=$k.ProcessId;ppid=$k.ParentProcessId;name=$k.Name;created=$k.CreationDate.ToUniversalTime().ToString('o');cmd=$k.CommandLine}; $next += $k.ProcessId } }; $frontier = $next }; if ($out.Count -eq 0) { '[]' } else { $out | ConvertTo-Json -Compress }`;
  try {
    const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30000 }).trim();
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

/** 强杀宿主主进程（不带 /T）：子进程死活本身是观测项，不能被静默一起杀掉。 */
function killHostPid(pid, identity) {
  const facts = processFacts(pid);
  if (!facts) return { attempted: false, reason: "进程已不存在" };
  if (identity && (facts.created !== identity.created || facts.name !== identity.name)) {
    return { attempted: false, reason: "PID 身份与启动记录不一致", facts, identity };
  }
  cp.execFileSync("C:/Windows/System32/taskkill.exe", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
  return { attempted: true, pid, at: now(), identity: facts };
}

function treeKill(pid) {
  if (!pid) return;
  try { cp.execFileSync("C:/Windows/System32/taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15000 }); } catch { /* already gone */ }
}

// ---------------------------------------------------------------- fixture provider

function contentFor(index) {
  return `task=${TASK_PREFIX}\nindex=${String(index).padStart(2, "0")}\npayload=${sha(`${TASK_PREFIX}:${index}`).slice(0, 32)}\n`;
}

function checkpointContent(upTo) {
  return CHECKPOINTS.filter((value) => value <= upTo).map((value) => `checkpoint ${String(value).padStart(2, "0")} files=${value}\n`).join("");
}

function buildPlan(scenario) {
  const steps = [];
  for (let index = 1; index <= FILES; index += 1) {
    const rel = `data/${String(index).padStart(2, "0")}.txt`;
    if (scenario === "effect" && index === 10) {
      // 真实外部副作用：先把字节落盘并留下完成标记，再阻塞等待宿主放行；放行前工具调用不可能返回。
      const content = contentFor(index).replace(/\r?\n/g, "`n");
      steps.push({
        kind: "shell",
        rel,
        content: contentFor(index),
        command: `[IO.File]::WriteAllText((Join-Path $PWD 'data/10.txt'), "${content}"); [IO.File]::WriteAllText((Join-Path $PWD '.effect-10.done'), 'done'); while (-not (Test-Path (Join-Path $PWD '.effect-10.allow'))) { Start-Sleep -Milliseconds 100 }`,
      });
    } else {
      steps.push({ kind: "write", rel, content: contentFor(index) });
    }
    if (CHECKPOINTS.includes(index)) steps.push({ kind: "write", rel: "checkpoints.log", content: checkpointContent(index), checkpoint: index });
  }
  return steps;
}

function fixtureProvider(scenario, traceFile) {
  const requests = [];
  const plan = buildPlan(scenario);
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    const messages = body.messages || [];
    const tools = (body.tools || []).map((tool) => tool.function?.name).filter(Boolean);
    // 结构判据：子会话的工具集里永远没有 subagent（递归工具被硬排除）。
    const isChild = !tools.includes("subagent");
    const toolMessages = messages.filter((message) => message.role === "tool").length;
    const parentDelegated = messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.function?.name === "subagent"));
    const entry = { at: now(), seq: requests.length, scope: isChild ? "child" : "parent", toolMessages, tools, bytes: raw.length };
    if (traceFile) fs.appendFileSync(traceFile, JSON.stringify(entry) + "\n");
    requests.push(entry);

    let call;
    if (isChild) {
      const step = toolMessages < plan.length ? plan[toolMessages] : undefined;
      if (step?.kind === "write") call = { name: "write", arguments: { path: step.rel, content: step.content } };
      else if (step?.kind === "shell") call = { name: tools.includes("powershell") ? "powershell" : "bash", arguments: { command: step.command } };
    } else if (!parentDelegated) {
      call = {
        name: "subagent",
        arguments: { agent: "worker", displayName: "长跑测试员", task: `${CHILD_MARKER} 在当前工作目录顺序完成 ${FILES} 个文件与 ${CHECKPOINTS.length} 次检查点。` },
      };
    }
    const finish = isChild && !call ? "KILLRECON_CHILD_DONE" : !isChild && parentDelegated && !call ? "KILLRECON_PARENT_DONE" : undefined;
    entry.decision = call ? call.name : finish;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `${entry.scope}-call-${entry.seq}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
      : { role: "assistant", content: finish };
    const packet = (payload, reason) => ({ id: `chatcmpl-${entry.seq}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta: payload, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240, prompt_tokens_details: { cached_tokens: 0 } } } : {}) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + JSON.stringify(packet(delta, null)) + "\n\n");
    // finish_reason 必须是 tool_calls，Durable 才会进入工具执行（stop 会直接收尾）。
    res.end("data: " + JSON.stringify(packet({}, call ? "tool_calls" : "stop")) + "\n\ndata: [DONE]\n\n");
  });
  return { server, requests, plan };
}

// ---------------------------------------------------------------- electron + CDP

function makeDriver() {
  let proc; let socket; let log; let port; let seq = 0;
  let exitInfo = null;
  const pending = new Map();
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await rpc("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  async function until(predicate, label, timeout = 60000) {
    const started = Date.now();
    for (;;) {
      try { if (await predicate()) return Date.now() - started; } catch { /* retry */ }
      if (Date.now() - started > timeout) throw new Error(`timeout: ${label}`);
      await wait(200);
    }
  }
  async function launch(profile, label) {
    port = await freePort();
    log = fs.openSync(path.join(profile.out, `host-${label}.log`), "a");
    const env = { ...process.env, HOME: profile.home, USERPROFILE: profile.home, APPDATA: path.join(profile.home, "AppData/Roaming"), LOCALAPPDATA: path.join(profile.home, "AppData/Local") };
    // 本脚本由真实 MyBuddy 进程拉起，环境里带着真实 profile 指针与真实 API key：
    // 隔离实例只能用临时 profile，绝不能读到真实 subagent.json / 真实凭据 / 真实 dev 渲染服务。
    env.PI_CODING_AGENT_DIR = profile.agentDir;
    for (const key of Object.keys(env)) if (/(?:^|_)(?:API_KEY|TOKEN|SECRET)$/.test(key)) delete env[key];
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    proc = cp.spawn(harness, [root, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"], { cwd: root, env, stdio: ["ignore", log, log], windowsHide: true });
    proc.once("exit", (code, signal) => { exitInfo = { code, signal, at: now() }; });
    const identity = processFacts(proc.pid);
    let target;
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`Electron exited ${proc.exitCode}`);
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        target = list.find((item) => item.type === "page" && item.url.includes("index.html"));
        return Boolean(target);
      } catch { return false; }
    }, "electron renderer", 90000);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return;
      pending.delete(message.id); clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    });
    await rpc("Runtime.enable");
    await until(() => evaluate("Boolean(window.api?.agent && window.api?.db)"), "app ready", 120000);
    return { pid: proc.pid, identity, port, launchedAt: now() };
  }
  async function close() {
    if (socket) { try { socket.close(); } catch { /* ignore */ } socket = null; }
    if (proc && proc.exitCode === null) treeKill(proc.pid);
    proc = null;
    if (log !== undefined) { fs.closeSync(log); log = undefined; }
  }
  return { launch, close, evaluate, until, rpc, get pid() { return proc?.pid; }, get alive() { return Boolean(proc && proc.exitCode === null); }, get exitInfo() { return exitInfo; } };
}

// ---------------------------------------------------------------- profile

function makeProfile(scenario, port) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `mybuddy-killrecon-${scenario}-`));
  const home = path.join(base, "home");
  const agentDir = path.join(home, ".mybuddy");
  const scratch = path.join(base, "scratch");
  const out = path.join(root, "out", "host-kill-recovery", scenario);
  for (const dir of [agentDir, scratch, path.join(home, "AppData/Roaming"), path.join(home, "AppData/Local"), path.join(agentDir, "agents"), out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: General-purpose subagent with full capabilities, isolated context\n---\n\nYou are a worker agent with full capabilities.\n");
  const model = { id: "fixture", name: "Durable Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "durable-fixture": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only", models: [model] } } }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "durable-fixture", defaultModel: "fixture", enabledModels: ["durable-fixture/fixture"], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: "light", permissionMode: "auto" }));
  fs.writeFileSync(path.join(agentDir, "subagent.json"), JSON.stringify({ defaultModel: "durable-fixture/fixture" }));
  return { scenario, base, home, agentDir, scratch, out };
}

function durableSnapshot(agentDir) {
  const dir = path.join(agentDir, "durable");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const files = fs.existsSync(full) ? fs.readdirSync(full).filter((file) => file.endsWith(".jsonl")).map((file) => fileFact(path.join(full, file))) : [];
    return { session: name, files };
  });
}

/** 从 durable JSONL 直接数事实：提交数、工具结果数、每个目标路径的写入结果数。 */
function durableFacts(agentDir) {
  const dir = path.join(agentDir, "durable");
  const facts = { sessions: [], commits: 0, toolResults: 0, subagentResults: [], interruptedResults: [], subagentTools: 0, writeResults: {}, toolCalls: 0, submissions: 0, placedSubmissions: [], userMessages: 0, conversations: new Set() };
  if (!fs.existsSync(dir)) return { ...facts, conversations: [] };
  for (const session of fs.readdirSync(dir)) {
    const file = path.join(dir, session, "main.jsonl");
    if (!fs.existsSync(file)) continue;
    facts.sessions.push({ session, bytes: fs.statSync(file).size });
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "commit") facts.commits += 1;
      for (const write of record.writes || []) {
        if (write.type === "submission") {
          facts.submissions += 1;
          // placed = 真正提交一次输入；done 是同一 requestId 的收尾记录，不能用来判断"是否重新提交"。
          if (write.value?.status === "placed") facts.placedSubmissions.push(`${write.value.conversationId}::${write.value.requestId}`);
        }
        const value = write.value;
        if (!value) continue;
        if (value.kind === "pi.tool-result") {
          facts.toolResults += 1;
          facts.conversations.add(value.conversationId);
          const message = (value.model || [])[0] || {};
          if (message.toolName === "subagent") {
            facts.subagentTools += 1;
            facts.subagentResults.push({ isError: Boolean(message.isError), text: JSON.stringify(message.content || "").slice(0, 600) });
          }
          if (message.isError) facts.interruptedResults.push({ tool: message.toolName, content: JSON.stringify(message.content || "").slice(0, 200) });
          if (message.toolName === "write" || message.toolName === "powershell" || message.toolName === "bash") {
            const text = JSON.stringify(message.content || "");
            const data = /data\/(\d\d)\.txt/.exec(text);
            const key = data ? `data/${data[1]}.txt` : /checkpoints\.log/.test(text) ? "checkpoints.log" : `${message.toolName}:unmatched`;
            facts.writeResults[key] = (facts.writeResults[key] || 0) + 1;
          }
        }
        if (value.kind === "pi.assistant") for (const message of value.model || []) for (const part of message.content || []) if (part.type === "toolCall") facts.toolCalls += 1;
        if (value.model) for (const message of value.model) {
          if (message.role !== "user") continue;
          const text = JSON.stringify(message.content || "");
          if (text.includes("跑一遍完整流程")) facts.userMessages += 1;
        }
      }
    }
  }
  facts.conversations = [...facts.conversations];
  return facts;
}

/** durable 日志里的 assistant 文本（产品真实提交，不依赖 UI 投影字段）。 */
function durableTexts(agentDir) {
  const dir = path.join(agentDir, "durable");
  const texts = [];
  if (!fs.existsSync(dir)) return texts;
  for (const session of fs.readdirSync(dir)) {
    const file = path.join(dir, session, "main.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(String.fromCharCode(10))) {
      let record; try { record = JSON.parse(line); } catch { continue; }
      for (const write of record.writes || []) {
        const value = write.value;
        if (!value || value.kind !== "pi.assistant") continue;
        for (const message of value.model || []) {
          const text = (message.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
          if (text) texts.push(text);
        }
      }
    }
  }
  return texts;
}

/** Durable 存储单写者租约：记录 owner pid，用于证明重启后是新宿主接管而不是死锁/双写。 */
function leaseOwner(agentDir) {
  const dir = path.join(agentDir, "durable");
  if (!fs.existsSync(dir)) return [];
  const owners = [];
  for (const session of fs.readdirSync(dir)) {
    const file = path.join(dir, session, ".mybuddy-owner.json");
    if (!fs.existsSync(file)) continue;
    try { owners.push({ session, owner: JSON.parse(fs.readFileSync(file, "utf8")) }); } catch (error) { owners.push({ session, error: String(error) }); }
  }
  return owners;
}

function collectFiles(dir) {
  const list = [];
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else list.push(fileFact(full));
    }
  };
  walk(dir);
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

function expectationFor(cwd) {
  const expected = [];
  for (let index = 1; index <= FILES; index += 1) {
    const content = contentFor(index);
    expected.push({ rel: `data/${String(index).padStart(2, "0")}.txt`, path: path.join(cwd, "data", `${String(index).padStart(2, "0")}.txt`), sha256: sha(content), bytes: content.length });
  }
  const checkpoints = checkpointContent(FILES);
  expected.push({ rel: "checkpoints.log", path: path.join(cwd, "checkpoints.log"), sha256: sha(checkpoints), bytes: checkpoints.length, content: checkpoints });
  return expected;
}

module.exports = { fixtureProvider, makeProfile, makeDriver, durableFacts, durableSnapshot, durableTexts, leaseOwner, collectFiles, expectationFor, contentFor, checkpointContent, processFacts, descendants, killHostPid, treeKill, freePort, fileFact, wait, now, sha, root, harness, TASK_PREFIX, FILES, CHECKPOINTS };

if (require.main === module) {
  const scenarioArg = process.argv.indexOf("--scenario");
  const scenario = scenarioArg > -1 ? process.argv[scenarioArg + 1] : "baseline";
  const { runScenario } = require("./durable-host-kill-recovery-scenarios.cjs");
  void runScenario(scenario);
}
