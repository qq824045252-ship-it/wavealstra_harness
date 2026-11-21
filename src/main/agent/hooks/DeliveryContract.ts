import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type DeliveryContract = { document: string; headings: string[]; attachments: string[] };
const citation = "\u0000citations";
const fileName = /[\p{L}\p{N}_./\\-]+\.[\p{L}\p{N}]{1,12}/gu;
const unsafe = /(?:^|[\\/])\.\.(?:[\\/]|$)|^[\\/]|^[a-z]:|\0/i;

/** Only compile explicit, unambiguous delivery instructions. */
export function parseDeliveryContract(text: string): DeliveryContract | undefined {
  const source = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "").replace(/^\s*>.*$/gm, "").trim();
  if (!source || /[?？]\s*$/.test(source) || /^(?:如何|怎么|是否|如果|假设|举例|例如|how\b|what\b|if\b)/i.test(source)) return;
  if (/(?:取消|不要|无需|不必|不用|不需要|禁止|不要再|do not|don't|without|optional|可选|任选|或者|或是|either\b|\bor\b)/i.test(source.replace(/(?:不需要|无需|不用|不必|不要|without)\s*(?:任何|任何的|an?\s+)?(?:附件|attachments?)/gi, "")) || /\s或\s/.test(source)) return;
  if (!/(?:写|生成|创建|保存|交付|输出|制作|write|create|generate|save|deliver|produce)/i.test(source)) return;
  const pathsSource = source.replace(/(?:写入|生成|创建|保存|交付|输出|制作)(?=[\p{L}\p{N}_./\\-]+\.)/gu, " ");
  const files = [...pathsSource.matchAll(fileName)].map(m => m[0]);
  const docs = [...new Set(files.filter(f => /\.md$/i.test(f)))];
  if (docs.length !== 1 || unsafe.test(docs[0])) return;
  const headings: string[] = [];
  // Delimit the list explicitly: a free-form sentence is not a heading name.
  for (const m of source.matchAll(/(?:标题|章节|小节|headings?|sections?)\s*[:：]\s*([^\n。；;]+)/gi)) {
    for (const raw of m[1].split(/[、，,；;]/)) {
      const name = raw.trim().replace(/^[#\s`"“「『]+|[#\s`"”」』]+$/g, "");
      if (name && name.length <= 80 && !/[\\/]/.test(name)) headings.push(name);
    }
  }
  for (const m of source.matchAll(/(?:标题|章节|小节|headings?|sections?)\s*[「『“"`]+([^」』”"`\n]{1,80})[」』”"`]+/gi)) headings.push(m[1].trim());
  const attachments: string[] = [];
  for (const line of pathsSource.split(/[\n。；;]/)) {
    if (!/(?:附件|附上|附带|attach(?:ment)?s?)/i.test(line)) continue;
    if (/(?:不需要|无需|不用|不必|不要|without)\s*(?:任何|任何的|an?\s+)?(?:附件|attachments?)/i.test(line)) continue;
    for (const m of line.matchAll(fileName)) if (m[0] !== docs[0]) {
      if (unsafe.test(m[0])) return;
      attachments.push(m[0]);
    }
  }
  if (/(?:引用来源|标注来源|提供来源|提供引用|cite (?:sources|references)|include (?:citations|references))/i.test(source)) headings.push(citation);
  if (!headings.length && !attachments.length) return;
  return { document: docs[0], headings: [...new Set(headings)], attachments: [...new Set(attachments)] };
}

function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return Boolean(r) && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

async function readScoped(root: string, path: string): Promise<Buffer | undefined> {
  if (!path || unsafe.test(path) || isAbsolute(path)) throw new Error("unsafe path");
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error("outside workspace");
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  }
  if (await realpath(target) !== target) throw new Error("path changed");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error("unsupported file");
    const bytes = await handle.readFile();
    const after = await handle.stat(), now = await lstat(target);
    if (!now.isFile() || before.dev !== now.dev || before.ino !== now.ino || before.size !== after.size || before.size !== bytes.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || now.mtimeMs !== after.mtimeMs || now.ctimeMs !== after.ctimeMs || await realpath(target) !== target) throw new Error("file changed");
    return bytes;
  } finally { await handle.close(); }
}

export async function verifyDeliveryContract(cwd: string, contract: DeliveryContract): Promise<{ status: "passed" | "missing" | "unknown"; missing: string[]; evidence: Record<string, string> }> {
  const missing: string[] = [], evidence: Record<string, string> = {};
  try {
    const root = await realpath(cwd);
    const doc = await readScoped(root, contract.document);
    if (!doc) return { status: "missing", missing: [contract.document], evidence };
    evidence[contract.document] = createHash("sha256").update(doc).digest("hex");
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(doc);
    const visible = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "");
    const headings = [...visible.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(m => m[1].trim());
    for (const name of contract.headings) {
      if (name === citation) {
        if (!/\[[^\]\n]+\]\((?:https?:\/\/|[^)#\s]+)[^)]+\)|\[[^\]\n]+\]:\s*(?:https?:\/\/|\S+)/i.test(visible)) missing.push("引用来源");
      } else if (!headings.includes(name)) missing.push(`标题: ${name}`);
    }
    for (const path of contract.attachments) {
      const bytes = await readScoped(root, path);
      if (!bytes) missing.push(path);
      else evidence[path] = createHash("sha256").update(bytes).digest("hex");
    }
    return { status: missing.length ? "missing" : "passed", missing, evidence };
  } catch { return { status: "unknown", missing: [], evidence }; }
}

export function deliveryCorrection(text: string, contract: DeliveryContract): boolean {
  if (/(?:新增|增加|改为|修改要求|额外|再加|instead|add(?:itional)?|new requirement)/i.test(text)) return false;
  if (!/(?:遗漏|漏了|漏掉|缺少|没(?:有|写|交)|不完整|missing|omitted|forgot)/i.test(text)) return false;
  return [contract.document, ...contract.headings.filter(h => h !== citation), ...contract.attachments].some(item => text.includes(item));
}
