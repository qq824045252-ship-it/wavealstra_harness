import { type BrowserWindow, type WebContentsView } from "electron";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HtmlEditRuntimeAction, HtmlEditRuntimeTick, HtmlEditSnapshot, HtmlEditStart } from "../../shared/html-edit";
import { HtmlEditIpc } from "../../shared/html-edit";
import { HtmlSource, htmlHash, saveHtmlFile } from "./HtmlSource";
import { EDIT_WORLD, editorCommand, editorScript, editorSetState, editorSnapshot, editorTick } from "./HtmlEditRuntime";

interface Target { window: BrowserWindow; view: WebContentsView; artifactId?: string; path?: string; version?: number }
interface Dependencies {
  resolve(request: HtmlEditStart): Target;
  exitCapture(): void;
  draftDir: string;
  contentSaved(path: string): void;
  ai(modelId: string, html: string, instruction: string, signal: AbortSignal): Promise<string>;
}
interface Session {
  request: HtmlEditStart; target: Target; source: HtmlSource; hash: string; url: string;
  path?: string; draftPath: string; snapshot: HtmlEditSnapshot; status: string;
  observedRevision: number; draftRevision: number; timer?: ReturnType<typeof setInterval>; draftTimer?: ReturnType<typeof setTimeout>; cleanup: () => void;
  busy: boolean; abort: AbortController; polling: boolean; publishedState?: string;
}

/** Main-process trust boundary for source-safe visual editing. UI itself lives inside the page isolated world. */
export class HtmlEditService {
  private session: Session | null = null;
  private starting = false;
  private stopping: Promise<void> = Promise.resolve();
  constructor(private readonly deps: Dependencies) {}

