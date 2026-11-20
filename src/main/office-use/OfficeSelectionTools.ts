import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { OFFICE_USE_TOOLS } from "../../shared/office-use";
import { officeCreateParameters, type OfficeCreateRequest } from "./OfficeDocumentCreation";

const index = Type.Integer({ minimum: 0, maximum: 1_048_575 });
const shapeId = Type.Integer({ minimum: 0, maximum: 4_294_967_295 });
const excelAddress = {
  kind: Type.Literal("excel"),
  sheet: Type.String({ minLength: 1, maxLength: 64 }),
  address: Type.String({ minLength: 2, maxLength: 23, description: "A1 矩形，例如 A1:D20" }),
};
const exactText = Type.String({ minLength: 1, maxLength: 32_000 });
const selectionTarget = Type.Union([
  Type.Object({ kind: Type.Literal("word"), blockIndex: index, text: exactText }, { additionalProperties: false }),
  Type.Object(excelAddress, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("ppt"), slideIndex: index, shapeId, paragraphIndex: Type.Optional(index), text: exactText }, { additionalProperties: false }),
]);
const documentQuery = Type.Object({
  action: Type.Union([Type.Literal("inspect"), Type.Literal("read"), Type.Literal("find"), Type.Literal("evaluate")]),
  offset: Type.Optional(index),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  evaluation: Type.Optional(Type.Object({
    sheet: excelAddress.sheet,
    cell: Type.String({ maxLength: 10, pattern: "^\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]{0,6}$" }),
    formula: Type.String({ minLength: 2, maxLength: 1024, pattern: "^=[^\\r\\n]+$" }),
  }, { additionalProperties: false })),
  target: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal("word"), blockIndex: index }, { additionalProperties: false }),
    Type.Object({ ...excelAddress, values: Type.Optional(Type.Union([Type.Literal("raw"), Type.Literal("formatted"), Type.Literal("formulas")])) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("ppt"), slideIndex: index, shapeId: Type.Optional(shapeId), notes: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  ])),
}, { additionalProperties: false });
const renderTarget = Type.Union([
  Type.Object({ kind: Type.Literal("word"), pageIndex: index }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("excel"), sheet: excelAddress.sheet }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("ppt"), slideIndex: index }, { additionalProperties: false }),
]);
const editOperation = Type.Union([
  Type.Object({
    kind: Type.Literal("word"), action: Type.Literal("paragraphStyle"), blockIndex: index,
    style: Type.Union(["Normal", "Title", "Heading1", "Heading2", "Heading3"].map(style => Type.Literal(style))),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("excel"), action: Type.Literal("freezeTopRow"), sheet: excelAddress.sheet,
  }, { additionalProperties: false }),
  Type.Object({
    ...excelAddress, action: Type.Literal("numberFormat"),
    code: Type.String({ minLength: 1, maxLength: 80, pattern: "^[^\\x00-\\x1f]+$" }),
  }, { additionalProperties: false }),
  Type.Object({
    ...excelAddress, action: Type.Literal("insertChart"),
    chartType: Type.Union(["column", "bar", "line", "pie"].map(type => Type.Literal(type))),
    at: Type.String({ pattern: "^[A-Z]{1,3}[1-9][0-9]{0,6}$" }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("ppt"), action: Type.Literal("slideNotes"), slideIndex: index,
    text: Type.String({ maxLength: 8_000 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("ppt"), action: Type.Literal("insertShape"), slideIndex: index,
    preset: Type.Union(["rect", "roundRect", "ellipse", "triangle", "rightArrow"].map(preset => Type.Literal(preset))),
    x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }),
    width: Type.Number({ minimum: 1 }), height: Type.Number({ minimum: 1 }),
    text: Type.Optional(Type.String({ maxLength: 500 })),
  }, { additionalProperties: false }),
]);

interface OfficeSelectionPorts {
  read(request: Static<typeof documentQuery>): Promise<unknown>;
  render?(target: Static<typeof renderTarget>): Promise<unknown>;
  select(target?: Static<typeof selectionTarget>): Promise<unknown>;
  propose(captureId: string | number, text: string, proposalId: string): Promise<unknown>;
  proposeEdit?(operation: Static<typeof editOperation>, proposalId: string): Promise<unknown>;
  review?(proposalId: string): Promise<unknown>;
}

interface Binding {
  ports: OfficeSelectionPorts;
  sequence: number;
  capture?: { id: string; viewId: string | number; reason?: string };
}

const taskBindings = new Map<string, Map<string, Binding>>();
const MAX_SELECTION_LENGTH = 100_000;

export function bindOfficeSelection(taskId: string, sessionId: string, ports: OfficeSelectionPorts): () => void {
  let sessions = taskBindings.get(taskId);
  if (!sessions) {
    sessions = new Map();
    taskBindings.set(taskId, sessions);
  }
  const binding: Binding = { ports, sequence: 0 };
  sessions.set(sessionId, binding);

  return () => {
    if (sessions.get(sessionId) !== binding) return;
    sessions.delete(sessionId);
    if (!sessions.size) taskBindings.delete(taskId);
  };
}

function activeBinding(taskId: string): Binding {
  const sessions = taskBindings.get(taskId);
  if (!sessions?.size) throw new Error("当前任务没有打开的 Office 文档。请先在任务中打开要处理的文档。");
  if (sessions.size > 1) throw new Error("当前任务打开了多个 Office 文档。请只保留要处理的文档。");
  return sessions.values().next().value!;
}

function readCapture(value: unknown) {
  if (typeof value !== "object" || value === null ||
      !("captureId" in value) || (typeof value.captureId !== "string" && typeof value.captureId !== "number") ||
      !("content" in value) || typeof value.content !== "string" || !("target" in value)) {
    throw new Error("Office 面板没有返回可用的选区。");
  }
  if (value.content.length > MAX_SELECTION_LENGTH) throw new Error("Office 选区太长。请选择较小的范围。");
  const editable = !("editable" in value) || value.editable !== false;
  const reason = !editable && "reason" in value && typeof value.reason === "string" ? value.reason : undefined;
  return { captureId: value.captureId, content: value.content, target: value.target, editable, reason };
}

async function toolResult(run: () => Promise<object>) {
  try {
    const value = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
  }
}

export function createOfficeSelectionExtension(input: {
  taskId: string;
  getPermissionMode: () => PermissionMode;
  isEnabled: () => boolean;
  create?: (request: OfficeCreateRequest, toolCallId: string, assertWritable: () => void) => Promise<object>;
}): ExtensionFactory {
  const assertEnabled = () => {
    if (!input.isEnabled()) throw new Error("Office Use 已在本机工具设置中关闭。");
  };
  return (pi) => {
    const create = input.create;
    if (create) pi.registerTool({
      name: OFFICE_USE_TOOLS.documentCreate,
      label: "Office Use · 新建文档",
      description: "在当前任务目录创建并登记 DOCX、XLSX 或 PPTX。path 是带后缀的新文件名，省略 content 创建空白文件。Word 可写标题、章节、段落、项目列表和表格，Excel 可写工作表、数据和公式，PowerPoint 可写幻灯片标题、要点和备注。成功后可在任务面板打开产物。已有同名文件时请另取文件名。",
      parameters: officeCreateParameters,
      execute: async (toolCallId, request: OfficeCreateRequest, signal) => toolResult(async () => {
        const assertWritable = () => {
          signal?.throwIfAborted();
          assertEnabled();
          if (input.getPermissionMode() === "readonly") throw new Error("当前任务为只读模式。");
        };
        assertWritable();
        return create(request, toolCallId, assertWritable);
      }),
    });

    pi.registerTool({
      name: OFFICE_USE_TOOLS.documentRead,
      label: "Office Use · 阅读文档",
      description: "读取当前任务打开的 Office 文档，包括尚未保存的编辑。inspect 查看结构，find 按 query 查找，read 读取 target：Word blockIndex（含表格）；Excel sheet 与 A1 address（至多 1024 格，values 可选 raw、formatted 或 formulas）；PowerPoint slideIndex 加可选 shapeId，或 notes:true。evaluate 在当前 Excel 工作表试算 evaluation 的 sheet、cell、formula，不写入单元格。编号从 0 开始，nextOffset 用于翻页。保留选区。",
      parameters: documentQuery,
      execute: async (_id, params: Static<typeof documentQuery>, signal) => toolResult(async () => {
        signal?.throwIfAborted();
        assertEnabled();
        const binding = activeBinding(input.taskId);
        const result = await binding.ports.read(params);
        signal?.throwIfAborted();
        assertEnabled();
        if (activeBinding(input.taskId) !== binding) throw new Error("Office 文档已切换，请重新读取。");
        if (!result || typeof result !== "object" || JSON.stringify(result).length > 32_000) {
          throw new Error("Office 结果过大，请缩小范围或减少每页条数。");
        }
        return result;
      }),
    });

    pi.registerTool({
      name: OFFICE_USE_TOOLS.documentRender,
      label: "Office Use · 渲染页面",
      description: "返回当前任务 Office 文档的 PNG，包含尚未保存的内容。Word 渲染指定页，PowerPoint 渲染指定幻灯片，pageIndex、slideIndex 从 0 开始。Excel 返回指定工作表当前可见区域，sheet 必须是当前激活的表。检查完整数据请用 office_document_read。",
      parameters: Type.Object({ target: renderTarget }, { additionalProperties: false }),
      execute: async (_id, params: { target: Static<typeof renderTarget> }, signal) => {
        try {
          signal?.throwIfAborted();
          assertEnabled();
          const binding = activeBinding(input.taskId);
          const png = await binding.ports.render?.(params.target);
          signal?.throwIfAborted();
          assertEnabled();
          if (activeBinding(input.taskId) !== binding) throw new Error("Office 文档已切换，请重新渲染。");
          if (typeof png !== "string" || !png.startsWith("iVBORw0KGgo") || png.length > 4_000_000) {
            throw new Error("Office 未返回可用的页面图像，或图像超过大小限制。");
          }
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(params.target) },
              { type: "image" as const, data: png, mimeType: "image/png" },
            ],
            details: params.target,
          };
        } catch (error) {
          return toolResult(async () => { throw error; });
        }
      },
    });

    pi.registerTool({
      name: OFFICE_USE_TOOLS.reviewStatus,
      label: "Office Use · 查询确认和复验",
      description: "按 proposalId 查询当前 Office 编辑器中的模型提议。待确认、取消、已应用、复验状态和用户保存回执是不同结果。查询不会应用或保存。关掉编辑器后，用 document_read 在重新打开的文件中检查。",
      parameters: Type.Object({ proposalId: Type.String({ minLength: 36, maxLength: 36 }) }, { additionalProperties: false }),
      execute: async (_id, params: { proposalId: string }, signal) => toolResult(async () => {
        signal?.throwIfAborted();
        assertEnabled();
        const binding = activeBinding(input.taskId);
        const result = await binding.ports.review?.(params.proposalId);
        signal?.throwIfAborted();
        assertEnabled();
        if (activeBinding(input.taskId) !== binding) throw new Error("Office 文档已切换，请重新读取。");
        if (!result || typeof result !== "object") throw new Error("当前编辑器中找不到该提议。");
        return result;
      }),
    });

    pi.registerTool({
      name: OFFICE_USE_TOOLS.editPropose,
      label: "Office Use · 提议结构化编辑",
      description: "提交单项原生编辑，待用户确认。Word paragraphStyle 修改正文样式。Excel freezeTopRow 冻结表头，numberFormat 为 A1 范围设置数字格式代码，insertChart 从指定 A1 区域制作图表。PowerPoint slideNotes 更新完整备注，insertShape 按幻灯片点数坐标 x、y、width、height 添加形状。先读目标，应用后用 office_review_status 查回执。",
      parameters: Type.Object({ operation: editOperation }, { additionalProperties: false }),
      execute: async (_id, params: { operation: Static<typeof editOperation> }, signal) => toolResult(async () => {
        signal?.throwIfAborted();
        assertEnabled();
        if (input.getPermissionMode() === "readonly") throw new Error("当前任务为只读模式。");
        const binding = activeBinding(input.taskId);
        if (!binding.ports.proposeEdit) throw new Error("当前 Office 编辑器无法提交结构化编辑。");
        const proposalId = randomUUID();
        await binding.ports.proposeEdit(params.operation, proposalId);
        signal?.throwIfAborted();
        if (activeBinding(input.taskId) !== binding) throw new Error("Office 文档已切换，请重新读取。");
        binding.capture = undefined;
        return { status: "awaiting-user-review", proposalId };
      }),
    });

    pi.registerTool({
      name: OFFICE_USE_TOOLS.selectionRead,
      label: "Office Use · 读取选区",
      description: "读取当前选区，或在用户要求修改指定内容时传 target 定位并读取。Word: blockIndex 与段内唯一的原文 text。Excel: sheet 与 A1 address（最多 256 格）。PowerPoint: slideIndex、shapeId 与唯一的原文 text，必要时指定 paragraphIndex。编号从 0 开始。返回可供提议改写使用的 captureId。仅阅读请用 office_document_read。",
      parameters: Type.Object({ target: Type.Optional(selectionTarget) }, { additionalProperties: false }),
      execute: async (_id, params: { target?: Static<typeof selectionTarget> }, signal) => toolResult(async () => {
        signal?.throwIfAborted();
        assertEnabled();
        if (params.target && input.getPermissionMode() === "readonly") throw new Error("只读任务请使用 office_document_read 读取指定位置。");
        const binding = activeBinding(input.taskId);
        const sequence = ++binding.sequence;
        binding.capture = undefined;
        const selection = readCapture(await binding.ports.select(params.target));
        signal?.throwIfAborted();
        assertEnabled();
        if (sequence !== binding.sequence || activeBinding(input.taskId) !== binding) {
          throw new Error("Office 文档或选区已切换，请重新读取。");
        }
        const captureId = randomUUID();
        const reason = selection.editable ? undefined : selection.reason || "当前选区无法安全写回。";
        binding.capture = { id: captureId, viewId: selection.captureId, reason };
        return { captureId, content: selection.content, target: selection.target, editable: selection.editable, reason };
      }),
    });

    pi.registerTool({
      name: OFFICE_USE_TOOLS.selectionPropose,
      label: "Office Use · 提交改写提议",
      description: "将完整替换文本和 office_selection_read 返回的最新可编辑 captureId 提交到当前任务的 Office 面板。Word 使用单段文字。Excel 使用与选区行列数一致的 TSV，保留公式和其他单元格。用双引号包裹需要保持为文本的字段，并把字段内的双引号写成两个。PowerPoint 使用所选文本框文字的替换内容。用户核对后决定是否应用。成功后报告提议已显示。",
      parameters: Type.Object({
        captureId: Type.String({ minLength: 1, maxLength: 64 }),
        text: Type.String({ maxLength: MAX_SELECTION_LENGTH }),
      }, { additionalProperties: false }),
      execute: async (_id, params: { captureId: string; text: string }, signal) => toolResult(async () => {
        signal?.throwIfAborted();
        assertEnabled();
        if (input.getPermissionMode() === "readonly") throw new Error("当前任务为只读模式。");
        const binding = activeBinding(input.taskId);
        const capture = binding.capture;
        if (!capture || params.captureId !== capture.id) throw new Error("Office 选区已过期，请重新读取。");
        if (capture.reason) throw new Error(capture.reason);
        binding.capture = undefined;
        const proposalId = randomUUID();
        await binding.ports.propose(capture.viewId, params.text, proposalId);
        signal?.throwIfAborted();
        if (activeBinding(input.taskId) !== binding) throw new Error("Office 文档已切换，请重新读取。");
        return { status: "awaiting-user-review", proposalId };
      }),
    });
  };
}
