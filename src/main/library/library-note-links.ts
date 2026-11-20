import { closeSync, openSync, readSync, writeFileSync } from "node:fs";

function noteLinkRewriter(rewrite: (href: string) => string | undefined): (line: string) => string {
  let fence: string | undefined;
  return (line) => {
    const marker = /^ {0,3}(\x60{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker;
      return line;
    }
    if (fence) return line;
    return line.replace(/(\x60+)(.*?)\1|(\]\(\s*)(?:<([^>\n]+)>|([^\s()<>]+))/g,
      (full, ticks: string | undefined, _code: string | undefined, opening: string, angle: string | undefined, plain: string | undefined) => {
        if (ticks) return full;
        const href = rewrite(angle ?? plain ?? "");
        return href === undefined ? full : opening + (angle ? "<" + href + ">" : href);
      });
  };
}

/** Rewrite direct Markdown link destinations without treating fenced or inline code as links. */
export function rewriteNoteLinks(markdown: string, rewrite: (href: string) => string | undefined): string {
  return markdown.split(/(?<=\n)/).map(noteLinkRewriter(rewrite)).join("");
}

/** Copy Markdown a line at a time, preserving raw bytes for unchanged lines. */
export function copyWithRewrittenNoteLinks(source: string, destination: string, rewrite: (href: string) => string | undefined): boolean {
  const block = Buffer.allocUnsafe(64 * 1024);
  const maxLineBytes = 1024 * 1024;
  const rewriteLine = noteLinkRewriter(rewrite);
  const input = openSync(source, "r");
  let output: number | undefined;
  let parts: Buffer[] = [];
  let size = 0;
  let passthrough = false;
  let changed = false;
  try {
    output = openSync(destination, "wx");
    const target = output;
    const writeBuffer = Buffer.allocUnsafe(256 * 1024);
    let used = 0;
    const flush = () => {
      if (used) writeFileSync(target, writeBuffer.subarray(0, used));
      used = 0;
    };
    const append = (value: Buffer | string) => {
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      if (used + bytes.length > writeBuffer.length) flush();
      if (bytes.length >= writeBuffer.length) writeFileSync(target, bytes);
      else {
        bytes.copy(writeBuffer, used);
        used += bytes.length;
      }
    };
    const finishLine = () => {
      if (size) {
        const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts, size);
        const original = bytes.toString("utf8");
        const rewritten = rewriteLine(original);
        changed ||= rewritten !== original;
        append(rewritten === original ? bytes : rewritten);
      }
      parts = [];
      size = 0;
      passthrough = false;
    };
    for (let read = readSync(input, block); read > 0; read = readSync(input, block)) {
      let start = 0;
      while (start < read) {
        const newline = block.indexOf(0x0a, start);
        const end = newline >= start && newline < read ? newline + 1 : read;
        const part = block.subarray(start, end);
        if (!passthrough && size + part.length > maxLineBytes) {
          // Preserve abnormally long lines verbatim. Only their leading fence marker affects subsequent lines.
          rewriteLine(parts[0]?.subarray(0, 128).toString("utf8").match(/^ {0,3}(?:`{3,}|~{3,})/)?.[0] ?? "");
          for (const buffered of parts) append(buffered);
          parts = [];
          size = 0;
          passthrough = true;
        }
        if (passthrough) append(part);
        else {
          parts.push(Buffer.from(part));
          size += part.length;
        }
        if (end === newline + 1) finishLine();
        start = end;
      }
    }
    finishLine();
    flush();
    return changed;
  } finally {
    try { if (output !== undefined) closeSync(output); }
    finally { closeSync(input); }
  }
}