  async start(request: HtmlEditStart, sender: Electron.WebContents): Promise<{ ok: boolean; error?: string }> {
    if (this.starting) return { ok: false, error: "编辑器正在打开" };
    this.starting = true;
    try {
      if (!request || !["browser", "artifact"].includes(request.target)) throw new Error("无效的编辑目标");
      const target = this.deps.resolve(request);
      if (sender !== target.window.webContents) throw new Error("编辑请求必须来自应用窗口");
      await this.stop();
      this.deps.exitCapture();
      const wc = target.view.webContents;
      const url = wc.getURL();
      let path = target.path;
      if (!path && /^file:/i.test(url)) path = fileURLToPath(url);
      if (path && ![".html", ".htm"].includes(extname(path).toLowerCase())) throw new Error("仅 HTML 文件支持保存");
      if (path) path = realpathSync(path);
      const content = path ? readFileSync(path, "utf8") : await wc.executeJavaScriptInIsolatedWorld(EDIT_WORLD, [{ code: "'<!doctype html>\\n'+document.documentElement.outerHTML" }]) as string;
      if (wc.isDestroyed() || wc.getURL() !== url) throw new Error("页面已切换，请重新进入编辑");
      const source = new HtmlSource(content), hash = htmlHash(content);
      mkdirSync(this.deps.draftDir, { recursive: true });
      const draftPath = join(this.deps.draftDir, `${htmlHash(path ?? url)}-${hash}.json`);
      let patches: HtmlEditSnapshot["patches"] = [];
      if (existsSync(draftPath)) {
        try {
          const draft = JSON.parse(readFileSync(draftPath, "utf8"));
          if (draft.hash === hash && Array.isArray(draft.patches)) { source.apply(draft.patches); patches = draft.patches; }
        } catch { /* keep a malformed draft for manual recovery; start clean */ }
      }
      const count = await wc.executeJavaScriptInIsolatedWorld(EDIT_WORLD, [{ code: editorScript(content, source.nodes, patches) }]);
      if (!count) { await wc.executeJavaScriptInIsolatedWorld(EDIT_WORLD, [{ code: "window.__mybuddyHtmlEdit?.dispose()" }]); throw new Error("页面中没有可可靠定位的静态文案节点"); }
      const s: Session = {
        request, target, source, hash, url, path, draftPath,
        snapshot: { revision: -1, patches: [], selected: null },
        status: patches.length ? "已恢复未保存草稿" : path ? "点击文字即可原地编辑" : "临时编辑：不会写回网站",
        observedRevision: -1, draftRevision: -1, cleanup: () => undefined, busy: false, abort: new AbortController(), polling: false,
      };
      this.session = s;
      const invalidate = () => { if (this.session === s) void this.stop(); };
      wc.on("did-start-navigation", invalidate); wc.on("destroyed", invalidate);
      s.cleanup = () => { wc.removeListener("did-start-navigation", invalidate); wc.removeListener("destroyed", invalidate); };
      await this.poll(s);
      s.timer = setInterval(() => { void this.poll(s); }, 120);
      target.window.webContents.send(HtmlEditIpc.state, { active: true, target: request.target });
      return { ok: true };
    } catch (error) {
      await this.stop();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally { this.starting = false; }
  }

  invalidate(target: "browser" | "artifact"): void { if (this.session?.request.target === target) void this.stop(); }

  stop(): Promise<void> {
    const s = this.session;
    if (!s) return this.stopping;
    this.session = null; s.abort.abort(); clearInterval(s.timer); if (s.draftTimer) clearTimeout(s.draftTimer); s.cleanup();
    this.stopping = this.closeSession(s);
    return this.stopping;
  }

  private async closeSession(s: Session): Promise<void> {
    try {
      const wc = s.target.view.webContents;
      if (!wc.isDestroyed() && wc.getURL() === s.url) {
        try { this.syncSnapshot(s, await this.evaluate<HtmlEditSnapshot>(s, editorSnapshot()), true); }
        finally { await this.evaluate(s, "window.__mybuddyHtmlEdit?.dispose()"); }
      }
    } catch { /* last acknowledged draft remains durable */ }
    if (!s.target.window.isDestroyed()) s.target.window.webContents.send(HtmlEditIpc.state, { active: false, target: s.request.target });
  }

  private evaluate<T = unknown>(s: Session, code: string): Promise<T> {
    return s.target.view.webContents.executeJavaScriptInIsolatedWorld(EDIT_WORLD, [{ code }], true) as Promise<T>;
  }

  private syncSnapshot(s: Session, snapshot: HtmlEditSnapshot, flushDraft = false): void {
    s.snapshot = snapshot;
    if (snapshot.revision !== s.observedRevision) {
      s.observedRevision = snapshot.revision;
      if (snapshot.patches.length) s.status = s.path ? "修改中 · Ctrl+S 写回文件" : "临时修改中";
      else s.status = s.path ? "点击文字即可原地编辑" : "临时编辑：不会写回网站";
      this.scheduleDraft(s);
    }
    if (flushDraft) this.flushDraft(s);
  }

  private scheduleDraft(s: Session): void {
    if (s.draftTimer) clearTimeout(s.draftTimer);
    s.draftTimer = setTimeout(() => {
      s.draftTimer = undefined;
      if (this.session !== s) return;
      try { this.flushDraft(s); }
      catch (error) { s.status = error instanceof Error ? error.message : String(error); }
      void this.publish(s).catch(() => undefined);
    }, 350);
  }

  private flushDraft(s: Session): void {
    if (s.draftTimer) { clearTimeout(s.draftTimer); s.draftTimer = undefined; }
    if (s.snapshot.revision === s.draftRevision) return;
    if (!s.snapshot.patches.length) {
      try { unlinkSync(s.draftPath); } catch { /* no draft to remove */ }
      s.draftRevision = s.snapshot.revision;
      return;
    }
    s.source.apply(s.snapshot.patches); // validate only at the persistence boundary, not on every poll
    const tmp = `${s.draftPath}.tmp`;
    // The source text is keyed by hash and already exists on disk; duplicating up to 4 MB into every draft write was pure I/O overhead.
    writeFileSync(tmp, JSON.stringify({ hash: s.hash, patches: s.snapshot.patches, updatedAt: Date.now(), url: s.url }), "utf8");
    renameSync(tmp, s.draftPath);
    s.draftRevision = s.snapshot.revision;
    s.status = s.path ? "草稿已保存 · Ctrl+S 写回文件" : "临时草稿已保存";
  }

  private async poll(s: Session): Promise<void> {
    if (s.polling || this.session !== s) return;
    s.polling = true;
    try {
      const tick = await this.evaluate<HtmlEditRuntimeTick>(s, editorTick());
      if (this.session !== s) return;
      this.syncSnapshot(s, tick.snapshot);
      for (const action of tick.actions) {
        if (this.session !== s) break;
        this.handleAction(s, action);
      }
      if (this.session === s) await this.publish(s);
    } catch (error) {
      if (this.session === s) { s.status = error instanceof Error ? error.message : String(error); await this.publish(s).catch(() => undefined); }
    } finally { s.polling = false; }
  }

  private handleAction(s: Session, action: HtmlEditRuntimeAction): void {
    if (action.name === "stop") { void this.stop(); return; }
    if (action.name === "save") { void this.save(s); return; }
    if (action.name === "ai") { void this.runAi(s, action.value ?? ""); }
  }

  private async publish(s: Session): Promise<void> {
    if (this.session !== s || s.target.view.webContents.isDestroyed()) return;
    const state = {
      status: s.snapshot.error || s.status,
      canSave: !!s.path,
      busy: s.busy,
      aiEnabled: Boolean(s.request.modelId),
    };
    const key = JSON.stringify(state);
    if (key === s.publishedState) return;
    s.publishedState = key;
    try { await this.evaluate(s, editorSetState(state)); }
    catch (error) { s.publishedState = undefined; throw error; }
  }

  private async runAi(s: Session, instruction: string): Promise<void> {
    if (this.session !== s) return;
    if (s.busy) { s.status = "AI 正在生成，请稍候"; await this.publish(s); return; }
    const selected = s.snapshot.selected;
    if (!selected) { s.status = "先点击一段文字，再使用 AI"; await this.publish(s); return; }
    if (!instruction.trim() || instruction.length > 2000) { s.status = "请输入 1–2000 字的修改要求"; await this.publish(s); return; }
    if (!s.request.modelId) { s.status = "请先选择可用模型"; await this.publish(s); return; }
    const revision = s.snapshot.revision, key = selected.key;
    s.busy = true; s.status = "AI 正在生成修改…"; await this.publish(s);
    try {
      const after = await this.deps.ai(s.request.modelId, selected.html, instruction, s.abort.signal);
      if (this.session !== s) return;
      const current = await this.evaluate<HtmlEditSnapshot>(s, editorSnapshot());
      this.syncSnapshot(s, current);
      if (current.revision !== revision || current.selected?.key !== key) { s.status = "文字已继续变化，旧 AI 结果已丢弃"; return; }
      s.source.apply([{ key, html: after }]);
      await this.evaluate(s, editorCommand("preview", after));
      s.status = "AI 结果已在原位置预览 · 接受或撤销";
    } catch (error) {
      if (this.session === s && !s.abort.signal.aborted) s.status = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.session === s) { s.busy = false; await this.publish(s).catch(() => undefined); }
    }
  }

