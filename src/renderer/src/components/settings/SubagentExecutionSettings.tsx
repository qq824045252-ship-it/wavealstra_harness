import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfoDto, SubagentConfigDto, SubagentConfigPatch } from "@shared/agent-ipc";
import { DEFAULT_SUBAGENT_TIMEOUT_MS, MAX_SUBAGENT_TIMEOUT_MS } from "@shared/subagent-execution-policy";
import "./SubagentExecutionSettings.css";

const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = MAX_SUBAGENT_TIMEOUT_MS / 1000;
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_SUBAGENT_TIMEOUT_MS / 1000;

interface Draft {
  revision: string;
  restricted: boolean;
  allowedModels: string[];
  timeoutSeconds: string;
  allowOverride: boolean;
  roles: Array<{ name: string; text: string }>;
}

function draftFrom(config: SubagentConfigDto): Draft {
  const ms = config.timeoutMs;
  const seconds = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms / 1000 : DEFAULT_TIMEOUT_SECONDS;
  return {
    revision: config.revision,
    restricted: Array.isArray(config.allowedModels),
    allowedModels: Array.isArray(config.allowedModels) ? [...config.allowedModels] : [],
    timeoutSeconds: String(seconds),
    allowOverride: config.timeoutPolicy === "allow-override",
    roles: Object.entries(config.roles ?? {}).map(([name, ids]) => ({ name, text: ids.join("\n") })),
  };
}

