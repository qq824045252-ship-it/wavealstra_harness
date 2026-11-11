import { spawn, type ChildProcessByStdio } from "node:child_process";
import { get } from "node:http";
import type { Readable } from "node:stream";
import type { GadgetDescriptor, GadgetRuntimeDiagnostics, GadgetRuntimeState } from "../../shared/gadget-types";
import type { GadgetStorage } from "./GadgetStorage";
import type { GadgetRegistry } from "./GadgetRegistry";

interface RuntimeInstance {
  child: ChildProcessByStdio<null, Readable, Readable>;
  state: GadgetRuntimeState;
  stderr: string;
  termination?: GadgetRuntimeDiagnostics;
}

const HOST_SCRIPT = String.raw`
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=fs.realpathSync(process.cwd()),entry=process.env.MYBUDDY_GADGET_ENTRY||'index.html';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const server=http.createServer((req,res)=>{try{const a=server.address(),port=a&&typeof a==='object'?a.port:0,host=String(req.headers.host||'').toLowerCase();if(host!=='127.0.0.1:'+port&&host!=='localhost:'+port){res.writeHead(403,{'x-content-type-options':'nosniff'});return res.end('Forbidden')}if(req.url==='/__mybuddy_health'){res.writeHead(200,{'content-type':'application/json','x-content-type-options':'nosniff'});return res.end('{"ok":true}')}const raw=decodeURIComponent((req.url||'/').split('?')[0]);const rel=raw==='/'?entry:raw.replace(/^\/+/, '');const file=fs.realpathSync(path.resolve(root,rel));if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden')}const st=fs.statSync(file);if(!st.isFile()){res.writeHead(404);return res.end('Not found')}const ext=path.extname(file).toLowerCase();res.writeHead(200,{'content-type':mime[ext]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});if(ext==='.html'||ext==='.htm'){let html=fs.readFileSync(file,'utf8');const bridge="<script>(function(){document.addEventListener('click',function(e){const a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;const href=a.getAttribute('href')||'';if(!/^file:/i.test(href))return;e.preventDefault();e.stopPropagation();window.open('https://mybuddy-open.local/open-file?target='+encodeURIComponent(href),'_blank');},true);})();<\/script>";html=html.replace(/<\/body>/i,bridge+'</body>');return res.end(html)}fs.createReadStream(file).pipe(res)}catch(e){res.writeHead(404,{'x-content-type-options':'nosniff'});res.end('Not found')}});
server.listen(0,'127.0.0.1',()=>{const a=server.address();process.stdout.write('MYBUDDY_GADGET_PORT:'+a.port+'\n')});
const close=()=>server.close(()=>process.exit(0));process.on('SIGTERM',close);process.on('SIGINT',close);
`;

