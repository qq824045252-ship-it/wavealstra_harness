import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import yauzlPackage from "yauzl";
import { posix } from "node:path";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const rels = "http://schemas.openxmlformats.org/package/2006/relationships";

interface Entry { fileName: string; uncompressedSize: number }
interface ZipReader extends EventEmitter {
  entryCount: number;
  readEntry(): void;
  close(): void;
  openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void;
}
const yauzl = yauzlPackage as {
  fromBuffer(bytes: Buffer, options: Record<string, boolean>, callback: (error: Error | null, zip: ZipReader) => void): void;
};

export function requirePart(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
export class Package {
  private bytesRead = 0;
  constructor(readonly zip: ZipReader, readonly entries: Map<string, Entry>) {}

  static async open(bytes: Buffer): Promise<Package> {
    const zip = await new Promise<ZipReader>((resolve, reject) => {
      yauzl.fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
        (error, reader) => error ? reject(error) : resolve(reader));
    });
    try {
      requirePart(zip.entryCount <= 20_000, "Office ZIP 条目数超限");
      const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
        const result = new Map<string, Entry>();
        zip.on("error", reject);
        zip.on("entry", (entry: Entry) => {
          if (result.has(entry.fileName)) {
            reject(new Error("Office ZIP 路径重复"));
            return;
          }
          result.set(entry.fileName, entry);
          zip.readEntry();
        });
        zip.once("end", () => resolve(result));
        zip.readEntry();
      });
      return new Package(zip, entries);
    } catch (error) {
      zip.close();
      throw error;
    }
  }

  async read(path: string, limit: number): Promise<Buffer> {
    const entry = this.entries.get(path);
    requirePart(entry, "找不到 Office 部件 " + path);
    requirePart(entry.uncompressedSize <= limit && this.bytesRead + entry.uncompressedSize <= 96 * 1024 * 1024,
      "Office 部件过大");
    this.bytesRead += entry.uncompressedSize;
    const stream = await new Promise<Readable>((resolve, reject) => {
      this.zip.openReadStream(entry, (error, reader) => error ? reject(error) : resolve(reader));
    });
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of stream) {
      const chunk = value as Buffer;
      length += chunk.length;
      requirePart(length <= entry.uncompressedSize, "Office 部件解压长度异常");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }

  async xml(path: string): Promise<Document> {
    const bytes = await this.read(path, 4 * 1024 * 1024);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    requirePart(!/<!DOCTYPE|<!ENTITY/i.test(source), "Office 部件 XML 声明不受支持");
    return new DOMParser({ onError: (_level, message) => { throw new Error(message); } })
      .parseFromString(source, "application/xml");
  }
}

export function root(document: Document, ns: string, local: string): Element {
  const element = document.documentElement;
  requirePart(element?.namespaceURI === ns && element.localName === local, "Office 部件 XML 类型不匹配");
  return element;
}
export type NamedElement = Element & { localName: string };
export function children(element: Element, ns: string, local?: string): NamedElement[] {
  const result: NamedElement[] = [];
  for (let current = element.firstChild; current; current = current.nextSibling) {
    if (current.nodeType !== 1) continue;
    const child = current as Element;
    if (child.namespaceURI === ns && child.localName && (!local || child.localName === local)) {
      result.push(child as NamedElement);
    }
  }
  return result;
}
export function one(element: Element, ns: string, local: string): Element {
  const result = children(element, ns, local);
  requirePart(result.length === 1, "找不到唯一 Office 元素 " + local);
  return result[0];
}
export function relationPath(part: string): string {
  return posix.join(posix.dirname(part), "_rels", posix.basename(part) + ".rels");
}
export function targetOf(link: Element, part: string, expectedType: string, directory: string): string {
  const target = link.getAttribute("Target");
  const mode = link.getAttribute("TargetMode");
  requirePart(link.getAttribute("Type") === office + "/" + expectedType && (!mode || mode === "Internal") &&
    target && /^[A-Za-z0-9_./-]+$/.test(target), "Office 嵌入关系目标不受支持");
  const resolved = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.join(posix.dirname(part), target);
  requirePart(resolved.startsWith(directory + "/"), "Office 嵌入关系超出部件目录");
  return resolved;
}
export function linkedRelation(document: Document, id: string | null): Element {
  const matches = children(root(document, rels, "Relationships"), rels, "Relationship")
    .filter((item) => item.getAttribute("Id") === id);
  requirePart(id && matches.length === 1, "找不到唯一 Office 嵌入关系");
  return matches[0];
}
