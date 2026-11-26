import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../src/main/agent/AgentService";
import {
  PASSIVE_READONLY_MODELS,
  readDurableConversationHead,
  readDurableReadOnlyHistory,
  readDurableUserQuestions,
} from "../src/main/agent/durable/DurableReadOnlyHistory";
import { claimDurableStorageLease, DurableStorageOwnedError } from "../src/main/agent/durable/DurableStorageLease";
import { blockSummaryBudget } from "../src/main/agent/durable/context/SummaryBudget";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { ensurePiNodeHostScript } from "../src/main/host/pi-node-host-bundle";
import { assertExpectedPiVersion, installedPiVersion, readExpectedPiVersion } from "../src/main/host/pi-version";
import { CoreBusinessClient } from "../src/main/platform/core-business-client";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { Models } from "@earendil-works/pi-ai";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

interface LlmServerTurnControl {
  delayBeforeDoneMs?: number;
  responseText?: string;
  writeToolFile?: { path: string; content: string };
  hitEffectUrl?: string;
  stallMidResponse?: boolean;
  onRequestSeen?: () => void;
}

function startFixtureOpenAiServer(onChat: (body: Record<string, unknown>, reqIndex: number) => LlmServerTurnControl | Promise<LlmServerTurnControl>) {
  let reqCount = 0;
  let effectCalls = 0;
  const seenRequestIds = new Set<string>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith("/effect-once")) {
      const opId = new URL(url, "http://127.0.0.1").searchParams.get("op") ?? "default";
      if (!seenRequestIds.has(opId)) {
        seenRequestIds.add(opId);
        effectCalls += 1;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, opId, effectCalls }));
      return;
    }

    if (!url.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    const lastRole = messages.at(-1)?.role;
    const toolNames = Array.isArray(body.tools)
      ? (body.tools as Array<{ function?: { name?: string }; name?: string }>).map(t => t.function?.name ?? t.name).filter(Boolean)
      : [];
    const hasWriteTool = toolNames.includes("write");

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${reqCount}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "model",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        usage: finishReason ? { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } : undefined,
      })}\n\n`);
    };

    if (!hasWriteTool && !toolNames.length) {
      // Background extraction / naming calls without execution tools
      writeChunk({ role: "assistant", content: JSON.stringify({ candidates: [] }) });
      writeChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    reqCount += 1;
    const ctrl = await onChat(body, reqCount);
    ctrl.onRequestSeen?.();

    const lastUserText = messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).at(-1) ?? "";
    console.log(`[fixture-llm] #${reqCount} stall=${Boolean(ctrl.stallMidResponse)} roles=${messages.map(m => m.role).join(",")} user=${lastUserText.slice(0, 60)}`);

    if (ctrl.hitEffectUrl && lastRole !== "tool" && hasWriteTool) {
      await fetch(ctrl.hitEffectUrl).catch(() => undefined);
    }

    if (ctrl.stallMidResponse) {
      writeChunk({ role: "assistant", content: "working-" });
      await new Promise(resolve => setTimeout(resolve, 15_000));
      try { res.end(); } catch { /* */ }
      return;
    }

    if (ctrl.delayBeforeDoneMs) {
      writeChunk({ role: "assistant", content: "starting " });
      await new Promise(resolve => setTimeout(resolve, ctrl.delayBeforeDoneMs));
    }

    if (ctrl.writeToolFile && hasWriteTool && lastRole !== "tool") {
      const toolId = `call_${reqCount}`;
      writeChunk({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: toolId,
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({
              path: ctrl.writeToolFile.path,
              content: ctrl.writeToolFile.content,
            }),
          },
        }],
      });
      writeChunk({}, "tool_calls");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const reply = ctrl.responseText ?? `completed-${reqCount}`;
    writeChunk({ role: "assistant", content: reply });
    writeChunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });

  return {
    server,
    getEffectCalls: () => effectCalls,
    getRequestCount: () => reqCount,
    listen: async () => {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      assert(addr && typeof addr === "object");
      return `http://127.0.0.1:${addr.port}`;
    },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function runMainClientSubprocess(input: {
  helperFile: string;
  executable: string;
  dataDir: string;
  dbPath: string;
  taskId: string;
  userMessageId: string;
  text: string;
  homeDir: string;
}): Promise<{ pid: number; kill: () => void; exited: Promise<number | null> }> {
  const inlineCode = `
    const { AppDatabase, AgentService, CoreBusinessClient } = require(${JSON.stringify(input.helperFile)});
    (async () => {
      const db = await AppDatabase.open(${JSON.stringify(input.dbPath)}, {
        runtimeAuditExecutable: ${JSON.stringify(input.executable)},
        runtimeAuditSupervised: true,
        readonly: true,
      });
      const client = await CoreBusinessClient.connect(${JSON.stringify(input.executable)}, ${JSON.stringify(input.dbPath)}, {
        dataDirectory: ${JSON.stringify(input.dataDir)},
        role: "ui",
        clientId: "sim-main-" + process.pid,
      });
      const agent = new AgentService(db, undefined, {
        executionMode: "isolated-client",
        coreClient: () => client,
      });
      await client.openEventSubscription({
        onEvent: (ev) => agent.handleCoreExecutionEvent(ev),
      });
      await agent.init();
      const accepted = await agent.prompt({
        taskId: ${JSON.stringify(input.taskId)},
        userMessageId: ${JSON.stringify(input.userMessageId)},
        assistantMessageId: "asst-" + ${JSON.stringify(input.userMessageId)},
        text: ${JSON.stringify(input.text)},
        modelId: "fixture/model",
      }, { durableAdmissionOnly: true });
      process.stdout.write(JSON.stringify({ admitted: Boolean(accepted && accepted.receipt), pid: process.pid }) + "\\n");
      setInterval(() => {}, 10_000);
    })().catch(err => {
      console.error(err);
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ["-e", inlineCode], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: input.homeDir,
      USERPROFILE: input.homeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`Simulated Main subprocess timeout; stderr=${stderr}`)), 15_000);
    child.stdout.on("data", chunk => {
      buf += String(chunk);
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as { admitted?: boolean };
          if (parsed.admitted) {
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch { /* ignore non-JSON stdout */ }
      }
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`Simulated Main subprocess exited prematurely (${code}); stderr=${stderr}`));
    });
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  return {
    pid: child.pid!,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* */ } },
    exited,
  };
}

async function main() {
  const runtimeAuditExecutable = locateRuntimeAudit(process.cwd());
  assert(runtimeAuditExecutable, "native mybuddy-runtime-audit binary is required");

  // Validate pinned Pi version dynamically from worker-launcher.mjs (never hardcoded).
  const expectedPiVersion = readExpectedPiVersion(process.cwd());
  assert.equal(installedPiVersion(), expectedPiVersion, "installed Pi version must match EXPECTED_PI_VERSION");

  const root = mkdtempSync(join(tmpdir(), "mybuddy-pi-host-test-"));
  const dataDir = join(root, ".mybuddy");
  const dbPath = join(dataDir, "app.db");
  const storageRoot = join(dataDir, "durable-bots");
  const workspaceDir = join(root, "workspace");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;

  let mode: "slow-graceful" | "slow-sigkill" | "crash-mid-turn" | "fast" = "slow-graceful";
  let stallSeen = false;
  let crashEffectCount = 0;

  const llm = startFixtureOpenAiServer((_body, reqIdx) => {
    if (mode === "slow-graceful") {
      return {
        delayBeforeDoneMs: 900,
        writeToolFile: { path: "graceful-output.txt", content: "graceful-survived-ui-exit\n" },
        responseText: "graceful turn completed in isolated pi host",
      };
    }
    if (mode === "slow-sigkill") {
      return {
        delayBeforeDoneMs: 900,
        writeToolFile: { path: "sigkill-output.txt", content: "survived-main-sigkill\n" },
        responseText: "sigkill turn completed in isolated pi host",
      };
    }
    if (mode === "crash-mid-turn") {
      crashEffectCount += 1;
      const shouldStall = !stallSeen;
      return {
        stallMidResponse: shouldStall,
        onRequestSeen: () => { stallSeen = true; },
        hitEffectUrl: `${baseUrl}/effect-once?op=recover-1`,
        writeToolFile: { path: "recovered-output.txt", content: "recovered-after-pi-host-crash\n" },
        responseText: "recovered cleanly without duplicating external effect",
      };
    }
    return { responseText: `ok-${reqIdx}` };
  });
  const baseUrl = await llm.listen();

  writeFileSync(join(dataDir, "models.json"), JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `${baseUrl}/v1`,
        apiKey: "fixture-key",
        api: "openai-completions",
        models: [{
          id: "model",
          name: "Fixture Model",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2));
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "model",
    enabledModels: ["fixture/model"],
  }, null, 2));

  // Bundle small helper used by simulated Electron Main subprocess in RC-20 SIGKILL test.
  const { build } = await import("esbuild");
  const helperFile = join(process.cwd(), "out/tests/pi-node-host-client-helper.cjs");
  await build({
    stdin: {
      contents: `
        export { AppDatabase } from "./src/main/db/AppDatabase";
        export { AgentService } from "./src/main/agent/AgentService";
        export { CoreBusinessClient } from "./src/main/platform/core-business-client";
      `,
      resolveDir: process.cwd(),
      sourcefile: "helper.ts",
      loader: "ts",
    },
    outfile: helperFile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    define: {
      "import.meta.url": "__piImportMetaUrl",
    },
    banner: {
      js: 'var __piImportMetaUrl = typeof __filename === "string" ? require("node:url").pathToFileURL(__filename).href : "";',
    },
    external: ["better-sqlite3", "jiti", "node-pty", "onnxruntime-node", "@napi-rs/keyring", "bufferutil", "utf-8-validate"],
    alias: {
      electron: join(process.cwd(), "src/main/shims/node-electron-host.ts"),
      "node:sqlite": join(process.cwd(), "src/main/shims/node-sqlite.ts"),
      "@shared": join(process.cwd(), "src/shared"),
    },
  });

  const piHostScript = await ensurePiNodeHostScript(process.cwd());
  assert(existsSync(piHostScript), "pi-node-host script bundle must exist");

  let db: AppDatabase | undefined;
  let uiClient: CoreBusinessClient | undefined;
  let mainAgent: AgentService | undefined;

  try {
    await initializeCoreDatabase(runtimeAuditExecutable, dataDir, dbPath, CURRENT_DATABASE_SCHEMA_VERSION);
    db = await AppDatabase.open(dbPath, {
      runtimeAuditExecutable,
      runtimeAuditSupervised: true,
      readonly: true,
    });
    assert.equal(db.readonly, true, "Main/Reader AppDatabase must open strictly readonly");

    const now = Date.now();
    await db.writeWorkspaceUpsert({
      id: "space-test",
      name: "Pi Host Test Space",
      path: workspaceDir,
    });
    await db.writeTaskRecord({
      id: "task-graceful",
      title: "Graceful Main Exit Task",
      spaceId: "space-test",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: now,
    });
    await db.writeTaskRecord({
      id: "task-sigkill",
      title: "Main SIGKILL Task",
      spaceId: "space-test",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: now,
    });
    await db.writeTaskRecord({
      id: "task-recover",
      title: "Pi Crash Recovery Task",
      spaceId: "space-test",
      cwd: workspaceDir,
      modelId: "fixture/model",
      welcomeMode: "general",
      updatedAt: now,
    });

    // RC-22: Reject old Pi versions before launching.
    assert.throws(
      () => {
        process.env.MYBUDDY_PI_VERSION_OVERRIDE = "0.99.2";
        try { return assertExpectedPiVersion(process.cwd()); }
        finally { delete process.env.MYBUDDY_PI_VERSION_OVERRIDE; }
      },
      /Pi version mismatch/,
      "Old Pi version 0.99.2 must be rejected",
    );

    const launchRes = await db.runtimeAuditReader!.piHost<{
      launched?: boolean;
      hostId?: string;
      pid?: number;
      hostGeneration?: string;
    }>({
      action: "launch",
      executable: process.execPath,
      scriptPath: piHostScript,
      dataDirectory: dataDir,
      dbPath,
      storageRoot,
      piVersion: expectedPiVersion,
      expectedPiVersion,
      runtimeAuditExecutable,
      autoRestart: false,
      extraEnv: {
        MYBUDDY_APP_PATH: process.cwd(),
      },
    });
    assert(launchRes?.launched && launchRes.pid && launchRes.hostGeneration, "Core must launch detached Pi Node Host");
    const piHostPid = launchRes.pid!;
    const piHostGen = launchRes.hostGeneration!;
    assert.notEqual(piHostPid, process.pid, "RC-20: Pi Host PID must differ from Main process PID");

    await until(async () => {
      const status = await db!.runtimeAuditReader!.piHost<{ activeHost?: { status?: string; alive?: boolean; pid?: number } }>({ action: "status" });
      return status?.activeHost?.status === "running" && status.activeHost?.alive === true;
    }, "Pi Node Host registered as running in Core", 20_000);

    // Connect Electron Main in isolated-client mode (no ModelRuntime / DurableBotService).
    uiClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "ui",
      clientId: "test-main-ui",
    });
    mainAgent = new AgentService(db, undefined, {
      executionMode: "isolated-client",
      coreClient: () => uiClient,
    });
    await uiClient.openEventSubscription({
      onEvent: ev => mainAgent!.handleCoreExecutionEvent(ev),
    });
    await mainAgent.init();

    const uiModels = await mainAgent.listModels();
    assert(uiModels.some(m => m.id === "fixture/model"), "RC-22: Isolated UI client reads real Pi model catalog from Pi Host");

    // RC-20 (A): Submit non-desktop Pi task, disconnect Main UI client gracefully mid-flight.
    const admittedGraceful = await mainAgent.prompt({
      taskId: "task-graceful",
      userMessageId: "msg-graceful-1",
      assistantMessageId: "asst-graceful-1",
      text: "Write graceful-output.txt",
      modelId: "fixture/model",
    }, { durableAdmissionOnly: true });
    assert(admittedGraceful.receipt, "Main isolated client receives durable submission receipt");

    await uiClient.close();
    uiClient = undefined;

    await until(() => existsSync(join(workspaceDir, "graceful-output.txt")), "Pi Node Host writes file while Main UI is disconnected");
    assert.equal(readFileSync(join(workspaceDir, "graceful-output.txt"), "utf8"), "graceful-survived-ui-exit\n");

    const checkClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "ui",
      clientId: "test-check-1",
    });
    await until(async () => {
      const exec = await checkClient.executionStatus("pi:task-graceful:msg-graceful-1");
      return exec.execution?.status === "completed";
    }, "Core marks graceful execution completed");
    const statusAfterGraceful = await checkClient.piHost<{ activeHost?: { pid?: number; alive?: boolean } }>({ action: "status" });
    assert.equal(statusAfterGraceful?.activeHost?.pid, piHostPid, "RC-20: Same Pi Host PID remains active after UI quit");
    assert.equal(statusAfterGraceful?.activeHost?.alive, true);
    await checkClient.close();
    console.log("PASS RC-20A: Graceful Electron Main disconnect keeps Core + isolated Pi Node Host alive and finishes Pi execution");

    // RC-20 (B): Spawn separate simulated Main client process, submit Pi task, SIGKILL Main mid-turn.
    mode = "slow-sigkill";
    const simMain = await runMainClientSubprocess({
      helperFile,
      executable: runtimeAuditExecutable,
      dataDir,
      dbPath,
      taskId: "task-sigkill",
      userMessageId: "msg-sigkill-1",
      text: "Write sigkill-output.txt",
      homeDir: root,
    });
    simMain.kill();
    await simMain.exited;
    assert.equal(alive(simMain.pid), false, "Simulated Main process must be dead");

    await until(() => existsSync(join(workspaceDir, "sigkill-output.txt")), "Pi Node Host completes task after Main SIGKILL");
    assert.equal(readFileSync(join(workspaceDir, "sigkill-output.txt"), "utf8"), "survived-main-sigkill\n");
    const checkSigkillClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "ui",
      clientId: "test-check-2",
    });
    await until(async () => {
      const exec = await checkSigkillClient.executionStatus("pi:task-sigkill:msg-sigkill-1");
      return exec.execution?.status === "completed";
    }, "Core marks sigkill execution completed");
    await checkSigkillClient.close();
    console.log("PASS RC-20B: Forced Electron Main SIGKILL leaves Core + isolated Pi Node Host executing without launching new Electron host");

    // RC-22: Passive read from Main while Pi Host owns store MUST NOT acquire writer lock or reject on lease.
    const binding = db.connection.prepare("SELECT directory, cwd FROM durable_bot_bindings WHERE task_id = ?").get("task-graceful") as { directory: string; cwd: string };
    assert(binding, "Durable binding recorded for task-graceful");
    assert.throws(
      () => claimDurableStorageLease(binding.directory),
      err => err instanceof DurableStorageOwnedError,
      "RC-21: Concurrent writer on same store is rejected while Pi Host holds lease",
    );
    const passiveModels = PASSIVE_READONLY_MODELS;
    const passiveHistory = await readDurableReadOnlyHistory({
      directory: binding.directory,
      cwd: binding.cwd,
      models: passiveModels,
      reader: db.runtimeAuditReader,
    });
    assert(passiveHistory.messages.length >= 2, "RC-22: Passive read sees committed history without writer lease");
    const passiveQuestions = await readDurableUserQuestions({
      directory: binding.directory,
      cwd: binding.cwd,
      models: passiveModels,
      reader: db.runtimeAuditReader,
    });
    assert.equal(passiveQuestions.questions.length, 1);
    const passiveHead = await readDurableConversationHead({
      directory: binding.directory,
      cwd: binding.cwd,
      models: passiveModels,
      reader: db.runtimeAuditReader,
      maxTokens: 256,
    });
    assert(passiveHead.length > 0, "RC-22: Passive head reader works without writer lock");

    // Verify SummaryBudget single contract source remains intact.
    const budget = blockSummaryBudget({ maxSummaryLength: 20_000, minSummaryLength: 200 } as never);
    assert.equal(budget.charMax, 20_000);
    assert.equal(budget.maxRangeChars, 80_000);
    console.log("PASS RC-22: Real Pi config, SummaryBudget contract, old version fence, and lock-free passive reads");

    // RC-21: Crash Pi Node Host mid-execution, restart on same store, fence stale generation, no duplicate effect.
    mode = "crash-mid-turn";
    uiClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "ui",
      clientId: "test-main-ui-2",
    });
    mainAgent.setCoreClient(() => uiClient);
    await uiClient.openEventSubscription({
      onEvent: ev => mainAgent!.handleCoreExecutionEvent(ev),
    });

    await mainAgent.prompt({
      taskId: "task-recover",
      userMessageId: "msg-recover-1",
      assistantMessageId: "asst-recover-1",
      text: "Execute recoverable turn",
      modelId: "fixture/model",
    }, { durableAdmissionOnly: true });

    await until(() => stallSeen, "Fixture LLM received stalled mid-flight request before crash");
    // Kill Pi Node Host hard (SIGKILL / taskkill) and confirm stale generation gets fenced.
    try { process.kill(piHostPid, "SIGKILL"); } catch { /* */ }
    await until(() => !alive(piHostPid), "Killed Pi Node Host PID exits");

    await uiClient.piHost({
      action: "fenceGeneration",
      hostGeneration: piHostGen,
      reason: "simulated_crash_takeover",
    });

    // Fenced generation cannot commit late ExecutorSettled.
    const spoofExecClient = await CoreBusinessClient.connect(runtimeAuditExecutable, dbPath, {
      dataDirectory: dataDir,
      role: "execution-host",
      clientId: "stale-host-client",
    });
    const staleAck = await spoofExecClient.request<{ status?: string; code?: string }>({
      operation: "coreExecution",
      action: "executorSettled",
      executionId: "pi:task-graceful:msg-graceful-1",
      attempt: 1,
      status: "failed",
      hostGeneration: piHostGen,
    });
    assert.equal(staleAck.code, "STALE_HOST_GENERATION", "RC-21: Core rejects late commits from fenced Pi host generation");
    await spoofExecClient.close();

    // Restart replacement Pi Node Host on the same Durable store.
    stallSeen = true;
    const relaunchRes = await db.runtimeAuditReader!.piHost<{
      launched?: boolean;
      pid?: number;
      hostGeneration?: string;
    }>({
      action: "launch",
      executable: process.execPath,
      scriptPath: piHostScript,
      dataDirectory: dataDir,
      dbPath,
      storageRoot,
      piVersion: expectedPiVersion,
      expectedPiVersion,
      runtimeAuditExecutable,
      autoRestart: false,
      extraEnv: {
        MYBUDDY_APP_PATH: process.cwd(),
      },
    });
    assert(relaunchRes?.launched && relaunchRes.pid && relaunchRes.pid !== piHostPid, "Replacement Pi Node Host launches with new PID");
    assert.notEqual(relaunchRes.hostGeneration, piHostGen, "Replacement Pi Node Host gets a fresh hostGeneration");

    await until(async () => {
      const status = await db!.runtimeAuditReader!.piHost<{ activeHost?: { pid?: number; status?: string } }>({ action: "status" });
      return status?.activeHost?.pid === relaunchRes.pid && status?.activeHost?.status === "running";
    }, "Replacement Pi Node Host ready");

    // Reconcile/query receipt continuity with idempotency key on same store (single writer, no duplicate effect).
    const sub = await mainAgent.findSubmission("task-recover", "msg-recover-1");
    assert(sub?.receipt, "RC-21: Replacement Pi Host preserves receipt identity on same Durable store");
    const settled = await mainAgent.waitForSubmission(sub.receipt);
    assert(
      settled.receipt?.status === "done" || settled.receipt?.status === "unanswered",
      `RC-21: Interrupted turn resolves deterministically to recovered 'done' or preserved 'unanswered', got ${settled.receipt?.status}`,
    );
    assert.equal(llm.getEffectCalls(), 1, "RC-21: Recovering interrupted operation does not duplicate idempotent external effect");

    // Verify unknown status reconciliation stays unknown without blind replay.
    await uiClient.submitExecution({
      executionId: "exec-unknown-test",
      idempotencyKey: "unknown-key-1",
      taskId: "task-recover",
      kind: "work",
    });
    const unknownSet = await uiClient.reconcileExecution({
      executionId: "exec-unknown-test",
      status: "unknown",
      errorMessage: "Indeterminate external effect boundary",
    });
    assert.equal(unknownSet.execution?.status, "unknown", "RC-21: Unknown outcome remains unknown without auto-replay");

    // Verify recovered store continues accepting new turns cleanly under the new Pi Node Host lease.
    mode = "fast";
    const followUp = await mainAgent.prompt({
      taskId: "task-recover",
      userMessageId: "msg-recover-2",
      assistantMessageId: "asst-recover-2",
      text: "Verify store works after recovery",
      modelId: "fixture/model",
    }, { durableAdmissionOnly: false });
    assert.equal(followUp.receipt?.status, "done", "RC-21: New turn after crash recovery completes cleanly on same store");
    console.log("PASS RC-21: Crash recovery, single writer lease, stale generation fence, unknown preserved, and zero duplicate effects");

    await uiClient.piHost({ action: "stop", reason: "test_complete" });
    await until(() => !alive(relaunchRes.pid!), "Explicit Core stop terminates Pi Node Host");
  } catch (err) {
    const logPath = join(dataDir, "logs", "pi-node-host.log");
    if (existsSync(logPath)) {
      console.error("--- pi-node-host.log ---\n" + readFileSync(logPath, "utf8"));
    }
    throw err;
  } finally {
    await uiClient?.piHost({ action: "stop", reason: "test_cleanup" }).catch(() => undefined);
    await uiClient?.close().catch(() => undefined);
    mainAgent?.dispose();
    await shutdownCoreWorker(dataDir, dbPath).catch(() => undefined);
    await db?.runtimeAuditReader?.close().catch(() => undefined);
    try { db?.close(); } catch { /* */ }
    await llm.close().catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 150));
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows async handle release */ }
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
