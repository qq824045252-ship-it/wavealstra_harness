export function matchesImageMime(bytes: Buffer, mime: string): boolean {
  const header = (start: number, end: number) => bytes.toString("latin1", start, end);
  switch (mime) {
    case "image/png": return bytes.length >= 24 && header(0, 8) === "\x89PNG\r\n\x1a\n";
    case "image/jpeg": return bytes.length >= 4 && header(0, 3) === "\xff\xd8\xff";
    case "image/gif": return bytes.length >= 13 && /^GIF8[79]a$/.test(header(0, 6));
    case "image/webp": return bytes.length >= 16 && header(0, 4) === "RIFF" && header(8, 12) === "WEBP";
    case "image/bmp": return bytes.length >= 26 && header(0, 2) === "BM";
    case "image/avif": {
      if (bytes.length < 16 || header(4, 8) !== "ftyp") return false;
      if (/^avi[fs]$/.test(header(8, 12))) return true;
      const boxLength = Math.min(bytes.readUInt32BE(0), bytes.length);
      for (let offset = 16; offset + 4 <= boxLength; offset += 4) {
        if (/^avi[fs]$/.test(header(offset, offset + 4))) return true;
      }
      return false;
    }
    default: return false;
  }
}
