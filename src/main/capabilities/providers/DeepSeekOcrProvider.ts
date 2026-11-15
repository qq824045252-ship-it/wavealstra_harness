import { extname } from "node:path";
import type { ImageRecognitionAdapter, OcrResult } from "../HttpOcrProvider";
import {
  ApiProviderError, apiJson, assertNotAborted, imageMime, readTaskFile, record,
  resolveApiConnection, type ApiProviderOptions,
} from "./ApiServiceConnection";

export type DeepSeekOcrPurpose = "text_recognition" | "rich_layout_recognition";
export interface DeepSeekOcrOptions extends ApiProviderOptions { purpose?: () => DeepSeekOcrPurpose }

const EXTENSIONS = [".pdf", ".doc", ".docx", ".ppt", ".pptx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"];

/** Detect the container from bytes. DeepSeek performs document/image decoding. */
function documentType(bytes: Buffer, extension: string): { mime: string; suffix: string } {
  const image = imageMime(bytes);
  const imageExtensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  if (image && imageExtensions[image]) return { mime: image, suffix: imageExtensions[image] };
  if (bytes.length >= 14 && bytes.toString("ascii", 0, 2) === "BM") return { mime: "image/bmp", suffix: "bmp" };
  if (bytes.length >= 8 && (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))) return { mime: "image/tiff", suffix: "tiff" };
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { mime: "application/pdf", suffix: "pdf" };
  if (bytes.length >= 512 && bytes.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) {
    // Both binary DOC and PPT use OLE containers. The server detects the inner format.
    return { mime: "application/octet-stream", suffix: extension === ".ppt" ? "ppt" : "doc" };
  }
  if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x04034b50 && bytes.includes(Buffer.from("[Content_Types].xml"))) {
    if (bytes.includes(Buffer.from("word/document.xml"))) return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", suffix: "docx" };
    if (bytes.includes(Buffer.from("ppt/presentation.xml"))) return { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", suffix: "pptx" };
  }
  throw new ApiProviderError("format", "DeepSeek OCR requires a supported image, PDF, Word or PowerPoint document");
}

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) ? value : undefined;
}

/** Standalone OCR returns page text; it does not create a Files API file_id. */
export function createDeepSeekOcrAdapter(options: DeepSeekOcrOptions): ImageRecognitionAdapter {
  return {
    async recognize(filePath, context): Promise<OcrResult> {
      assertNotAborted(context.signal);
      const connection = await resolveApiConnection(options);
      if (connection.protocol !== "deepseek") throw new ApiProviderError("configuration", "DeepSeek OCR requires a DeepSeek service connection");
      const purpose = options.purpose?.() ?? "text_recognition";
      if (purpose !== "text_recognition" && purpose !== "rich_layout_recognition") throw new ApiProviderError("input", "unsupported DeepSeek OCR purpose");
      const bytes = await readTaskFile(filePath, context, 100 * 1024 * 1024, EXTENSIONS);
      const type = documentType(bytes, extname(filePath).toLowerCase());
      const body = new FormData();
      body.set("purpose", purpose);
      // Avoid transmitting local filenames and keep the two-field native contract.
      body.set("file", new Blob([new Uint8Array(bytes)], { type: type.mime }), `document.${type.suffix}`);
      let result: Record<string, unknown>;
      try {
        result = await apiJson(connection, "/v1/tools/ocr", { body, signal: context.signal, maxBytes: 64 * 1024 * 1024 }, options);
      } catch (error) {
        if (error instanceof ApiProviderError && ["cancelled", "timeout", "transport"].includes(error.code)) {
          throw new ApiProviderError(error.code, "stopped waiting for OCR; if DeepSeek received the file, recognition may still finish and be billed", error.status);
        }
        throw error;
      }
      // Recognition failures can arrive after HTTP 200 and keep-alive whitespace.
      if (result.error !== undefined) {
        const error = record(result.error);
        const code = typeof error.code === "string" && /^[a-z_]{1,80}$/.test(error.code) ? ` (${error.code})` : "";
        throw new ApiProviderError("response", `DeepSeek OCR failed${code}`);
      }
      if (result.purpose !== purpose || !Number.isSafeInteger(result.page_count) || (result.page_count as number) < 1 || (result.page_count as number) > 1_000
        || !Array.isArray(result.pages) || result.pages.length !== result.page_count) throw new ApiProviderError("response", "DeepSeek OCR returned invalid page metadata");
      const pages = result.pages.map((value): NonNullable<OcrResult["pages"]>[number] => {
        const page = record(value);
        if (!Number.isSafeInteger(page.index) || (page.index as number) < 0 || (page.index as number) >= (result.page_count as number)
          || typeof page.text !== "string" || (page.finish_reason !== "stop" && page.finish_reason !== "length")) throw new ApiProviderError("response", "DeepSeek OCR returned an invalid page");
        return { index: page.index as number, text: page.text, finishReason: page.finish_reason };
      }).sort((a, b) => a.index - b.index);
      if (pages.some((page, index) => page.index !== index)) throw new ApiProviderError("response", "DeepSeek OCR returned duplicate or missing pages");
      const usage: Record<string, number> = {};
      if (result.usage !== undefined) {
        const raw = record(result.usage);
        for (const name of ["input_tokens", "output_tokens", "total_tokens"]) {
          if (!Number.isSafeInteger(raw[name]) || (raw[name] as number) < 0) throw new ApiProviderError("response", "DeepSeek OCR returned invalid usage");
          usage[name] = raw[name] as number;
        }
      }
      return {
        text: pages.map(page => `--- Page ${page.index + 1}${page.finishReason === "length" ? " (incomplete)" : ""} ---\n${page.text}`).join("\n\n"),
        pages, pageCount: pages.length, truncated: pages.some(page => page.finishReason === "length"), purpose,
        provider: options.id ?? "deepseek-ocr", requestId: safeRequestId(result.id),
        // Keep raw ref/box tokens in page text. These are normalized page coordinates,
        // never the input-image pixel boxes or desktop-click coordinates of OcrResult.boxes.
        metadata: { coordinateSpace: "page-normalized-0-1000", ...(result.usage !== undefined ? { usage } : {}), billingUnit: "page", billablePages: pages.length },
      };
    },
  };
}
