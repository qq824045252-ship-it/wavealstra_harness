import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { BuiltinCapabilityRuntime, ToolExecutionContext } from "./BuiltinCapabilityRuntime";
import { recognitionRequest } from "./HttpRecognitionService";

export interface OcrResult {
  text: string;
  /** Input-image pixels. Absent boxes/confidence remain unknown; never synthesize them. */
  boxes?: Array<{ text: string; x: number; y: number; width: number; height: number; confidence?: number }>;
}
export interface ImageRecognitionAdapter {
  recognize(imagePath: string, context: ToolExecutionContext): Promise<OcrResult>;
}
export function createHttpOcrAdapter(runtime: BuiltinCapabilityRuntime): ImageRecognitionAdapter {
  return { async recognize(imagePath, context) {
    const config = runtime.recognitionService("ocr", "http-ocr");
    if (![".png", ".jpg", ".jpeg"].includes(extname(imagePath).toLowerCase())) throw new Error("format: OCR supports PNG/JPEG only; PDF and Office unsupported");
    if ((await stat(imagePath)).size > 10 * 1024 * 1024) throw new Error("limit: image exceeds 10 MiB");
    const result = await recognitionRequest(config, config.credentialRef ? runtime.credentials.get(config.credentialRef) : null,
      JSON.stringify({ model: config.model, image: (await readFile(imagePath)).toString("base64") }), context.signal) as OcrResult;
    if (typeof result.text !== "string") throw new Error("response: OCR text missing");
    if (result.boxes?.some(b => ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0)) throw new Error("response: invalid pixel boxes");
    runtime.recordRecognitionRun("ocr");
    return { text: result.text, boxes: result.boxes };
  } };
}
