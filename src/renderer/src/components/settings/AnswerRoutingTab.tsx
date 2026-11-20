import { useEffect, useRef, useState } from "react";
import {
  answerRuleExamples, eligibleAnswerEvidenceItem, matchAnswerRule, newAnswerRule,
  type AnswerRule, type AnswerRuleDraft, type AnswerRuleMatch, type AnswerRuleUse,
} from "@shared/answer-routing";
import type { LibraryItemDto } from "@shared/library-ipc";
import { useAppStore } from "@/store/appStore";
import { openAnswerRuleTurn } from "@/lib/openAnswerRuleTurn";
import { libraryCollectionSubtree } from "@/lib/scopedLibrary";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import AnswerRoutingGraph from "@/components/answer-routing/AnswerRoutingGraph";
import AnswerRuleMemoryCheck from "@/components/answer-routing/AnswerRuleMemoryCheck";
import "./AnswerRoutingTab.css";

type Seed = NonNullable<ReturnType<typeof useAppStore.getState>["answerRuleSeed"]>;
type EvidenceMode = "none" | "library" | "task-file";

const splitPhrases = (raw: string) => raw.split(/[\n，,]/u).map(s => s.trim()).filter(Boolean);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const evidenceMode = (rule: AnswerRuleDraft): EvidenceMode =>
  rule.evidenceLibraryItemId ? "library" : rule.evidenceFile ? "task-file" : "none";

const exampleRules = answerRuleExamples.map(rule => ({ ...rule, id: rule.title, revision: 1 }));
function questionPhrase(question: string): string {
  // Keep one literal substring when a pasted prompt has multiple lines or clauses.
  return splitPhrases(question).sort((a, b) => b.length - a.length)[0]?.slice(0, 100).trim() ?? "";
}

function currentTask(taskId?: string) {
  const store = useAppStore.getState();
  return store.tasks.find(task => task.id === (taskId ?? store.activeTaskId));
}

function initialDraft(seed?: Seed): AnswerRuleDraft {
  const store = useAppStore.getState();
  const projectId = store.page === "projects" ? store.activeProjectId : currentTask()?.projectId;
  return {
    ...newAnswerRule(),
    title: seed?.title?.slice(0, 90) ?? "",
    instruction: seed?.instruction?.slice(0, 2000) ?? "",
    projectId: seed?.turn ? seed.projectId ?? null : seed?.projectId ?? projectId ?? null,
  };
}

