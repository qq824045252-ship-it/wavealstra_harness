import { app, WebContentsView, type BrowserWindow } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { OfficeOpen, OfficeRect } from "../../shared/office-use";
import cadRelease from "../../../vendor/cadcraft/releases.json";
import { CadCraftFile } from "../artifact/CadCraftFile";
import { OfficeFile, type OfficeFileTarget } from "./OfficeFile";
import { bindOfficeSelection } from "./OfficeSelectionTools";
import { locateOfficeNative, officeNativeEngines } from "../platform/office-native";
import { checkOfficeUseAssets, isOfficeEngineAsset, officeEngineByKind, officeStaticFiles } from "./OfficeUseAssets";

interface Session {
  id: string; owner: BrowserWindow; view: WebContentsView; file: OfficeFile | CadCraftFile; initial: Buffer | undefined;
  modelId?: string; visible: boolean; release?: () => void; closing?: Promise<void>; retained?: boolean; abort: AbortController;
}
interface Ports {
  target(request: OfficeOpen, owner: BrowserWindow): Promise<OfficeFileTarget>;
  saveAs(bytes: Buffer, target: OfficeFileTarget, owner: BrowserWindow): Promise<string | null>;
  propose(modelId: string, selection: string, instruction: string, signal: AbortSignal): Promise<string>;
  drafts: string;
}
const mime: Record<string,string> = { ".html":"text/html; charset=utf-8", ".css":"text/css", ".js":"application/javascript", ".wasm":"application/wasm", ".metadata":"application/json", ".otf":"font/otf" };
async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error("办公室编辑请求过大");
    parts.push(chunk);
  }
  return Buffer.concat(parts, length);
}

export class OfficeUseHost {
  private readonly sessions = new Map<string, Session>();
  private readonly blocked = new Map<number, Set<string>>();
  private readonly activeFiles = new Set<string>();
  private readonly watched = new WeakSet<BrowserWindow>();
  private readonly partition = "mybuddy-office-" + randomUUID();
  private origin?: Promise<string>;
  private server?: ReturnType<typeof createServer>;
  private runtime = app.isPackaged ? join(process.resourcesPath, "office-editor/craft-assets") : join(app.getAppPath(), "vendor/craft-office/assets");
  private editor = app.isPackaged ? join(process.resourcesPath, "office-editor/editor") : join(app.getAppPath(), "src/renderer/src/lib/office-use");
  private cadRuntime = app.isPackaged ? join(process.resourcesPath, "cadcraft/web") : join(app.getAppPath(), "vendor/cadcraft/assets/web");
  constructor(private ports: Ports) {}

  async checkAssets() {
    const [editor, upstream] = await Promise.all([
      checkOfficeUseAssets(this.runtime, this.editor),
      Promise.all(officeNativeEngines.map(async engine => {
        try {
          await locateOfficeNative(app.getAppPath(), engine, app.isPackaged ? process.resourcesPath : undefined);
          return { engine, available: true };
        } catch {
          return { engine, available: false };
        }
      })),
    ]);
    const ready = upstream.filter(item => item.available).map(item => item.engine);
    const missing = upstream.filter(item => !item.available).map(item => item.engine);
    return {
      state: missing.length && editor.state === "ready" ? "degraded" as const : editor.state,
      detail: [editor.detail, ready.length ? `上游引擎可用：${ready.join("、")}。` : "",
        missing.length ? `上游运行资源缺失：${missing.join("、")}。` : ""].filter(Boolean).join(" "),
    };
  }

