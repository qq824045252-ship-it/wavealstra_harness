import { useEffect, useState } from "react";
import { exampleHook, hookEventLabels, hookEvents, type HookDraft, type NativeHookReceipt, type NativeHooksApi, type PublishedHook } from "@shared/native-hooks";
import { useAppStore } from "@/store/appStore";
import { IconChevronRight, IconCode, IconPlay } from "@/components/common/icons";
import { SettingsInput, SettingsSection, SettingsSelect } from "./SettingsPrimitives";
import "./NativeHooksTab.css";

const hints = {
  beforeRequest: "event.userText 包含最近一条用户消息。返回的文字会随本次请求发给模型。",
  beforeTool: "event.args 是工具参数。返回处理说明会拦住本次调用，交给代理修正。",
  afterTool: "可读取 event.args 和 event.result 的 isError、text、diagnostics。处理说明会附在实际工具结果后。",
  beforeFinish: "可读取 event.userText、answer、recentTools 和 historyTruncated。recentTools 含本轮最近的工具名、路径、结果文本和错误标记。返回处理说明可要求代理补救，最多两次。",
};
const outcomeLabels = { pass: "通过", feedback: "已反馈", error: "检查异常" };

export default function NativeHooksTab(): React.JSX.Element {
  const api = window.api?.nativeHooks;
  return api ? <HookEditor api={api} /> : <p>执行钩子服务尚未就绪。</p>;
}

