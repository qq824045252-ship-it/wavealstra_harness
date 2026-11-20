import yauzlPackage from "yauzl";
import type { Readable } from "node:stream";
import type { ExtractionBudget } from "./ContentExtractorRegistry";

interface ZipEntry {
  fileName: string;
  uncompressedSize: number;
}

interface ZipFile {
  entryCount: number;
  readEntry(): void;
  close(): void;
  once(event: "entry", listener: (entry: ZipEntry) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream: Readable) => void): void;
}

const yauzl = yauzlPackage as {
  open(path: string, options: { lazyEntries: true; autoClose: false; validateEntrySizes: true },
    callback: (error: Error | null, zip: ZipFile) => void): void;
};

export function createExtractionFailureSignal(): { promise: Promise<never>; reject: (reason?: unknown) => void } {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}
/** Read the central directory and only decompress the XML parts consumed by the extractor. */
export async function readOfficeParts(
  path: string,
  include: (name: string) => boolean,
  budget: ExtractionBudget,
  checkBudget: () => void,
): Promise<Map<string, Buffer>> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, file) => error ? reject(error) : resolve(file));
  });
  const failed = createExtractionFailureSignal();
  zip.on("error", failed.reject);
  // The error can arrive between calls to readEntry.
  void failed.promise.catch(() => {});
  const timer = setTimeout(() => failed.reject(new Error("Office 抽取超时")),
    Math.max(0, budget.timeoutMs - (Date.now() - budget.startMs)));
  let activeReader: Readable | undefined;
  try {
    if (zip.entryCount > budget.maxZipEntries) throw new Error("ZIP 条目数超限");
    const parts = new Map<string, Buffer>();
    let total = 0;
    for (let i = 0; i < zip.entryCount; i++) {
      checkBudget();
      const entry = await Promise.race([failed.promise, new Promise<ZipEntry>((resolve) => {
        zip.once("entry", resolve);
        zip.readEntry();
      })]);
      if (!include(entry.fileName)) continue;
      if (parts.has(entry.fileName)) throw new Error(`ZIP 重复正文条目：${entry.fileName}`);
      if (entry.uncompressedSize > budget.maxEntryBytes) throw new Error(`ZIP 单条目解压超限：${entry.fileName}`);
      total += entry.uncompressedSize;
      if (total > budget.maxUncompressedBytes) throw new Error("ZIP 正文解压总量超限");
      const content = await Promise.race([failed.promise, new Promise<Buffer>((resolve, reject) => {
        zip.openReadStream(entry, (error, reader) => {
          if (error) { reject(error); return; }
          activeReader = reader;
          const chunks: Buffer[] = [];
          let length = 0;
          reader.on("error", reject);
          reader.once("end", () => {
            activeReader = undefined;
            resolve(Buffer.concat(chunks, length));
          });
          reader.on("data", (buffer: Buffer) => {
            try {
              checkBudget();
              length += buffer.length;
              if (length > entry.uncompressedSize) throw new Error(`ZIP 条目实际解压超限：${entry.fileName}`);
              chunks.push(buffer);
            } catch (failure) {
              reject(failure);
              reader.destroy();
            }
          });
        });
      })]);
      parts.set(entry.fileName, content);
    }
    return parts;
  } finally {
    clearTimeout(timer);
    activeReader?.destroy();
    zip.close();
  }
}
