import * as dbus from "dbus-native";
import dbusPackage from "dbus-native/package.json";
import { ComputerUseError } from "../protocol";
import { AtSpiDriver } from "./atspiDriver";
import { ATSPI_WORKER_PROTOCOL, type AtSpiHandshake, type AtSpiWorkerReply, type AtSpiWorkerRequest } from "./atspiTypes";

function handshake(): AtSpiHandshake {
  const nodeVersion = process.versions.node;
  if (Number(nodeVersion.split(".")[0]) < 24) throw new Error("AT-SPI worker requires Electron's built-in Node >=24");
  if (dbusPackage.version !== "0.16.3" || typeof dbus.createClient !== "function") throw new Error("AT-SPI worker requires bundled dbus-native 0.16.3");
  return { protocol: ATSPI_WORKER_PROTOCOL, backend: "linux-atspi", nodeVersion, dbusNativeVersion: dbusPackage.version, pid: process.pid, ready: true };
}

function send(reply: AtSpiWorkerReply): void {
  if (process.connected && process.send) process.send(reply, () => {});
}

function serializeError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof ComputerUseError) return { code: error.code, message: error.message, details: error.details };
  return { code: "HOST_PROTOCOL_ERROR", message: error instanceof Error ? error.message : String(error) };
}

function isRequest(value: unknown): value is AtSpiWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || Number(request.id) <= 0 || typeof request.method !== "string") return false;
  return ["probe", "inspectWindow", "readControl", "invoke", "setValue", "shutdown", "cancel"].includes(request.method);
}

async function main(): Promise<void> {
  const ready = handshake();
  if (process.argv.includes("--handshake")) {
    process.stdout.write(JSON.stringify(ready) + "\n");
    return;
  }
  const driver = new AtSpiDriver();
  if (process.argv.includes("--probe")) {
    try {
      const result = await driver.probe();
      process.stdout.write(JSON.stringify({ handshake: ready, ...result }) + "\n");
      process.exitCode = result.available ? 0 : 1;
    } finally { await driver.shutdown(); }
    return;
  }
  if (!process.send) throw new Error("AT-SPI worker requires an IPC parent; use --handshake or --probe for diagnostics");
  const controllers = new Map<number, AbortController>();
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const controller of controllers.values()) controller.abort();
    await driver.shutdown();
    if (process.connected) process.disconnect();
    process.exit(0);
  };
  process.on("disconnect", () => { void close(); });
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
  process.on("message", (raw: unknown) => {
    if (!isRequest(raw)) return;
    const request = raw;
    if (request.method === "cancel") {
      controllers.get(request.requestId)?.abort();
      return;
    }
    if (request.method === "shutdown") { void close(); return; }
    if (closing) {
      send({ type: "error", id: request.id, error: { code: "REQUEST_CANCELLED", message: "AT-SPI worker 正在关闭" } });
      return;
    }
    if (controllers.has(request.id) || controllers.size >= 128) {
      send({ type: "error", id: request.id, error: { code: "HOST_PROTOCOL_ERROR", message: "AT-SPI 请求 ID 重复或队列已满" } });
      return;
    }
    const controller = new AbortController();
    controllers.set(request.id, controller);
    queue = queue.catch(() => {}).then(async () => {
      try {
        if (controller.signal.aborted || closing) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 排队请求已取消", { executed: false });
        let result: unknown;
        switch (request.method) {
          case "probe": result = await driver.probe(controller.signal); break;
          case "inspectWindow": result = await driver.inspectWindow(request.window, request.options, controller.signal); break;
          case "readControl": result = await driver.readControl(request.window, request.runtimeId, controller.signal); break;
          case "invoke": result = await driver.invoke(request.window, request.runtimeId, request.actionName, controller.signal); break;
          case "setValue": result = await driver.setValue(request.window, request.runtimeId, request.text, controller.signal); break;
        }
        send({ type: "result", id: request.id, result });
      } catch (error) {
        send({ type: "error", id: request.id, error: serializeError(error) });
      } finally {
        controllers.delete(request.id);
      }
    });
  });
  send({ type: "ready", handshake: ready });
}

void main().catch((error: unknown) => {
  process.stderr.write("AT-SPI worker startup failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
