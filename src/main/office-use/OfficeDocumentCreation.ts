import { mkdtemp, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import PptxGenJS from "pptxgenjs";
import * as XLSX from "xlsx";
import { Type, type Static } from "typebox";
import type { ArtifactService } from "../artifact/ArtifactService";
import { assertOfficePackage, atomicBytes, kindFor, type OfficeKind } from "./OfficeFile";

const shortText = Type.String({ maxLength: 240 });
const bodyText = Type.String({ maxLength: 8_000 });
const wordContent = Type.Object({
  kind: Type.Literal("word"),
  title: Type.Optional(shortText),
  sections: Type.Array(Type.Object({
    heading: Type.Optional(shortText),
    paragraphs: Type.Array(bodyText, { maxItems: 100 }),
    bullets: Type.Optional(Type.Array(bodyText, { maxItems: 50 })),
    table: Type.Optional(Type.Object({
      headers: Type.Array(shortText, { minItems: 1, maxItems: 12 }),
      rows: Type.Array(Type.Array(bodyText, { minItems: 1, maxItems: 12 }), { maxItems: 100 }),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }), { maxItems: 100 }),
}, { additionalProperties: false });
const spreadsheetCell = Type.Union([
  bodyText, Type.Number(), Type.Boolean(), Type.Null(),
  Type.Object({ formula: Type.String({ pattern: "^=[^\\r\\n]+$", maxLength: 1_024 }) }, { additionalProperties: false }),
]);
const excelContent = Type.Object({
  kind: Type.Literal("excel"),
  sheets: Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 31 }),
    rows: Type.Array(Type.Array(spreadsheetCell, { maxItems: 100 }), { maxItems: 1_000 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
}, { additionalProperties: false });
const pptContent = Type.Object({
  kind: Type.Literal("ppt"),
  slides: Type.Array(Type.Object({
    title: Type.Optional(shortText),
    bullets: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 6 })),
    notes: Type.Optional(bodyText),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 60 }),
}, { additionalProperties: false });

export const officeCreateParameters = Type.Object({
  path: Type.String({ minLength: 6, maxLength: 160, description: "当前任务目录下的新文件名，后缀为 .docx、.xlsx 或 .pptx" }),
  content: Type.Optional(Type.Union([wordContent, excelContent, pptContent])),
}, { additionalProperties: false });
export type OfficeCreateRequest = Static<typeof officeCreateParameters>;
export const OFFICE_RECOVERY_CREATE_MEMO = "mybuddy.office.recovery-create";

const mime: Record<OfficeKind, string> = {
  word: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function createBytes(kind: OfficeKind, content: OfficeCreateRequest["content"]): Promise<Buffer> {
  if (kind === "word") {
    const word = content?.kind === kind ? content : undefined;
    const children: Array<Paragraph | Table> = [];
    if (word?.title) children.push(new Paragraph({ text: word.title, heading: HeadingLevel.TITLE }));
    for (const section of word?.sections ?? []) {
      if (section.heading) children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
      for (const text of section.paragraphs) children.push(new Paragraph(text));
      for (const text of section.bullets ?? []) children.push(new Paragraph({ text, bullet: { level: 0 } }));
      if (section.table) {
        const { headers, rows } = section.table;
        if (rows.some(row => row.length !== headers.length)) throw new Error("Word 表格的每行列数必须与表头一致。");
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [headers, ...rows].map((row, i) => new TableRow({
            tableHeader: i === 0,
            children: row.map(text => new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text, bold: i === 0 })] })],
            })),
          })),
        }));
      }
    }
    return Packer.toBuffer(new Document({ sections: [{ children: children.length ? children : [new Paragraph("")] }] }));
  }
  if (kind === "excel") {
    const sheets = content?.kind === kind ? content.sheets : [{ name: "Sheet1", rows: [] }];
    const book = XLSX.utils.book_new();
    const names = new Set<string>();
    for (const sheet of sheets) {
      const normalized = sheet.name.toLowerCase();
      if (!sheet.name.trim() || /[\x00-\x1f:\\/?*\[\]]/.test(sheet.name) || /^'|'$/.test(sheet.name) || names.has(normalized)) {
        throw new Error(`工作表名称无效或重复：${sheet.name}`);
      }
      names.add(normalized);
      const rows = sheet.rows.map(row => row.map(cell => cell && typeof cell === "object"
        ? { t: "n", f: cell.formula.slice(1) } : cell));
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheet.name);
    }
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  const slides = content?.kind === kind ? content.slides : [{}];
  for (const spec of slides) {
    const slide = deck.addSlide();
    if (spec.title) slide.addText(spec.title, { x: 0.7, y: 0.5, w: 11.9, h: 0.9, fontSize: 32, bold: true, color: "20304F", fit: "shrink" });
    for (const [index, text] of (spec.bullets ?? []).entries()) {
      slide.addText(text, { x: 0.8, y: 1.7 + index * 0.85, w: 11.5, h: 0.78, fontSize: 20, bullet: true, color: "243047", fit: "shrink" });
    }
    if (spec.notes) slide.addNotes(spec.notes);
  }
  return Buffer.from(await deck.write({ outputType: "nodebuffer" }) as Uint8Array);
}

