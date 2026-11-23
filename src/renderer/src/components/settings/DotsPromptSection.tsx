import { useCallback, useEffect, useState } from "react";
import { dotsPromptCategories, maxDotsPromptChars, type DotsPromptCategoryId, type DotsPromptSections } from "@shared/dots-settings";
import type { AppSettingsDto } from "@shared/agent-ipc";
import type { AssemblySegmentDto } from "@shared/mode-profile";
import { SettingsSection } from "./SettingsPrimitives";

type PromptChanges = Pick<Partial<AppSettingsDto>, "dotsPromptOverride" | "dotsPromptSections" | "dotsPromptAppend">;

export default function DotsPromptSection({ value, onSaved }: {
  value: string;
  onSaved: (settings: AppSettingsDto) => void;
}): React.JSX.Element {
  const [category, setCategory] = useState<DotsPromptCategoryId>("role");
  const [systemDrafts, setSystemDrafts] = useState<Partial<Record<string, string>>>({});
  const [appendDraft, setAppendDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [segments, setSegments] = useState<AssemblySegmentDto[]>();
  const [loading, setLoading] = useState(true);

  const preview = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const dots = window.api?.dots;
      if (!dots?.getPromptSegments) throw new Error("提示词预览尚未就绪");
      setSegments(await dots.getPromptSegments());
    } catch (cause) {
      setSegments(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, []);

  const save = async (changes: PromptChanges) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const agent = window.api?.agent;
      if (!agent) throw new Error("设置服务尚未就绪");
      const result = await agent.updateAppSettings(changes);
      onSaved(result);
      const savedIds = Object.keys(changes.dotsPromptSections ?? {});
      if (changes.dotsPromptOverride !== undefined) savedIds.push("dotsInstructions");
      setSystemDrafts(drafts => {
        const remaining = { ...drafts };
        for (const id of savedIds) delete remaining[id];
        return remaining;
      });
      if (changes.dotsPromptAppend !== undefined) setAppendDraft(undefined);
      setNotice("Dots 提示词已保存，下一轮对话生效");
      await preview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  useEffect(() => { void preview(); }, [preview]);

  const legacy = segments?.find(segment => segment.id === "dotsInstructions");
  const current = legacy ?? segments?.find(segment => segment.id === category);
  const systemText = current ? systemDrafts[current.id] ?? current.content : "";
  const appendText = appendDraft ?? value;
  const systemChanged = Boolean(current && systemText.trim() !== current.content);
  const appendChanged = appendText !== value;
  const edited = current?.source === "user";
  const busy = saving || loading;

  const changes: PromptChanges = {};
  if (appendChanged) changes.dotsPromptAppend = appendText;
  if (legacy) {
    if (systemChanged) changes.dotsPromptOverride = systemText;
  } else {
    const editedSections: DotsPromptSections = {};
    for (const { id } of dotsPromptCategories) {
      const draft = systemDrafts[id];
      if (draft !== undefined && draft.trim() !== segments?.find(segment => segment.id === id)?.content) {
        editedSections[id] = draft;
      }
    }
    if (Object.keys(editedSections).length) changes.dotsPromptSections = editedSections;
  }

  const restoreCurrent = () => {
    if (!current) return;
    if (edited) {
      void save(legacy ? { dotsPromptOverride: "" } : { dotsPromptSections: { [category]: "" } });
    } else {
      setSystemDrafts(drafts => ({ ...drafts, [current.id]: undefined }));
    }
  };

  return <SettingsSection title="Dots 提示词"
    description="选一个分类修改。保存后从下一轮 Dots 对话开始生效。" className="dots-prompt-settings">
    <div className="dots-prompt-editor">
      <div className={`dots-prompt-layout${legacy ? " is-legacy" : ""}`}>
        {!legacy && <nav className="dots-prompt-categories" aria-label="提示词分类">
          {dotsPromptCategories.map(({ id, label, description }) => (
            <button key={id} type="button" aria-label={label} aria-describedby={`dots-prompt-category-${id}`}
              aria-pressed={category === id} onClick={() => setCategory(id)}>
              <span>{label}</span><small id={`dots-prompt-category-${id}`}>{description}</small>
            </button>
          ))}
        </nav>}
        <div className="dots-prompt-field">
          <div className="dots-prompt-field-heading">
            <label htmlFor="dots-system-prompt">{current?.title ?? "系统提示词"}</label>
            {current && <small>{systemChanged ? "未保存" : edited ? "已自定义" : "默认"}</small>}
          </div>
          {legacy && <small>此前保存的整段内容仍在生效。选择「恢复分类默认」即可改用分类编辑。</small>}
          <textarea id="dots-system-prompt" value={systemText} maxLength={maxDotsPromptChars} rows={9}
            disabled={busy || !current} placeholder={loading ? "正在加载提示词…" : undefined}
            onChange={event => {
              const text = event.target.value;
              if (current) setSystemDrafts(drafts => ({ ...drafts, [current.id]: text }));
              setNotice("");
            }} />
          <div className="dots-prompt-field-meta">
            <button className="btn" type="button" disabled={busy || !(edited || systemChanged)} onClick={restoreCurrent}>
              {legacy ? "恢复分类默认" : "恢复本类默认"}
            </button>
            <small>{systemText.length} / {maxDotsPromptChars} 字</small>
          </div>
        </div>
      </div>
      <details className="dots-prompt-disclosure">
        <summary>追加指令</summary>
        <div className="dots-prompt-field">
          <textarea id="dots-append-prompt" aria-label="追加指令" value={appendText} maxLength={maxDotsPromptChars} rows={4}
            disabled={busy || !current} placeholder="例如：先给结论，数字注明来源。"
            onChange={event => { setAppendDraft(event.target.value); setNotice(""); }} />
          <small>附在系统提示词之后。{appendText.length} / {maxDotsPromptChars} 字</small>
        </div>
      </details>
      <div className="dots-prompt-actions">
        <button className="btn primary" type="button" disabled={busy || !current || Object.keys(changes).length === 0} onClick={() => void save(changes)}>
          {saving ? "正在保存…" : "保存提示词"}
        </button>
        {!segments && !loading && <button className="btn" type="button" onClick={() => void preview()}>重新加载</button>}
        {notice && <small role="status">{notice}</small>}
      </div>
      {error && <p role="alert" className="answer-routing-error">{error}</p>}
      {segments && <details className="dots-prompt-disclosure">
        <summary>查看当前生效提示词</summary>
        <div className="dots-prompt-preview">
          {segments.map(segment => <section key={segment.id}>
            <h4>{segment.title}</h4><pre>{segment.content}</pre>
          </section>)}
        </div>
      </details>}
    </div>
  </SettingsSection>;
}