  private start(): Promise<string> {
    if (!this.origin) {
      this.origin = new Promise<string>((resolve, reject) => {
        let host = "";
        const server = createServer((req,res) => {
          if (!host || req.headers.host !== host) { res.writeHead(403).end(); return; }
          this.serve(req,res,"http://" + host).catch(e => {
            if (res.headersSent) { res.destroy(); return; }
            res.writeHead(400, {"Content-Type":"text/plain; charset=utf-8"}).end(e instanceof Error ? e.message : "Office 请求失败");
          });
        });
        this.server = server;
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") { reject(new Error("Office 服务不可用")); return; }
          host = "127.0.0.1:" + address.port;
          server.unref();
          resolve("http://" + host);
        });
      }).catch(error => { this.origin = undefined; throw error; });
    }
    return this.origin;
  }
  private async asset(group: string, name: string, res: ServerResponse): Promise<void> {
    const engine = isOfficeEngineAsset(group,name);
    const cadEngine = group === "cadcraft" && Object.hasOwn(cadRelease.targets.web.files, name);
    const cadHost = group === "cad" && ["index.html", "cad.js", "cad.css"].includes(name);
    if (!engine && !cadEngine && !cadHost && (!Object.hasOwn(officeStaticFiles,group) || !officeStaticFiles[group].includes(name))) { res.writeHead(404).end(); return; }
    const path = cadEngine ? join(this.cadRuntime, name)
      : join(engine || group === "fonts" ? this.runtime : this.editor, group, name);
    const size = (await stat(path)).size;
    if (engine || cadEngine || group === "fonts") res.setHeader("Cache-Control","private, max-age=86400");
    res.writeHead(200, {"Content-Type":mime[extname(name)] ?? "application/octet-stream", "Content-Length":size});
    await pipeline(createReadStream(path),res);
  }
  private async serve(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
    res.setHeader("Cross-Origin-Opener-Policy","same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy","require-corp");
    res.setHeader("Cross-Origin-Resource-Policy","same-origin");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Cache-Control","no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    const path = new URL(req.url || "/", origin).pathname.split("/");
    if (path[1] !== "session") {
      if (path.length >= 3 && req.method === "GET") return this.asset(path[1],path.slice(2).join("/"),res);
      res.writeHead(404).end(); return;
    }
    const s = this.sessions.get(path[2]);
    if (path.length !== 4 || !s || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
    const action = path[3];
    if (req.method === "GET") {
      if (action === "") return this.asset(s.file instanceof CadCraftFile ? "cad" : "host", "index.html", res);
      if (action === "config") {
        const t = s.file.target;
        res.setHeader("Content-Type","application/json");
        res.end(JSON.stringify(s.file instanceof CadCraftFile ? s.file.config() : {
          kind: s.file.target.kind, name: t.name, readOnly: !!t.readOnly, copy: !!s.file.target.copy,
          recovered: s.file.recovered, conflict: s.file.conflict,
        }));
        return;
      }
      if (action === "source" && s.initial) {
        const bytes = s.initial;
        res.setHeader("Content-Type","application/octet-stream");
        res.end(bytes); s.initial = undefined; return;
      }
    }
    if (req.method === "POST" && req.headers.origin === origin && !s.file.target.readOnly) {
      if (s.file instanceof CadCraftFile) {
        if (action === "draft" || action === "save") {
          const bytes = await body(req, 128 * 1024 * 1024);
          if (!bytes.length) throw new Error("CAD 编辑器没有返回图纸数据");
          if (action === "draft") { await s.file.writeDraft(bytes); res.end(); return; }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(await s.file.saveCopy(bytes)));
          return;
        }
        res.writeHead(404).end(); return;
      }
      if (action === "propose") {
        const {selection,instruction} = JSON.parse((await body(req,512*1024)).toString());
        if (!selection || typeof selection.content !== "string" || !selection.target || typeof instruction !== "string" || !instruction.trim()) throw new Error("请先选择内容并填写修改要求");
        if (!s.modelId) throw new Error("请先为当前会话选择模型");
        res.end(await this.ports.propose(s.modelId, JSON.stringify(selection), instruction, s.abort.signal)); return;
      }
      if (action === "draft" || action === "save" || action === "export" || action === "export-engine-copy") {
        const bytes = await body(req, 512 * 1024 * 1024);
        if (action === "export" || action === "export-engine-copy") {
          let output = bytes;
          if (action === "export") {
            try { output = await s.file.prepareExport(bytes); }
            catch (error) {
              res.writeHead(409,{ "Content-Type":"text/plain; charset=utf-8" }).end(error instanceof Error ? error.message : "未能保留图表工作簿");
              return;
            }
          }
          const destination = await this.ports.saveAs(output,s.file.target,s.owner);
          res.end(destination ? "已另存至 " + destination : "已取消另存"); return;
        }
        const result = await s.file.write(bytes, action === "draft");
        if (result.saved) res.setHeader("X-Office-Saved", "1");
        res.end(result.message); return;
      }
    }
    res.writeHead(404).end();
  }
  async open(request: OfficeOpen, owner: BrowserWindow) {
    const target = await this.ports.target(request,owner);
    await access(join(this.runtime, officeEngineByKind[target.kind], "index.html")).catch(() => {
      throw new Error("缺少本地 Office 引擎。请在「设置 → 工具能力 → 本机工具 → Office Use」检查编辑器资源。");
    });
    return this.openEditor(new OfficeFile(target, this.ports.drafts), owner, request.modelId);
  }
  async openCadCraft(file: CadCraftFile, owner: BrowserWindow) {
    await access(join(this.cadRuntime, "index.html")).catch(() => {
      throw new Error("缺少嵌入式 CADCraft 资源，请运行 pnpm prepare:cadcraft。");
    });
    return this.openEditor(file, owner);
  }
  private async openEditor(file: OfficeFile | CadCraftFile, owner: BrowserWindow, modelId?: string) {
    const { target } = file;
    const cad = file instanceof CadCraftFile;
    if (!target.readOnly && this.activeFiles.has(target.path)) {
      const previous = [...this.sessions.values()].find(s => s.file.target.path === target.path && s.owner === owner);
      if (previous?.closing) await previous.closing.catch(() => {});
      if (previous?.retained && previous.file.target.identity === target.identity) {
        previous.retained = false;
        previous.modelId = modelId;
        return {id:previous.id};
      }
      if (this.activeFiles.has(target.path)) throw new Error("文档已在另一个编辑窗口打开");
    }
    if (!target.readOnly) this.activeFiles.add(target.path);
    let state: Session | undefined;
    try {
      const [initial,origin] = await Promise.all([file.open(), this.start()]);
      if (owner.isDestroyed()) throw new Error("主窗口已关闭");
      const id = randomUUID();
      // The editors process engine commands on their frame loop, including while a panel is opening or closing.
      const view = new WebContentsView({webPreferences:{sandbox:true, contextIsolation:true,nodeIntegration:false, partition:this.partition, spellcheck:false,
        backgroundThrottling: false }});
      const s = state = {id,owner,view,file,initial,visible:false,abort:new AbortController(),modelId};
      this.sessions.set(id,s);
      view.setVisible(false);
      owner.contentView.addChildView(view);
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({action:"deny"}));
      wc.session.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
      wc.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url.startsWith(origin + "/") || details.url.startsWith("blob:"+origin+"/") || details.url.startsWith("data:") || details.url === "about:blank";
        callback({cancel:!allowed});
      });
      wc.on("will-navigate",event => event.preventDefault());
      wc.on("render-process-gone", (_event, details) => {
        if (!owner.isDestroyed() && this.sessions.has(id)) {
          owner.webContents.send("office-use:failed", id, (cad ? "CADCraft" : "Office") + " 编辑器已停止（" + details.reason + "）。请重新打开以恢复最近的草稿。");
        }
        this.destroy(s);
      });
      const ownerClosed = () => this.destroy(s);
      owner.once("closed",ownerClosed);
      wc.once("destroyed", () => { owner.off("closed",ownerClosed); this.destroy(s); });
      this.watchOwner(owner);
      await wc.loadURL(origin + "/session/" + id + "/");
      return {id};
    } catch (error) {
      if (state) this.destroy(state);
      else if (!target.readOnly) this.activeFiles.delete(target.path);
      throw error;
    }
  }
  private watchOwner(owner: BrowserWindow) {
    if (this.watched.has(owner)) return;
    this.watched.add(owner);
    const ownerId = owner.webContents.id;
    const releaseViews = () => {
      this.blocked.delete(ownerId);
      for (const s of this.sessions.values()) if (s.owner === owner) void this.close(ownerId,s.id).catch(console.error);
    };
    owner.webContents.on("did-start-navigation", details => {
      if (details.isMainFrame && !details.isSameDocument) releaseViews();
    });
    owner.webContents.on("render-process-gone",releaseViews);
    owner.once("closed",() => this.blocked.delete(ownerId));
    let closing = false;
    owner.on("close", event => {
      if (event.defaultPrevented || closing || ![...this.sessions.values()].some(s => s.owner === owner)) return;
      event.preventDefault();
      void this.flush(owner).then(() => { closing = true; if (!owner.isDestroyed()) owner.close(); })
        .catch(error => { console.error("[Office] 窗口关闭前保存草稿失败",error); });
    });
  }
  async flush(owner?: BrowserWindow) {
    await Promise.all([...this.sessions.values()].filter(s => !owner || owner === s.owner).map(s =>
      s.closing ?? this.flushDraft(s)));
  }
  private flushDraft(s: Session): Promise<unknown> {
    return s.view.webContents.executeJavaScript(s.file instanceof CadCraftFile ? "window.flushCadDraft?.()" : "window.flushOfficeDraft?.()");
  }
  private show(s: Session) {
    if (s.view.webContents.isDestroyed() || s.owner.isDestroyed()) return;
    const visible = !s.closing && s.visible && !this.blocked.get(s.owner.webContents.id)?.size;
    s.view.setVisible(visible);
    if (visible && s.file instanceof OfficeFile && s.file.target.taskId && !s.release) {
      const wc = s.view.webContents;
      s.release = bindOfficeSelection(s.file.target.taskId,s.id,{
        read: request => wc.executeJavaScript(`window.officeDocument(${JSON.stringify(request)})`),
        render: async target => {
          const result = await wc.executeJavaScript(`window.officeRender(${JSON.stringify(target)})`);
          if (target.kind !== "excel") return result;
          const image = await wc.capturePage(result);
          return image.isEmpty() ? undefined : image.toPNG().toString("base64");
        },
        select: target => wc.executeJavaScript(`window.officeSelection(${JSON.stringify(target) ?? "undefined"})`),
        propose: (id, text, proposalId) => wc.executeJavaScript(`window.officeProposal(${JSON.stringify(id)},${JSON.stringify(text)},${JSON.stringify(proposalId)})`),
        proposeEdit: (operation, proposalId) => wc.executeJavaScript(`window.officeEditProposal(${JSON.stringify(operation)},${JSON.stringify(proposalId)})`),
        review: proposalId => wc.executeJavaScript(`window.officeReviewStatus(${JSON.stringify(proposalId)})`),
      });
    } else if (!visible && s.release) { s.release(); s.release = undefined; }
  }
  bounds(ownerId: number, id: string, rect: OfficeRect) {
    const s = this.sessions.get(id);
    if (!s || s.owner.isDestroyed() || s.owner.webContents.id !== ownerId || !rect || ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)) return;
    const [w,h] = s.owner.getContentSize();
    const x = Math.max(0,Math.round(rect.x)), y = Math.max(0,Math.round(rect.y));
    const width = Math.max(0,Math.min(w-x,Math.round(rect.width))), height = Math.max(0,Math.min(h-y,Math.round(rect.height)));
    s.visible = width > 0 && height > 0;
    if (s.visible) s.view.setBounds({x,y,width,height});
    this.show(s);
  }
  block(ownerId: number, token: string, active: boolean) {
    if (!token) return;
    const tokens = this.blocked.get(ownerId) ?? new Set<string>();
    if (active) tokens.add(token); else tokens.delete(token);
    if (tokens.size) this.blocked.set(ownerId,tokens); else this.blocked.delete(ownerId);
    for (const s of this.sessions.values()) if (!s.owner.isDestroyed() && s.owner.webContents.id === ownerId) this.show(s);
  }
  async close(ownerId: number, id: string) {
    const s = this.sessions.get(id);
    if (!s || s.owner.isDestroyed() || s.owner.webContents.id !== ownerId) return;
    if (!s.closing) {
      s.visible = false;
      this.show(s);
      s.closing = this.flushDraft(s).then(() => this.destroy(s)).catch(error => {
        s.closing = undefined;
        s.retained = true;
        throw error;
      });
    }
    await s.closing;
  }
  private destroy(s: Session) {
    if (!this.sessions.delete(s.id)) return;
    s.release?.(); s.abort.abort();
    if (!s.file.target.readOnly) this.activeFiles.delete(s.file.target.path);
    if (!s.owner.isDestroyed()) s.owner.contentView.removeChildView(s.view);
    if (!s.view.webContents.isDestroyed()) s.view.webContents.close();
  }
  dispose() {
    for (const s of this.sessions.values()) this.destroy(s);
    this.server?.close();
  }
}
