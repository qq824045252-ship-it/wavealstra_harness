import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import type { CodemodeOutputItem } from "@earendil-works/pi-codemode";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";

const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** Images remain model content even when disk persistence fails after a script's side effects. */
export async function persistDurableImages(items: readonly CodemodeOutputItem[], directory: string): Promise<{ content: CodemodeOutputItem[]; paths: string[] }> {
  const content: CodemodeOutputItem[] = [], paths = new Set<string>();
  const labels = new Map<string, Promise<string>>();
  for (const item of items) {
    if (item.type === "image") {
      const key = `${item.mimeType}:${item.data}`;
      let label = labels.get(key);
      if (!label) {
        label = (async () => {
          const bytes = Buffer.from(item.data, "base64");
          try {
            const extension = extensions[item.mimeType];
            if (!extension) throw new Error(`Unsupported image type: ${item.mimeType}`);
            const file = join(resolve(directory), createHash("sha256").update(item.mimeType).update(bytes).digest("hex") + extension);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            try { await writeFile(file, bytes, { flag: "wx", mode: 0o600 }); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error;
            }
            paths.add(file);
            return `[Image saved to ${file} (${item.mimeType}, ${bytes.length} bytes)]`;
          } catch (error) {
            return `[Image (${item.mimeType}, ${bytes.length} bytes) could not be saved: ${error instanceof Error ? error.message : String(error)}]`;
          }
        })();
        labels.set(key, label);
      }
      content.push({ type: "text", text: await label });
    }
    content.push(item);
  }
  return { content, paths: [...paths] };
}

/** Keep native text reads unchanged, and add image content through the same native environment. */
export function withDurableImageRead(tool: ToolRegistration): ToolRegistration {
  return { ...tool, description: tool.description + " Images (PNG, JPEG, GIF, WebP, BMP) are returned as image blocks; Code Mode can pass them to image().",
    execute: async (args, api, context) => {
      const result = await tool.execute(args, api, context);
      const diagnostic = result.diagnostics?.find(item => item.code === "unsupported_image");
      const mimeType = diagnostic?.message.match(/\((image\/[a-z]+)\)/)?.[1];
      const rawPath = (args as { path?: unknown }).path;
      if (!mimeType || typeof rawPath !== "string" || !api.env) return result;
      const normalized = rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
      const resolved = getOrThrow(await api.env.absolutePath(normalized, context));
      const variants = [resolved, resolved.replace(/ (AM|PM)\./gi, "\u202F$1."), resolved.normalize("NFD"), resolved.replace(/'/g, "\u2019"), resolved.normalize("NFD").replace(/'/g, "\u2019")];
      let path = resolved;
      for (const variant of new Set(variants)) if (getOrThrow(await api.env.exists(variant, context))) { path = variant; break; }
      const reader = getOrThrow(await api.env.openBinaryReader(path, undefined, context));
      try {
        const before = getOrThrow(await reader.info(context));
        if (before.size > 32 * 1024 * 1024) throw new Error("Image file exceeds the 32 MiB read limit");
        const bytes = getOrThrow(await reader.read(0, before.size, context));
        const after = getOrThrow(await reader.info(context));
        if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Image file changed while it was read");
        const resized = await resizeImage(bytes, mimeType);
        if (!resized && mimeType === "image/bmp") throw new Error("BMP image could not be converted for model input");
        const image = resized ?? { data: Buffer.from(bytes).toString("base64"), mimeType };
        const note = resized && formatDimensionNote(resized);
        return { output: [{ type: "text", text: `Read image file [${image.mimeType}]${note ? `\n${note}` : ""}` }, { type: "image", data: image.data, mimeType: image.mimeType }] };
      } finally { await reader.close(context); }
    },
  };
}
