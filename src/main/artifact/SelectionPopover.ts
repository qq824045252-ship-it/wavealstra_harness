import { BrowserWindow, ipcMain, nativeTheme, screen, type WebContentsView } from "electron";
import { join } from "node:path";
import type { SelectionDescriptor } from "../../shared/capture-mode";
import { normalizeSelectionComment, selectionFingerprintMatches, type SelectionState } from "../../shared/selection";

export interface SelectionPopoverTarget {
  window: BrowserWindow;
  view: WebContentsView;
  selection: SelectionDescriptor;
  resume: () => void;
  attach: (comment?: string) => void;
}

/** Trusted app-owned child window: above the native webpage, never injected into its DOM. */
export class SelectionPopover {
  private popup: BrowserWindow | null = null;
  private target: SelectionPopoverTarget | null = null;
  private cleanup: (() => void) | null = null;

  constructor(private readonly getSelection: () => SelectionState) {}

  invalidate(state: SelectionState): void {
    if (this.target && (state.status !== "active" || !state.descriptor ||
      !selectionFingerprintMatches(state.descriptor, this.target.selection))) this.close(false);
  }

  close(resume = true): void {
    const target = this.target;
    const popup = this.popup;
    this.popup = null;
    this.target = null;
    this.cleanup?.();
    this.cleanup = null;
    if (popup && !popup.isDestroyed()) popup.destroy();
    if (resume) target?.resume();
  }

