import { useEffect, useState } from "react";
import { answerRuleExamples, matchAnswerRule, newAnswerRule, type AnswerRule, type AnswerRuleDraft, type AnswerRuleUse } from "@shared/answer-routing";
import { useAppStore } from "@/store/appStore";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import "./AnswerRoutingTab.css";

const splitPhrases = (raw: string) => raw.split(/[\n，,]/u).map(s => s.trim()).filter(Boolean);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function AnswerRoutingTab(): React.JSX.Element {
  const [seed, setSeed] = useState(() => useAppStore.getState().answerRuleSeed);
  const projects = useAppStore(s => s.projects);
  const [rules, setRules] = useState<AnswerRule[]>([]);
  const [uses, setUses] = useState<AnswerRuleUse[]>([]);
  const [form, setForm] = useState<AnswerRuleDraft | null>(() => seed ? { ...newAnswerRule(),
    title: seed.title ?? "", instruction: seed.instruction ?? "", sourceMemoryId: seed.memoryId ?? null,
    sourceHash: seed.sourceHash, projectId: seed.projectId ?? null } : null);
  const [editing, setEditing] = useState<AnswerRule>();
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [teaching, setTeaching] = useState(seed?.instruction ?? "");
  const [trial, setTrial] = useState(seed?.question ?? "");
  const [query, setQuery] = useState(seed?.question ?? "");
  const [scope, setScope] = useState<string | null>(seed?.projectId ?? null);
  const [preview, setPreview] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AnswerRule>();
  const [turnUses, setTurnUses] = useState<AnswerRuleUse[]>();
  const api = window.api?.answerRouting;
  const refresh = async () => {
    if (!api) return;
    const [items, recent] = await Promise.all([api.list(), api.history()]);
    setRules(items); setUses(recent);
  };
  useEffect(() => {
    useAppStore.setState({ answerRuleSeed: undefined });
    void refresh().catch(error => setNotice(errorText(error)));
    if (seed?.turn) void api?.history(seed.turn).then(setTurnUses).catch(error => setNotice(errorText(error)));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setNotice("");
    try { await action(); } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  };
  const open = (draft: AnswerRuleDraft, existing?: AnswerRule) => {
    setForm(draft); setEditing(existing); setInclude(draft.include.join("，")); setExclude(draft.exclude.join("，"));
    setSeed(undefined); setTeaching(""); setTrial(""); setNotice("");
  };
  const projectName = (id: string | null) => id ? projects.find(p => p.id === id)?.name ?? id : "全局";
  const options = projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>);
  const update = (patch: Partial<AnswerRuleDraft>) => setForm(old => old ? { ...old, ...patch } : null);
  const trialMatch = form && trial.trim() && matchAnswerRule(trial, form.projectId, [{ ...form, include: splitPhrases(include),
    exclude: splitPhrases(exclude), enabled: true, id: "draft", revision: 0 }]);
  if (!api) return <p role="status">回答调度服务尚未就绪。</p>;

  return <div className="answer-routing">
    <section className="settings-section">
      <h3 className="settings-section-title">回答规则</h3>
      <p className="settings-section-desc">为常问的问题指定做法。项目规则优先，其次采用匹配短语最长的一条。</p>
      <div className="answer-routing-actions">
        <button className="btn primary" disabled={busy} onClick={() => open(newAnswerRule())}>新增规则</button>
        {answerRuleExamples.map(example => <button className="btn" key={example.title} disabled={busy}
          onClick={() => open({ ...example })}>{example.title}示例</button>)}
      </div>
      {rules.map(rule => <div className="answer-routing-row" key={rule.id}>
        <label><input type="checkbox" checked={rule.enabled} disabled={busy} aria-label={`启用${rule.title}`}
          onChange={e => { const enabled = e.target.checked; void run(async () => {
            await api.save({ ...rule, enabled }, rule); setPreview(""); await refresh();
          }); }} /> {rule.title}</label>
        <small>{projectName(rule.projectId)} · v{rule.revision}{rule.sourceNeedsReview ? " · 来源已变化，暂停使用" : ""}</small>
        <button className="btn" disabled={busy} onClick={() => open(rule, rule)}>编辑</button>
        <button className="btn" disabled={busy} onClick={() => setDeleting(rule)}>删除</button>
      </div>)}
    </section>
    {form && <fieldset className="answer-rule-form" disabled={busy}>
      <legend>{editing ? "编辑规则" : "新规则"}</legend>
      {seed?.answer && <details><summary>来自这次回答</summary><p>{seed.question}</p><p>{seed.answer.slice(0, 2500)}</p></details>}
      {seed?.turn && turnUses && <p>{turnUses.length ? turnUses.map(item => `本次采用「${item.title}」· ${item.detail}`).join("\n") : "这次回答没有调度记录。"}</p>}
      {form.sourceMemoryId && <div className="answer-routing-actions"><small>已关联全局记忆。来源变化后需要重新审核。</small>
        <button className="btn" onClick={() => void run(async () => {
          const memory = await window.api?.memory.get(form.sourceMemoryId!);
          if (!memory || memory.status !== "active" || !memory.scopes.some(s => s.scopeType === "global")) throw new Error("来源全局记忆已失效");
          setTeaching(memory.content); update({ instruction: memory.content, sourceHash: memory.contentHash });
        })}>重新载入来源内容</button></div>}
      <label>下次怎么做<textarea value={teaching} maxLength={4000} placeholder="例如：写周报时，只有发布记录确认的才写已上线"
        onChange={e => setTeaching(e.target.value)} /></label>
      <button className="btn" disabled={!teaching.trim()} onClick={() => void run(async () => {
        const suggestion = await api.suggest(teaching, seed?.question, seed?.answer);
        update(suggestion); setInclude(suggestion.include.join("，")); setExclude(suggestion.exclude.join("，"));
      })}>用模型整理成草稿</button>
      <label>规则名称<input value={form.title} maxLength={90} onChange={e => update({ title: e.target.value })} /></label>
      <label>遇到这些短语时使用<input value={include} placeholder="多个短语用逗号分隔" onChange={e => setInclude(e.target.value)} /></label>
      <label>遇到这些短语时跳过<input value={exclude} placeholder="例如：翻译，润色" onChange={e => setExclude(e.target.value)} /></label>
      <label>试问当前草稿<input value={trial} placeholder="换个问法，检查触发条件" onChange={e => setTrial(e.target.value)} />
        {trial.trim() && <small>{trialMatch ? `会采用，匹配“${trialMatch.phrase}”` : "会跳过此草稿"}</small>}</label>
      <label>回答做法<textarea value={form.instruction} maxLength={2000} placeholder="先做什么、证据不足时怎么处理、什么时候可以回答"
        onChange={e => update({ instruction: e.target.value })} /></label>
      <label>适用范围<select value={form.projectId ?? ""} onChange={e => update({ projectId: e.target.value || null })}>
        <option value="">全局</option>{options}</select></label>
      <label>回答前预读的文件（可选）<input value={form.evidenceFile} placeholder="任务目录内的相对路径，如 docs/发布记录.md"
        onChange={e => update({ evidenceFile: e.target.value })} /><small>支持 16 KiB 以内的 UTF-8 文本。资料缺失时会提示模型另行核实。</small></label>
      <div className="answer-routing-actions"><button className="btn primary" disabled={!form.title.trim() || !form.instruction.trim() || !splitPhrases(include).length}
        onClick={() => void run(async () => {
          await api.save({ ...form, include: splitPhrases(include), exclude: splitPhrases(exclude) }, editing);
          setScope(form.projectId); setForm(null); setSeed(undefined); setPreview(""); setNotice("规则已保存"); await refresh();
        })}>保存规则</button>
        <button className="btn" onClick={() => { setForm(null); setSeed(undefined); }}>取消</button></div>
    </fieldset>}
    {notice && <p role="status">{notice}</p>}
    <section className="settings-section">
      <h3 className="settings-section-title">试问</h3>
      <div className="answer-routing-actions"><input aria-label="试问内容" placeholder="输入问题，试用已保存的规则" value={query}
        onChange={e => { setQuery(e.target.value); setPreview(""); }} />
        <select aria-label="试问项目" value={scope ?? ""} onChange={e => { setScope(e.target.value || null); setPreview(""); }}>
          <option value="">无项目</option>{options}</select>
        <button className="btn" disabled={busy || !query.trim()} onClick={() => void run(async () => {
          const result = await api.preview(query, scope);
          setPreview(result ? `${result.rule.title} · 匹配“${result.phrase}”\n${result.rule.instruction}${result.rule.evidenceFile ? "\n将预读 " + result.rule.evidenceFile : ""}` : "没有匹配规则，将按通常方式回答。");
        })}>试问</button></div>
      {preview && <p className="answer-rule-result" role="status">{preview}</p>}
    </section>
    <section className="settings-section"><div className="answer-routing-actions"><h3 className="settings-section-title">最近使用</h3>
      <button className="btn" disabled={busy} onClick={() => void run(refresh)}>刷新</button></div>
      {!uses.length && <p className="settings-section-desc">真实对话采用规则后，记录会出现在这里。</p>}
      {uses.map(use => <div className="answer-routing-row" key={JSON.stringify([use.taskId, use.inputId, use.title, use.revision])}>
        <div><strong>{use.title}</strong> · v{use.revision}<br />{use.detail}<br /><small>{use.taskTitle} · {new Date(use.at).toLocaleString()}</small></div>
        <button className="btn" onClick={() => { const store = useAppStore.getState(); store.setActiveTask(use.taskId); store.setSettingsOpen(false); }}>打开对话</button>
      </div>)}
    </section>
    <ConfirmDialog open={!!deleting} title="删除回答规则" body={`删除“${deleting?.title ?? ""}”和它的使用记录？`}
      danger confirmLabel="删除" onCancel={() => setDeleting(undefined)} onConfirm={() => {
        const target = deleting; setDeleting(undefined);
        if (target) void run(async () => { await api.remove(target.id, target.revision); if (editing?.id === target.id) setForm(null); setPreview(""); await refresh(); });
      }} />
  </div>;
}
