import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ClipboardEvent, type ReactNode } from "react";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type Editor, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Mathematics } from "@tiptap/extension-mathematics";
import Image from "@tiptap/extension-image";
import type { ScopedLibraryOperations } from "@/lib/scopedLibraryOperations";
import { libraryLinkedVersion } from "@/lib/scopedLibrary";
import ScopedLibraryMarkdown, { ScopedImage } from "./ScopedLibraryMarkdown";
import "katex/dist/katex.min.css";

interface Props {
  itemId: string;
  access: ScopedLibraryOperations;
  content: string;
  onChange: (content: string) => void;
  onOpenItem: (id: string, version?: number) => void;
  onError: (message: string) => void;
}

type Mode = "rich" | "source" | "preview";
const cursorByItem = new Map<string, { mode: Mode; start: number; end: number; scroll: number }>();
const unavailableInRichText = /(?:^ {0,3}\[[^\]\n]+\]:|(?<!\\)<!--|(?<!\\)<\/?[a-z][a-z0-9]*(?=[\s/>])|\\\[|\\\()/i;
const externalLink = /^https?:\/\//i;

function needsSourceMode(markdown: string): boolean {
  let fence: string | undefined;
  return markdown.split("\n").some((line) => {
    const marker = /^ {0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker;
      return false;
    }
    return !fence && unavailableInRichText.test(line.replace(/(\x60+).*?\1/g, ""));
  });
}

function noteExtensions(props: Pick<Props, "itemId" | "access">) {
  function ImageNode({ node }: NodeViewProps) {
    return <NodeViewWrapper className="notes-image"><ScopedImage src={node.attrs.src} alt={node.attrs.alt}
      itemId={props.itemId} access={props.access} /></NodeViewWrapper>;
  }
  return [
    StarterKit.configure({ trailingNode: false, link: { openOnClick: false,
      isAllowedUri: (uri, context) => /^mybuddy-library:\/\/local\//i.test(uri) || context.defaultValidate(uri) } }),
    Markdown.configure({ markedOptions: { gfm: true } }),
    TaskList, TaskItem.configure({ nested: true }), TableKit, Mathematics.configure({ katexOptions: { throwOnError: false } }),
    Image.extend({ addNodeView() { return ReactNodeViewRenderer(ImageNode); } }).configure({ allowBase64: true }),
  ];
}

export default function NoteEditor(props: Props): React.JSX.Element {
  const { itemId, access, content } = props;
  const stored = cursorByItem.get(itemId);
  const cannotRich = needsSourceMode(content);
  const [mode, setMode] = useState<Mode>(access.readOnly ? "preview" : stored?.mode ?? (cannotRich ? "source" : "rich"));
  const actualMode = access.readOnly ? "preview" : mode === "rich" && cannotRich ? "source" : mode;
  const modeRef = useRef(actualMode);
  modeRef.current = actualMode;
  const [tool, setTool] = useState<"link" | "inlineMath" | "blockMath" | null>(null);
  const [toolValue, setToolValue] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");
  const [assetItems, setAssetItems] = useState<Array<{ id: string; title: string; kind: string }>>([]);
  const [chosenItem, setChosenItem] = useState("");
  const [pickingImages, setPickingImages] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const richCursor = useRef(stored?.mode === "rich" ? { from: stored.start, to: stored.end } : null);
  const sourceCursor = useRef(stored?.mode === "source" ? { from: stored.start, to: stored.end } : { from: 0, to: 0 });
  const latest = useRef(props);
  latest.current = props;
  const lastSource = useRef(content);
  const lastRich = useRef<string | null>(null);
  const initialRich = cannotRich ? "" : content;
  const editor = useEditor({
    extensions: noteExtensions(props),
    content: initialRich,
    contentType: "markdown",
    editable: !access.readOnly,
    editorProps: {
      attributes: { "aria-label": "富文本正文", role: "textbox", "aria-multiline": "true", spellcheck: "false" },
      handleClick: (_view, _pos, event) => {
        const href = (event.target as HTMLElement | null)?.closest("a")?.getAttribute("href");
        if (!href || !(event.ctrlKey || event.metaKey)) return false;
        event.preventDefault();
        if (externalLink.test(href)) void latest.current.access.note({ type: "openLink", url: href }).catch(report);
        else void latest.current.access.resolveLink(itemId, href).then((id) => latest.current.onOpenItem(id, libraryLinkedVersion(href)), report);
        return true;
      },
    },
    onCreate: ({ editor }) => { lastRich.current = editor.getMarkdown(); },
    onUpdate: ({ editor }) => {
      if (modeRef.current !== "rich") return;
      const markdown = editor.getMarkdown();
      if (lastRich.current?.trimEnd() === markdown.trimEnd()) return;
      lastRich.current = markdown;
      lastSource.current = markdown;
      latest.current.onChange(markdown);
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      richCursor.current = { from, to };
      if (modeRef.current === "rich") cursorByItem.set(itemId, { mode: "rich", start: from, end: to, scroll: surface.current?.scrollTop ?? 0 });
    },
  }, [itemId, access]);
  const toolbar = useEditorState({ editor, selector: ({ editor }) => editor ? {
    bold: editor.isActive("bold"), italic: editor.isActive("italic"), strike: editor.isActive("strike"),
    code: editor.isActive("code"), list: editor.isActive("bulletList"), ordered: editor.isActive("orderedList"),
    task: editor.isActive("taskList"), quote: editor.isActive("blockquote"), table: editor.isActive("table"),
    language: editor.isActive("codeBlock") ? String(editor.getAttributes("codeBlock").language || "") : null,
    heading: editor.isActive("heading") ? Number(editor.getAttributes("heading").level) : 0,
    undo: editor.can().undo(), redo: editor.can().redo(),
  } : null });
  const report = (error: unknown): void => latest.current.onError(error instanceof Error ? error.message : "笔记操作失败");

  useEffect(() => {
    if (!editor || actualMode !== "rich") return;
    if (lastSource.current !== content) {
      editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false });
      lastSource.current = content;
      lastRich.current = editor.getMarkdown();
    }
    const remembered = richCursor.current;
    if (remembered) editor.commands.setTextSelection({
      from: Math.min(Math.max(1, remembered.from), editor.state.doc.content.size),
      to: Math.min(Math.max(1, remembered.to), editor.state.doc.content.size),
    });
  }, [actualMode, content, editor]);

  useEffect(() => {
    if (actualMode === "source" && input.current) input.current.setSelectionRange(sourceCursor.current.from, sourceCursor.current.to);
    if (surface.current) surface.current.scrollTop = cursorByItem.get(itemId)?.scroll ?? 0;
  }, [actualMode, itemId]);

  const remember = () => {
    const selection = actualMode === "rich" ? richCursor.current : sourceCursor.current;
    cursorByItem.set(itemId, { mode: actualMode, start: selection?.from ?? 0, end: selection?.to ?? 0, scroll: surface.current?.scrollTop ?? 0 });
  };

  const moveToMatches = (replaceCurrent = false): void => {
    if (!search) return;
    const needle = search.toLowerCase();
    if (actualMode === "source" && input.current) {
      const element = input.current;
      const source = content.toLowerCase();
      if (replaceCurrent && source.slice(element.selectionStart, element.selectionEnd) === needle) {
        replaceInSource(replace);
        return;
      }
      let index = source.indexOf(needle, element.selectionEnd);
      if (index < 0) index = source.indexOf(needle);
      if (index >= 0) { element.focus(); element.setSelectionRange(index, index + needle.length); }
      else report("笔记中没有匹配的文字");
    } else if (actualMode === "rich" && editor) {
      const selections: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node, position) => {
        if (!node.isText || !node.text) return;
        const text = node.text.toLowerCase();
        for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
          selections.push({ from: position + index, to: position + index + needle.length });
        }
      });
      const { from, to } = editor.state.selection;
      const selected = selections.find((entry) => entry.from === from && entry.to === to);
      if (selected && replaceCurrent) {
        editor.chain().focus().deleteRange(selected).insertContent(replace ? { type: "text", text: replace } : []).run();
        return;
      }
      const match = selections.find((entry) => entry.from >= to) ?? selections[0];
      if (match) editor.chain().focus().setTextSelection(match).scrollIntoView().run();
      else report("笔记中没有匹配的文字");
    }
  };

  function replaceInSource(value: string): void {
    const element = input.current;
    if (!element) return;
    const { selectionStart, selectionEnd } = element;
    const source = latest.current.content;
    latest.current.onChange(source.slice(0, selectionStart) + value + source.slice(selectionEnd));
    sourceCursor.current = { from: selectionStart + value.length, to: selectionStart + value.length };
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(selectionStart + value.length, selectionStart + value.length); });
  }

  function insertStoredImages(images: Array<{ url: string; name: string }>): void {
    if (!images.length || latest.current.itemId !== itemId || latest.current.access !== access || access.readOnly) return;
    if (modeRef.current === "source") {
      replaceInSource(images.map(({ name, url }) => "\n![" + name.replace(/[\[\]]/g, "") + "](" + url + ")\n").join(""));
    } else if (modeRef.current === "rich" && editor && !editor.isDestroyed) {
      const nodes = images.map(({ name, url }) => ({
        type: "image",
        attrs: { src: url, alt: name },
      }));
      editor.chain().focus().insertContentAt(editor.state.selection.to, nodes).run();
    }
  }

  async function pickImages(): Promise<void> {
    setPickingImages(true);
    try {
      const { images, errors } = await access.note({ type: "pickImages", owner: access.scope, id: itemId });
      insertStoredImages(images);
      if (errors.length) latest.current.onError(errors.join("\n"));
    } catch (error) { report(error); }
    finally { setPickingImages(false); }
  }

  async function insertImages(files: File[]): Promise<void> {
    const images: Array<{ url: string; name: string }> = [];
    for (const file of files) {
      try {
        const url = await access.note({ type: "addImage", owner: access.scope, id: itemId,
          mime: file.type, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        images.push({ url, name: file.name });
      } catch (error) { report(error); }
    }
    insertStoredImages(images);
  }

  const transferImages = (event: DragEvent | ClipboardEvent): void => {
    const transfer = "dataTransfer" in event ? event.dataTransfer : event.clipboardData;
    const images = Array.from(transfer.files).filter((file) => file.type.startsWith("image/"));
    if (!images.length || access.readOnly || actualMode === "preview") return;
    event.preventDefault(); event.stopPropagation();
    void insertImages(images);
  };

  const addLink = (): void => {
    setTool("link"); setToolValue(editor?.getAttributes("link").href ?? "");
    setChosenItem("");
    void access.snapshot().then((snapshot) => setAssetItems(snapshot.items.filter((item) => item.id !== itemId)), report);
  };
  const submitTool = (): void => {
    const value = toolValue.trim();
    if (tool === "link") {
      const linkedItem = assetItems.find((item) => item.id === chosenItem);
      const url = linkedItem ? "mybuddy-library://local/" + encodeURIComponent(linkedItem.id) + "/" : value;
      if (!/^(https?:\/\/|mailto:|mybuddy-library:\/\/local\/|#)/i.test(url)) { report("请输入有效的网页或笔记链接"); return; }
      const label = (linkedItem?.title ?? url).replace(/[\[\]]/g, "");
      if (actualMode === "source") replaceInSource("[" + label + "](" + url + ")");
      else if (editor && editor.state.selection.empty) editor.chain().focus().insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href: url } }] }).run();
      else editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    } else if (value) {
      if (actualMode === "source") replaceInSource(tool === "blockMath" ? "\n$$\n" + value + "\n$$\n" : "$" + value + "$");
      else if (tool === "blockMath") editor?.chain().focus().insertBlockMath({ latex: value }).run();
      else editor?.chain().focus().insertInlineMath({ latex: value }).run();
    }
    setTool(null);
  };
  const toolButton = (label: string, text: ReactNode, action: () => void, active?: boolean, disabled?: boolean) =>
    <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled}
      onMouseDown={(event) => event.preventDefault()} onClick={action}>{text}</button>;
  const pickLanguage = (event: ChangeEvent<HTMLSelectElement>) =>
    editor?.chain().focus().updateAttributes("codeBlock", { language: event.target.value.trim() || null }).run();

  return <div className="note-editor" onPasteCapture={transferImages} onDropCapture={transferImages}
    onDragOver={(event) => { if (!access.readOnly && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
    onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && actualMode !== "preview") {
        event.preventDefault(); setSearchOpen(true);
      }
    }}>
    <div className="note-edit-modes">
      {!access.readOnly && <>
        <button aria-pressed={actualMode === "rich"} onClick={() => { remember(); setMode("rich"); }} disabled={cannotRich}>富文本</button>
        <button aria-pressed={actualMode === "source"} onClick={() => { remember(); setMode("source"); }}>Markdown</button>
      </>}
      <button aria-pressed={actualMode === "preview"} onClick={() => { remember(); setMode("preview"); }}>预览</button>
    </div>
    {cannotRich && actualMode === "source" && <div className="note-status">这篇笔记包含原始 HTML 或扩展语法，已保留全部 Markdown。</div>}
    {actualMode !== "preview" && <div className="note-format-bar" role="toolbar" aria-label="笔记格式">
      {actualMode === "rich" && editor && toolbar && <>
        {toolButton("撤销", "↶", () => editor.chain().focus().undo().run(), undefined, !toolbar.undo)}
        {toolButton("重做", "↷", () => editor.chain().focus().redo().run(), undefined, !toolbar.redo)}
        <select value={toolbar.heading} aria-label="段落或标题" onChange={(event) => {
          const level = Number(event.target.value) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
          if (level) editor.chain().focus().setHeading({ level }).run(); else editor.chain().focus().setParagraph().run();
        }}><option value={0}>正文</option>{[1, 2, 3, 4, 5, 6].map((level) => <option value={level} key={level}>标题 {level}</option>)}</select>
        {toolButton("粗体", <b>B</b>, () => editor.chain().focus().toggleBold().run(), toolbar.bold)}
        {toolButton("斜体", <i>I</i>, () => editor.chain().focus().toggleItalic().run(), toolbar.italic)}
        {toolButton("删除线", <s>S</s>, () => editor.chain().focus().toggleStrike().run(), toolbar.strike)}
        {toolButton("引用", "❝", () => editor.chain().focus().toggleBlockquote().run(), toolbar.quote)}
        {toolButton("无序列表", "•≡", () => editor.chain().focus().toggleBulletList().run(), toolbar.list)}
        {toolButton("有序列表", "1≡", () => editor.chain().focus().toggleOrderedList().run(), toolbar.ordered)}
        {toolButton("任务列表", "☑", () => editor.chain().focus().toggleTaskList().run(), toolbar.task)}
        {toolButton("行内代码", "<>", () => editor.chain().focus().toggleCode().run(), toolbar.code)}
        {toolButton("代码块", "代码", () => editor.chain().focus().toggleCodeBlock().run(), toolbar.language !== null)}
        {toolbar.language !== null && <select aria-label="代码语言" value={toolbar.language} onChange={pickLanguage}>
          {Array.from(new Set(["", "text", "javascript", "typescript", "python", "bash", "json", "sql", "html", "css", "mermaid", toolbar.language])).map((lang) =>
            <option value={lang} key={lang}>{lang || "语言"}</option>)}</select>}
        {toolButton("表格", "▦", () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {toolbar.table && <select aria-label="编辑表格" value="" onChange={(event) => {
          const chain = editor.chain().focus();
          switch (event.target.value) {
            case "row": chain.addRowAfter().run(); break;
            case "col": chain.addColumnAfter().run(); break;
            case "delrow": chain.deleteRow().run(); break;
            case "delcol": chain.deleteColumn().run(); break;
            case "deltable": chain.deleteTable().run(); break;
          }
        }}><option value="">编辑表格</option><option value="row">插入行</option><option value="col">插入列</option>
          <option value="delrow">删除行</option><option value="delcol">删除列</option><option value="deltable">删除表格</option></select>}
      </>}
      {toolButton("插入链接或笔记引用", "链接", addLink)}
      {toolButton("插入图片", "图片", () => void pickImages(), undefined, pickingImages)}
      {toolButton("行内公式", "ƒ", () => { setTool("inlineMath"); setToolValue(""); })}
      {toolButton("块公式", "∑", () => { setTool("blockMath"); setToolValue(""); })}
      {toolButton("查找和替换", "查找", () => setSearchOpen((value) => !value))}
    </div>}
    {tool && <form className="note-inline-form" onSubmit={(event) => { event.preventDefault(); submitTool(); }}>
      <input autoFocus aria-label={tool.includes("Math") ? "LaTeX 公式" : "链接网址"} placeholder={tool.includes("Math") ? "LaTeX" : "https://"}
        value={toolValue} onChange={(event) => setToolValue(event.target.value)} />
      {tool === "link" && <select aria-label="引用现有资料" value={chosenItem} onChange={(event) => setChosenItem(event.target.value)}>
        <option value="">选择笔记或附件</option>{assetItems.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
      </select>}
      <button type="submit">插入</button><button type="button" onClick={() => setTool(null)}>取消</button>
    </form>}
    {searchOpen && actualMode !== "preview" && <form className="note-inline-form" onSubmit={(event) => { event.preventDefault(); moveToMatches(); }}>
      <input autoFocus aria-label="查找正文" placeholder="查找" value={search} onChange={(event) => setSearch(event.target.value)} />
      <input aria-label="替换为" placeholder="替换为" value={replace} onChange={(event) => setReplace(event.target.value)} />
      <button>下一个</button><button type="button" onClick={() => moveToMatches(true)}>替换</button>
      <button type="button" onClick={() => setSearchOpen(false)}>关闭</button>
    </form>}
    <div className="note-editor-scroll" ref={surface} onScroll={remember}>
      {actualMode === "rich" && <EditorContent editor={editor} className="note-rich" />}
      {actualMode === "source" && <textarea value={content} ref={input} spellCheck={false} aria-label="文档正文" placeholder="用 Markdown 写正文"
        onChange={(event) => props.onChange(event.target.value)} onScroll={remember}
        onSelect={(event) => {
          sourceCursor.current = { from: event.currentTarget.selectionStart, to: event.currentTarget.selectionEnd };
          remember();
        }} />}
      {actualMode === "preview" && <ScopedLibraryMarkdown content={content} itemId={itemId} access={access}
        onOpenItem={props.onOpenItem} onError={props.onError} notes />}
    </div>
  </div>;
}

