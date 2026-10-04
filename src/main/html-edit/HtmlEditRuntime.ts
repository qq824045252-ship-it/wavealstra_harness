import type { HtmlEditNode, HtmlEditPatch, HtmlEditRuntimeAction, HtmlEditRuntimeTick, HtmlEditRuntimeUiState, HtmlEditSnapshot } from "../../shared/html-edit";

/** Runs only in an isolated world. It owns the in-page editing UI but has no IPC, file or model access. */
interface RuntimeApi {
  source: string;
  command(name: string, value?: string): HtmlEditSnapshot;
  snapshot(): HtmlEditSnapshot;
  tick(): HtmlEditRuntimeTick;
  setState(state: HtmlEditRuntimeUiState): void;
  dispose(): void;
  resume(patches?: HtmlEditPatch[]): void;
  request(name: HtmlEditRuntimeAction["name"], value?: string): void;
  ui(): Record<string, unknown>;
  count: number;
}
function installEditor(source: string, nodes: HtmlEditNode[], restored: HtmlEditPatch[]): RuntimeApi {
  const scope = window as unknown as { __mybuddyHtmlEdit?: RuntimeApi };
  if (scope.__mybuddyHtmlEdit) {
    if (scope.__mybuddyHtmlEdit.source !== source) throw new Error("源文件已更新，请刷新页面后再进入编辑；旧草稿已保留");
    scope.__mybuddyHtmlEdit.resume(restored);
    return scope.__mybuddyHtmlEdit;
  }

  const baseline = new DOMParser().parseFromString(source, "text/html");
  type Entry = { node: HtmlEditNode; el: HTMLElement; html: string; style: string | null; editable: string | null; parent: Node | null; next: Node | null };
  const entries = new Map<string, Entry>();
  const byElement = new Map<HTMLElement, Entry>();
  for (const node of nodes) {
    const el = document.querySelector<HTMLElement>(node.selector), original = baseline.querySelector(node.selector);
    if (el && original && el.outerHTML === original.outerHTML) {
      const entry = { node, el, html: el.innerHTML, style: el.getAttribute("style"), editable: el.getAttribute("contenteditable"), parent: el.parentNode, next: el.nextSibling };
      entries.set(node.key, entry); byElement.set(el, entry);
    }
  }
  if (restored.some(p => !entries.has(p.key))) throw new Error("草稿节点与当前页面不匹配，草稿已保留。请恢复原页面后重试。");

  let selected: Entry | null = null, hovered: Entry | null = null, range: Range | null = null, revision = 0, error = "", active = false;
  let selectedRect: DOMRect | null = null, uiTimer = 0, layoutRuns = 0;
  let patches = new Map<string, HtmlEditPatch>();
  let history: HtmlEditPatch[][] = [[]], historyIndex = 0;
  let preview: { key: string; before: string; after: string } | null = null;
  let uiState: HtmlEditRuntimeUiState = { status: "点击页面中的文字开始编辑", canSave: false, busy: false, aiEnabled: false };
  let actionSeq = 0;
  const actions: HtmlEditRuntimeAction[] = [];

  const style = document.createElement("style");
  style.textContent = `
    #__mybuddy_html_hover,#__mybuddy_html_selected{all:initial;position:fixed!important;pointer-events:none!important;border-radius:6px!important;display:none;z-index:2147483645!important;box-sizing:border-box!important}
    #__mybuddy_html_hover{border:1px dashed rgba(22,120,210,.75)!important;background:rgba(22,120,210,.035)!important}
    #__mybuddy_html_selected{border:2px solid #1678d2!important;box-shadow:0 0 0 2px rgba(22,120,210,.12)!important}
    #__mybuddy_html_toolbar{all:initial;position:fixed!important;display:flex!important;align-items:center!important;gap:3px!important;max-width:min(720px,calc(100vw - 16px))!important;padding:5px 6px!important;border:1px solid rgba(90,90,90,.28)!important;border-radius:10px!important;background:rgba(255,255,255,.97)!important;box-shadow:0 8px 30px rgba(0,0,0,.16)!important;font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif!important;color:#222!important;pointer-events:auto!important;z-index:2147483647!important}
    #__mybuddy_html_toolbar *,#__mybuddy_html_ai *,#__mybuddy_html_preview *{box-sizing:border-box!important;font-family:system-ui,"Microsoft YaHei",sans-serif!important}
    #__mybuddy_html_toolbar button,#__mybuddy_html_ai button,#__mybuddy_html_preview button{height:27px!important;min-width:27px!important;padding:0 7px!important;border:0!important;border-radius:6px!important;background:transparent!important;color:inherit!important;font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif!important;cursor:pointer!important}
    #__mybuddy_html_toolbar button:hover,#__mybuddy_html_ai button:hover,#__mybuddy_html_preview button:hover{background:#edf3f9!important}
    #__mybuddy_html_toolbar button:disabled,#__mybuddy_html_ai button:disabled{opacity:.35!important;cursor:default!important;background:transparent!important}
    #__mybuddy_html_toolbar .primary,#__mybuddy_html_ai .primary,#__mybuddy_html_preview .primary{background:#1678d2!important;color:#fff!important}
    #__mybuddy_html_toolbar .danger:hover{background:#fff0f0!important;color:#b42318!important}
    #__mybuddy_html_toolbar .sep{width:1px!important;height:18px!important;background:#ddd!important;margin:0 2px!important}#__mybuddy_html_toolbar .spacer{flex:1!important}
    #__mybuddy_html_toolbar .status{max-width:180px!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;color:#666!important;padding:0 3px!important}#__mybuddy_html_toolbar .mode{font-weight:650!important;color:#1678d2!important;padding:0 3px!important;white-space:nowrap!important}
    #__mybuddy_html_ai{all:initial;position:fixed!important;display:none!important;width:min(420px,calc(100vw - 16px))!important;padding:7px!important;border:1px solid rgba(90,90,90,.28)!important;border-radius:10px!important;background:rgba(255,255,255,.98)!important;box-shadow:0 8px 30px rgba(0,0,0,.16)!important;font:12px/1.3 system-ui,"Microsoft YaHei",sans-serif!important;color:#222!important;pointer-events:auto!important;z-index:2147483647!important}#__mybuddy_html_ai.open{display:flex!important;gap:5px!important;align-items:center!important}
    #__mybuddy_html_ai input{height:30px!important;min-width:0!important;flex:1!important;border:1px solid #d6d6d6!important;border-radius:7px!important;padding:0 9px!important;outline:none!important;font:12px/1.2 system-ui,"Microsoft YaHei",sans-serif!important;color:inherit!important;background:#fff!important}
    #__mybuddy_html_preview{all:initial;position:fixed!important;display:none!important;align-items:center!important;gap:5px!important;padding:5px 6px!important;border:1px solid rgba(90,90,90,.28)!important;border-radius:9px!important;background:#fff8e8!important;box-shadow:0 8px 24px rgba(0,0,0,.14)!important;font:12px system-ui,"Microsoft YaHei",sans-serif!important;color:#6d4c00!important;pointer-events:auto!important;z-index:2147483647!important}#__mybuddy_html_preview.open{display:flex!important}
    @media (prefers-color-scheme:dark){#__mybuddy_html_toolbar,#__mybuddy_html_ai{background:rgba(38,38,38,.97)!important;color:#eee!important;border-color:#555!important}#__mybuddy_html_toolbar button:hover,#__mybuddy_html_ai button:hover{background:#454545!important}#__mybuddy_html_toolbar .sep{background:#555!important}#__mybuddy_html_toolbar .status{color:#bbb!important}#__mybuddy_html_ai input{background:#222!important;color:#eee!important;border-color:#555!important}#__mybuddy_html_preview{background:#493d20!important;color:#ffe9a8!important;border-color:#6c5a2a!important}}
  `;
  const hoverBox = document.createElement("div"); hoverBox.id = "__mybuddy_html_hover";
  const selectedBox = document.createElement("div"); selectedBox.id = "__mybuddy_html_selected";
  const toolbar = document.createElement("div"); toolbar.id = "__mybuddy_html_toolbar";
  toolbar.innerHTML = `<span class="mode">编辑</span><span class="status" id="status">点击文字开始</span><span class="sep"></span><button data-cmd="bold" title="加粗"><b>B</b></button><button data-cmd="italic" title="斜体"><i>I</i></button><button data-cmd="underline" title="下划线"><u>U</u></button><input id="color" type="color" value="#222222" title="文字颜色" style="width:28px;height:27px;padding:2px;border:0;background:transparent"><button data-cmd="align" data-value="left" title="左对齐">≡</button><button data-cmd="align" data-value="center" title="居中">≣</button><button data-cmd="align" data-value="right" title="右对齐">≡</button><span class="sep"></span><button data-cmd="undo" title="撤销">↶</button><button data-cmd="redo" title="重做">↷</button><button id="ai" title="AI 改写">✦ AI</button><button id="delete" data-cmd="delete" class="danger" title="删除这段">⌫</button><span class="spacer"></span><button id="save" class="primary" title="保存到源文件">保存</button><button id="done" title="完成编辑">完成</button>`;
  const aiPanel = document.createElement("div"); aiPanel.id = "__mybuddy_html_ai";
  aiPanel.innerHTML = `<input id="aiInput" maxlength="2000" placeholder="例如：更简洁一点，保留原意"><button id="aiGo" class="primary">生成</button><button id="aiCancel">取消</button>`;
  const previewBar = document.createElement("div"); previewBar.id = "__mybuddy_html_preview";
  previewBar.innerHTML = `<span>AI 预览已显示在原位置</span><button id="acceptPreview" class="primary">接受</button><button id="rejectPreview">撤销</button>`;
  const editorUiElements = [toolbar, aiPanel, previewBar];
  const isUiTarget = (target: EventTarget | null) => target instanceof Node && editorUiElements.some(el => el === target || el.contains(target));

  const statusEl = toolbar.querySelector<HTMLElement>("#status")!;
  const saveBtn = toolbar.querySelector<HTMLButtonElement>("#save")!;
  const aiBtn = toolbar.querySelector<HTMLButtonElement>("#ai")!;
  const deleteBtn = toolbar.querySelector<HTMLButtonElement>("#delete")!;
  const aiInput = aiPanel.querySelector<HTMLInputElement>("#aiInput")!;
  const aiGo = aiPanel.querySelector<HTMLButtonElement>("#aiGo")!;
  const restoreAttribute = (el: Element, name: string, value: string | null) => value === null ? el.removeAttribute(name) : el.setAttribute(name, value);
  const findEntry = (target: EventTarget | null): Entry | null => {
    let el = target instanceof Element ? target : null;
    while (el) { const hit = byElement.get(el as HTMLElement); if (hit) return hit; el = el.parentElement; }
    return null;
  };
  const enqueue = (name: HtmlEditRuntimeAction["name"], value?: string) => actions.push({ id: `${Date.now()}-${++actionSeq}`, name, value });
  const checkpoint = () => {
    const next = Array.from(patches.values());
    if (JSON.stringify(history[historyIndex]) === JSON.stringify(next)) return;
    history = history.slice(0, historyIndex + 1); history.push(next.map(p => ({ ...p })));
    if (history.length > 100) history.shift();
    historyIndex = history.length - 1; revision++;
  };
  const capture = () => {
    if (!selected || preview) return;
    const prev = patches.get(selected.node.key);
    if (prev?.deleted) return;
    if (selected.el.innerHTML === selected.html && !prev?.align) patches.delete(selected.node.key);
    else patches.set(selected.node.key, { key: selected.node.key, html: selected.el.innerHTML, align: prev?.align });
    checkpoint();
  };
  const rejectPreview = () => {
    if (!preview || !selected || selected.node.key !== preview.key) { preview = null; return; }
    selected.el.innerHTML = preview.before; selected.el.setAttribute("contenteditable", "true"); preview = null;
  };
  const select = (entry: Entry | null) => {
    if (selected === entry) return;
    if (preview) rejectPreview();
    if (selected) restoreAttribute(selected.el, "contenteditable", selected.editable);
    selected = entry; range = null; error = ""; aiPanel.classList.remove("open");
    if (selected) selected.el.setAttribute("contenteditable", "true");
    selectedRect = selected?.el.isConnected ? selected.el.getBoundingClientRect() : null;
    updateUi();
  };
  const applyPatches = (next: HtmlEditPatch[]) => {
    if (preview) rejectPreview(); select(null);
    for (const entry of entries.values()) {
      if (!patches.has(entry.node.key) && !next.some(p => p.key === entry.node.key)) continue;
      if (!entry.el.isConnected && entry.parent?.isConnected) entry.parent.insertBefore(entry.el, entry.next?.parentNode === entry.parent ? entry.next : null);
      entry.el.innerHTML = entry.html; restoreAttribute(entry.el, "style", entry.style);
    }
    patches = new Map();
    for (const patch of next) {
      const entry = entries.get(patch.key);
      if (!entry) { error = "部分草稿节点与当前页面不匹配，未恢复"; continue; }
      if (patch.deleted && entry.node.deletable) entry.el.remove();
      else { entry.el.innerHTML = patch.html; if (patch.align) entry.el.style.textAlign = patch.align; }
      patches.set(patch.key, { ...patch });
    }
    revision++;
  };
  const restoreRangeAtPoint = (x: number, y: number) => {
    if (!selected) return;
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    let r = doc.caretRangeFromPoint?.(x, y) ?? null;
    if (!r) { const p = doc.caretPositionFromPoint?.(x, y); if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); } }
    if (r && selected.el.contains(r.commonAncestorContainer)) { const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); range = r.cloneRange(); }
  };
  const positionBox = (box: HTMLElement, b: DOMRect | null) => {
    if (!b?.width || !b.height) { box.style.display = "none"; return; }
    Object.assign(box.style, { display: "block", left: `${Math.round(b.left - 2)}px`, top: `${Math.round(b.top - 2)}px`, width: `${Math.round(b.width + 4)}px`, height: `${Math.round(b.height + 4)}px` });
  };
  function renderUi(): void {
    layoutRuns++;
    const hoverRect = hovered && hovered !== selected && hovered.el.isConnected ? hovered.el.getBoundingClientRect() : null;
    selectedRect = selected?.el.isConnected ? selected.el.getBoundingClientRect() : null;
    positionBox(hoverBox, hoverRect);
    positionBox(selectedBox, selectedRect);
    const selectedControls = toolbar.querySelectorAll<HTMLButtonElement>("[data-cmd='bold'],[data-cmd='italic'],[data-cmd='underline'],[data-cmd='align'],#delete");
    selectedControls.forEach(btn => { btn.disabled = !selected || !!preview; });
    deleteBtn.disabled = !selected?.node.deletable || !!preview;
    aiBtn.disabled = !selected || !uiState.aiEnabled || uiState.busy || !!preview;
    saveBtn.disabled = !uiState.canSave || uiState.busy || !!preview || patches.size === 0;
    statusEl.textContent = error || uiState.status || (selected ? "直接输入即可修改" : "点击文字开始编辑");
    toolbar.style.visibility = "hidden"; toolbar.style.display = "flex";
    const toolbarRect = toolbar.getBoundingClientRect(), tw = Math.max(320, toolbarRect.width), th = toolbarRect.height || 38;
    let left = Math.max(8, window.innerWidth - tw - 12), top = 12;
    if (selectedRect) {
      left = Math.max(8, Math.min(selectedRect.left, window.innerWidth - tw - 8));
      top = selectedRect.top - th - 8 >= 8 ? selectedRect.top - th - 8 : Math.min(window.innerHeight - th - 8, selectedRect.bottom + 8);
    }
    toolbar.style.left = `${Math.round(left)}px`; toolbar.style.top = `${Math.round(Math.max(8, top))}px`; toolbar.style.visibility = "visible";
    if (aiPanel.classList.contains("open")) { aiPanel.style.left = `${Math.round(left)}px`; aiPanel.style.top = `${Math.round(Math.min(window.innerHeight - 50, top + th + 6))}px`; }
    if (preview) {
      previewBar.classList.add("open"); const pb = previewBar.getBoundingClientRect();
      const py = selectedRect ? Math.min(window.innerHeight - pb.height - 8, selectedRect.bottom + 8) : top + th + 6;
      previewBar.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - pb.width - 8)))}px`; previewBar.style.top = `${Math.round(Math.max(8, py))}px`;
    } else previewBar.classList.remove("open");
  }
  const updateUi = (): void => {
    if (uiTimer) return;
    uiTimer = window.setTimeout(() => { uiTimer = 0; if (active) renderUi(); }, 0);
  };
  const command = (name: string, value = ""): HtmlEditSnapshot => {
    error = "";
    if (name === "undo" || name === "redo") {
      if (preview) rejectPreview(); capture(); const next = historyIndex + (name === "undo" ? -1 : 1);
      if (next >= 0 && next < history.length) { historyIndex = next; applyPatches(history[next]); }
      updateUi(); return snapshot();
    }
    if (name === "discard") { if (preview) rejectPreview(); applyPatches([]); checkpoint(); updateUi(); return snapshot(); }
    if (name === "preview") {
      if (!selected || !selected.el.isConnected) throw new Error("请先选择文案节点");
      if (preview) rejectPreview(); preview = { key: selected.node.key, before: selected.el.innerHTML, after: value };
      selected.el.innerHTML = value; restoreAttribute(selected.el, "contenteditable", "false"); aiPanel.classList.remove("open"); updateUi(); return snapshot();
    }
    if (name === "acceptPreview") {
      if (!preview || !selected || selected.node.key !== preview.key) throw new Error("AI 预览已失效");
      restoreAttribute(selected.el, "contenteditable", "true"); preview = null; capture(); updateUi(); return snapshot();
    }
    if (name === "rejectPreview") { rejectPreview(); updateUi(); return snapshot(); }
    if (!selected || !selected.el.isConnected || preview) throw new Error(preview ? "请先接受或撤销 AI 预览" : "请先选择文案节点");
    const el = selected.el; el.focus(); const s = window.getSelection();
    if (range && el.contains(range.commonAncestorContainer)) { s?.removeAllRanges(); s?.addRange(range); }
    else { const r = document.createRange(); r.selectNodeContents(el); s?.removeAllRanges(); s?.addRange(r); }
    if (name === "delete") {
      if (!selected.node.deletable) throw new Error("此节点不能直接删除");
      const entry = selected; select(null); patches.set(entry.node.key, { key: entry.node.key, html: "", deleted: true }); entry.el.remove(); checkpoint();
    } else if (name === "replace") { el.innerHTML = value; range = null; capture(); }
    else if (name === "align") { el.style.textAlign = value; patches.set(selected.node.key, { key: selected.node.key, html: el.innerHTML, align: value }); checkpoint(); }
    else {
      if (["bold", "italic", "underline", "strikeThrough", "foreColor", "createLink", "unlink"].includes(name)) document.execCommand(name, false, value);
      capture(); const sel = window.getSelection(); if (sel?.rangeCount && el.contains(sel.getRangeAt(0).commonAncestorContainer)) range = sel.getRangeAt(0).cloneRange();
    }
    updateUi(); return snapshot();
  };
  const snapshot = (): HtmlEditSnapshot => {
    let current: HtmlEditSnapshot["selected"] = null;
    if (selected?.el.isConnected) { const b = selectedRect; current = { key: selected.node.key, text: selected.el.textContent ?? "", html: selected.el.innerHTML, deletable: selected.node.deletable, x: b?.x ?? 0, y: b?.y ?? 0, width: b?.width ?? 0, height: b?.height ?? 0 }; }
    return { revision, patches: Array.from(patches.values()), selected: current, error };
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || isUiTarget(event.target)) return;
    const entry = findEntry(event.target); event.preventDefault(); event.stopImmediatePropagation();
    if (!entry) { select(null); error = "这里不是可安全写回的静态文案"; updateUi(); return; }
    if (preview && selected !== entry) rejectPreview(); select(entry); entry.el.focus(); restoreRangeAtPoint(event.clientX, event.clientY); updateUi();
  };
  const move = (event: MouseEvent) => { if (!event.isTrusted || isUiTarget(event.target)) return; const next = findEntry(event.target); if (next === hovered) return; hovered = next; updateUi(); };
  const input = (event: Event) => { if (event.isTrusted && !preview) { capture(); updateUi(); } };
  const selection = () => { const s = window.getSelection(); if (selected && s?.rangeCount && selected.el.contains(s.getRangeAt(0).commonAncestorContainer)) range = s.getRangeAt(0).cloneRange(); };
  const paste = (event: ClipboardEvent) => { if (!selected || preview) return; event.preventDefault(); event.stopImmediatePropagation(); document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? ""); capture(); updateUi(); };
  const drop = (event: DragEvent) => { if (selected) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const keydown = (event: KeyboardEvent) => {
    if (isUiTarget(event.target) || event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && ["z", "y", "s"].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopImmediatePropagation(); const key = event.key.toLowerCase();
      if (key === "s") { if (!preview) enqueue("save"); }
      else command(key === "y" || event.shiftKey ? "redo" : "undo");
    }
    if (selected && !preview && event.key === "Enter") { event.preventDefault(); document.execCommand("insertLineBreak"); capture(); updateUi(); }
    if (event.key === "Escape") { if (preview) command("rejectPreview"); else if (aiPanel.classList.contains("open")) aiPanel.classList.remove("open"); else select(null); updateUi(); }
  };
  const reposition = () => updateUi();
  const onToolbarClick = (event: Event) => {
    if (!(event instanceof MouseEvent) || !event.isTrusted) return; event.stopPropagation();
    const target = (event.target as Element | null)?.closest<HTMLElement>("button"); if (!target) return;
    const cmd = target.dataset.cmd;
    try {
      if (cmd) command(cmd, target.dataset.value ?? "");
      else if (target.id === "ai") { aiPanel.classList.toggle("open"); updateUi(); if (aiPanel.classList.contains("open")) aiInput.focus(); }
      else if (target.id === "save") enqueue("save");
      else if (target.id === "done") enqueue("stop");
      else if (target.id === "aiGo") { const value = aiInput.value.trim(); if (!value) { error = "输入一句修改要求"; updateUi(); } else { enqueue("ai", value); aiPanel.classList.remove("open"); updateUi(); } }
      else if (target.id === "aiCancel") { aiPanel.classList.remove("open"); updateUi(); }
      else if (target.id === "acceptPreview") command("acceptPreview");
      else if (target.id === "rejectPreview") command("rejectPreview");
    } catch (e) { error = e instanceof Error ? e.message : String(e); updateUi(); }
  };
  const onToolbarChange = (event: Event) => { if (!event.isTrusted) return; const target = event.target as HTMLInputElement; if (target.id === "color") { try { command("foreColor", target.value); } catch (e) { error = String(e); updateUi(); } } };
  const onAiKey = (event: KeyboardEvent) => { event.stopPropagation(); if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); const value = aiInput.value.trim(); if (value) { enqueue("ai", value); aiPanel.classList.remove("open"); updateUi(); } } };
  toolbar.addEventListener("click", onToolbarClick); aiPanel.addEventListener("click", onToolbarClick); previewBar.addEventListener("click", onToolbarClick); toolbar.addEventListener("change", onToolbarChange); aiInput.addEventListener("keydown", onAiKey);

  const setState = (next: HtmlEditRuntimeUiState) => { const changed = next.status !== uiState.status || next.canSave !== uiState.canSave || next.busy !== uiState.busy || next.aiEnabled !== uiState.aiEnabled; if (!changed) return; uiState = next; if (!next.busy) aiGo.textContent = "生成"; else aiGo.textContent = "生成中…"; aiGo.disabled = next.busy; updateUi(); };
  const tick = (): HtmlEditRuntimeTick => ({ snapshot: snapshot(), actions: actions.splice(0, actions.length) });
  const request = (name: HtmlEditRuntimeAction["name"], value?: string) => enqueue(name, value);
  const uiRect = (el: Element | null) => {
    if (!(el instanceof HTMLElement) || !el.isConnected) return null;
    const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, width: b.width, height: b.height, disabled: el instanceof HTMLButtonElement ? el.disabled : false };
  };
  const ui = () => ({
    active, selected: selected?.node.key ?? null, preview: !!preview, aiOpen: aiPanel.classList.contains("open"), patches: patches.size, toolbarText: toolbar.textContent, layoutRuns,
    controls: {
      bold: uiRect(toolbar.querySelector("[data-cmd=bold]")), ai: uiRect(aiBtn), save: uiRect(saveBtn), done: uiRect(toolbar.querySelector("#done")),
      aiInput: uiRect(aiInput), aiGo: uiRect(aiGo), acceptPreview: uiRect(previewBar.querySelector("#acceptPreview")), rejectPreview: uiRect(previewBar.querySelector("#rejectPreview")),
    },
  });
  const resume = (restoredPatches?: HtmlEditPatch[]) => {
    if (restoredPatches && JSON.stringify(restoredPatches) !== JSON.stringify(Array.from(patches.values()))) { applyPatches(restoredPatches); checkpoint(); }
    if (active) { updateUi(); return; } active = true; document.documentElement.append(style, hoverBox, selectedBox, toolbar, aiPanel, previewBar);
    document.addEventListener("click", click, true); document.addEventListener("mousemove", move, true); document.addEventListener("input", input, true); document.addEventListener("selectionchange", selection); document.addEventListener("paste", paste, true); document.addEventListener("drop", drop, true); document.addEventListener("keydown", keydown, true); window.addEventListener("scroll", reposition, true); window.addEventListener("resize", reposition); updateUi();
  };
  const dispose = () => {
    if (preview) rejectPreview(); if (selected) restoreAttribute(selected.el, "contenteditable", selected.editable); selected = null; hovered = null; range = null; selectedRect = null; active = false; if (uiTimer) clearTimeout(uiTimer); uiTimer = 0; style.remove(); hoverBox.remove(); selectedBox.remove(); toolbar.remove(); aiPanel.remove(); previewBar.remove();
    document.removeEventListener("click", click, true); document.removeEventListener("mousemove", move, true); document.removeEventListener("input", input, true); document.removeEventListener("selectionchange", selection); document.removeEventListener("paste", paste, true); document.removeEventListener("drop", drop, true); document.removeEventListener("keydown", keydown, true); window.removeEventListener("scroll", reposition, true); window.removeEventListener("resize", reposition);
  };
  if (restored.length) { applyPatches(restored); checkpoint(); }
  const api: RuntimeApi = { source, command, snapshot, tick, setState, dispose, resume, request, ui, count: entries.size };
  scope.__mybuddyHtmlEdit = api; resume(); return api;
}

export const EDIT_WORLD = 1004;
export function editorScript(source: string, nodes: HtmlEditNode[], patches: HtmlEditPatch[]): string {
  return `(${installEditor.toString()})(${JSON.stringify(source)},${JSON.stringify(nodes)},${JSON.stringify(patches)}).count`;
}
export function editorCommand(command?: string, value?: string): string {
  return command ? `window.__mybuddyHtmlEdit.command(${JSON.stringify(command)},${JSON.stringify(value ?? "")})` : "window.__mybuddyHtmlEdit.snapshot()";
}
export function editorSnapshot(): string { return "window.__mybuddyHtmlEdit.snapshot()"; }
export function editorTick(): string { return "window.__mybuddyHtmlEdit.tick()"; }
export function editorSetState(state: HtmlEditRuntimeUiState): string { return `window.__mybuddyHtmlEdit.setState(${JSON.stringify(state)})`; }
export function editorRequest(name: HtmlEditRuntimeAction["name"], value?: string): string { return `window.__mybuddyHtmlEdit.request(${JSON.stringify(name)},${JSON.stringify(value ?? "")})`; }
export function editorUi(): string { return "window.__mybuddyHtmlEdit.ui()"; }
