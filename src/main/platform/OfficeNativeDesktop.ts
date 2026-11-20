import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { OfficeNativeEngine } from "./office-native";

const host = "127.0.0.1";

export async function stopOfficeNativeDesktop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
  child.kill();
  await exited;
}
async function reservePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Office 界面控制地址不可用。")));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function connects(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

export async function launchOfficeNativeDesktop(input: {
  engine: OfficeNativeEngine; cli: string; root: string; file?: string; signal: AbortSignal;
}): Promise<{ child: ChildProcess; address: string; clientEnv: Record<string, string>; close(): Promise<void> }> {
  const port = await reservePort();
  input.signal.throwIfAborted();
  const clientEnv: Record<string, string> = {};
  if (input.engine === "gridcraft") clientEnv.GRIDCRAFT_CONTROL_TOKEN = randomBytes(32).toString("hex");
  const profile = input.engine === "wordcraft" ? await mkdtemp(join(input.root, ".mybuddy-wordcraft-")) : undefined;
  if (profile) Object.assign(clientEnv, { WORDCRAFT_PROFILE_DIR: profile, WORDCRAFT_NO_PREFS: "1" });
  const keyFile = profile && join(profile, `control-key.local-${port}`);
  const command = join(dirname(input.cli), basename(input.cli).replace(/-cli(?=\.exe$|$)/, ""));
  const env = { ...process.env, ...clientEnv };
  delete env.WORDCRAFT_CONTROL_KEY;
  const child = spawn(command, ["--control", String(port), ...(input.file ? [input.file] : [])],
    { cwd: input.root, env, stdio: "ignore" });
  const close = async () => {
    await stopOfficeNativeDesktop(child);
    if (profile) {
      if (dirname(await realpath(profile)) !== await realpath(input.root)) throw new Error("Office 临时配置目录已变化。");
      await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    }
  };
  let failure: Error | undefined;
  child.once("error", error => { failure = error; });
  const stop = () => { if (child.exitCode === null) child.kill(); };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    const until = performance.now() + 30_000;
    while (performance.now() < until) {
      input.signal.throwIfAborted();
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`${input.engine} 界面启动后退出。`);
      if (await connects(port) && (!keyFile || await access(keyFile).then(() => true, () => false))) {
        return { child, address: `${host}:${port}`, clientEnv, close };
      }
      await pause(130, undefined, { signal: input.signal });
    }
    throw new Error(`${input.engine} 界面控制连接超时。`);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
}
