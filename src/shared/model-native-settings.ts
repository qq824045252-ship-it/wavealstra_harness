import { deepseekRecord, supportsDeepSeekNative } from "./deepseek";

export interface NativeCapabilityField {
  id: string;
  label: string;
  /** Provider-qualified accessible names distinguish controls when more adapters register. */
  accessibleName: string;
  kind: "boolean" | "select";
  options?: readonly { value: string; label: string }[];
  hint?: string;
}
export interface NativeCapabilitySchema {
  provider: string;
  compatKey: string;
  supported: (model: unknown) => boolean;
  description: string;
  unavailableDescription: string;
  fields: readonly NativeCapabilityField[];
}

/** Register controls with the adapter, not a second vendor page. Do not infer
 * hosted-tool support from a model name or an OpenAI-compatible endpoint. */
const NATIVE_CAPABILITY_SCHEMAS: readonly NativeCapabilitySchema[] = [{
  provider: "deepseek", compatKey: "mybuddyDeepSeek", supported: supportsDeepSeekNative,
  description: "使用此模型的 API Key。联网搜索与网页读取由模型服务端执行；引用来源和网页上下文会随对话保存。独立工具连接仍在工具能力中管理。",
  unavailableDescription: "此适配器的原生能力需要官方 api.deepseek.com 的 deepseek-flash，支持 Chat Completions、Responses 和 Anthropic Messages（/anthropic）。当前模型或连接不满足条件，已保存的配置不会被删除。",
  fields: [
    { id: "webSearch", label: "允许模型使用服务端联网搜索", accessibleName: "DeepSeek 联网搜索", kind: "boolean" },
    { id: "readUrl", label: "允许模型使用服务端网页读取", accessibleName: "DeepSeek 网页读取", kind: "boolean" },
    { id: "files", label: "Bot 对话附件处理", accessibleName: "DeepSeek 附件处理", kind: "select",
      options: [{ value: "", label: "应用默认处理" }, { value: "text", label: "原生文件接口：文档正文" }, { value: "rich", label: "原生文件接口：文档正文和插图" }],
      hint: "启用后，受支持的 Bot 附件会上传至当前模型服务商，并通过 file_id 交给模型。PDF、Word、PowerPoint、BMP 和 TIFF 使用所选解析模式；其他支持的图片、文本、表格和电子书使用原生文件输入。对话中显示上传与解析进度。此适配器的服务器副本保留 24 小时，重启后仍复用有效上传记录；过期后重新上传。" },
  ],
}];

export function modelNativeCapabilitySchema(model: unknown): NativeCapabilitySchema | undefined {
  return NATIVE_CAPABILITY_SCHEMAS.find(schema => schema.provider === deepseekRecord(model)?.provider);
}

export function nativeCapabilityValue(model: unknown, schema: NativeCapabilitySchema, field: NativeCapabilityField): boolean | string {
  if (!schema.supported(model)) return field.kind === "boolean" ? false : "";
  const values = deepseekRecord(deepseekRecord(deepseekRecord(model)?.compat)?.[schema.compatKey]);
  const value = values?.[field.id];
  return field.kind === "boolean" ? value === true
    : typeof value === "string" && field.options?.some(option => option.value === value) ? value : "";
}

/** Preserve unrelated native/compat keys; reject unknown controls and invalid values. */
export function nativeCapabilityPatch(model: unknown, fieldId: string, value: boolean | string): { compat: Record<string, unknown> } {
  const schema = modelNativeCapabilitySchema(model);
  const field = schema?.fields.find(item => item.id === fieldId);
  if (!schema || !field || !schema.supported(model)) throw new Error("当前模型未接入此原生能力");
  if (field.kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string" || !field.options?.some(option => option.value === value)) {
    throw new Error("无效的模型原生能力选项");
  }
  const compat = deepseekRecord(deepseekRecord(model)?.compat) ?? {};
  const previous = deepseekRecord(compat[schema.compatKey]) ?? {};
  return { compat: { ...compat, [schema.compatKey]: { ...previous, [field.id]: value === "" ? undefined : value } } };
}
