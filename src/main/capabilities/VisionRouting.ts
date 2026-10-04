import type { ToolExecutionContext, VisionCapabilityProvider, VisionDescribeOutput } from "./BuiltinCapabilityRuntime";

export type VisionRouteKind = "native-multimodal" | "delegated-vision" | "vision-unavailable";

export interface VisionRouteResult {
  route: VisionRouteKind;
  model?: string;
  provider?: string;
  descriptions?: VisionDescribeOutput["descriptions"];
  error?: string;
}

interface ModelLike {
  id?: unknown;
  provider?: unknown;
  name?: unknown;
  input?: unknown;
}

export function modelSupportsImageInput(model: unknown): boolean {
  if (!model || typeof model !== "object") return false;
  const input = (model as ModelLike).input;
  return Array.isArray(input) && input.some((item) => String(item).toLowerCase() === "image");
}

export function modelReference(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const value = model as ModelLike;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (provider && id) return `${provider}/${id}`;
  if (id) return id;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  return name || undefined;
}

export async function routeVisionForPaths(options: {
  model: unknown;
  provider: VisionCapabilityProvider | null;
  imagePaths: string[];
  prompt?: string;
  context: ToolExecutionContext;
}): Promise<VisionRouteResult> {
  if (modelSupportsImageInput(options.model)) {
    return {
      route: "native-multimodal",
      model: modelReference(options.model),
    };
  }

  if (!options.provider) {
    return {
      route: "vision-unavailable",
      model: modelReference(options.model),
      error: "当前主模型不支持图片输入，且未启用可用的委托 Vision 模型。",
    };
  }

  try {
    const result = await options.provider.describe(
      { imagePaths: options.imagePaths, prompt: options.prompt },
      options.context,
    );
    return {
      route: "delegated-vision",
      model: modelReference(options.model),
      provider: result.provider,
      descriptions: result.descriptions,
    };
  } catch (error) {
    return {
      route: "vision-unavailable",
      model: modelReference(options.model),
      provider: options.provider.label,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
