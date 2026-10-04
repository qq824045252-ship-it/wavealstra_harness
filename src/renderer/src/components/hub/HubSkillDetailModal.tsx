import { useCallback, useEffect, useMemo, useState } from "react";
import type { Skill } from "@/types";
import type {
  SkillAuthoringDraft,
  SkillDetailDto,
  SkillEvalRunResultDto,
  SkillResourceCategory,
} from "../../../../shared/agent-ipc";

type Props = {
  skill: Skill;
  onClose: () => void;
  onApplied: (message: string) => void | Promise<void>;
};

type DetailTab = "overview" | "instructions" | "resources" | "evals" | "versions" | "quality";

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "instructions", label: "Instructions" },
  { id: "resources", label: "Resources" },
  { id: "evals", label: "Evals" },
  { id: "versions", label: "Versions" },
  { id: "quality", label: "Quality" },
];

const RESOURCE_LABEL: Record<SkillResourceCategory, string> = {
  references: "References",
  scripts: "Scripts",
  templates: "Templates",
  evals: "Evals",
  other: "Other",
};

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function parentLocalPath(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return index >= 0 ? filePath.slice(0, index) : filePath;
}

function resolveLocalChild(root: string, relativePath: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root}${root.endsWith(sep) ? "" : sep}${relativePath.replace(/[\\/]+/g, sep)}`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return (
    <div style={{ border: "1px solid var(--border-color)", borderRadius: 9, padding: "10px 12px", minWidth: 120 }}>
      <div className="mcp-auth-hint">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 650, marginTop: 3 }}>{value}</div>
      {hint ? <div className="mcp-auth-hint" style={{ marginTop: 3 }}>{hint}</div> : null}
    </div>
  );
}

function EvalResult({ result, stale }: { result: SkillEvalRunResultDto; stale: boolean }): React.JSX.Element {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="hub-section-note">
        {result.note} {result.skillVersion ? `· v${result.skillVersion}` : ""} · {formatTime(result.evaluatedAt)}
        {stale ? " · 此报告针对旧版本，当前 Quality 不采用" : ""}
      </div>
      {result.total === 0 ? (
        <div className="mcp-auth-hint">没有可执行的 Trigger / Boundary eval case。</div>
      ) : result.cases.map((item, index) => (
        <div key={`${index}-${item.prompt}`} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 9 }}>
          <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{item.pass ? "✓" : item.actual === "unknown" ? "?" : "✕"}</strong>
            <span className="hub-card-tag">期望 {item.expected}</span>
            <span className="hub-card-tag">判定 {item.actual}</span>
          </div>
          <div style={{ marginTop: 5 }}>{item.prompt}</div>
          {item.reason ? <div className="mcp-auth-hint" style={{ marginTop: 4 }}>{item.reason}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function HubSkillDetailModal({ skill, onClose, onApplied }: Props): React.JSX.Element {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [detail, setDetail] = useState<SkillDetailDto | null>(null);
  const [evalResult, setEvalResult] = useState<SkillEvalRunResultDto | null>(null);
  const [draft, setDraft] = useState<SkillAuthoringDraft | null>(null);
  const [improvementBaseContentHash, setImprovementBaseContentHash] = useState<string | null>(null);
  const [positive, setPositive] = useState("");
  const [negative, setNegative] = useState("");
  const [busy, setBusy] = useState<"load" | "eval" | "improve" | "apply" | null>("load");
  const [error, setError] = useState("");

  const loadDetail = useCallback(async (): Promise<void> => {
    setError("");
    const result = await window.api?.agent?.getSkillDetail?.(skill.id);
    if (!result) throw new Error("Skill Detail API 未返回结果");
    setDetail(result);
    setEvalResult(result.latestEval);
  }, [skill.id]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setBusy("load");
      try {
        const result = await window.api?.agent?.getSkillDetail?.(skill.id);
        if (!result || !active) return;
        setDetail(result);
        setEvalResult(result.latestEval);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setBusy(null);
      }
    })();
    return () => { active = false; };
  }, [skill.id]);

  const resourceGroups = useMemo(() => {
    const groups = new Map<SkillResourceCategory, SkillDetailDto["resources"]>();
    for (const item of detail?.resources ?? []) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    return groups;
  }, [detail]);

  const skillDir = useMemo(() => detail?.filePath ? parentLocalPath(detail.filePath) : "", [detail?.filePath]);

  const staleEval = Boolean(evalResult && detail && (
    evalResult.skillContentHash
      ? evalResult.skillContentHash !== detail.contentHash
      : (evalResult.skillVersion && evalResult.skillVersion !== detail.version)
  ));

  const runEval = async (): Promise<void> => {
    if (busy) return;
    setBusy("eval"); setError("");
    try {
      const result = await window.api?.agent?.runSkillEvals?.({ skillId: skill.id });
      if (!result) throw new Error("Eval API 未返回结果");
      setEvalResult(result);
      setTab("evals");
      try { await loadDetail(); } catch (refreshError) {
        setError(`Eval 已完成并保存，但详情刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const generateImprovement = async (): Promise<void> => {
    if (busy) return;
    setBusy("improve"); setError("");
    try {
      const result = await window.api?.agent?.generateSkillImprovementDraft?.({ skillId: skill.id });
      if (!result) throw new Error("Improve API 未返回结果");
      setEvalResult(result.eval);
      setDraft(result.draft);
      setImprovementBaseContentHash(result.baseContentHash);
      setPositive(result.draft.triggerExamples.join("\n"));
      setNegative(result.draft.nonTriggerExamples.join("\n"));
      setTab("quality");
      try { await loadDetail(); } catch (refreshError) {
        setError(`改进草稿已生成，但详情刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  const applyImprovement = async (): Promise<void> => {
    if (!draft || !improvementBaseContentHash || busy) return;
    const next: SkillAuthoringDraft = {
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
      instructions: draft.instructions.trim(),
      triggerExamples: lines(positive),
      nonTriggerExamples: lines(negative),
    };
    if (!next.name || !next.description || !next.instructions) {
      setError("改进草稿缺少名称、Intent 或 Workflow");
      return;
    }
    setBusy("apply"); setError("");
    try {
      const result = await window.api?.agent?.applySkillImprovement?.({
        skillId: skill.id,
        draft: next,
        baseContentHash: improvementBaseContentHash,
      });
      if (!result) throw new Error("Apply API 未返回结果");
      setDraft(null);
      setImprovementBaseContentHash(null);
      setPositive(""); setNegative("");
      await onApplied(`已改进「${result.skill.name}」 · 已保留启用状态、frontmatter 和附属资源`);
      setTab("versions");
      try { await loadDetail(); } catch (refreshError) {
        setError(`改进已成功应用，但详情刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  };

  return (
    <div className="modal-overlay" onClick={() => { if (busy == null && draft == null) onClose(); }}>
      <div className="mcp-auth-modal" style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "88vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div className="mcp-auth-title">{detail?.skillName ?? skill.name}</div>
            <div className="mcp-auth-hint">
              Skill Detail · {detail?.version ? `v${detail.version}` : "未声明版本"} · {(detail?.enabled ?? skill.enabled) ? "已启用" : "已停用"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button type="button" className="btn" disabled={!skillDir} onClick={() => { if (skillDir) void window.api?.openFolder?.(skillDir); }}>打开目录</button>
            <button type="button" className="btn" disabled={busy != null} onClick={() => void runEval()}>{busy === "eval" ? "评测中…" : "运行 Eval"}</button>
            <button
              type="button"
              className="btn primary"
              disabled={busy != null || detail?.improvable === false}
              title={detail?.improveBlockedReason}
              onClick={() => void generateImprovement()}
            >{busy === "improve" ? "分析中…" : "AI 改进"}</button>
            <button type="button" className="btn" disabled={busy != null} onClick={onClose}>关闭</button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 14, borderBottom: "1px solid var(--border-color)", paddingBottom: 8 }}>
          {TABS.map((item) => (
            <button key={item.id} type="button" className={`btn${tab === item.id ? " primary" : ""}`} onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>

        {busy === "load" && <div className="mcp-auth-hint" style={{ padding: "18px 0" }}>正在读取 Skill Package…</div>}
        {error && <div className="mcp-auth-error">操作失败：{error}</div>}

        {detail && tab === "overview" && (
          <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            <div>{detail.description || "无描述"}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Metric label="Package" value={detail.validation.valid ? "Valid" : "Invalid"} />
              <Metric label="Evals" value={`${detail.evalDefinitions.length}`} hint="Trigger + Boundary cases" />
              <Metric label="Resources" value={`${detail.resources.length}`} hint="附属文件" />
              <Metric label="Versions" value={`${detail.revisions.length + 1}`} hint="当前 + 改进前快照" />
            </div>
            <div className="hub-section-note">{detail.filePath}</div>
            {!detail.improvable && detail.improveBlockedReason ? (
              <div className="hub-section-note">AI Improve 不可用：{detail.improveBlockedReason}</div>
            ) : null}
            {detail.validation.warnings.length > 0 && (
              <div>
                <strong>Warnings</strong>
                <ul>{detail.validation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}
          </div>
        )}

        {detail && tab === "instructions" && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <button type="button" className="btn" onClick={() => void window.api?.showItemInFolder?.(detail.filePath)}>定位 SKILL.md</button>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono, monospace)", fontSize: 12.5, lineHeight: 1.6 }}>{detail.markdown}</pre>
          </div>
        )}

        {detail && tab === "resources" && (
          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            {detail.resources.length === 0 ? <div className="mcp-auth-hint">此 Skill 没有 SKILL.md 之外的资源文件。</div> : (["references", "scripts", "templates", "evals", "other"] as SkillResourceCategory[]).map((category) => {
              const items = resourceGroups.get(category) ?? [];
              if (items.length === 0) return null;
              return (
                <div key={category}>
                  <strong>{RESOURCE_LABEL[category]} · {items.length}</strong>
                  <div style={{ display: "grid", gap: 5, marginTop: 7 }}>
                    {items.map((item) => (
                      <div key={item.path} className="hub-section-note" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{item.path}</span>
                        <span style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                          <span>{formatBytes(item.size)}</span>
                          <button type="button" className="btn" onClick={() => { if (skillDir) void window.api?.showItemInFolder?.(resolveLocalChild(skillDir, item.path)); }}>定位</button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {detail && tab === "evals" && (
          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            <div>
              <strong>Eval Definitions · {detail.evalDefinitions.length}</strong>
              <div style={{ display: "grid", gap: 5, marginTop: 7 }}>
                {detail.evalDefinitions.length === 0 ? <div className="mcp-auth-hint">没有定义 eval case。</div> : detail.evalDefinitions.map((item, index) => (
                  <div key={`${index}-${item.prompt}`} className="hub-section-note"><span className="hub-card-tag">{item.expected}</span> {item.prompt}</div>
                ))}
              </div>
            </div>
            <div>
              <strong>Latest Eval</strong>
              <div style={{ marginTop: 7 }}>{evalResult ? <EvalResult result={evalResult} stale={staleEval} /> : <div className="mcp-auth-hint">尚未运行 Eval。</div>}</div>
            </div>
          </div>
        )}

        {detail && tab === "versions" && (
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 10 }}>
              <strong>当前版本 {detail.version ? `v${detail.version}` : "未声明"}</strong>
              <div className="mcp-auth-hint">当前已安装 Package</div>
            </div>
            {detail.revisions.length === 0 ? <div className="mcp-auth-hint">还没有改进前快照。首次应用 AI 改进时会自动创建。</div> : detail.revisions.map((revision) => (
              <div key={revision.id} style={{ border: "1px solid var(--border-color)", borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div>
                  <strong>{revision.version ? `v${revision.version}` : "未声明版本"}</strong>
                  <div className="mcp-auth-hint">改进前快照 · {formatTime(revision.createdAt)} · {revision.id}</div>
                </div>
                {revision.packagePath ? <button type="button" className="btn" onClick={() => void window.api?.openFolder?.(revision.packagePath)}>打开快照</button> : null}
              </div>
            ))}
            <div className="mcp-auth-hint">Versions 当前只读：保留真实 Package 快照用于审计，不自动回滚，避免绕过现有安装/启用边界。</div>
          </div>
        )}

        {detail && tab === "quality" && (
          <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Metric label="Package" value={detail.quality.packageValid ? "Valid" : "Invalid"} />
              <Metric label="Trigger Cases" value={`${detail.quality.triggerCaseCount}`} />
              <Metric label="Boundary Cases" value={`${detail.quality.boundaryCaseCount}`} />
              <Metric label="SKILL.md" value={`${detail.quality.skillMdChars.toLocaleString()} chars`} />
              <Metric label="Resources" value={`${detail.quality.resourceFileCount}`} />
              <Metric
                label="Current Eval"
                value={detail.quality.latestEvalTotal == null ? "—" : `${detail.quality.latestEvalPassed ?? 0}/${detail.quality.latestEvalTotal}`}
                hint={detail.quality.latestEvalUnknown ? `${detail.quality.latestEvalUnknown} unknown` : "仅当前版本"}
              />
            </div>
            {staleEval && <div className="hub-section-note">最近一份 Eval 属于 v{evalResult?.skillVersion}，当前为 v{detail.version}；请重新运行 Eval 后再判断当前版本质量。</div>}
            {detail.quality.warnings.length > 0 ? (
              <div><strong>Quality warnings</strong><ul>{detail.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>
            ) : <div className="mcp-auth-hint">当前 Package Validator 没有结构性 warning。</div>}
          </div>
        )}

        {draft && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border-color)", paddingTop: 14 }}>
            <div className="mcp-auth-title" style={{ fontSize: 14 }}>AI 改进草稿 · 人工确认后才写入</div>
            <input className="mcp-auth-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Skill 显示名称" />
            <textarea className="mcp-auth-input" rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Intent" />
            <textarea className="mcp-auth-input" rows={7} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} placeholder="Workflow / Boundary / Output Contract" />
            <textarea className="mcp-auth-input" rows={3} value={positive} onChange={(e) => setPositive(e.target.value)} placeholder="应该触发的示例（每行一个）" />
            <textarea className="mcp-auth-input" rows={3} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="不应该触发的示例（每行一个）" />
            <div className="mcp-auth-hint">应用时保持 Skill id、启用状态和附属资源；保留未知 frontmatter 字段；SemVer 版本自动 patch +1（未知版本格式保持原值）；覆盖前保存完整 Package 快照。</div>
            <div className="mcp-auth-actions">
              <button type="button" className="btn primary" disabled={busy != null} onClick={() => void applyImprovement()}>{busy === "apply" ? "应用中…" : "应用改进"}</button>
              <button type="button" className="btn" disabled={busy != null} onClick={() => setDraft(null)}>放弃草稿</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
