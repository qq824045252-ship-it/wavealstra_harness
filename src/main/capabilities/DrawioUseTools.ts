import { shell } from "electron";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { DRAWIO_USE_TOOLS, isDrawioFile } from "../../shared/drawio-use";
import type { ArtifactService } from "../artifact/ArtifactService";
import { findDrawioShapes, readDrawioReference, repairDrawioXml } from "../drawio-use/DrawioReferences";
import { getDrawioRuntime } from "../drawio-use/DrawioRuntime";
import { assertDrawioBytes, DRAWIO_FILE_LIMIT, drawioCells, editDrawioPage, EMPTY_DRAWIO, readDrawioPages, readEmbeddedDrawioSvg, serializeDrawioXml } from "../drawio-use/DrawioXml";
import { atomicBytes, digest, plainFile } from "../office-use/OfficeFile";
import { assertPathInsideTask } from "../task/TaskExecutionWorkspace";
import { isChatAttachment } from "../task/ChatAttachmentAccess";

const pathField = Type.String({ minLength: 1, maxLength: 1024 });
const xmlField = Type.String({ minLength: 1, maxLength: 2000000 });
const pageField = Type.Integer({ minimum: 1, maximum: 1000 });
const revisionField = Type.String({ pattern: "^[a-f0-9]{64}$" });
const strict = { additionalProperties: false };
const preset = Type.Union([
  Type.Literal("verticalFlow"), Type.Literal("horizontalFlow"), Type.Literal("verticalTree"),
  Type.Literal("horizontalTree"), Type.Literal("radialTree"), Type.Literal("organic"), Type.Literal("libavoid"),
]);
const algorithm = Type.Union([
  Type.Literal("elkLayered"), Type.Literal("elkTree"), Type.Literal("elkRadial"),
  Type.Literal("elkOrganic"), Type.Literal("elkStress"), Type.Literal("elkBox"),
]);
const layoutField = Type.Union([preset, Type.Array(Type.Object({
  layout: algorithm,
  config: Type.Optional(Type.Record(Type.String({ maxLength: 120 }), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
}, strict), { minItems: 1, maxItems: 12 })]);
const layoutArgument = (layout: unknown) => typeof layout === "string" ? layout : JSON.stringify(layout);

interface Ports {
  taskId: string;
  taskRoot(): string;
  artifacts(): ArtifactService | null;
  producerMessageId(): string | undefined;
  getPermissionMode(): PermissionMode;
  isEnabled(): boolean;
}

const exportKinds = { png: "image", svg: "svg", pdf: "pdf", jpg: "image" } as const;

export function createDrawioUseExtension(ports: Ports): ExtensionFactory {
  function assertEnabled(signal?: AbortSignal, writable = false) {
    signal?.throwIfAborted();
    if (!ports.isEnabled()) throw new Error("Draw.io Use 已在工具能力中关闭");
    if (writable && ports.getPermissionMode() === "readonly") throw new Error("当前任务为只读模式");
  }

  async function result(action: () => Promise<object>, signal?: AbortSignal, writable = false) {
    try {
      assertEnabled(signal, writable);
      const details = await action();
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    } catch (error) {
      const message = (error as Error).message;
      return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
    }
  }

  async function read(source: string, context: ExtensionContext, signal?: AbortSignal) {
    const root = ports.taskRoot();
    const requested = resolve(root, source);
    if (!/\.(?:drawio|xml|drawio\.(?:png|svg|pdf))$/i.test(requested)) {
      throw new Error("请选择 .drawio、Draw.io XML 或可回编 PNG、SVG、PDF 源文件");
    }
    let path: string;
    try { path = assertPathInsideTask(root, requested); }
    catch (error) {
      const artifacts = ports.artifacts();
      const artifact = artifacts?.findByEntryFile(ports.taskId, requested);
      if (artifact?.source.type === "workspace-file") path = assertPathInsideTask(artifact.source.rootDir, requested);
      else if (isAbsolute(source) && isChatAttachment(context, requested)) path = requested;
      else throw error;
    }
    await plainFile(path);
    if ((await lstat(path)).size > DRAWIO_FILE_LIMIT) throw new Error("Draw.io 源文件超过 32 MiB");
    const bytes = await readFile(path, { signal });
    const extension = extname(path).toLowerCase();
    const xml = extension === ".png" || extension === ".pdf"
      ? (await getDrawioRuntime().render({ format: "xml", xml: bytes.toString("base64") }, signal)).toString("utf8")
      : extension === ".svg" ? readEmbeddedDrawioSvg(bytes.toString("utf8")) : bytes.toString("utf8");
    assertDrawioBytes(Buffer.from(xml));
    return { path, xml, revision: digest(bytes) };
  }

  async function deliver(raw: string, bytes: Buffer, format: keyof typeof exportKinds | "drawio",
    toolCallId: string, root: string, signal?: AbortSignal) {
    if (format === "drawio" ? !isDrawioFile(raw) : extname(raw).toLowerCase() !== "." + format) {
      throw new Error("请使用 ." + format + " 文件扩展名");
    }
    assertEnabled(signal, true);
    const configuredRoot = ports.taskRoot();
    if (await realpath(configuredRoot) !== root) throw new Error("任务工作区已变化，请重试");
    const target = assertPathInsideTask(root, resolve(root, raw));
    const artifacts = ports.artifacts();
    if (!artifacts) throw new Error("任务产物服务不可用");
    await mkdir(dirname(target), { recursive: true });
    const path = assertPathInsideTask(root, resolve(await realpath(dirname(target)), basename(target)));
    await atomicBytes(path, bytes, async () => {
      assertEnabled(signal, true);
      if (await realpath(configuredRoot) !== root) throw new Error("任务工作区已变化，请重试");
      assertPathInsideTask(root, path);
    }, { create: true }).catch(error => {
      if (error.code === "EEXIST") throw new Error("同名文件已存在，请选择新的文件名");
      throw error;
    });
    const artifact = await artifacts.register({
      taskId: ports.taskId, kind: format === "drawio" ? "office" : exportKinds[format], title: basename(path),
      capabilities: format === "drawio" ? { originalKind: "drawio" } : undefined,
      workspaceFile: { entryFile: path, rootDir: root }, producerMessageId: ports.producerMessageId(), producerToolCallId: toolCallId,
    }).catch(error => {
      throw new Error("文件已生成于 " + path + "，登记任务产物失败：" + (error as Error).message);
    });
    return { path, format, revision: digest(bytes), artifactId: artifact.id };
  }

  return pi => {
    pi.registerTool({
      name: DRAWIO_USE_TOOLS.create, label: "Create Draw.io diagram",
      description: "Create an editable .drawio task artifact from Mermaid, Draw.io XML, or a local Draw.io source (including editable PNG, SVG and PDF). Mermaid is converted by the bundled official editor. XML is repaired before optional ELK layout. Omit inputs to create a blank diagram.",
      parameters: Type.Object({ path: pathField, xml: Type.Optional(xmlField), mermaid: Type.Optional(xmlField), source: Type.Optional(pathField),
        mermaidImage: Type.Optional(Type.Boolean()), layout: Type.Optional(layoutField), normalize: Type.Optional(Type.Boolean()) }, strict),
      execute: (id, input, signal, _onUpdate, context) => result(async () => {
        const root = await realpath(ports.taskRoot());
        if ([input.xml, input.mermaid, input.source].filter(Boolean).length > 1) throw new Error("请选择一种创建来源");
        if (input.mermaid && (input.xml || input.layout || input.normalize)) throw new Error("Mermaid 已自动布局，请单独提供 Mermaid");
        if (input.mermaidImage && !input.mermaid) throw new Error("仅 Mermaid 支持单图像模式");
        if (input.mermaid) {
          const bytes = await getDrawioRuntime().render({ format: "xml", mermaid: input.mermaid, mermaidImage: input.mermaidImage }, signal);
          return deliver(input.path, bytes, "drawio", id, root, signal);
        }
        const original = input.source ? (await read(input.source, context, signal)).xml : input.xml ?? EMPTY_DRAWIO;
        const { xml, repairs } = await repairDrawioXml(original);
        const bytes = Buffer.from(xml);
        assertDrawioBytes(bytes);
        const output = input.layout || input.normalize ? await getDrawioRuntime().render({
          format: "xml", xml, layout: layoutArgument(input.layout), normalize: input.normalize,
        }, signal) : bytes;
        return { ...await deliver(input.path, output, "drawio", id, root, signal), repairs };
      }, signal, true),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.read, label: "Read Draw.io diagram",
      description: "Read page names, stable cell IDs, structure and revision from an existing Draw.io file. Use page (1-based) and cellId for precise XML, or includeXml for the page model.",
      parameters: Type.Object({ path: pathField, page: Type.Optional(pageField), cellId: Type.Optional(Type.String()),
        includeXml: Type.Optional(Type.Boolean()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, strict),
      execute: (_id, input, signal, _onUpdate, context) => result(async () => {
        const { path, xml, revision } = await read(input.path, context, signal);
        const { pages } = readDrawioPages(xml);
        const selected = pages[(input.page ?? 1) - 1];
        if (!selected) throw new Error("Draw.io 页码不存在");
        const cells = drawioCells(selected.model).cells;
        const candidates = input.cellId ? cells.filter(cell => cell.id === input.cellId) : cells;
        if (input.cellId && !candidates.length) throw new Error("找不到图元 " + input.cellId);
        const offset = input.offset ?? 0;
        const xmlPreview = input.includeXml ? serializeDrawioXml(selected.model) : undefined;
        return {
          path, revision, pages: pages.map(({ id, name }, index) => ({ page: index + 1, id, name })),
          cellCount: cells.length,
          cells: candidates.slice(offset, offset + (input.limit ?? 30)).map(({ id, cell, node }) => ({
            id, value: (node.getAttribute("label") ?? cell.getAttribute("value") ?? "").slice(0, 500),
            parent: cell.getAttribute("parent"), source: cell.getAttribute("source"), target: cell.getAttribute("target"),
            vertex: cell.getAttribute("vertex") === "1", edge: cell.getAttribute("edge") === "1",
            ...(input.cellId ? { xml: serializeDrawioXml(node).slice(0, 32000) } : {}),
          })),
          ...(xmlPreview ? { xml: xmlPreview.slice(0, 32000), xmlTruncated: xmlPreview.length > 32000 } : {}),
        };
      }, signal),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.edit, label: "Edit Draw.io diagram",
      description: "Save an edited .drawio copy. Read the source revision first. Add, replace or remove cells on a page, or supply a repaired replacement mxfile for multi-page edits.",
      parameters: Type.Object({ source: pathField, path: pathField, revision: revisionField, page: Type.Optional(pageField),
        xml: Type.Optional(xmlField), edits: Type.Optional(Type.Array(Type.Union([
          Type.Object({ operation: Type.Literal("add"), xml: xmlField }, strict),
          Type.Object({ operation: Type.Literal("replace"), id: Type.String(), xml: xmlField }, strict),
          Type.Object({ operation: Type.Literal("remove"), id: Type.String() }, strict),
        ]), { minItems: 1, maxItems: 64 })) }, strict),
      execute: (id, input, signal, _onUpdate, context) => result(async () => {
        const root = await realpath(ports.taskRoot());
        const source = await read(input.source, context, signal);
        if (source.revision !== input.revision) throw new Error("源图已修改，请重新读取版本号和图元");
        if (Boolean(input.xml) === Boolean(input.edits)) throw new Error("请选择一组图元修改或完整文件 XML");
        const xml = input.xml ? (await repairDrawioXml(input.xml)).xml : editDrawioPage(source.xml, input.page ?? 1, input.edits!);
        const bytes = Buffer.from(xml);
        assertDrawioBytes(bytes);
        if ((await read(input.source, context, signal)).revision !== source.revision) throw new Error("源图已修改，请重新读取");
        return deliver(input.path, bytes, "drawio", id, root, signal);
      }, signal, true),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.layout, label: "Lay out Draw.io diagram",
      description: "Create a laid-out .drawio copy with the official ELK presets or custom JSON workflows. libavoid routes edges around nodes without moving the nodes.",
      parameters: Type.Object({ source: pathField, path: pathField, layout: layoutField, normalize: Type.Optional(Type.Boolean()) }, strict),
      execute: (id, input, signal, _onUpdate, context) => result(async () => {
        const root = await realpath(ports.taskRoot());
        const { xml } = await read(input.source, context, signal);
        const bytes = await getDrawioRuntime().render({ format: "xml", xml, layout: layoutArgument(input.layout), normalize: input.normalize }, signal);
        return deliver(input.path, bytes, "drawio", id, root, signal);
      }, signal, true),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.export, label: "Export Draw.io diagram",
      description: "Export a native diagram to PNG/SVG/PDF/JPG. PNG, SVG and PDF embed the editable diagram by default. Prefer name.drawio.png, name.drawio.svg and name.drawio.pdf. Page is 1-based. PDF can include all pages.",
      parameters: Type.Object({
        source: pathField, path: pathField,
        format: Type.Union([Type.Literal("png"), Type.Literal("svg"), Type.Literal("pdf"), Type.Literal("jpg")]),
        page: Type.Optional(pageField), allPages: Type.Optional(Type.Boolean()),
        editable: Type.Optional(Type.Boolean()), transparent: Type.Optional(Type.Boolean()),
        border: Type.Optional(Type.Integer({ minimum: 0, maximum: 1024 })),
        scale: Type.Optional(Type.Number({ minimum: 0.01, maximum: 10 })),
        width: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
        height: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })),
      }, strict),
      execute: (id, input, signal, _onUpdate, context) => result(async () => {
        const root = await realpath(ports.taskRoot());
        const { xml } = await read(input.source, context, signal);
        if (input.allPages && (input.format !== "pdf" || input.page)) throw new Error("仅 PDF 可以导出全部页面，请勿同时选择单页");
        if (input.page && input.page > readDrawioPages(xml).pages.length) throw new Error("Draw.io 页码不存在");
        const bytes = await getDrawioRuntime().render({ ...input, xml }, signal);
        return deliver(input.path, bytes, input.format, id, root, signal);
      }, signal, true),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.shapes, label: "Find Draw.io shapes",
      description: "Look up accurate Draw.io stencil styles and sizes from the official catalog. Batch queries such as aws4 lambda, azure2 storage, or cisco19 router. Set includeOnlineIcons to also query the official brand and concept icon service.",
      parameters: Type.Object({ queries: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 12 }),
        includeOnlineIcons: Type.Optional(Type.Boolean()) }, strict),
      execute: (_id, input, signal) => result(async () => ({
        results: await Promise.all(input.queries.map(async query => ({
          query, ...await findDrawioShapes(query, Boolean(input.includeOnlineIcons), signal),
        }))),
      }), signal),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.reference, label: "Read Draw.io reference",
      description: "Read the official offline Mermaid, XML, advanced XML (layers, tags, metadata, grids and tables), style or schema reference. Continue at nextOffset for longer references.",
      parameters: Type.Object({ name: Type.Union([Type.Literal("mermaid"), Type.Literal("xml"), Type.Literal("xml-advanced"),
        Type.Literal("styles"), Type.Literal("schema")]), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, strict),
      execute: (_id, input, signal) => result(async () => {
        const text = await readDrawioReference(input.name);
        const start = input.offset ?? 0;
        const end = Math.min(start + 18000, text.length);
        return { name: input.name, text: text.slice(start, end), nextOffset: end < text.length ? end : null };
      }, signal),
    });

    pi.registerTool({
      name: DRAWIO_USE_TOOLS.link, label: "Make Draw.io browser link",
      description: "Generate the official app.diagrams.net #R link from a local .drawio source and keep the file. Only set open when the user asks to open the browser link.",
      parameters: Type.Object({ path: pathField, open: Type.Optional(Type.Boolean()) }, strict),
      execute: (_id, input, signal, _onUpdate, context) => result(async () => {
        const { xml, path } = await read(input.path, context, signal);
        const data = deflateRawSync(encodeURIComponent(xml)).toString("base64");
        const url = "https://app.diagrams.net/?grid=0&pv=0&border=10&edit=_blank#R" + encodeURIComponent(data);
        if (url.length > 100000) return { path, reason: "图纸生成的链接过长，请从 MyBuddy 打开本地文件" };
        if (input.open) {
          assertEnabled(signal);
          await shell.openExternal(url);
        }
        return { path, url, opened: Boolean(input.open) };
      }, signal),
    });
  };
}