export async function createOfficeDocument(request: OfficeCreateRequest, context: {
  taskId: string;
  taskRoot: string;
  toolCallId: string;
  producerMessageId?: string;
  artifacts: ArtifactService;
  assertWritable(): void;
  preserveExisting?: boolean;
}) {
  const name = request.path;
  const kind = kindFor(name);
  if (!kind || basename(name) !== name || /[\x00-\x1f<>:"/\\|?*]/.test(name) || name.trim() !== name || name.startsWith(".") ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name.split(".")[0].trimEnd())) {
    throw new Error("请提供任务目录内的有效新文件名，后缀使用 .docx、.xlsx 或 .pptx。");
  }
  if (request.content && request.content.kind !== kind) throw new Error("初始内容类型与文件后缀不匹配。");
  if (JSON.stringify(request.content ?? null).length > 300_000) throw new Error("初始内容过大，请缩小单个文件的创建内容。");

  const root = await realpath(context.taskRoot);
  const directory = await stat(root);
  let path = join(root, name);
  let recoveryDirectory: string | undefined;
  const bytes = await createBytes(kind, request.content);
  await assertOfficePackage(bytes, kind);
  const validateRoot = async () => {
    const currentRoot = await realpath(context.taskRoot);
    const current = await stat(currentRoot);
    if (currentRoot !== root || current.dev !== directory.dev || current.ino !== directory.ino) {
      throw new Error("任务目录已变化，请重新创建。");
    }
    context.assertWritable();
  };
  try {
    await atomicBytes(path, bytes, validateRoot, { create: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!context.preserveExisting) throw new Error(`任务目录已有文件 ${name}，请选择其他文件名。`);
    await validateRoot();
    const output = await mkdtemp(join(root, ".mybuddy-recovery-"));
    recoveryDirectory = output;
    path = join(output, name);
    try {
      await atomicBytes(path, bytes, async () => {
        await validateRoot();
        if (await realpath(output) !== output) throw new Error("补件目录已变化，请重新创建。");
      }, { create: true });
    } catch (error) {
      await rmdir(output).catch(() => {});
      throw error;
    }
  }

  try {
    const artifact = await context.artifacts.register({
      taskId: context.taskId,
      kind: "office",
      title: name,
      mimeType: mime[kind],
      capabilities: { originalKind: extname(name).slice(1).toLowerCase() },
      workspaceFile: { entryFile: path, rootDir: root },
      producerMessageId: context.producerMessageId,
      producerToolCallId: context.toolCallId,
    });
    return { status: "created", path, name, artifactId: artifact.id };
  } catch (error) {
    try { await unlink(path); }
    catch (cleanup) { throw new Error(`文件已创建在 ${path}，产物登记和清理失败。`, { cause: new AggregateError([error, cleanup]) }); }
    if (recoveryDirectory) await rmdir(recoveryDirectory).catch(() => {});
    throw error;
  }
}