  async show(target: SelectionPopoverTarget, editing = false): Promise<void> {
    this.close(false);
    const state = this.getSelection();
    if (state.status !== "active" || !state.descriptor || !selectionFingerprintMatches(state.descriptor, target.selection)) return;
    this.target = target;
    const popup = new BrowserWindow({
      parent: target.window, frame: false, transparent: true, show: false,
      width: 340, height: 52, resizable: false, movable: false, skipTaskbar: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      title: "MyBuddy 元素评论", hasShadow: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(__dirname, "../preload/selectionPopover.js") },
    });
    this.popup = popup;
    let expanded = editing;
    const position = (): void => {
      if (popup.isDestroyed() || target.window.isDestroyed() || target.view.webContents.isDestroyed()) return;
      const parent = target.window.getContentBounds();
      const view = target.view.getBounds();
      if (view.width < 1 || view.height < 1) { this.close(false); return; }
      const zoom = target.view.webContents.getZoomFactor();
      const bounds = target.selection.bounds;
      const area = screen.getDisplayMatching(parent).workArea;
      const left = Math.max(area.x, parent.x + view.x);
      const right = Math.min(area.x + area.width, parent.x + view.x + view.width);
      const top = Math.max(area.y, parent.y + view.y);
      const bottom = Math.min(area.y + area.height, parent.y + view.y + view.height);
      const width = Math.min(340, Math.max(240, right - left));
      const height = expanded ? 210 : 52;
      const anchorTop = parent.y + view.y + bounds.y * zoom;
      const anchorBottom = anchorTop + bounds.height * zoom;
      const preferredY = anchorBottom + height + 8 <= bottom ? anchorBottom + 8 : anchorTop - height - 8;
      popup.setBounds({
        x: Math.round(Math.max(left, Math.min(parent.x + view.x + bounds.x * zoom, right - width))),
        y: Math.round(Math.max(top, Math.min(preferredY, bottom - height))), width, height,
      });
    };
    const close = (): void => this.close();
    const invalidate = (): void => this.close(false);
    popup.on("blur", close);
    target.window.on("move", close);
    target.window.on("resize", close);
    target.window.on("hide", invalidate);
    target.window.on("minimize", invalidate);
    target.view.on("bounds-changed", position);
    target.view.webContents.on("did-start-navigation", invalidate);
    target.view.webContents.on("destroyed", invalidate);
    this.cleanup = () => {
      ipcMain.removeListener("selection-popover:action", onAction);
      popup.removeListener("blur", close);
      target.window.removeListener("move", close);
      target.window.removeListener("resize", close);
      target.window.removeListener("hide", invalidate);
      target.window.removeListener("minimize", invalidate);
      target.view.removeListener("bounds-changed", position);
      if (!target.view.webContents.isDestroyed()) {
        target.view.webContents.removeListener("did-start-navigation", invalidate);
        target.view.webContents.removeListener("destroyed", invalidate);
      }
    };
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    popup.webContents.on("will-navigate", (event) => event.preventDefault());
    const onAction = (event: Electron.IpcMainEvent, request: { action?: unknown; text?: unknown } | null): void => {
      if (this.popup !== popup || event.sender !== popup.webContents || !request) return;
      const state = this.getSelection();
      if (state.status !== "active" || !state.descriptor || !selectionFingerprintMatches(state.descriptor, target.selection)) {
        this.close(false); return;
      }
      if (request.action === "edit") { expanded = true; position(); }
      else if (request.action === "cancel") this.close();
      else if (request.action === "add" || request.action === "comment") {
        const comment = request.action === "comment" ? normalizeSelectionComment(request.text) : undefined;
        if (request.action === "comment" && !comment) return;
        target.attach(comment);
        this.close();
        if (!target.window.isDestroyed()) { target.window.focus(); target.window.webContents.focus(); }
      }
    };
    ipcMain.on("selection-popover:action", onAction);
    try {
      await popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(popoverHtml(nativeTheme.shouldUseDarkColors))}`);
      if (this.popup !== popup || popup.isDestroyed()) return;
      const label = `${target.selection.tagName}${target.selection.id ? `#${target.selection.id}` : ""}`;
      await popup.webContents.executeJavaScript(`document.querySelector('#target').textContent = ${JSON.stringify(label)}; ${editing ? "edit(false);" : ""}`);
      if (this.popup !== popup || popup.isDestroyed()) return;
      position();
      popup.show();
    } catch (error) {
      if (this.popup === popup) this.close();
      console.warn("[SelectionPopover] could not open", error);
    }
  }
}

function popoverHtml(dark: boolean): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{padding:4px;font:13px system-ui,'Microsoft YaHei',sans-serif;color:${dark ? "#eee" : "#252525"}}
.card{border:1px solid ${dark ? "#4a4a4a" : "#ddd"};border-radius:12px;background:${dark ? "#292929" : "#fff"};height:100%;overflow:hidden}
.actions{height:42px;display:flex;align-items:center;padding:4px;gap:3px}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:transparent;border-radius:7px;padding:6px 8px;white-space:nowrap}
button:hover{background:${dark ? "#404040" : "#f0f0f0"}}button:focus-visible,textarea:focus-visible{outline:2px solid #2196e0;outline-offset:-2px}
.actions button{flex:1;display:flex;align-items:center;justify-content:center;gap:7px}.divider{height:19px;border-left:1px solid ${dark ? "#555" : "#ddd"}}
kbd{font:12px system-ui;color:${dark ? "#aaa" : "#777"}}svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.5}
#editor{padding:8px 12px}#target{display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:11px;opacity:.65;margin-bottom:6px}
textarea{display:block;width:100%;height:79px;resize:none;border:0;background:transparent;font:inherit;color:inherit;padding:4px 0;outline:none}
footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:5px}footer kbd{margin-right:auto}#submit{background:${dark ? "#eaeaea" : "#252525"};color:${dark ? "#222" : "white"};padding:6px 10px}#submit:disabled{opacity:.35;cursor:default}
</style><div class="card"><div class="actions">
<button id="comment"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3H15M18 2v6m-3-3h6"/></svg>评论到对话 <kbd>Ctrl J</kbd></button>
<span class="divider"></span><button id="add">添加到对话 <kbd>↵</kbd></button>
</div><form id="editor" hidden><span id="target"></span><textarea id="text" aria-label="元素评论" placeholder="描述更改或提出问题" maxlength="2000"></textarea><footer><kbd>Ctrl + Enter</kbd><button type="button" id="cancel">取消</button><button id="submit" type="submit" disabled>添加评论</button></footer></form></div>
<script>
const editor=document.querySelector('#editor'),text=document.querySelector('#text'),submit=document.querySelector('#submit');
const action=(name,value='')=>window.selectionPopover.action(name,value);
function edit(notify=true){editor.hidden=false;text.focus();if(notify)action('edit')}
document.querySelector('#comment').onclick=()=>edit();document.querySelector('#add').onclick=()=>action('add');document.querySelector('#cancel').onclick=()=>action('cancel');
text.oninput=()=>submit.disabled=!text.value.trim();editor.onsubmit=e=>{e.preventDefault();if(text.value.trim())action('comment',text.value)};
document.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Escape'){e.preventDefault();action('cancel')}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='j'){e.preventDefault();edit()}else if(e.key==='Enter'&&editor.hidden){e.preventDefault();action('add')}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();editor.requestSubmit()}};
</script></html>`;
}
