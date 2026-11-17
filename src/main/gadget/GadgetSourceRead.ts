import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GadgetSourceSnapshot } from "../../shared/gadget-types";

export const gadgetReadSchema = Type.Object({
  gadgetId: Type.String({ minLength: 1, maxLength: 200 }),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 2000, maximum: 20000 })),
}, { additionalProperties: false });
type ReadInput = Static<typeof gadgetReadSchema>;
const cursorSchema = Type.Object({ gadgetId: Type.String(), revision: Type.String(), path: Type.String(), offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const gadgetReadOutputSchema = Type.Object({ isError: Type.Boolean(), revision: Type.Optional(Type.String()), gadgetId: Type.Optional(Type.String()) }, { additionalProperties: true });

/** Revision and continuation metadata precede all source, including on native output truncation. */
export function readGadgetSourcePage(input: ReadInput, source: GadgetSourceSnapshot) {
  if (!Value.Check(gadgetReadSchema, input)) throw new Error("gadget_read 参数无效");
  const file = input.path ? source.files.find(file => file.path === input.path) : undefined;
  if (input.path && !file) throw new Error(`Gadget 源文件不存在：${input.path}`);
  const text = file ? file.content : JSON.stringify({ revision: source.revision, manifest: source.manifest, files: source.files }, null, 2);
  const path = input.path ?? "";
  let offset = 0;
  if (input.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
    catch { throw new Error("gadget_read cursor 无效，请重新读取"); }
    if (!Value.Check(cursorSchema, cursor) || cursor.gadgetId !== input.gadgetId || cursor.revision !== source.revision || cursor.path !== path || cursor.offset > text.length) {
      throw new Error("Gadget 源码或读取范围已变化，请重新读取；不能拼接旧 cursor");
    }
    offset = cursor.offset;
  }
  const budget = input.maxBytes ?? 12000;
  const make = (end: number) => {
    const nextCursor = end < text.length ? Buffer.from(JSON.stringify({ gadgetId: input.gadgetId, revision: source.revision, path, offset: end })).toString("base64url") : undefined;
    const details = { revision: source.revision, gadgetId: input.gadgetId, path: input.path, encoding: file?.encoding ?? "utf8", offset, totalChars: text.length, truncated: end < text.length, nextCursor, chunk: text.slice(offset, end) };
    return { details, content: JSON.stringify(details) };
  };
  let low = offset, high = Math.min(text.length, offset + budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(make(middle).content, "utf8") <= budget) low = middle;
    else high = middle - 1;
  }
  // Do not split an astral character between pages.
  if (low > offset && low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1]) && /[\uDC00-\uDFFF]/.test(text[low])) low--;
  if (low === offset && offset < text.length || Buffer.byteLength(make(low).content, "utf8") > budget) throw new Error("读取元数据超过 maxBytes，请增加预算或缩短 path");
  return make(low);
}
