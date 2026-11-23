import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { routingFlowLimits as limits, type AnswerFlowBranch, type AnswerFlowCheck, type AnswerRoutingFlow } from "@shared/answer-routing-flow";
import type { AnswerRule } from "@shared/answer-routing";
import "./AnswerRoutingFlowEditor.css";

const emptyFlow: AnswerRoutingFlow = { enabled: false, branches: [] };
const newCheck = (): AnswerFlowCheck => ({ id: crypto.randomUUID(), operator: "any", phrases: [""] });

type NodeLocation = { branchId: string; checkId?: string };
type Drag = { location: NodeLocation; pointer: number; startY: number };

function move<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

function validFlow(flow: AnswerRoutingFlow) {
  return (!flow.enabled || flow.branches.length > 0) && flow.branches.every(branch =>
    branch.title.trim() && (branch.ruleId || branch.routeMode) && branch.checks.length > 0
    && branch.checks.every(check => check.phrases.some(phrase => phrase.trim())));
}

export default function AnswerRoutingFlowEditor({ saved, rules, busy, onSave }: {
  saved?: AnswerRoutingFlow;
  rules: readonly AnswerRule[];
  busy: boolean;
  onSave: (flow: AnswerRoutingFlow) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<{ flow: AnswerRoutingFlow; base?: AnswerRoutingFlow }>();
  const [announcement, setAnnouncement] = useState("");
  const [dropId, setDropId] = useState<string>();
  const drag = useRef<Drag | undefined>(undefined);
  const focus = useRef<string | undefined>(undefined);
  const root = useRef<HTMLFieldSetElement>(null);
  const flow = draft?.flow ?? saved ?? emptyFlow;
  const branches = flow.branches;
  const baseChanged = !!draft && JSON.stringify(draft.base) !== JSON.stringify(saved);
  const edit = (next: AnswerRoutingFlow) => setDraft(previous => ({ flow: next, base: previous ? previous.base : saved }));

  useLayoutEffect(() => {
    if (focus.current) root.current?.querySelector<HTMLElement>(`[data-flow-focus="${CSS.escape(focus.current)}"]`)?.focus();
    focus.current = undefined;
  });

  const setBranches = (next: AnswerFlowBranch[]) => edit({ ...flow, branches: next });
  const patchBranch = (index: number, patch: Partial<AnswerFlowBranch>) =>
    setBranches(branches.map((branch, i) => i === index ? { ...branch, ...patch } : branch));
  const patchCheck = (branch: number, index: number, patch: Partial<AnswerFlowCheck>) =>
    patchBranch(branch, { checks: branches[branch].checks.map((check, i) => i === index ? { ...check, ...patch } : check) });

  const moveBranch = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= branches.length) return;
    focus.current = branches[from].id;
    setBranches(move(branches, from, to));
    setAnnouncement(`${branches[from].title || "分支"}已移到第 ${to + 1} 位`);
  };
  const moveCheck = (branch: number, from: number, to: number) => {
    const checks = branches[branch].checks;
    if (from === to || from < 0 || to < 0 || to >= checks.length) return;
    focus.current = checks[from].id;
    patchBranch(branch, { checks: move(checks, from, to) });
    setAnnouncement(`判断节点已移到分支 ${branch + 1} 的第 ${to + 1} 位`);
  };
  const endDrag = () => { drag.current = undefined; setDropId(undefined); };
  const targetOf = (event: PointerEvent<HTMLButtonElement>, active: Drag) => {
    if (Math.abs(event.clientY - active.startY) < 5) return;
    const hovered = document.elementFromPoint(event.clientX, event.clientY);
    const branch = hovered?.closest<HTMLElement>("[data-flow-branch]");
    if (!branch || !root.current?.contains(branch)) return;
    if (!active.location.checkId) return branch.dataset.flowBranch;
    if (branch.dataset.flowBranch !== active.location.branchId) return;
    return hovered?.closest<HTMLElement>("[data-flow-check]")?.dataset.flowCheck;
  };
  const dragHandle = (location: NodeLocation, label: string) => <button type="button" className="btn answer-flow__handle"
    aria-label={label} title={label} data-flow-focus={location.checkId ?? location.branchId}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      drag.current = { location, pointer: event.pointerId, startY: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const active = drag.current;
      if (active?.pointer === event.pointerId) setDropId(targetOf(event, active));
    }} onPointerUp={event => {
      const active = drag.current;
      if (active?.pointer !== event.pointerId) return;
      const target = targetOf(event, active);
      endDrag();
      if (!target) return;
      const from = branches.findIndex(branch => branch.id === location.branchId);
      if (!location.checkId) return moveBranch(from, branches.findIndex(branch => branch.id === target));
      const checks = branches[from].checks;
      moveCheck(from, checks.findIndex(check => check.id === location.checkId), checks.findIndex(check => check.id === target));
    }} onLostPointerCapture={endDrag} onKeyDown={event => {
      if (event.key === "Escape") endDrag();
    }}>⠿</button>;

  const save = async () => {
    const cleaned = { ...flow, branches: branches.map(branch => ({ ...branch, title: branch.title.trim(),
      checks: branch.checks.map(check => ({ ...check, phrases: [...new Set(check.phrases.map(phrase => phrase.trim()).filter(Boolean))] })),
    })) };
    if (await onSave(cleaned)) setDraft(undefined);
  };

  return <fieldset ref={root} className="answer-flow" disabled={busy}>
    <label className="answer-flow__toggle"><input type="checkbox" checked={flow.enabled} onChange={event => edit({ ...flow, enabled: event.target.checked })} />启用调度流程</label>
    <p className="settings-section-desc">分支从上到下判断。分支内的节点依次执行，失败就转到下一分支。同一节点里的短语独立判断，再按选定条件汇合。</p>
    <div className="answer-flow__endpoint">用户提问</div>
    <ol className="answer-flow__sequence" aria-label="调度分支顺序">
      {branches.map((branch, index) => <li key={branch.id} className="answer-flow__branch"
        data-flow-branch={branch.id} data-flow-drop={dropId === branch.id}>
        <div className="answer-flow__row">
          {dragHandle({ branchId: branch.id }, `拖动分支 ${index + 1}`)}
          <input aria-label={`分支 ${index + 1} 名称`} placeholder="分支名称" value={branch.title} maxLength={limits.titleLength}
            onChange={event => patchBranch(index, { title: event.target.value })} />
          <button type="button" className="btn" aria-label={`上移分支 ${index + 1}`} disabled={index === 0} onClick={() => moveBranch(index, index - 1)}>↑</button>
          <button type="button" className="btn" aria-label={`下移分支 ${index + 1}`} disabled={index === branches.length - 1} onClick={() => moveBranch(index, index + 1)}>↓</button>
          <button type="button" className="btn" aria-label={`移除分支 ${index + 1}`} onClick={() => {
            const remaining = branches.filter(item => item.id !== branch.id);
            edit({ enabled: flow.enabled && remaining.length > 0, branches: remaining });
          }}>移除</button>
        </div>
        <ol className="answer-flow__sequence answer-flow__checks" aria-label={`分支 ${index + 1} 的串行判断`}>
          {branch.checks.map((check, checkIndex) => {
            const label = `分支 ${index + 1} 判断 ${checkIndex + 1}`;
            return <li key={check.id} className="answer-flow__check"
              data-flow-check={check.id} data-flow-drop={dropId === check.id}>
              <div className="answer-flow__row">
                {dragHandle({ branchId: branch.id, checkId: check.id }, `拖动${label}`)}
                <select aria-label={`${label}的通过条件`} value={check.operator} onChange={event => {
                  const operator = event.target.value;
                  if (operator === "any" || operator === "all" || operator === "none") patchCheck(index, checkIndex, { operator });
                }}><option value="any">任一短语命中</option><option value="all">全部短语命中</option><option value="none">均不命中</option></select>
                <button type="button" className="btn" aria-label={`上移${label}`} disabled={!checkIndex} onClick={() => moveCheck(index, checkIndex, checkIndex - 1)}>↑</button>
                <button type="button" className="btn" aria-label={`下移${label}`} disabled={checkIndex === branch.checks.length - 1} onClick={() => moveCheck(index, checkIndex, checkIndex + 1)}>↓</button>
                <button type="button" className="btn" aria-label={`移除${label}`} disabled={branch.checks.length === 1}
                  onClick={() => patchBranch(index, { checks: branch.checks.filter(node => node.id !== check.id) })}>移除</button>
              </div>
              <div className="answer-flow__parallel">
                {check.phrases.map((phrase, phraseIndex) => <div className="answer-flow__phrase" key={phraseIndex}>
                  <input aria-label={`${label} 短语 ${phraseIndex + 1}`} placeholder="匹配短语" value={phrase} maxLength={limits.phraseLength}
                    onChange={event => patchCheck(index, checkIndex, { phrases: check.phrases.map((text, i) => i === phraseIndex ? event.target.value : text) })} />
                  <button type="button" className="btn" disabled={check.phrases.length === 1} aria-label={`移除${label}短语 ${phraseIndex + 1}`}
                    onClick={() => patchCheck(index, checkIndex, { phrases: check.phrases.filter((_, i) => i !== phraseIndex) })}>×</button>
                </div>)}
              </div>
              <button type="button" className="btn" aria-label={`为${label} 添加并行短语`} disabled={check.phrases.length >= limits.phrases}
                onClick={() => patchCheck(index, checkIndex, { phrases: [...check.phrases, ""] })}>添加并行短语</button>
            </li>;
          })}
        </ol>
        <button type="button" className="btn" aria-label={`为分支 ${index + 1} 添加判断节点`} disabled={branch.checks.length >= limits.checks}
          onClick={() => patchBranch(index, { checks: [...branch.checks, newCheck()] })}>添加判断节点</button>
        <div className="answer-flow__result">
          <label>通过后采用<select aria-label={`分支 ${index + 1} 的回答规则`} value={branch.ruleId ?? ""}
            onChange={event => patchBranch(index, { ruleId: event.target.value || null })}>
            <option value="">沿用原规则匹配</option>
            {branch.ruleId && !rules.some(rule => rule.id === branch.ruleId) && <option value={branch.ruleId}>规则已删除</option>}
            {rules.map(rule => <option key={rule.id} value={rule.id}>{rule.title}{rule.enabled ? "" : "（已停用）"}</option>)}
          </select></label>
          <label>处理方式<select aria-label={`分支 ${index + 1} 的处理方式`} value={branch.routeMode ?? ""} onChange={event => {
            const value = event.target.value;
            patchBranch(index, { routeMode: value === "direct" || value === "delegate" || value === "auto" ? value : null });
          }}><option value="">沿用默认策略</option><option value="auto">自动</option><option value="direct">优先直答</option><option value="delegate">优先委派</option></select></label>
        </div>
      </li>)}
    </ol>
    <button type="button" className="btn" disabled={branches.length >= limits.branches} onClick={() => {
      const id = crypto.randomUUID();
      focus.current = id;
      setBranches([...branches, { id, title: "", checks: [newCheck()], ruleId: null, routeMode: "auto" }]);
    }}>新增分支</button>
    <div className="answer-flow__endpoint">无分支采用时，按原规则匹配</div>
    <div className="answer-flow__row">
      <button type="button" className="btn primary" disabled={!draft || baseChanged || !validFlow(flow)} onClick={() => void save()}>保存流程</button>
      {draft && <button type="button" className="btn" onClick={() => setDraft(undefined)}>放弃修改</button>}
      {baseChanged ? <small role="alert">已保存的流程有新版本。放弃此草稿后可继续编辑新版本。</small>
        : draft && <small>{validFlow(flow) ? "流程有未保存的修改" : "每个分支需要名称、判断短语和至少一种处理结果"}</small>}
    </div>
    <span role="status" className="answer-flow__announcement">{announcement}</span>
  </fieldset>;
}