function explicitTaskPath(text: string): string {
  const paths = [...text.matchAll(/(?:^|[\s"'\x60“”‘’「《：:(（])((?:[\p{L}\p{N}_-]+[\\/])+[\p{L}\p{N}_.-]+\.(?:md|txt|csv|json|tsv|log|ya?ml)|[a-z\d_.-]+\.(?:md|txt|csv|json|tsv|log|ya?ml))(?=$|[\s"'\x60“”‘’」》，。；,;：:)）])/giu)]
    .map(match => match[1].replaceAll("\\", "/"));
  const quoted = [...text.matchAll(/["'\x60“‘「《]([\p{L}\p{N}_ .-]+\.(?:md|txt|csv|json|tsv|log|ya?ml))["'\x60”’」》]/giu)].map(match => match[1]);
  const adjacent = [...text.matchAll(/(?<=\p{Script=Han})([a-z\d][a-z\d_.-]*\.(?:md|txt|csv|json|tsv|log|ya?ml))(?=$|[\p{Script=Han}\s"'\x60“”‘’」》，。；,;：:)）])/giu)].map(match => match[1]);
  const unique = [...new Set([...paths, ...quoted, ...adjacent])];
  return unique.length === 1 ? unique[0] : "";
}

function requestedReadPath(instruction: string): string {
  const file = explicitTaskPath(instruction);
  if (!file) return "";
  const beforeFile = instruction.replaceAll("\\", "/").split(file)[0];
  const action = beforeFile.split(/[，。；;！？\n]/u).at(-1) ?? "";
  return /^\s*(?:(?:请|先|优先|回答前|务必)\s*)*(?:读取|读|查阅|查看|核对|检查|参考)\s*(?:任务目录(?:中|里)?的?\s*)?["'“‘「《`]?\s*$/u.test(action) ? file : "";
}

function taskRelativePath(root: string, filePath: string): string | undefined {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedPath = filePath.replaceAll("\\", "/");
  const windows = /^(?:[a-z]:|\/\/)/iu.test(normalizedRoot);
  const compare = (path: string) => windows ? path.toLowerCase() : path;
  const result = normalizedPath.slice(normalizedRoot.length + 1);
  return compare(normalizedPath).startsWith(compare(normalizedRoot) + "/") && result ? result : undefined;
}

function selectionReason(match: AnswerRuleMatch): string {
  const runnerUp = match.candidates?.find(candidate => candidate.ruleId !== match.rule.id);
  if (!runnerUp) return "只有这条规则符合条件";
  if (match.rule.projectId !== runnerUp.projectId) return "项目规则优先于全局规则";
  if (match.phrase.length !== runnerUp.phrase.length) return "在同一范围内采用较长的匹配短语";
  return "范围和短语长度相同，按规则固定顺序选用";
}

function lastUseLabel(use?: AnswerRuleUse): string {
  if (!use) return "暂无最近记录";
  switch (use.evidence?.status) {
    case "read": return "上次已预读";
    case "skipped": return "上次跳过预读";
    case "not-found": return "上次找不到资料";
    case "denied": return "上次读取被拒绝";
    case "failed": return "上次读取失败";
    case "revoked": return "上次读取授权已撤销";
    default: return "上次已采用";
  }
}

export type TeachingResult = { message: string; review?: boolean };

export default function AnswerRoutingTab({ finishTeaching }: { finishTeaching?: (result?: TeachingResult) => void }): React.JSX.Element {
  const [seed, setSeed] = useState(() => useAppStore.getState().answerRuleSeed);
  const projects = useAppStore(s => s.projects);
  const [rules, setRules] = useState<AnswerRule[]>([]);
  const [uses, setUses] = useState<AnswerRuleUse[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [form, setForm] = useState<AnswerRuleDraft | null>(() => seed ? initialDraft(seed) : null);
  const [editing, setEditing] = useState<AnswerRule>();
  const [include, setInclude] = useState<string>();
  const [exclude, setExclude] = useState<string>();
  const [positiveExample, setPositiveExample] = useState(seed?.question?.trim() ?? "");
  const [negativeTrial, setNegativeTrial] = useState<string>();
  const [query, setQuery] = useState(seed?.question ?? "");
  const [scope, setScope] = useState(() => initialDraft(seed).projectId);
  const [preview, setPreview] = useState<{ input: string; match: AnswerRuleMatch | null }>();
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingTurn, setLoadingTurn] = useState(!!finishTeaching);
  const [optionsOpen, setOptionsOpen] = useState(!finishTeaching);
  const instructionInput = useRef<HTMLTextAreaElement>(null);
  const [deleting, setDeleting] = useState<AnswerRule>();
  const [mode, setMode] = useState<EvidenceMode>("none");
  const [evidenceChosen, setEvidenceChosen] = useState(false);
  const [documents, setDocuments] = useState<LibraryItemDto[]>([]);
  const [documentNames, setDocumentNames] = useState<Record<string, string>>({});
  const [documentsStatus, setDocumentsStatus] = useState("");
  const api = window.api?.answerRouting;
  const selected = rules.find(rule => rule.id === selectedId) ?? rules[0];
  const formProject = form ? form.projectId : selected?.projectId;
  const contextTask = currentTask(seed?.turn?.taskId);
  const root = contextTask?.cwd;

  useEffect(() => {
    if (finishTeaching && !loadingTurn) instructionInput.current?.focus();
  }, [loadingTurn]);

  const refresh = async () => {
    if (!api) return;
    const [items, recent] = await Promise.all([api.list(), api.history()]);
    setRules(items);
    setUses(recent);
    setLoaded(true);
  };

  useEffect(() => {
    if (finishTeaching && seed?.turn && api) {
      let active = true;
      void api.history(seed.turn).then(async ([use]) => {
        if (!active || !use?.ruleId || use.routeStatus === "revoked" || !seed.question) return;
        const rule = (await api.preview(seed.question, seed.projectId ?? null))?.rule;
        if (!active || !rule || rule.id !== use.ruleId || rule.revision !== use.revision || rule.projectId !== (seed.projectId ?? null)) return;
        setForm(rule);
        setEditing(rule);
        setInclude(rule.include.join("，"));
        setExclude(rule.exclude.join("，"));
        setMode(evidenceMode(rule));
      }).catch(() => { if (active) setNotice("暂时无法读取本轮原规则，可将做法保存为新规则。"); })
        .finally(() => { if (active) setLoadingTurn(false); });
      return () => { active = false; };
    }
    useAppStore.setState({ answerRuleSeed: undefined });
    void refresh().catch(error => setFailure(errorText(error)));
  }, []);

  useEffect(() => {
    if (finishTeaching && !optionsOpen && mode !== "library") return;
    if (!form && !rules.some(rule => rule.evidenceLibraryItemId)) return;
    const library = window.api?.library;
    if (!library) {
      setDocumentsStatus("资料库尚未就绪");
      return;
    }
    let alive = true;
    setDocuments([]);
    setDocumentsStatus("正在加载资料…");
    const projectId = formProject ?? null;
    const sameProject = contextTask && (contextTask.projectId ?? null) === projectId;
    void Promise.all([
      library.snapshot(),
      projectId ? window.api?.db.listProjectPins(projectId) : undefined,
      sameProject ? library.listTaskReferences(contextTask.id) : undefined,
      sameProject && contextTask.spaceId ? window.api?.workspace.libraryBindings.list(contextTask.spaceId) : undefined,
    ]).then(([snapshot, pins, references, bindings]) => {
      if (!alive) return;
      if (references && !references.ok) throw new Error(references.error);
      const projectSpaces = new Set(snapshot.spaces.filter(space => projectId && space.projectId === projectId).map(space => space.id));
      const allowedSpaces = new Set(snapshot.spaces.filter(space => !space.projectId || space.projectId === projectId).map(space => space.id));
      const boundCollections = new Set<string>();
      for (const binding of [...(bindings?.owned ?? []), ...(bindings?.direct ?? []), ...(bindings?.inherited ?? [])]) {
        if (!allowedSpaces.has(binding.librarySpaceId)) continue;
        if (binding.targetType === "space") projectSpaces.add(binding.librarySpaceId);
        else if (binding.collectionId) {
          for (const id of libraryCollectionSubtree(snapshot.collections, binding.collectionId)) boundCollections.add(id);
        }
      }
      const explicitIds = new Set([
        ...(pins ?? []).map(pin => pin.itemId),
        ...(references?.value.items ?? []).map(item => item.id),
      ]);
      setDocuments(snapshot.items.filter(item => eligibleAnswerEvidenceItem(item) &&
        (projectSpaces.has(item.spaceId) || explicitIds.has(item.id) || !!item.collectionId && boundCollections.has(item.collectionId))));
      setDocumentNames(Object.fromEntries(snapshot.items.map(item => [item.id, item.title])));
      setDocumentsStatus("");
    }).catch(error => {
      if (alive) setDocumentsStatus(`资料加载失败：${errorText(error)}`);
    });
    return () => { alive = false; };
  }, [!!form, formProject, contextTask?.id, contextTask?.spaceId, rules, optionsOpen, mode === "library"]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    setFailure("");
    try { await action(); } catch (error) { setFailure(errorText(error)); }
    finally { setBusy(false); }
  };

  const open = (draft: AnswerRuleDraft, existing?: AnswerRule) => {
    setForm(draft);
    setEditing(existing);
    setInclude(draft.include.length ? draft.include.join("，") : undefined);
    setExclude(draft.include.length ? draft.exclude.join("，") : undefined);
    setMode(evidenceMode(draft));
    setEvidenceChosen(false);
    setSeed(undefined);
    setPositiveExample(draft.include[0] ?? "");
    setNegativeTrial(undefined);
    setNotice("");
    setFailure("");
  };

  const projectName = (id: string | null) => id ? projects.find(p => p.id === id)?.name ?? id : "全局";
  const options = projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>);
  const update = (patch: Partial<AnswerRuleDraft>) => setForm(old => {
    if (!old) return null;
    const next = { ...old, ...patch };
    if (old.sourcePrefixLength && !("sourcePrefixLength" in patch) &&
        (old.sourceMemoryId !== next.sourceMemoryId || !next.instruction.startsWith(old.instruction.slice(0, old.sourcePrefixLength) + "\n"))) {
      delete next.sourcePrefixLength;
    }
    return next;
  });
  const example = matchAnswerRule(positiveExample, null, exampleRules)?.rule;
  const literal = questionPhrase(positiveExample);
  const triggerPhrases = include === undefined ? example?.include ?? (literal ? [literal] : []) : splitPhrases(include);
  const excludedPhrases = exclude === undefined ? example?.exclude ?? [] : splitPhrases(exclude);
  const title = form?.title.trim() || example?.title || (positiveExample.trim() || triggerPhrases[0] || "").slice(0, 90);
  const negativeExample = negativeTrial ?? (excludedPhrases[0] && positiveExample.trim()
    ? `${excludedPhrases[0]}：${positiveExample}` : "");
  const draftMatches = (query: string, include = triggerPhrases, exclude = excludedPhrases) => form && query.trim() ? matchAnswerRule(query, form.projectId, [{
    ...form, include, exclude, enabled: true, id: "draft", revision: 0,
  }]) : null;
  const positiveMatch = draftMatches(positiveExample);
  const negativeMatch = draftMatches(negativeExample);
  const positiveConflict = !!positiveExample.trim() && !positiveMatch;
  const excludedBy = positiveConflict && literal
    ? excludedPhrases.filter(term => !draftMatches(positiveExample, [literal], [term])) : [];
  const negativePhrase = questionPhrase(negativeExample);
  const suggestedFile = !evidenceChosen && mode === "none" && form && form.instruction !== editing?.instruction
    ? requestedReadPath(form.instruction) : "";
  const file = form?.evidenceFile || suggestedFile;
  const effectiveMode = suggestedFile ? "task-file" : mode;
  const missing = !positiveExample.trim() || !triggerPhrases.length ? "写一句希望使用这条规则的问题。" : !form?.instruction.trim() ? "写下希望下次采用的做法。"
    : triggerPhrases.length > 24 || excludedPhrases.length > 24 || [...triggerPhrases, ...excludedPhrases].some(p => p.length > 100)
      ? "展开匹配问法，每组最多 24 个短语，每个最多 100 字。"
    : positiveConflict || negativeMatch ? "请先解决下方的问法冲突。"
    : effectiveMode === "library" && !form.evidenceLibraryItemId ? "请选择要读取的资料。"
    : effectiveMode === "task-file" && !file.trim() ? "请选择或填写要读取的文件。" : "";
  const selectedUses = selected ? uses.filter(use => use.ruleId === selected.id) : [];
  const Options = finishTeaching ? "details" : "div";
  const knownDocument = (id: string) => documentNames[id] ?? (documentsStatus || "资料不可用");

  if (!api) return <p role="status">回答调度服务尚未就绪。</p>;

  return <div className="answer-routing">
    {!form && <div className="answer-routing-heading">
      <div>
        <h3 className="settings-section-title">回答规则</h3>
        <p className="settings-section-desc">指定常问问题的处理方式。项目规则优先，同一范围内优先采用更长的匹配短语。</p>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => open(initialDraft())}>新增规则</button>
    </div>}
    {!form && failure && <p className="answer-routing-error" role="alert">{failure}</p>}
    {!form && notice && <p role="status">{notice}</p>}
    <div className={form ? "answer-routing-editor-layout" : "answer-routing-layout"}>
      {!form && <nav className="answer-routing-list" aria-label="规则列表">
        {!loaded && !failure && <p role="status">正在加载规则…</p>}
        {!loaded && failure && <button className="btn" disabled={busy} onClick={() => void run(refresh)}>重新加载</button>}
        {loaded && !rules.length && <p>还没有规则。可以在这里新增，也可以点击回答下方的星光图标创建。</p>}
        {rules.map(rule => {
          const lastUse = uses.find(use => use.ruleId === rule.id);
          const phrases = rule.include.slice(0, 2).join("、");
          const firstAction = rule.evidenceLibraryItemId ? `预读 ${knownDocument(rule.evidenceLibraryItemId)}`
            : rule.evidenceFile ? `预读 ${rule.evidenceFile}` : "提供回答做法";
          return <button key={rule.id} type="button" disabled={busy} aria-label={rule.title}
            aria-current={!form && rule.id === selected?.id ? "true" : undefined}
            className="answer-routing-rule" onClick={() => {
              setSelectedId(rule.id); setScope(rule.projectId); setForm(null); setSeed(undefined); setPreview(undefined);
            }}>
            <strong>{rule.title}</strong>
            <small>{projectName(rule.projectId)} · {rule.enabled ? rule.sourceNeedsReview ? "待审核" : "已启用" : "已停用"}</small>
            <small className="answer-routing-rule-summary" title={rule.include.join("、")}>{phrases}</small>
            <small className="answer-routing-rule-summary" title={firstAction}>{firstAction}</small>
            <small title={lastUse?.detail}>{lastUseLabel(lastUse)}</small>
          </button>;
        })}
      </nav>}
      <div className="answer-routing-detail">
        {form ? <fieldset className="answer-rule-form" aria-busy={busy} disabled={busy || loadingTurn}>
          <legend>{editing && finishTeaching ? `调整「${editing.title}」` : editing ? "编辑回答规则" : seed?.turn ? "教它下次怎么答" : "创建回答规则"}</legend>
          <label>遇到什么问题<input aria-label="遇到什么问题" value={positiveExample} onChange={e => setPositiveExample(e.target.value)}
            placeholder="例如：今天天气怎么样" /></label>
          <label>下次怎么做<textarea ref={instructionInput} id="answer-rule-instruction" aria-label="下次怎么做" value={form.instruction} maxLength={2000}
            autoFocus={!!seed?.turn} placeholder="写下你希望它采用的做法"
            onChange={e => update({ instruction: e.target.value })} /></label>
            <AnswerRuleMemoryCheck key={JSON.stringify([editing?.id, form.sourceMemoryId, title, triggerPhrases, excludedPhrases, form.instruction, form.projectId])}
              draft={{ title, instruction: form.instruction, include: triggerPhrases, exclude: excludedPhrases }}
              api={api} onDistill={proposal => {
                update({ instruction: proposal.instruction, evidenceFile: file, sourceMemoryId: null, sourceHash: undefined, sourcePrefixLength: undefined });
                setMode(effectiveMode);
                setEvidenceChosen(true);
                if (proposal.include.length) setInclude(proposal.include.join("，"));
                setExclude(proposal.exclude.join("，"));
                setNotice("提炼稿已填入，保存后生效。");
              }} onUse={memory => {
                update({ sourceMemoryId: memory.memoryId, sourceHash: memory.sourceHash,
                  sourcePrefixLength: memory.additionalInstruction ? memory.content.length : undefined,
                  instruction: memory.additionalInstruction ? memory.content + "\n" + memory.additionalInstruction : memory.content });
                setNotice(`草稿已引用「${memory.title}」。保存后生效。`);
              }} />
          {seed?.answer && <details className="answer-rule-original"><summary>查看原回答</summary><p>{seed.answer.slice(0, 2500)}</p></details>}
          <Options className="answer-rule-config" onToggle={event => {
            if (event.target === event.currentTarget && event.currentTarget instanceof HTMLDetailsElement) setOptionsOpen(event.currentTarget.open);
          }}>
            {finishTeaching && <summary>规则选项<small>{projectName(form.projectId)} · {file ? `先读 ${file}` :
              form.evidenceLibraryItemId ? `先读 ${knownDocument(form.evidenceLibraryItemId)}` : positiveMatch ? `匹配「${positiveMatch.phrase}」` : "匹配问法与资料"}</small></summary>}
            <div className="answer-rule-config-body">
              {seed?.memoryId && (!form.sourceMemoryId || form.sourceMemoryId === seed.memoryId) ? <label>与来源记忆的关系
                <select value={form.sourceMemoryId ? "linked" : "independent"} onChange={e => update(e.target.value === "linked"
                  ? { sourceMemoryId: seed.memoryId!, sourceHash: seed.sourceHash } : { sourceMemoryId: null, sourceHash: undefined })}>
                  <option value="independent">独立规则</option><option value="linked">关联来源记忆</option>
                </select>
                <small>{form.sourceMemoryId ? "来源改动后需重新审核。来源删除时会移除此规则。" : "以这条记忆为草稿起点。以后修改或删除记忆，规则照常使用。"}</small>
              </label> : form.sourceMemoryId && <div className="answer-routing-actions">
                <small>关联来源记忆。来源改动后需重新审核，删除来源会移除此规则。</small>
                <button className="btn" onClick={() => void run(async () => {
                  const memory = await window.api?.memory.get(form.sourceMemoryId!);
                  if (!memory || memory.status !== "active" || !memory.scopes.some(s => s.scopeType === "global")) throw new Error("来源全局记忆已失效");
                  const extra = form.sourcePrefixLength ? form.instruction.slice(form.sourcePrefixLength) : "";
                  const instruction = memory.content + extra;
                  if (instruction.length > 2000) throw new Error("来源原文与额外做法超过 2000 字，请调整后再引用。");
                  update({ instruction, sourceHash: memory.contentHash, sourcePrefixLength: extra ? memory.content.length : undefined });
                  setNotice("已重新载入来源，请检查回答做法后保存");
                })}>重新载入来源内容</button>
                <button className="btn" onClick={() => update({ sourceMemoryId: null, sourceHash: undefined })}>改为独立规则</button>
              </div>}
              <details className="answer-rule-options">
                <summary>匹配问法与例外{positiveMatch && <small>含「{positiveMatch.phrase}」{triggerPhrases.length > 1 ? "等" : ""}</small>}</summary>
                <div className="answer-rule-options-body">
                  <label>规则名称<input value={form.title} placeholder={title || "默认使用问题作为名称"} maxLength={90} onChange={e => update({ title: e.target.value })} /></label>
                  <label>遇到这些短语时使用<input id="answer-rule-include" value={include ?? triggerPhrases.join("，")} placeholder="多个短语用逗号分隔" onChange={e => setInclude(e.target.value)} /></label>
                  <label>遇到这些短语时跳过<input id="answer-rule-exclude" value={exclude ?? excludedPhrases.join("，")} placeholder="例如：翻译，润色" onChange={e => setExclude(e.target.value)} /></label>
                  <button className="btn" disabled={!form.instruction.trim()} onClick={() => void run(async () => {
                    const teaching = form.instruction;
                    const suggestion = await api.suggest(teaching, positiveExample, seed?.answer);
                    update(suggestion);
                    setInclude(suggestion.include.join("，"));
                    setExclude(suggestion.exclude.join("，"));
                    if (mode === "none" && !evidenceChosen) {
                      const supplied = teaching.trim();
                      const named = documents.filter(item => {
                        if (item.filename && [supplied, seed?.question].some(text => text?.includes(item.filename))) return true;
                        return item.title && [`「${item.title}」`, `“${item.title}”`, `"${item.title}"`].some(name => supplied.includes(name));
                      });
                      const attachedPaths = root ? [...new Set((seed?.evidencePaths ?? [])
                        .map(path => taskRelativePath(root, path))
                        .filter((path): path is string => !!path && /\.(?:md|txt|csv|json|tsv|log|ya?ml)$/iu.test(path)))] : [];
                      const file = explicitTaskPath(supplied) || explicitTaskPath(seed?.question ?? "") ||
                        (attachedPaths.length === 1 ? attachedPaths[0] : "");
                      if (file?.includes("/")) {
                        setMode("task-file");
                        update({ evidenceFile: file });
                      } else if (named.length === 1) {
                        setMode("library");
                        update({ evidenceLibraryItemId: named[0].id });
                      } else if (file && !named.length) {
                        setMode("task-file");
                        update({ evidenceFile: file });
                      }
                    }
                    setNotice("草稿已整理，请检查触发条件、资料和回答做法");
                  })}>用模型整理成草稿</button>
                  <label>用一句话测试例外<input value={negativeExample} placeholder="例如：帮我翻译这份天气预报"
                    onChange={e => setNegativeTrial(e.target.value)} />
                    {negativeExample.trim() && !negativeMatch && <small>这句会跳过。</small>}
                  </label>
                </div>
              </details>
              <div className="answer-rule-scope">
                <label>适用范围<select value={form.projectId ?? ""} onChange={e => {
                  const projectId = e.target.value || null;
                  if (finishTeaching && editing && projectId !== editing.projectId) setEditing(undefined);
                  if (mode === "library") setDocuments([]);
                  update({ projectId, ...(mode === "library" ? { evidenceLibraryItemId: null } : {}) });
                }}>
                  <option value="">全局</option>{options}
                </select></label>
                <label>回答前读什么<select value={effectiveMode} onChange={e => {
                  setMode(e.target.value as EvidenceMode);
                  setEvidenceChosen(true);
                  update({ evidenceFile: "", evidenceLibraryItemId: null, evidenceFailure: e.target.value === "none" ? undefined : form.evidenceFailure });
                }}>
                  <option value="none">无需预读资料</option><option value="library">项目资料库、绑定资料或当前对话附件</option>
                  <option value="task-file">当前任务目录里的文件</option>
                </select></label>
              </div>
              {effectiveMode === "library" && <label>选择资料<select value={form.evidenceLibraryItemId ?? ""} onChange={e => update({ evidenceLibraryItemId: e.target.value || null })}>
                <option value="">请选择文本资料</option>
                {form.evidenceLibraryItemId && !documents.some(item => item.id === form.evidenceLibraryItemId) &&
                  <option value={form.evidenceLibraryItemId}>{knownDocument(form.evidenceLibraryItemId)}</option>}
                {documents.map(item => <option key={item.id} value={item.id}>{item.title} · {item.filename}</option>)}
              </select><small>{documentsStatus || (documents.length
                ? "以后每次使用时，只会读取那轮对话能够访问的资料。"
                : "找不到可选文本。可以先将资料存入项目资料库，或附加到当前对话。")}</small></label>}
              {effectiveMode === "task-file" && <div className="answer-rule-field">
                <label htmlFor="answer-rule-file">回答前预读的文件</label>
                <div className="answer-routing-actions">
                  <input id="answer-rule-file" aria-label="任务目录相对路径" value={file}
                    placeholder="例如 docs/发布记录.md" maxLength={300} onChange={e => { setMode("task-file"); setEvidenceChosen(true); update({ evidenceFile: e.target.value }); }} />
                  {root && <button className="btn" onClick={() => void run(async () => {
                    const chosen = await window.api?.pickLocalFile();
                    if (!chosen) return;
                    const relative = taskRelativePath(root, chosen.path);
                    if (!relative) throw new Error("请选择当前任务目录中的文件");
                    setMode("task-file"); setEvidenceChosen(true); update({ evidenceFile: relative });
                  })}>选择文件</button>}
                </div>
                <small>每轮从自己的任务目录找这个相对路径。支持 16 KiB 以内的 UTF-8 文本。</small>
              </div>}
              {effectiveMode !== "none" && <label>读不到资料时<select value={form.evidenceFailure ?? "verify"}
                onChange={e => update({ evidenceFailure: e.target.value as AnswerRuleDraft["evidenceFailure"] })}>
                <option value="verify">用其他获准来源核实，再标注待核实</option>
                <option value="mark-unverified">直接标注待核实</option>
              </select></label>}
            </div>
          </Options>
          {positiveConflict && <div className="answer-rule-repair" role="status">
            {positiveExample.trimStart().startsWith("/") ? "以 / 开头的是命令，请换一句日常提问。" : !literal ? "请在问题里写入可以匹配的文字。" : <>
              <span>{excludedBy.length ? `这句被例外「${excludedBy.join("、")}」跳过。` : "这句还没有匹配到触发短语。"}</span>
              <button type="button" className="btn" onClick={() => {
                setInclude([...new Set([...triggerPhrases, literal])].join("，"));
                setExclude(excludedPhrases.filter(term => !excludedBy.includes(term)).join("，"));
              }}>{excludedBy.length ? "移除这些例外并匹配这句" : "把这句加入匹配问法"}</button>
            </>}
          </div>}
          {negativeMatch && <div className="answer-rule-repair" role="status">
            <span>例外「{negativeExample}」也包含触发短语「{negativeMatch.phrase}」。</span>
            {!negativePhrase || !draftMatches(positiveExample, [literal], [negativePhrase]) ? <span>请换一个能与原问题区分的例子。</span>
              : <button type="button" className="btn" onClick={() => setExclude(
                [...new Set([...excludedPhrases, negativePhrase])].join("，"))}>把这句设为例外</button>}
          </div>}
          {failure && <p className="answer-routing-error" role="alert">{failure}</p>}
          {notice && <p role="status">{notice}</p>}
          <div className="answer-routing-actions answer-rule-save">
            <button className="btn primary" disabled={!!missing}
              onClick={() => void run(async () => {
                const saved = await api.save({ ...form, title, include: triggerPhrases, exclude: excludedPhrases, evidenceFile: file }, editing);
                if (finishTeaching && seed?.turn) {
                  let result: TeachingResult;
                  try {
                    const match = await api.preview(positiveExample, seed.projectId ?? null);
                    result = match?.rule.id === saved.id ? {message: `已保存「${saved.title}」。下次这样问就会使用。`}
                      : {message: match ? `规则已保存。这句会优先使用「${match.rule.title}」。` : "规则已保存，当前对话未匹配到它。", review: true};
                  } catch { result = {message: "规则已保存，暂时无法确认这句会使用哪条规则。", review: true}; }
                  finishTeaching(result);
                  return;
                }
                setSelectedId(saved.id);
                setScope(saved.projectId);
                setForm(null);
                setSeed(undefined);
                setPreview(undefined);
                setNotice("规则已保存");
                await refresh();
              })}>{seed?.turn ? editing ? "更新规则并返回对话" : "保存并返回对话" : "保存规则"}</button>
            <button className="btn" onClick={() => {
              if (finishTeaching) finishTeaching();
              else { setForm(null); setSeed(undefined); setNotice(""); setFailure(""); }
            }}>取消</button>
            {missing && !positiveConflict && !negativeMatch && <small role="status">{missing}</small>}
          </div>
        </fieldset> : selected ? <>
          <section className="answer-routing-panel" aria-label="规则详情">
            <div className="answer-routing-actions">
              <h3>{selected.title}</h3>
              <button className="btn" disabled={busy} onClick={() => open(selected, selected)}>编辑</button>
              <button className="btn" disabled={busy || (!selected.enabled && selected.sourceNeedsReview)} onClick={() => void run(async () => {
                await api.save({ ...selected, enabled: !selected.enabled }, selected);
                setPreview(undefined);
                await refresh();
              })}>{selected.enabled ? "停用" : "启用"}</button>
              <button className="btn" disabled={busy} onClick={() => setDeleting(selected)}>删除</button>
            </div>
            <p className="answer-routing-meta">{projectName(selected.projectId)} · 第 {selected.revision} 版 · {selected.enabled ? "已启用" : "已停用"}</p>
            {selected.sourceNeedsReview && <p className="answer-routing-error">来源记忆已变化。编辑并重新载入来源后即可恢复使用。</p>}
            <dl className="answer-routing-properties">
              <dt>触发短语</dt><dd>{selected.include.join("、")}</dd>
              <dt>跳过短语</dt><dd>{selected.exclude.join("、") || "无"}</dd>
              <dt>回答做法</dt><dd>{selected.instruction}</dd>
              <dt>预读资料</dt><dd>{selected.evidenceLibraryItemId ? knownDocument(selected.evidenceLibraryItemId) : selected.evidenceFile || "无"}</dd>
              {evidenceMode(selected) !== "none" && <><dt>读不到资料</dt>
                <dd>{selected.evidenceFailure === "mark-unverified" ? "直接标注待核实" : "用其他获准来源核实，证据不足时标注待核实"}</dd></>}
            </dl>
            <AnswerRoutingGraph key={selected.id} rule={selected}
              evidenceLabel={selected.evidenceLibraryItemId ? knownDocument(selected.evidenceLibraryItemId) : undefined} preview={preview && {
              input: preview.input, matched: preview.match?.rule.id === selected.id,
              phrase: preview.match?.rule.id === selected.id ? preview.match.phrase : undefined,
              details: preview.match?.rule.id === selected.id ? [selectionReason(preview.match)] :
                [preview.match ? `采用另一条规则「${preview.match.rule.title}」` : "没有匹配规则"],
            }} />
          </section>
          <section className="answer-routing-panel" aria-label="最近使用">
            <div className="answer-routing-actions"><h3>最近使用</h3>
              <button className="btn" disabled={busy} onClick={() => void run(refresh)}>刷新</button></div>
            {!selectedUses.length && <p className="settings-section-desc">暂无这条规则的最近使用记录。</p>}
            {selectedUses.map(use => <div className="answer-routing-row" key={JSON.stringify([use.taskId, use.inputId, use.revision])}>
              <div>{use.detail}<br /><small>{use.taskTitle} · 第 {use.revision} 版 · {new Date(use.at).toLocaleString()}</small></div>
              <button className="btn" data-routing-input={use.inputId} onClick={() => openAnswerRuleTurn(use)}>查看这轮回答</button>
            </div>)}
          </section>
        </> : loaded && <section className="answer-routing-panel" aria-label="规则示例">
          <h3>从示例开始</h3>
          <div className="answer-routing-actions">
            {answerRuleExamples.map(({ chooseSource, ...example }) => <button className="btn" key={example.title} disabled={busy}
              onClick={() => {
                open({ ...example, projectId: initialDraft().projectId });
                if (chooseSource) {
                  setMode("task-file");
                  setNotice("请选择这条规则要核对的发布记录。");
                }
              }}>{example.title}示例</button>)}
          </div>
        </section>}
        {!form && !!rules.length && <section className="answer-routing-panel" aria-label="测试匹配">
          <h3>测试匹配</h3>
          <p className="settings-section-desc">检查已保存的规则会采用哪条。这一步只检查匹配。</p>
          <div className="answer-routing-actions">
            <input aria-label="测试匹配的问题" placeholder="输入问题" value={query} disabled={busy}
              onChange={e => { setQuery(e.target.value); setPreview(undefined); }} />
            <select aria-label="测试匹配的项目" value={scope ?? ""} disabled={busy}
              onChange={e => { setScope(e.target.value || null); setPreview(undefined); }}>
              <option value="">无项目</option>{options}
            </select>
            <button className="btn" disabled={busy || !query.trim()} onClick={() => void run(async () => {
              const match = await api.preview(query, scope);
              setPreview({ input: query, match });
              if (match && !form) setSelectedId(match.rule.id);
            })}>测试匹配</button>
          </div>
          {preview && <div className="answer-rule-result" role="status">{preview.match ? <>
            <strong>{preview.match.rule.title} · 匹配“{preview.match.phrase}”</strong>
            <p>{selectionReason(preview.match)}</p>
            {!!preview.match.candidates && preview.match.candidates.length > 1 && <ul className="answer-routing-candidates">
              {preview.match.candidates.map(candidate => <li key={candidate.ruleId}>
                {candidate.title} · {projectName(candidate.projectId)} · “{candidate.phrase}”
                {candidate.ruleId === preview.match?.rule.id && "（采用）"}
              </li>)}
            </ul>}
            <p>{preview.match.rule.instruction}</p>
            {preview.match.rule.evidenceFile && <small>预读 {preview.match.rule.evidenceFile}</small>}
            {preview.match.rule.evidenceLibraryItemId && <small>预读 {knownDocument(preview.match.rule.evidenceLibraryItemId)}</small>}
          </> : "没有匹配规则，将按通常方式回答。"}</div>}
        </section>}
      </div>
    </div>
    <ConfirmDialog open={!!deleting} title="删除回答规则" body={`删除“${deleting?.title ?? ""}”？已有回答里的使用记录会保留。`}
      danger confirmLabel="删除" onCancel={() => setDeleting(undefined)} onConfirm={() => {
        const target = deleting;
        setDeleting(undefined);
        if (target) void run(async () => {
          await api.remove(target.id, target.revision);
          setSelectedId(undefined);
          setPreview(undefined);
          await refresh();
        });
      }} />
  </div>;
}
