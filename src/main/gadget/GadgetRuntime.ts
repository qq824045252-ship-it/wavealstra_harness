import { spawn, type ChildProcessByStdio } from "node:child_process";
import { get } from "node:http";
import type { Readable } from "node:stream";
import type { GadgetDescriptor, GadgetRuntimeState } from "../../shared/gadget-types";
import type { GadgetStorage } from "./GadgetStorage";
import type { GadgetRegistry } from "./GadgetRegistry";

interface RuntimeInstance {
  child: ChildProcessByStdio<null, Readable, Readable>;
  state: GadgetRuntimeState;
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
  private readonly starts = new Map<string, Promise<GadgetRuntimeState>>();

  constructor(
    private readonly storage: GadgetStorage,
    private readonly registry: GadgetRegistry,
    private readonly onState?: (state: GadgetRuntimeState) => void,
  ) {}

  async start(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    const pending = this.starts.get(descriptor.id);
    if (pending) return pending;
    const startPromise = this.startOne(descriptor);
    this.starts.set(descriptor.id, startPromise);
    try {
      return await startPromise;
    } finally {
      if (this.starts.get(descriptor.id) === startPromise) this.starts.delete(descriptor.id);
    }
  }

  private async startOne(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    const existing = this.instances.get(descriptor.id);
    if (existing && existing.state.status === "running") return { ...existing.state };
    if (existing) await this.stop(descriptor.id);
    const starting: GadgetRuntimeState = { gadgetId: descriptor.id, status: "starting" };
    this.setState(starting);
    let spawned: RuntimeInstance["child"] | null = null;
    try {
      this.storage.materializeLegacyLocalHtmlRedirect(descriptor.id);
      const manifest = this.storage.readManifest(descriptor.id);
      const child = spawn(process.execPath, ["-e", HOST_SCRIPT], {
        cwd: this.storage.paths(descriptor.id).sourcePath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MYBUDDY_GADGET_ENTRY: manifest.entry },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      spawned = child;
      const state = await new Promise<GadgetRuntimeState>((resolve, reject) => {
        let stderr = "";
        let stdout = "";
        let ready = false;
        const timer = setTimeout(() => reject(new Error("Gadget 启动超时")), 8_000);
        const cleanup = (): void => clearTimeout(timer);
        child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
        child.stdout.on("data", (chunk) => {
          if (ready) return;
          stdout = `${stdout}${String(chunk)}`.slice(-4000);
          const match = /MYBUDDY_GADGET_PORT:(\d+)/.exec(stdout);
          if (!match) return;
          ready = true;
          cleanup();
          const port = Number(match[1]);
          const running: GadgetRuntimeState = {
            gadgetId: descriptor.id,
            status: "running",
            url: `http://127.0.0.1:${port}/`,
            port,
            pid: child.pid,
            startedAt: Date.now(),
          };
          this.instances.set(descriptor.id, { child, state: running });
          this.setState(running);
          resolve(running);
        });
        child.once("error", (error) => { cleanup(); reject(error); });
        child.once("exit", (code) => {
          cleanup();
          if (!ready) return reject(new Error(stderr.trim() || `Gadget 进程提前退出（${code ?? "unknown"}）`));
          const current = this.instances.get(descriptor.id);
          if (!current || current.child !== child) return;
          this.instances.delete(descriptor.id);
          this.setState({
            gadgetId: descriptor.id,
            status: code === 0 ? "stopped" : "error",
            ...(code === 0 ? {} : { error: `Gadget 进程退出（${code ?? "unknown"}）` }),
          });
        });
      });
      const current = this.instances.get(descriptor.id);
      return current?.child === child ? { ...state } : this.registry.runtime(descriptor.id);
    } catch (error) {
      if (spawned && spawned.exitCode === null && !spawned.killed) spawned.kill();
      const state: GadgetRuntimeState = {
        gadgetId: descriptor.id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      this.setState(state);
      return state;
    }
  }

  async health(id: string): Promise<GadgetRuntimeState> {
    const instance = this.instances.get(id);
    if (!instance || !instance.state.url) return this.registry.runtime(id);
    const ok = await new Promise<boolean>((resolve) => {
      const request = get(`${instance.state.url}__mybuddy_health`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.setTimeout(1_500, () => request.destroy());
      request.once("error", () => resolve(false));
    });
    if (ok) return { ...instance.state };
    const failed = { ...instance.state, status: "error" as const, error: "Gadget health check 失败" };
    instance.state = failed;
    this.setState(failed);
    return failed;
  }

  async stop(id: string): Promise<GadgetRuntimeState> {
    const pending = this.starts.get(id);
    if (pending) await pending;
    const instance = this.instances.get(id);
    if (!instance) {
      const stopped = { gadgetId: id, status: "stopped" as const };
      this.setState(stopped);
      return stopped;
    }
    this.instances.delete(id);
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      instance.child.once("exit", finish);
      instance.child.kill();
      const timer = setTimeout(() => { if (!done) instance.child.kill("SIGKILL"); finish(); }, 2_000);
      timer.unref();
    });
    const stopped = { gadgetId: id, status: "stopped" as const };
    this.setState(stopped);
    return stopped;
  }

  async restart(descriptor: GadgetDescriptor): Promise<GadgetRuntimeState> {
    await this.stop(descriptor.id);
    return this.start(descriptor);
  }

  async dispose(id: string): Promise<void> {
    await this.stop(id);
  }

  async disposeAll(): Promise<void> {
    const ids = new Set([...this.instances.keys(), ...this.starts.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  private setState(state: GadgetRuntimeState): void {
    this.registry.setRuntime(state);
    try { this.onState?.({ ...state }); } catch { /* state remains observable through registry */ }
  }
}
