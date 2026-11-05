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
      setHint("Enter a whole number from 1 to 3600 seconds.");
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
      if (!returned) throw new Error("Subagent settings API is unavailable.");
      onSaved(returned);
      const echoed = draftKey(draftFrom(returned)) === draftKey(draft);
      setDraft(draftFrom(returned));
      setHint(echoed ? "Execution limits saved." : "Saved values differ from the requested limits. Check the displayed values.");
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
        <strong>Subagent execution limits</strong>
        <span>Restrict which models a subagent may run and how long one run may take.</span>
        {dirty && <span className="subagent-policy-badge">Unsaved</span>}
      </summary>
      <div className="subagent-policy-body">
        <div className="subagent-policy-row">
          <label className="subagent-policy-toggle">
            <input type="checkbox" checked={draft.restricted} disabled={saving} aria-label="Restrict subagent models"
              onChange={(event) => patch({ restricted: event.target.checked })} />
            <span>Limit subagent models</span>
          </label>
          <small>Off allows models enabled in the app and current workspace. On further limits every subagent model selection to the checked models.</small>
        </div>

        {!draft.restricted ? (
          <div className="subagent-policy-hint">No model limit is saved; the subagent default and role frontmatter still apply.</div>
        ) : (
          <>
            {draft.allowedModels.length === 0 && (
              <div className="subagent-policy-warn" role="alert">Empty list blocks every subagent run.</div>
            )}
            {models.length === 0 ? (
              <div className="subagent-policy-warn" role="alert">No enabled chat model. Enable one above before restricting.</div>
            ) : (
              <div className="subagent-policy-models" role="group" aria-label="Allowed subagent models">
                {models.map((model) => (
                  <label key={model.id} className="subagent-policy-model">
                    <input type="checkbox" checked={draft.allowedModels.includes(model.id)} disabled={saving}
                      aria-label={`Allow ${model.id}`} onChange={() => toggleModel(model.id)} />
                    <span>{model.name}</span>
                    <small>{model.id}</small>
                  </label>
                ))}
              </div>
            )}
            {missing.length > 0 && (
              <div className="subagent-policy-missing">
                <span>Saved but not available now. Remove to keep the list honest.</span>
                {missing.map((id) => (
                  <span key={id} className="subagent-policy-chip" title={id}>
                    {id}
                    <button type="button" disabled={saving} aria-label={`Remove ${id}`}
                      onClick={() => patch({ allowedModels: draft.allowedModels.filter((item) => item !== id) })}>x</button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <div className="subagent-policy-grid">
          <label className="subagent-policy-field">
            <span>Total run limit in seconds</span>
            <input className="settings-input" type="number" min={MIN_TIMEOUT_SECONDS} max={MAX_TIMEOUT_SECONDS}
              value={draft.timeoutSeconds} disabled={saving} aria-label="Subagent run time limit in seconds"
              onChange={(event) => patch({ timeoutSeconds: event.target.value })} />
            <small>Time for the whole task after the worker starts, not idle time. Choose 1 to 3600 seconds. Changes apply to new runs.</small>
          </label>
          <label className="subagent-policy-field">
            <span>Time limit policy</span>
            <select className="settings-input" value={draft.allowOverride ? "allow-override" : "fixed"} disabled={saving}
              aria-label="Subagent time limit policy"
              onChange={(event) => patch({ allowOverride: event.target.value === "allow-override" })}>
              <option value="fixed">Fixed at this value</option>
              <option value="allow-override">Callers may override each run</option>
            </select>
            <small>Fixed replaces any per-call limit. An override applies to that run only.</small>
          </label>
        </div>

        <div className="subagent-policy-roles">
          <div className="subagent-policy-roles-head">
            <strong>Role candidates</strong>
            <small>Candidates are checked in order against enabled and allowed models. A provider error stops the run. The diverse role assigns distinct models to at least two tasks.</small>
          </div>
          {draft.roles.map((role, index) => {
            const candidates = candidatesOf(role.text);
            const unknown = candidates.filter((id) => !knownIds.has(id));
            return (
              <div key={role.name} className="subagent-policy-role">
                <div className="subagent-policy-role-head">
                  <span className="mono-path">{role.name}</span>
                  <small>{candidates.length} candidate(s)</small>
                  <button className="btn" type="button" disabled={saving}
                    onClick={() => patch({ roles: draft.roles.filter((_, item) => item !== index) })}>Remove</button>
                </div>
                <textarea className="settings-input full subagent-policy-textarea" rows={3} spellCheck={false}
                  disabled={saving} aria-label={`${role.name} candidate models`} placeholder="provider/model-id"
                  value={role.text}
                  onChange={(event) => patch({
                    roles: draft.roles.map((item, at) => (at === index ? { ...item, text: event.target.value } : item)),
                  })} />
                {unknown.length > 0 && (
                  <small className="subagent-policy-warn">Unavailable on this machine: {unknown.join(", ")}</small>
                )}
              </div>
            );
          })}
          <div className="subagent-policy-add-role">
            <input className="settings-input" aria-label="New role name" placeholder="fast" value={newRole}
              disabled={saving} onChange={(event) => setNewRole(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addRole(); } }} />
            <button className="btn" type="button" onClick={addRole}
              disabled={saving || !newRole.trim() || draft.roles.some((role) => role.name === newRole.trim())}>Add role</button>
          </div>
        </div>

        <div className="subagent-policy-actions">
          {hint && <div className="subagent-policy-hint" role="status">{hint}</div>}
          <small>Saved to {config.configPath ?? "subagent.json"}. Model limits are checked again before each request.</small>
          <button className="btn" type="button" disabled={!dirty || saving} onClick={() => setDraft(saved)}>Discard</button>
          <button className="btn primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save limits"}</button>
        </div>
      </div>
    </details>
  );
}
