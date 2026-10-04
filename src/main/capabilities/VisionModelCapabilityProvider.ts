import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { resizeImage, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getMyBuddyDir } from "../paths";
import { withModelInvocationSettings } from "../agent/ModelInvocationAdmission";
import type { VisionCapabilityProvider } from "./BuiltinCapabilityRuntime";

// 32x32 PNG used only when the user explicitly clicks the Vision capability
// check button. This verifies a real image request instead of catalogue metadata.
const VISION_TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAmElEQVR42t2WwQ6AIAxDbcP//zLeDDEG1m4ccDcO8rCwdui9XzuL1+Y6H9DGBYCSTcd7/ZlEkz+N1KfCVD+okeg5e57BpT5JBiN3kGEw+KJtBuNd4zEodabBoNr9KoOGw0gMzSoMhuxFKsMxO4lhummc4dt1kJHKgwgjGzhLRkGizXOp7Yuak0N/FADlsymAvXPR68TnD1435MZCQqcSGZsAAAAASUVORK5CYII=";

function mimeTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".bmp") return "image/bmp";
  return "image/jpeg";
}

function splitModelKey(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`无效的图像理解模型：${value}`);
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .map((part) => part.type === "text" ? part.text ?? "" : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function createVisionModelCapabilityProvider(options: {
  getRuntime: () => ModelRuntime | null;
  getSelectedModel: () => string | undefined;
}): VisionCapabilityProvider {
  const resolveModel = async () => {
    const runtime = options.getRuntime();
    if (!runtime) throw new Error("模型 Runtime 尚未初始化");
    const selected = options.getSelectedModel()?.trim();
    if (!selected) throw new Error("请先在工具能力中选择一个图像理解模型");
    const { provider, modelId } = splitModelKey(selected);
    const available = await runtime.getAvailable(provider);
    const model = available.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`图像理解模型当前不可用：${selected}`);
    if (!model.input.includes("image")) throw new Error(`模型不支持图片输入：${selected}`);
    return { runtime, selected, model };
  };

  return {
    id: "default",
    label: "MyBuddy Model Runtime",
    describe: async (input, context) => {
      const { runtime, selected, model } = await resolveModel();
      const settings = SettingsManager.create(context.taskRoot, getMyBuddyDir());
      const prompt = input.prompt?.trim() || "请准确描述这张图片的内容，并指出与当前任务相关的重要细节。";
      const descriptions: Array<{ imagePath: string; text: string }> = [];

      for (const imagePath of input.imagePaths) {
        if (context.signal?.aborted) throw new Error("图像理解已取消");
        const bytes = readFileSync(imagePath);
        const mimeType = mimeTypeFor(imagePath);
        const resized = settings.getImageAutoResize()
          ? await resizeImage(bytes, mimeType, model.inputLimits?.images?.resize) : undefined;
        if (resized === null) throw new Error(`图片无法按 Pi 模型限制预处理：${imagePath}`);
        const image = resized ?? { data: bytes.toString("base64"), mimeType };
        const response = await withModelInvocationSettings(settings, () => runtime.completeSimple(
          model,
          {
            messages: [{
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image", data: image.data, mimeType: image.mimeType },
              ],
              timestamp: Date.now(),
            }],
          },
          { signal: context.signal },
        ));
        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new Error(response.errorMessage || `图像理解失败：${selected}`);
        }
        const text = responseText(response);
        if (!text) throw new Error(`图像理解模型没有返回文本：${selected}`);
        descriptions.push({ imagePath, text });
      }

      return { descriptions, provider: selected };
    },
    test: async () => {
      const { runtime, selected, model } = await resolveModel();
      const response = await runtime.completeSimple(
        model,
        {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "这是图像输入链路自检。请简短回复 OK。" },
              { type: "image", data: VISION_TEST_IMAGE_BASE64, mimeType: "image/png" },
            ],
            timestamp: Date.now(),
          }],
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(response.errorMessage || `图像理解实测失败：${selected}`);
      }
      if (!responseText(response)) throw new Error(`图像理解模型实测没有返回文本：${selected}`);
      return `图像理解模型实测可用：${model.name || model.id}（${selected}）`;
    },
  };
}
