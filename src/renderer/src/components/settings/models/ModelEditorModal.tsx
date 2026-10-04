import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@/components/common/icons";
import type { ModelsModelConfigDto, ModelsModelOverrideDto } from "@shared/agent-ipc";
import { reasoningEffortLabel } from "@shared/model-metadata";
import { modelLimitLabel, modelSourceLabel, modelUsesDefault, type SavedModelEntry } from "./types";

interface ModelEditorModalProps {
  mode: "add" | "edit";
  initial: SavedModelEntry;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: SavedModelEntry) => Promise<void>;
  providerLocked?: boolean;
}

export default function ModelEditorModal({
  mode, initial, busy, onClose, onSave,
}: ModelEditorModalProps): React.JSX.Element {
  const [draft, setDraft] = useState<SavedModelEntry>(() => ({ ...initial }));
  const editingOverride = mode === "edit" && (!initial.definition || Boolean(initial.override));
  const [nativeJson, setNativeJson] = useState(() => {
    const { id: _id, ...definition } = initial.definition ?? { id: initial.modelId };
    return JSON.stringify(editingOverride ? initial.override ?? {} : definition, null, 2);
  });
  const [saveError, setSaveError] = useState("");
  const modelIdRef = useRef<HTMLInputElement | null>(null);

  const readNative = (): Record<string, unknown> => {
    const value: unknown = JSON.parse(nativeJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型参数必须是 JSON 对象");
    const allowed = new Set([
      "name", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost",
      "promptCache", "contextWindow", "maxTokens", "samplingParams", "compat",
      ...(!editingOverride ? ["api", "baseUrl"] : []),
    ]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`此编辑器不支持字段 ${key}；模型 ID 请在上方填写`);
    }
    return value as Record<string, unknown>;
  };
  let native: Record<string, unknown> = {};
  try { native = readNative(); } catch { /* Keep invalid JSON visible for correction. */ }

  const patchNative = (patch: Record<string, unknown>): void => {
    try {
      const next = { ...readNative(), ...patch };
      setNativeJson(JSON.stringify(next, null, 2));
      setSaveError("");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };
  const patch = (value: Partial<SavedModelEntry>): void => {
    setDraft((current) => ({ ...current, ...value }));
    setSaveError("");
  };
  const submit = async (): Promise<void> => {
    if (!draft.modelId.trim()) {
      setSaveError("请输入 Provider 使用的准确模型 ID，显示名称不能代替 ID");
      modelIdRef.current?.focus();
      return;
    }
    setSaveError("");
    try {
      const fields = readNative();
      await onSave({
        ...draft,
        ...(editingOverride
          ? { override: Object.keys(fields).length ? fields as ModelsModelOverrideDto : undefined }
          : { definition: { ...fields, id: draft.modelId.trim() } as ModelsModelConfigDto }),
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  return createPortal(
    <div className="models-modal-overlay" onClick={() => !busy && onClose()}>
      <div className="models-modal models-modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="models-modal-head">
          <div>
            <div className="models-modal-title">{mode === "add" ? "添加模型" : "模型详情 / 设置"}</div>
            <div className="models-modal-sub">
              {mode === "add"
                ? "模型 ID 和选填参数保存到 models.json；未填写的参数由 Pi 处理。"
                : `当前结果来自 ${modelSourceLabel(draft.metadata)}，由 Pi 解析。下面只保存你填写的本地参数。`}
            </div>
          </div>
          <button type="button" className="icon-btn" disabled={busy} onClick={onClose}><IconX size={16} /></button>
        </div>
        <div className="models-modal-body">
          <div className="models-modal-provider-context">
            <strong>{draft.providerId}</strong><span>{draft.baseUrl || "使用 Provider 默认地址"}</span>
          </div>
          <div className="models-field-row">
            <label className="models-field">
              <span>模型 ID</span>
              <input ref={modelIdRef} value={draft.modelId} readOnly={mode === "edit"} disabled={busy}
                onChange={(event) => patch({ modelId: event.target.value })}
                placeholder="准确 ID，例如 deepseek-chat"
                aria-invalid={Boolean(saveError && !draft.modelId.trim())} />
            </label>
            <label className="models-field">
              <span>显示名称（选填）</span>
              <input value={String(native.name ?? "")} disabled={busy} placeholder={draft.name || draft.modelId}
                onChange={(event) => patchNative({ name: event.target.value || undefined })} />
            </label>
          </div>

          {mode === "edit" && (
            <>
              <div className="models-adv-title">Pi 当前使用的参数</div>
              <div className="models-adv-grid">
                <div className="models-field"><span>上下文</span><strong>{modelLimitLabel(draft.metadata, "contextWindow", draft.contextWindow)}</strong></div>
                <div className="models-field"><span>最大输出</span><strong>{modelLimitLabel(draft.metadata, "maxTokens", draft.metadata?.limits?.output)}</strong></div>
                <div className="models-field"><span>图片输入</span><strong>{draft.imageInput ? "支持" : "仅文本"}{modelUsesDefault(draft.metadata, "input") ? "（Pi 默认）" : ""}</strong></div>
                <div className="models-field"><span>思考控制</span><strong>{draft.metadata?.reasoningControl === "unknown" ? "未公布"
                  : draft.thinkingKeys.map((level) => reasoningEffortLabel(level, draft.metadata)).join(" / ") || (draft.reasoning ? "由模型控制" : "不支持")}</strong></div>
              </div>
              {draft.metadata?.parameterSources?.maxTokens && <div className="models-modal-sub">输出上限来源：{draft.metadata.parameterSources.maxTokens}</div>}
              {draft.metadata?.reasoningControl === "toggle" && <div className="models-modal-sub">该模型默认开启思考，只区分开启和关闭，不区分思考强度。</div>}
              {draft.metadata?.defaultedFields?.length || draft.metadata?.configuration?.defaultedFields.length ? (
                <div className="models-modal-sub">标注「Pi 默认」的值是运行时回退值，不能据此确认 Provider 的实际能力或上限。</div>
              ) : null}
              {draft.inputLimits && <div className="models-modal-sub">Pi 输入限制声明：<code>{JSON.stringify(draft.inputLimits)}</code></div>}
              {draft.reasoning && draft.thinkingKeys.length > 0 && (
                <label className="models-field">
                  <span>该模型的思考偏好</span>
                  <select value={draft.reasoningPreference?.effort ?? ""} disabled={busy}
                    onChange={(event) => patch({ reasoningPreference: event.target.value ? { effort: event.target.value } : undefined })}>
                    <option value="">模型默认</option>
                    {draft.thinkingKeys.map((level) => <option key={level} value={level}>{reasoningEffortLabel(level, draft.metadata)}</option>)}
                  </select>
                  <small>保存到 Pi settings.json，与聊天输入框共用。</small>
                </label>
              )}
            </>
          )}

          <div className="models-adv-title">models.json 本地参数（选填）</div>
          <div className="models-modal-sub">
            {editingOverride ? "填写的字段覆盖 Pi 目录；清空字段后恢复目录值。" : "留空不会写入猜测值；新增模型缺少参数时，Pi 会使用自身默认值。"}
          </div>
          <div className="models-adv-grid">
            {(["contextWindow", "maxTokens"] as const).map((key) => (
              <label className="models-field" key={key}>
                <span>{key === "contextWindow" ? "上下文 token 数" : "最大输出 token 数"}</span>
                <input type="number" min={1} disabled={busy} value={typeof native[key] === "number" ? native[key] : ""}
                  placeholder="未声明" onChange={(event) => patchNative({ [key]: event.target.value ? Number(event.target.value) : undefined })} />
              </label>
            ))}
            <label className="models-field">
              <span>推理能力</span>
              <select disabled={busy} value={native.reasoning === true ? "yes" : native.reasoning === false ? "no" : ""}
                onChange={(event) => patchNative({ reasoning: event.target.value === "" ? undefined : event.target.value === "yes" })}>
                <option value="">未声明</option><option value="yes">支持</option><option value="no">不支持</option>
              </select>
            </label>
            <label className="models-field">
              <span>输入类型</span>
              <select disabled={busy} value={Array.isArray(native.input) ? native.input.includes("image") ? "image" : "text" : ""}
                onChange={(event) => patchNative({ input: event.target.value === "" ? undefined : event.target.value === "image" ? ["text", "image"] : ["text"] })}>
                <option value="">未声明</option><option value="text">文本</option><option value="image">文本和图片</option>
              </select>
            </label>
          </div>
          <details>
            <summary>更多 Pi 原生参数</summary>
            <label className="models-field">
              <span>{editingOverride ? "modelOverrides" : "models"} 参数 JSON</span>
              <textarea rows={8} value={nativeJson} disabled={busy} spellCheck={false}
                onChange={(event) => { setNativeJson(event.target.value); setSaveError(""); }} />
              <small>可编辑 inputLimits、thinkingLevelMap、cost 等 Pi 字段；已有的其他字段和请求头会保留。</small>
            </label>
          </details>
        </div>
        {saveError && <div className="models-modal-error" role="alert">{saveError}</div>}
        <div className="models-modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "保存中…" : mode === "add" ? "添加模型" : "保存"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