  private async save(s: Session): Promise<void> {
    if (this.session !== s) return;
    if (s.busy) { s.status = "AI 正在生成；完成后再保存"; await this.publish(s); return; }
    try {
      const snapshot = await this.evaluate<HtmlEditSnapshot>(s, editorSnapshot());
      this.syncSnapshot(s, snapshot, true);
      if (!s.path) { s.status = "网站页面只支持临时编辑，不会写回远端"; await this.publish(s); return; }
      if (!snapshot.patches.length) { s.status = "没有待保存的修改"; await this.publish(s); return; }
      const current = this.deps.resolve(s.request);
      if (current.view !== s.target.view || (current.version != null && s.target.version != null && current.version !== s.target.version)) throw new Error("页面版本已变化，请重新进入编辑");
      const html = s.source.apply(snapshot.patches), path = s.path, target = s.target, request = s.request;
      saveHtmlFile(path, s.hash, html);
      await this.stop();
      try { unlinkSync(s.draftPath); } catch { /* harmless retained draft */ }
      this.deps.contentSaved(path);
      if (!target.view.webContents.isDestroyed() && target.view.webContents.getURL() === s.url) target.view.webContents.reloadIgnoringCache();
      if (!target.window.isDestroyed()) target.window.webContents.send(HtmlEditIpc.state, { active: false, target: request.target, message: "已保存到源文件，并创建备份" });
    } catch (error) {
      if (this.session === s) { s.status = error instanceof Error ? error.message : String(error); await this.publish(s).catch(() => undefined); }
    }
  }
}
