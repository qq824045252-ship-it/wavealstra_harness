export function resolveByteRange(header: string | null | undefined, length: number) {
  const headers: Record<string, string> = { "accept-ranges": "bytes", "content-length": String(length) };
  if (!header) return { status: 200 as const, start: 0, end: length - 1, headers };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  let start = length;
  let end = length - 1;
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else {
      const suffix = Number(match[2]);
      if (Number.isSafeInteger(suffix) && suffix > 0) start = Math.max(0, length - suffix);
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) {
    headers["content-range"] = `bytes */${length}`;
    headers["content-length"] = "0";
    return { status: 416 as const, start: 0, end: -1, headers };
  }
  headers["content-range"] = `bytes ${start}-${end}/${length}`;
  headers["content-length"] = String(end - start + 1);
  return { status: 206 as const, start, end, headers };
}
