import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export const LARGE_LIBRARY_TEXT_BYTES = 1024 * 1024;
const READ_BYTES = 64 * 1024;

export function* readLibraryTextParts(path: string): IterableIterator<string> {
  const fd = openSync(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(READ_BYTES);
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      yield decoder.write(buffer.subarray(0, n));
    }
    yield decoder.end();
  } finally {
    closeSync(fd);
  }
}

export function libraryTextContains(parts: Iterable<string>, needle: string): boolean {
  let tail = "";
  for (const part of parts) {
    const text = tail + part.toLowerCase();
    if (text.includes(needle)) return true;
    tail = needle.length > 1 ? text.slice(-(needle.length - 1)) : "";
  }
  return false;
}