function HookEditor({ api }: { api: NativeHooksApi }): React.JSX.Element {
  const projects = useAppStore(s => s.projects), spaces = useAppStore(s => s.spaces), tasks = useAppStore(s => s.tasks);
  const [hooks, setHooks] = useState<PublishedHook[]>([]);
  const [base, setBase] = useState<PublishedHook>();
  const [draft, setDraft] = useState<HookDraft>(exampleHook);
  const [cases, setCases] = useState(() => JSON.stringify(draft.cases, null, 2));
  const [receipts, setReceipts] = useState<NativeHookReceipt[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const select = (hook?: PublishedHook) => {
    const next = hook?.draft ?? exampleHook();
    setBase(hook); setRevision(hook?.revision ?? 0); setDraft(next); setCases(JSON.stringify(next.cases, null, 2));
    setError(""); setNotice("");
  };
  useEffect(() => {
    let active = true;
    void api.list().then(items => { if (active) { setHooks(items); select(items[0]); } })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api]);
  useEffect(() => {
    let active = true;
    setReceipts([]);
    if (base) void api.receipts(base.id).then(rows => { if (active) setReceipts(rows); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [api, base, refresh]);
  const update = async (action: () => Promise<PublishedHook>, message: string) => {
    setBusy(true); setNotice(""); setError("");
    try {
      const saved = await action();
      setHooks(await api.list()); select(saved); setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try { setHooks(await api.list()); } catch { /* Keep the draft and original error. */ }
    } finally { setBusy(false); }
  };
  const scopeOptions = draft.scope.kind === "task" ? tasks.map(t => ({ id: t.id, name: t.title }))
    : draft.scope.kind === "project" ? projects : spaces;
  const scopeId = draft.scope.kind === "global" ? "" : draft.scope.id;
  const toolEvent = draft.event === "beforeTool" || draft.event === "afterTool";
  return <div className="native-hooks-tab">
    <SettingsSection title="执行规则" description="设置触发时机、作用范围和检查脚本。发布后从下一次匹配的操作开始生效。">
      <fieldset disabled={busy} className="native-hook-form">
        <div className="native-hook-identity">
        <SettingsSelect label="已发布的 Hook" value={base?.id ?? ""} onChange={e => select(hooks.find(h => h.id === e.target.value))}>
          <option value="">新建 Hook</option>
          {hooks.map(h => <option key={h.id} value={h.id}>{h.draft.title} · v{h.revision} · {h.enabled ? "已启用" : "已停用"}</option>)}
        </SettingsSelect>
        <SettingsInput label="名称" value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} />
        </div>
        <div className="native-hook-fields">
          <SettingsSelect label="触发时机" value={draft.event} onChange={e => {
            const event = e.target.value as HookDraft["event"];
            setDraft({ ...draft, event, tool: event === "beforeTool" || event === "afterTool" ? draft.tool : "" });
          }}>{hookEvents.map(event => <option key={event} value={event}>{hookEventLabels[event]}</option>)}</SettingsSelect>
          <SettingsSelect label="执行者" value={draft.actor} onChange={e => setDraft({ ...draft, actor: e.target.value as HookDraft["actor"] })}>
            <option value="all">主会话和子代理</option><option value="main">仅主会话</option><option value="subagent">仅原生子代理</option>
          </SettingsSelect>
          <SettingsSelect label="作用范围" value={draft.scope.kind} onChange={e => {
            const kind = e.target.value as HookDraft["scope"]["kind"];
            setDraft({ ...draft, scope: kind === "global" ? { kind } : { kind, id: "" } });
          }}><option value="global">全局</option><option value="workspace">工作空间</option><option value="project">项目</option><option value="task">任务</option></SettingsSelect>
        </div>
        {draft.scope.kind !== "global" && <SettingsSelect label="适用对象" value={scopeId} onChange={e => {
          if (draft.scope.kind !== "global") setDraft({ ...draft, scope: { ...draft.scope, id: e.target.value } });
        }}><option value="">请选择</option>{scopeId && !scopeOptions.some(o => o.id === scopeId) && <option value={scopeId}>{scopeId}</option>}
          {scopeOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</SettingsSelect>}
        {toolEvent && <SettingsInput label="工具名称" placeholder="留空匹配所有工具" value={draft.tool} onChange={e => setDraft({ ...draft, tool: e.target.value })} />}
        <label className="settings-field native-hook-code"><span className="settings-field-label"><IconCode size={15}/>检查脚本 <small>JavaScript</small></span>
          <textarea spellCheck={false} rows={4} value={draft.script} onChange={e => setDraft({ ...draft, script: e.target.value })} />
          <span className="settings-field-hint">返回 true 表示通过。{hints[draft.event]}</span></label>
        <details className="native-hook-tests"><summary><IconChevronRight size={14}/>发布前验证用例</summary>
          <label className="settings-field"><span className="settings-field-label">输入与预期返回值（JSON）</span>
            <textarea rows={9} spellCheck={false} value={cases} onChange={e => setCases(e.target.value)} /></label>
        </details>
        <div className="native-hook-actions"><button className="btn primary" onClick={() => void update(
          () => api.publish({ ...draft, cases: JSON.parse(cases) }, base && { id: base.id, generation: base.generation }), "验证通过，版本已保存。")}><IconPlay size={13}/>{busy ? "处理中…" : "验证并发布"}</button>
          {base && <><button className="btn" onClick={() => void update(() => api.activate(base.id, base.generation, base.revision, !base.enabled),
            base.enabled ? "已停用。" : "已启用。")}>{base.enabled ? "停用" : "启用"}</button>
            <button className="btn" onClick={() => select(hooks.find(h => h.id === base.id))}>重载已发布版本</button></>}
        </div>
        {base && base.versions.length > 1 && <div className="native-hook-actions"><SettingsSelect label="已验证版本" value={revision}
          onChange={e => setRevision(Number(e.target.value))}>{base.versions.map(v => <option key={v} value={v}>v{v}{v === base.revision ? "（当前）" : ""}</option>)}</SettingsSelect>
          <button className="btn" disabled={revision === base.revision} onClick={() => void update(() => api.activate(base.id, base.generation, revision, base.enabled), "已切换版本。")}>切换到此版本</button></div>}
      </fieldset>
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    </SettingsSection>
    {base && <SettingsSection title="最近执行记录" description="显示最近 100 次匹配的原生会话操作。">
      <button className="btn" onClick={() => setRefresh(x => x + 1)}>刷新记录</button>
      {!receipts.length && <p>暂无执行记录</p>}
      {receipts.map(r => <details className="native-hook-receipt" key={JSON.stringify([r.taskId,r.conversationId,r.nativeTaskId,r.event,r.revision,r.callId])}>
        <summary><IconChevronRight size={14}/><span><strong>{r.tool || hookEventLabels[r.event]}</strong>
          <small>{new Date(r.at).toLocaleString()} · {r.actor === "main" ? "主会话" : "子代理"} · v{r.revision}</small></span>
          <span className={"hook-outcome hook-outcome-" + r.outcome}>{outcomeLabels[r.outcome]}</span></summary>
        <p>任务 {r.taskId} · 会话 {r.conversationId} · 原生任务 {r.nativeTaskId}{r.callId && " · " + r.callId}</p>{r.message && <p>{r.message}</p>}
      </details>)}
    </SettingsSection>}
  </div>;
}
