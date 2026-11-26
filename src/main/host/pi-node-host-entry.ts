import { join } from "node:path";
import { PiNodeHost } from "./PiNodeHost";

async function main(): Promise<void> {
  const dbPath = process.env.MYBUDDY_DB_PATH?.trim();
  const dataDirectory = process.env.MYBUDDY_DATA_DIR?.trim();
  const runtimeAuditExecutable = process.env.MYBUDDY_RUNTIME_AUDIT_EXE?.trim();
  if (!dbPath || !dataDirectory || !runtimeAuditExecutable) {
    throw new Error("PiNodeHost requires MYBUDDY_DB_PATH, MYBUDDY_DATA_DIR, and MYBUDDY_RUNTIME_AUDIT_EXE");
  }
  const host = new PiNodeHost({
    hostId: process.env.MYBUDDY_PI_HOST_ID,
    hostGeneration: process.env.MYBUDDY_PI_HOST_GENERATION,
    dataDirectory,
    dbPath,
    storageRoot: process.env.MYBUDDY_PI_STORAGE_ROOT || join(dataDirectory, "durable-bots"),
    runtimeAuditExecutable,
    repoRoot: process.env.MYBUDDY_APP_PATH || process.cwd(),
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const info = await host.start();
  console.log(`[PiNodeHost] ready pid=${info.pid} hostId=${info.hostId} gen=${info.hostGeneration} pi=${info.piVersion}`);

  // Keep event loop alive cleanly until Core stops or fences this generation.
  const keepAlive = setInterval(() => undefined, 60_000);
  const originalClose = host.close.bind(host);
  host.close = async () => {
    clearInterval(keepAlive);
    await originalClose();
  };
}

main().catch(error => {
  console.error("[PiNodeHost] fatal startup error:", error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