export class GadgetRuntime {
  private readonly instances = new Map<string, RuntimeInstance>();
  // All public operations share one queue. Internal operations never re-enter it.
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly storage: GadgetStorage,
    private readonly registry: GadgetRegistry,
    private readonly onState?: (state: GadgetRuntimeState) => void,
  ) {}

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(id, current);
    const cleanup = (): void => {
      if (this.operations.get(id) === current) this.operations.delete(id);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  start(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    return this.enqueue(descriptor.id, () => this.startOne(descriptor));
  }

  private isAlive(instance: RuntimeInstance): boolean {
    return !!instance.child.pid && instance.child.exitCode === null &&
      instance.child.signalCode === null && !instance.child.killed;
  }

  private async startOne(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    const existing = this.instances.get(descriptor.id);
    if (existing) {
      const checked = await this.healthOne(descriptor.id);
      if (checked.status === "running") return checked;
      await this.stopOne(descriptor.id, "restart");
    }
    const starting: GadgetRuntimeState = {
      gadgetId: descriptor.id, status: "starting",
      diagnostics: this.registry.runtime(descriptor.id).diagnostics,
    };
    this.setState(starting);
    let instance: RuntimeInstance | undefined;
    try {
      this.storage.materializeLegacyLocalHtmlRedirect(descriptor.id);
      const manifest = this.storage.readManifest(descriptor.id);
      const child = spawn(process.execPath, ["-e", HOST_SCRIPT], {
        cwd: this.storage.paths(descriptor.id).sourcePath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MYBUDDY_GADGET_ENTRY: manifest.entry },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      instance = { child, state: starting, stderr: "" };
      const owned = instance;
      this.instances.set(descriptor.id, owned);
      child.stderr.on("data", (chunk) => { owned.stderr = `${owned.stderr}${String(chunk)}`.slice(-4000); });
      // close follows exit and drains stderr. Retain diagnostics even for code 0
      // when exit was not requested (a successful exit is not a healthy server).
      child.once("close", (code, signal) => {
        if (this.instances.get(descriptor.id) !== owned) return;
        this.instances.delete(descriptor.id);
        const diagnostics: GadgetRuntimeDiagnostics = {
          ...owned.termination,
          reason: owned.termination?.reason ?? (owned.state.status === "starting" ? "startup_failure" : "unexpected_exit"),
          occurredAt: owned.termination?.occurredAt ?? Date.now(), exitedAt: Date.now(),
          exitCode: code, signal, stderr: owned.stderr, pid: child.pid,
          url: owned.state.url ?? owned.termination?.url,
        };
        const expected = diagnostics.reason === "explicit_stop" || diagnostics.reason === "restart";
        const state: GadgetRuntimeState = {
          gadgetId: descriptor.id, status: expected ? "stopped" : "error", diagnostics,
          ...(expected ? {} : { error: diagnostics.error ?? `Gadget 进程退出（code=${code}, signal=${signal ?? "none"}）` }),
        };
        owned.state = state;
        this.setState(state);
      });
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => finish(new Error("Gadget 启动超时")), 8_000);
        const finish = (error?: Error): void => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
          error ? reject(error) : resolve();
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
          finish(new Error(owned.stderr.trim() || `Gadget 进程提前退出（code=${code}, signal=${signal ?? "none"}）`));
        const onData = (chunk: Buffer): void => {
          stdout = `${stdout}${String(chunk)}`.slice(-4000);
          const match = /MYBUDDY_GADGET_PORT:(\d+)\n/.exec(stdout);
          if (!match) return;
          const port = Number(match[1]);
          if (!this.isAlive(owned) || port < 1 || port > 65535) return finish(new Error("Gadget 启动状态无效"));
          owned.state = {
            gadgetId: descriptor.id, status: "running", url: `http://127.0.0.1:${port}/`,
            port, pid: child.pid, startedAt: Date.now(), diagnostics: starting.diagnostics,
          };
          finish();
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
        // Keep an error listener after startup too (kill/spawn errors must not
        // become uncaught main-process exceptions).
        child.on("error", (error) => {
          if (owned.state.status === "starting") finish(error);
          else if (this.instances.get(descriptor.id) === owned && !owned.termination) {
            this.fail(owned, "health_failure", error.message);
          }
        });
      });
      return await this.healthOne(descriptor.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (instance && this.instances.get(descriptor.id) === instance) {
        this.fail(instance, "startup_failure", message);
        await this.stopOne(descriptor.id, "restart");
        return this.registry.runtime(descriptor.id);
      }
      // A pre-spawn failure has no process exit evidence. Only the instance
      // created by this attempt can supply close diagnostics, never a previous
      // runtime's registry history inherited by the starting state.
      const closedDiagnostics = instance?.state.status === "error" &&
        instance.state.diagnostics?.reason === "startup_failure"
        ? instance.state.diagnostics : undefined;
      const state: GadgetRuntimeState = {
        gadgetId: descriptor.id, status: "error", error: message,
        diagnostics: { ...closedDiagnostics,
          reason: "startup_failure", occurredAt: closedDiagnostics?.occurredAt ?? Date.now(), error: message },
      };
      this.setState(state);
      return state;
    }
  }

  private fail(instance: RuntimeInstance, reason: "health_failure" | "startup_failure", error: string): GadgetRuntimeState {
    instance.termination = {
      reason, occurredAt: Date.now(), error, pid: instance.child.pid,
      url: instance.state.url, stderr: instance.stderr,
    };
    const state: GadgetRuntimeState = {
      gadgetId: instance.state.gadgetId, status: "error", error, diagnostics: instance.termination,
    };
    instance.state = state;
    this.setState(state);
    return state;
  }

  health(id: string): Promise<GadgetRuntimeState> {
    return this.enqueue(id, () => this.healthOne(id));
  }

  private async healthOne(id: string): Promise<GadgetRuntimeState> {
    const instance = this.instances.get(id);
    if (!instance) {
      const current = this.registry.runtime(id);
      if (current.status !== "running" && current.status !== "starting") return current;
      const error = "Gadget 没有关联的运行进程";
      const failed: GadgetRuntimeState = {
        gadgetId: id, status: "error", error,
        diagnostics: { reason: "health_failure", occurredAt: Date.now(),
          pid: current.pid, url: current.url, error },
      };
      this.setState(failed);
      return failed;
    }
    if (instance.state.status !== "running") return { ...instance.state };
    const url = instance.state.url;
    if (!this.isAlive(instance) || !url) return this.fail(instance, "health_failure", "Gadget 进程已停止");
    const ok = await new Promise<boolean>((resolve) => {
      // Absolute deadline also covers a peer that trickles data indefinitely.
      const timer = setTimeout(() => { request.destroy(); resolve(false); }, 1_500);
      const finish = (ok: boolean): void => { clearTimeout(timer); resolve(ok); };
      const request = get(`${url}__mybuddy_health`, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += String(chunk);
          if (body.length > 1024) { request.destroy(); finish(false); }
        });
        response.once("error", () => finish(false));
        response.once("end", () => {
          try { finish(response.statusCode === 200 && JSON.parse(body).ok === true); }
          catch { finish(false); }
        });
      });
      request.once("error", () => finish(false));
    });
    // Exit events may have run while HTTP was pending. Never revive that child.
    if (this.instances.get(id) !== instance) return this.registry.runtime(id);
    if (ok && this.isAlive(instance) && instance.state.status === "running") {
      this.setState(instance.state);
      return { ...instance.state };
    }
    return this.fail(instance, "health_failure", "Gadget health check 失败");
  }

  stop(id: string): Promise<GadgetRuntimeState> {
    return this.enqueue(id, () => this.stopOne(id, "explicit_stop"));
  }

  private async stopOne(id: string, reason: "explicit_stop" | "restart"): Promise<GadgetRuntimeState> {
    const instance = this.instances.get(id);
    if (!instance) {
      const stopped: GadgetRuntimeState = { gadgetId: id, status: "stopped", diagnostics: this.registry.runtime(id).diagnostics };
      this.setState(stopped);
      return stopped;
    }
    // Preserve an already recorded failure while reaping its child.
    instance.termination ??= {
      reason, occurredAt: Date.now(), pid: instance.child.pid, url: instance.state.url,
    };
    await new Promise<void>((resolve, reject) => {
      const child = instance.child;
      const finish = (): void => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      child.once("close", finish);
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      const deadline = setTimeout(() => {
        child.off("close", finish);
        reject(new Error("Gadget 进程停止超时；未启动替代进程"));
      }, 4_000);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    return this.registry.runtime(id);
  }

  restart(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    return this.enqueue(descriptor.id, async () => {
      await this.stopOne(descriptor.id, "restart");
      return this.startOne(descriptor);
    });
  }

  async dispose(id: string): Promise<void> { await this.stop(id); }

  async disposeAll(): Promise<void> {
    const ids = new Set([...this.instances.keys(), ...this.operations.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  private setState(state: GadgetRuntimeState): void {
    this.registry.setRuntime(state);
    if (state.diagnostics && state.status !== "starting" && state.status !== "running") {
      console.info("[GadgetRuntime]", JSON.stringify({ gadgetId: state.gadgetId, status: state.status, ...state.diagnostics }));
    }
    try { this.onState?.({ ...state }); } catch { /* state remains observable through registry */ }
  }
}
