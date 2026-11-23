import { useCallback, useEffect, useState } from "react";
import type { AnswerRule, AnswerRuleDiff, AnswerRuleVersion } from "@shared/answer-routing";
import { maxAnswerRuleVersions } from "@shared/answer-routing";

const sourceLabels: Record<AnswerRuleVersion["source"], string> = {
  baseline: "记录起点",
  save: "手动保存",
  restore: "恢复旧版",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 设置里的一条规则的保存历史。默认调度策略和普通规则共用这一块。
 * 恢复只追加新版本，当前版与历史都不改写。
 */
export default function AnswerRoutingVersions({ ruleId, currentRevision, memoryBound, busy, onRestored }: {
  ruleId: string;
  currentRevision: number;
  memoryBound?: boolean;
  busy?: boolean;
  onRestored: (rule: AnswerRule) => void | Promise<void>;
}): React.JSX.Element | null {
  const api = window.api?.answerRouting;
  const [versions, setVersions] = useState<AnswerRuleVersion[]>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState<number>();
  const [fromRevision, setFromRevision] = useState<number>();
  const [toRevision, setToRevision] = useState<number>();
  const [diff, setDiff] = useState<AnswerRuleDiff>();
  const [comparing, setComparing] = useState(false);
  const [noteDraft, setNoteDraft] = useState<{ revision: number; text: string }>();

  const load = useCallback(async () => {
    if (!api?.versions) return;
    setError("");
    try {
      setVersions(await api.versions(ruleId));
    } catch (cause) {
      setVersions(undefined);
      setError(errorText(cause));
    }
  }, [api, ruleId]);

  useEffect(() => {
    setVersions(undefined);
    setDiff(undefined);
    setFromRevision(undefined);
    setToRevision(undefined);
    void load();
  }, [load]);

  if (!api?.versions) return null;

  const revisions = versions?.map(version => version.revision) ?? [];
  const from = fromRevision !== undefined && revisions.includes(fromRevision) ? fromRevision : revisions.at(-1);
  const to = toRevision !== undefined && revisions.includes(toRevision) ? toRevision : currentRevision;

  const restore = async (revision: number) => {
    setPending(revision);
    setError("");
    try {
      const saved = await api.restore(ruleId, revision);
      await onRestored(saved);
      setDiff(undefined);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(undefined);
    }
  };

  const saveNote = async () => {
    if (!api.annotate || !noteDraft) return;
    setPending(noteDraft.revision);
    setError("");
    try {
      await api.annotate(ruleId, noteDraft.revision, noteDraft.text);
      setNoteDraft(undefined);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(undefined);
    }
  };

  const runCompare = async () => {
    if (!api.compare || from === undefined || to === undefined) return;
    setComparing(true);
    setError("");
    try {
      setDiff(await api.compare(ruleId, from, to));
    } catch (cause) {
      setDiff(undefined);
      setError(errorText(cause));
    } finally {
      setComparing(false);
    }
  };

  return <section className="answer-routing-panel" aria-label="版本历史">
    <div className="answer-routing-actions">
      <h3>版本历史</h3>
      <button className="btn" type="button" disabled={pending !== undefined} onClick={() => void load()}>刷新版本</button>
    </div>
    <p className="settings-section-desc">每次改动自动记一版，最多保留最近 {maxAnswerRuleVersions} 版。恢复会生成新版本，旧版仍保留。</p>
    {error && <p className="answer-routing-error" role="alert">{error}</p>}
    {!versions && !error && <p className="settings-section-desc">正在加载版本…</p>}
    {versions?.length === 0 && <p className="settings-section-desc">还没有版本记录。保存一次改动后开始记录。</p>}
    {!!versions?.length && <>
      <div className="answer-rule-diffbar">
        <label>旧版<select aria-label="对比的旧版" value={from ?? ""} onChange={event => { setFromRevision(Number(event.target.value)); setDiff(undefined); }}>
          {versions.map(version => <option key={version.revision} value={version.revision}>第 {version.revision} 版</option>)}
        </select></label>
        <label>新版<select aria-label="对比的新版" value={to ?? ""} onChange={event => { setToRevision(Number(event.target.value)); setDiff(undefined); }}>
          {versions.map(version => <option key={version.revision} value={version.revision}>第 {version.revision} 版</option>)}
        </select></label>
        <button className="btn" type="button" disabled={comparing || from === undefined || to === undefined}
          onClick={() => void runCompare()}>{comparing ? "对比中…" : "对比两版"}</button>
      </div>
      {diff && <div className="answer-rule-diff" role="status">
        <div className="answer-routing-actions">
          <strong>第 {diff.from} 版 → 第 {diff.to} 版</strong>
          <button className="btn" type="button" onClick={() => setDiff(undefined)}>收起对比</button>
        </div>
        {diff.entries.length ? <table>
          <thead><tr><th scope="col">项目</th><th scope="col">第 {diff.from} 版</th><th scope="col">第 {diff.to} 版</th></tr></thead>
          <tbody>{diff.entries.map(entry => <tr key={entry.label}>
            <th scope="row">{entry.label}</th><td>{entry.before}</td><td>{entry.after}</td>
          </tr>)}</tbody>
        </table> : <p className="settings-section-desc">这两版没有差别。</p>}
      </div>}
      <ol className="answer-rule-versions">
        {versions.map(version => {
          const current = version.revision === currentRevision;
          return <li key={version.revision} className="answer-rule-version" data-current={current || undefined}>
            <div className="answer-rule-version-head">
              <strong>第 {version.revision} 版</strong>
              <small>{sourceLabels[version.source]} · {new Date(version.at).toLocaleString()}{current ? " · 当前版本" : ""}
                {version.uses ? ` · ${version.uses} 轮对话用过` : ""}</small>
              <button className="btn" type="button" disabled={current || !!memoryBound || pending !== undefined || !!busy}
                aria-label={`恢复第 ${version.revision} 版`} onClick={() => void restore(version.revision)}>
                {pending === version.revision ? "恢复中…" : "恢复这版"}
              </button>
              <button className="btn" type="button" disabled={pending !== undefined || !!busy}
                aria-label={`${version.note ? "修改" : "添加"}第 ${version.revision} 版备注`}
                onClick={() => setNoteDraft({ revision: version.revision, text: version.note })}>
                {version.note ? "改备注" : "写备注"}
              </button>
            </div>
            {version.note && <p className="answer-rule-version-note">备注：{version.note}</p>}
            {noteDraft?.revision === version.revision && <div className="answer-rule-version-noteform">
              <input aria-label={`第 ${version.revision} 版备注`} value={noteDraft.text} maxLength={120}
                placeholder="例如：对接客户 A 的配置" onChange={event => setNoteDraft({ revision: version.revision, text: event.target.value })} />
              <button className="btn primary" type="button" disabled={pending !== undefined} onClick={() => void saveNote()}>保存备注</button>
              <button className="btn" type="button" disabled={pending !== undefined} onClick={() => setNoteDraft(undefined)}>取消</button>
            </div>}
            <p className="answer-rule-version-change">{version.changes.join("；")}</p>
            <p className="answer-rule-version-summary">{version.summary}</p>
          </li>;
        })}
      </ol>
      {versions[versions.length - 1].revision > 1 && <p className="settings-section-desc">
        第 1 版到第 {versions[versions.length - 1].revision - 1} 版不在列表里，无法从这里恢复。
      </p>}
    </>}
    {!!memoryBound && <p className="settings-section-desc">这条规则的内容来自记忆，只能在记忆里修改；这里只保留版本记录。</p>}
  </section>;
}
