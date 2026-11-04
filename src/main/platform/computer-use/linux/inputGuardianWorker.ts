import { ComputerUseError } from "../protocol";
import {
  INPUT_GUARDIAN_PROTOCOL,
  InputGuardianEngine,
  type InputGuardianHandshake,
  type InputGuardianReply,
  type InputGuardianRequest,
} from "./inputGuardian";

function handshake(): InputGuardianHandshake {
  const nodeVersion = process.versions.node;
  if (Number(nodeVersion.split(".")[0]) < 24) throw new Error("Input guardian requires Electron's built-in Node >=24");
  return { protocol: INPUT_GUARDIAN_PROTOCOL, backend: "linux-atspi-input-guardian", nodeVersion, pid: process.pid, ready: true };
}
function send(reply: InputGuardianReply): void {
  if (process.connected && process.send) process.send(reply, () => {});
}
async function main(): Promise<void> {
  const ready = handshake();
  if (process.argv.includes("--handshake")) {
    process.stdout.write(JSON.stringify(ready) + "\n");
    return;
  }
  if (!process.send) throw new Error("Input guardian requires an IPC parent");
  const engine = new InputGuardianEngine();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try { await engine.close(); process.exit(0); }
    catch (error) {
      process.stderr.write("Input guardian cleanup failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
      process.exit(1);
    }
  };
  process.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const request = raw as InputGuardianRequest;
    if (!Number.isSafeInteger(request.id) || request.id <= 0) return;
    if (request.type === "cancel") { engine.cancel(request.requestId); return; }
    if (closing) return;
    let result: Promise<Awaited<ReturnType<InputGuardianEngine["execute"]>>>;
    try { result = engine.execute(request.id, request); }
    catch (error) { result = Promise.reject(error); }
    void result.then(value => send({ type: "result", id: request.id, result: value }), (error: unknown) => {
      send({ type: "error", id: request.id, error: {
        code: error instanceof ComputerUseError ? error.code : "HOST_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        details: error instanceof ComputerUseError ? error.details : undefined,
      } });
    });
  });
  process.once("disconnect", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  send({ type: "ready", handshake: ready });
}
void main().catch((error: unknown) => {
  process.stderr.write("Input guardian startup failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
