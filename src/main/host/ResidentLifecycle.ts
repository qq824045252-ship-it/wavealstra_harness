import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

export const RESIDENT_HOST_ARGUMENT = "--resident-host";

/** The same composition owns the database; this only transfers process lifetime. */
export class ResidentLifecycle {
  readonly resident: boolean;
  private stopping = false;
  private requested = false;
  private transferred = false;

  constructor(private readonly runtime: {
    argv: string[]; packaged: boolean; executable: string; appPath: string;
    enabled: () => boolean; quit: () => void;
    relaunch: (args: string[]) => void;
    closeInterface: () => void;
    diagnosticsPath?: string;
    developmentOutput?: string;
    log: (event: string, data: Record<string, unknown>) => void;
  }) { this.resident = runtime.argv.includes(RESIDENT_HOST_ARGUMENT); }

  exitInterface(): void {
    if (this.resident) { this.runtime.closeInterface(); return; }
    if (!this.runtime.enabled()) throw new Error("请先启用此机常驻助理");
    this.requested = true;
    this.runtime.quit();
  }

  stop(): void { this.stopping = true; this.requested = false; this.runtime.quit(); }

  /** Called only after every writer and the authority lease have been closed. */
  afterCleanup(): void {
    if (this.transferred || this.stopping || this.resident || !(this.requested || this.runtime.enabled())) return;
    this.transferred = true;
    const args = this.runtime.argv.slice(1).filter(arg => arg !== RESIDENT_HOST_ARGUMENT);
    args.push(RESIDENT_HOST_ARGUMENT);
    if (this.runtime.packaged) {
      this.runtime.relaunch(args);
    } else {
      // electron-vite exits its renderer server with the old main. A fresh dev
      // parent must own the new host, rather than inheriting a dead renderer URL.
      const cli = join(this.runtime.appPath, "node_modules", "electron-vite", "bin", "electron-vite.js");
      if (!existsSync(cli)) throw new Error("常驻开发宿主缺少 electron-vite，无法交接");
      const developmentArgs = this.runtime.argv.slice(2).filter(arg => arg !== RESIDENT_HOST_ARGUMENT
        && !arg.startsWith("--inspect") && !arg.startsWith("--remote-debugging-port"));
      developmentArgs.push(RESIDENT_HOST_ARGUMENT);
      const cliArgs = ["dev", ...(this.runtime.developmentOutput ? ["--outDir", this.runtime.developmentOutput] : []),
        "--entry", this.runtime.argv[1] || this.runtime.appPath, "--", ...developmentArgs];
      const bootstrap = `
        const { pathToFileURL } = require('node:url');
        const parent = ${process.pid};
        const deadline = Date.now() + 60000;
        const timer = setInterval(async () => {
          try { process.kill(parent, 0); if (Date.now() > deadline) process.exit(1); return; } catch {}
          clearInterval(timer);
          delete process.env.ELECTRON_RUN_AS_NODE;
          delete process.env.ELECTRON_RENDERER_URL;
          if (process.env.REMOTE_DEBUGGING_PORT) process.env.REMOTE_DEBUGGING_PORT = '0';
          process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(cliArgs)}];
          try { await import(pathToFileURL(${JSON.stringify(cli)}).href); } catch (error) { console.error(error); process.exit(1); }
        }, 100);
      `;
      const diagnostics = this.runtime.diagnosticsPath;
      if (diagnostics) mkdirSync(dirname(diagnostics), { recursive: true });
      const output = diagnostics ? openSync(diagnostics, "a") : undefined;
      const child = spawn(this.runtime.executable, ["-e", bootstrap], {
        cwd: this.runtime.appPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        detached: true, windowsHide: true, stdio: output === undefined ? "ignore" : ["ignore", output, output],
      });
      if (output !== undefined) closeSync(output);
      child.on("error", error => this.runtime.log("resident-launch-failed", { message: error.message }));
      child.unref();
    }
    this.runtime.log("resident-transfer-scheduled", { previousPid: process.pid });
  }
}
