import type { ImageRecognitionAdapter } from "../HttpOcrProvider";
import {
  ApiProviderError, apiJson, assertNotAborted, imageMime, readTaskFile, record,
  resolveApiConnection, resolveModel, type ApiProviderOptions,
} from "./ApiServiceConnection";

/** Both API variants produce text only. Neither response is assumed to contain calibrated text boxes. */
export function createApiOcrAdapter(options: ApiProviderOptions): ImageRecognitionAdapter {
  return {
    async recognize(imagePath, context) {
      assertNotAborted(context.signal);
      const connection = await resolveApiConnection(options);
      const model = resolveModel(connection);
      const bytes = await readTaskFile(imagePath, context, 10 * 1024 * 1024, [".png", ".jpg", ".jpeg", ".webp"]);
      const mimeType = imageMime(bytes);
      if (!mimeType || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new ApiProviderError("format", "OCR requires a PNG, JPEG or WebP image");
      const imageUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
      if (connection.protocol === "mistral-ocr") {
        const result = await apiJson(connection, "/ocr", {
          body: JSON.stringify({ model, document: { type: "image_url", image_url: imageUrl }, include_image_base64: false }), signal: context.signal,
        }, options);
        if (!Array.isArray(result.pages) || !result.pages.length) throw new ApiProviderError("response", "OCR pages are missing");
        const text = result.pages.map(page => {
          const data = record(page);
          if (typeof data.markdown !== "string") throw new ApiProviderError("response", "OCR page text is missing");
          return data.markdown;
        }).join("\n\n");
        // Mistral image-region boxes are not text boxes. Do not expose them as click coordinates.
        return { text };
      }
      const result = await apiJson(connection, "/chat/completions", {
        body: JSON.stringify({ model, stream: false, messages: [
          { role: "system", content: "Transcribe the visible text in the supplied image, preserving reading order and line breaks. Return only the transcription, without commentary or invented text. If no text is visible, return an empty string." },
          { role: "user", content: [{ type: "text", text: "Extract the text from this image." }, { type: "image_url", image_url: { url: imageUrl } }] },
        ] }), signal: context.signal,
      }, options);
      if (!Array.isArray(result.choices) || result.choices.length !== 1) throw new ApiProviderError("response", "OCR response is missing a single text result");
      const choice = record(result.choices[0]);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "stop") {
        throw new ApiProviderError("response", "OCR response was incomplete or refused");
      }
      const message = record(choice.message);
      if (message.refusal) throw new ApiProviderError("response", "OCR request was refused");
      if (typeof message.content !== "string") throw new ApiProviderError("response", "OCR text is missing");
      return { text: message.content };
    },
  };
}