/** Candidate order is priority order, so the parsed list keeps document order. */
function candidatesOf(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

function rolesOf(draft: Draft): Record<string, string[]> {
  return Object.fromEntries(draft.roles.map(role => [role.name, candidatesOf(role.text)]));
}

function draftKey(draft: Draft): string {
  return JSON.stringify({
    restricted: draft.restricted,
    allowedModels: draft.restricted ? [...draft.allowedModels].sort() : null,
    timeoutSeconds: draft.timeoutSeconds,
    allowOverride: draft.allowOverride,
    roles: rolesOf(draft),
  });
}

export default function SubagentExecutionSettings({ models, config, onSaved }: {
  models: ModelInfoDto[];
  config: SubagentConfigDto;
  onSaved: (next: SubagentConfigDto) => void;
}): React.JSX.Element {
  const saved = useMemo(() => draftFrom(config), [config]);
  const savedKey = useMemo(() => draftKey(saved), [saved]);
  const [draft, setDraft] = useState<Draft>(saved);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState("");
  const [newRole, setNewRole] = useState("");
  const [open, setOpen] = useState(true);
  const savedRef = useRef(saved);

  // A parent refresh adopts the new saved config only when the draft has no unsaved edits.
  useEffect(() => {
    const previous = savedRef.current;
    savedRef.current = saved;
    setDraft((current) => (draftKey(current) === draftKey(previous) ? saved : current));
  }, [saved]);

  const dirty = draftKey(draft) !== savedKey;
  const knownIds = new Set(models.map((model) => model.id));
  const missing = draft.allowedModels.filter((id) => !knownIds.has(id));
  const patch = (next: Partial<Draft>): void => setDraft({ ...draft, ...next });
  const toggleModel = (id: string): void => patch({
    allowedModels: draft.allowedModels.includes(id)
      ? draft.allowedModels.filter((item) => item !== id)
      : [...draft.allowedModels, id],
  });

  const save = async (): Promise<void> => {
    const seconds = Number(draft.timeoutSeconds);
    if (!Number.isInteger(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
      setHint("请输入 1 到 3600 之间的整数秒。");
      return;
    }
    const payload: SubagentConfigPatch = {
      expectedRevision: draft.revision,
      allowedModels: draft.restricted ? [...draft.allowedModels] : undefined,
      roles: rolesOf(draft),
      timeoutMs: seconds * 1000,
      timeoutPolicy: draft.allowOverride ? "allow-override" : "fixed",
    };
    setSaving(true);
    setHint("");
    try {
      const returned = await window.api?.agent?.saveSubagentConfig?.(payload);
      if (!returned) throw new Error("子代理设置接口不可用。");
      onSaved(returned);
      const echoed = draftKey(draftFrom(returned)) === draftKey(draft);
      setDraft(draftFrom(returned));
      setHint(echoed ? "执行限制已保存。" : "保存后的值与提交值不同，请检查当前显示的设置。");
    } catch (error) {
      setHint(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const addRole = (): void => {
    const name = newRole.trim();
    if (!name || draft.roles.some((role) => role.name === name)) return;
    patch({ roles: [...draft.roles, { name, text: "" }] });
    setNewRole("");
  };

  return (
    <details className="subagent-policy" open={open} onToggle={(event) => setOpen(event.currentTarget.open)} data-testid="subagent-policy">
      <summary className="subagent-policy-summary">
        <strong>子代理执行限制</strong>
        <span>设置子代理可用的模型和单次任务的运行时限。</span>
        {dirty && <span className="subagent-policy-badge">未保存</span>}
      </summary>
      <div className="subagent-policy-body">
        <div className="subagent-policy-row">
          <label className="subagent-policy-toggle">
            <input type="checkbox" checked={draft.restricted} disabled={saving} aria-label="限制子代理可用模型"
              onChange={(event) => patch({ restricted: event.target.checked })} />
            <span>限制可用模型</span>
          </label>
          <small>关闭时可使用应用和当前工作区启用的模型；开启后，子代理只能使用下方选中的模型。</small>
        </div>

        {!draft.restricted ? (
          <div className="subagent-policy-hint">未设置模型限制；子代理默认模型和角色配置仍然生效。</div>
        ) : (
          <>
            {draft.allowedModels.length === 0 && (
              <div className="subagent-policy-warn" role="alert">未选择任何模型，所有子代理任务都将无法运行。</div>
            )}
            {models.length === 0 ? (
              <div className="subagent-policy-warn" role="alert">当前没有启用的聊天模型，请先在上方启用模型。</div>
            ) : (
              <div className="subagent-policy-models" role="group" aria-label="子代理允许使用的模型">
                {models.map((model) => (
                  <label key={model.id} className="subagent-policy-model">
                    <input type="checkbox" checked={draft.allowedModels.includes(model.id)} disabled={saving}
                      aria-label={`允许使用 ${model.id}`} onChange={() => toggleModel(model.id)} />
                    <span>{model.name}</span>
                    <small>{model.id}</small>
                  </label>
                ))}
              </div>
            )}
            {missing.length > 0 && (
              <div className="subagent-policy-missing">
                <span>以下已保存的模型当前不可用，可将其移除。</span>
                {missing.map((id) => (
                  <span key={id} className="subagent-policy-chip" title={id}>
                    {id}
                    <button type="button" disabled={saving} aria-label={`移除 ${id}`}
                      onClick={() => patch({ allowedModels: draft.allowedModels.filter((item) => item !== id) })}>x</button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <div className="subagent-policy-grid">
          <label className="subagent-policy-field">
            <span>单次运行时限（秒）</span>
            <input className="settings-input" type="number" inputMode="numeric" step={1} min={MIN_TIMEOUT_SECONDS} max={MAX_TIMEOUT_SECONDS}
              value={draft.timeoutSeconds} disabled={saving} aria-label="子代理单次运行时限（秒）"
              onChange={(event) => patch({ timeoutSeconds: event.target.value })} />
            <small>从工作进程启动后开始计算整个任务的运行时间，范围为 1～3600 秒。修改仅对新任务生效。</small>
          </label>
          <label className="subagent-policy-field">
            <span>时限策略</span>
            <select className="settings-input" value={draft.allowOverride ? "allow-override" : "fixed"} disabled={saving}
              aria-label="子代理时限策略"
              onChange={(event) => patch({ allowOverride: event.target.value === "allow-override" })}>
              <option value="fixed">固定使用此时限</option>
              <option value="allow-override">允许调用方单次覆盖</option>
            </select>
            <small>固定时限会覆盖调用方指定的时限；允许覆盖时，调用方的设置仅对该次运行生效。</small>
          </label>
        </div>

        <div className="subagent-policy-roles">
          <div className="subagent-policy-roles-head">
            <strong>角色候选模型</strong>
            <small>每行填写一个模型 ID，按顺序检查模型是否已启用且被允许。服务商报错会终止运行；diverse 角色会为至少两个任务分配不同模型。</small>
          </div>
          {draft.roles.map((role, index) => {
            const candidates = candidatesOf(role.text);
            const unknown = candidates.filter((id) => !knownIds.has(id));
            return (
              <div key={role.name} className="subagent-policy-role">
                <div className="subagent-policy-role-head">
                  <span className="mono-path">{role.name}</span>
                  <small>{candidates.length} 个候选模型</small>
                  <button className="btn" type="button" disabled={saving}
                    onClick={() => patch({ roles: draft.roles.filter((_, item) => item !== index) })}>移除</button>
                </div>
                <textarea className="settings-input full subagent-policy-textarea" rows={3} spellCheck={false}
                  disabled={saving} aria-label={`${role.name} 的候选模型`} placeholder={"每行一个模型 ID，例如：\nprovider/model-id"}
                  value={role.text}
                  onChange={(event) => patch({
                    roles: draft.roles.map((item, at) => (at === index ? { ...item, text: event.target.value } : item)),
                  })} />
                {unknown.length > 0 && (
                  <small className="subagent-policy-warn">当前设备不可用： {unknown.join(", ")}</small>
                )}
              </div>
            );
          })}
          <div className="subagent-policy-add-role">
            <input className="settings-input" aria-label="新角色名称" placeholder="fast" value={newRole}
              disabled={saving} onChange={(event) => setNewRole(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRole(); } }} />
            <button className="btn" type="button" onClick={addRole}
              disabled={saving || !newRole.trim() || draft.roles.some((role) => role.name === newRole.trim())}>添加角色</button>
          </div>
        </div>

        <div className="subagent-policy-actions">
          {hint && <div className="subagent-policy-hint" role="status">{hint}</div>}
          <small>配置保存至 {config.configPath ?? "subagent.json"}。每次请求前会再次检查模型限制。</small>
          <button className="btn" type="button" disabled={!dirty || saving} onClick={() => setDraft(saved)}>放弃更改</button>
          <button className="btn primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存设置"}</button>
        </div>
      </div>
    </details>
  );
}
