import { ModelMenu } from "@/components/chat/ModelMenu";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { BotSettingsView } from "@shared/bot-settings";
import type { BotComposerSelection } from "@shared/bot-conversation";
import InputAddMenu, { type RefFileItem, type RefTaskItem } from "@/components/chat/InputAddMenu";
import { useConsultSelection } from "@/components/chat/useConsultSelection";
import { useExternalAgentCatalog } from "@/lib/externalAgentCatalog";
import { collectBotConversationFiles } from "@/lib/botConversationFiles";
import ModelBrandIcon from "@/components/common/ModelBrandIcon";
import { IconPlus, IconX, IconChevronDown } from "@/components/common/icons";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { usePromptEnhance } from "@/features/prompt-enhance/usePromptEnhance";
import { PromptEnhanceControl } from "@/features/prompt-enhance/PromptEnhanceControl";
import "./BotComposerCapabilities.css";

/** Adapter only: same menu, chips and prompt-enhance state machine as ordinary chat.
 * Selection belongs to the draft scope and travels with the immutable send, never
 * saves global Bot settings or mutates a request already executing. */
export function BotComposerCapabilities({ botId, scope, text, attach, attachmentBusy }: {
  botId: string; scope: string; text: string; attach: () => void; attachmentBusy: boolean;
}) {
  const selection = useAppStore(state => state.botComposerDrafts[scope]);
  const setSelection = useAppStore(state => state.setBotComposerSelection);
  const [catalog, setCatalog] = useState<BotSettingsView>();
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const models = useAppStore(state => state.models);
  const history = useAppStore(state => state.botHistories[scope]);
  const settingsOpen = useAppStore(state => state.settingsOpen);
  const externalAgents = useExternalAgentCatalog(state => state.agents);
  const conversationFiles = useMemo(() => collectBotConversationFiles(history), [history]);
  const globalPreferences = useAppStore(state => state.modelPreferences);
  const root = useRef<HTMLDivElement>(null), addAnchor = useRef<HTMLDivElement>(null), addRoot = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const refresh = async () => {
    const own = ++epoch.current;
    try {
      const next = await window.api!.botWork.getSettings(botId);
      if (own !== epoch.current) return;
      setCatalog(next); setError("");
      void useAppStore.getState().refreshModelConfiguration();
      if (!useAppStore.getState().botComposerDrafts[scope]) {
        const { modelId, expertId, skillIds, mcpIds, connectorIds } = next.settings;
        const reasoningPreference = useAppStore.getState().modelPreferences[modelId]?.reasoning;
        setSelection(scope, { modelId, expertId, skillIds, mcpIds, connectorIds, ...(reasoningPreference ? { reasoningPreference } : {}) });
      }
    } catch (cause) { if (own === epoch.current) setError(String(cause)); }
  };
  useEffect(() => { void refresh(); return () => { epoch.current++; }; }, [botId, scope]);
  useDismissOnClickOutside(addOpen, () => setAddOpen(false), root, [addRoot]);
  const update = (patch: Partial<BotComposerSelection>) => {
    const current = useAppStore.getState().botComposerDrafts[scope];
    if (!current) return;
    const next = { ...current, ...patch };
    if (!next.reasoningPreference) delete next.reasoningPreference;
    setSelection(scope, next); setError("");
  };
  const add = (key: "skillIds" | "mcpIds" | "connectorIds", id: string) => {
    const current = useAppStore.getState().botComposerDrafts[scope];
    if (current) update({ [key]: [...new Set([...current[key], id])] });
    setAddOpen(false);
  };
  const consult = useConsultSelection({ taskId: scope, externalAgentId: selection?.externalAgentId,
    settingsOpen, openSettings: () => useAppStore.getState().setSettingsOpen(true, "extensions"),
    focusComposer: () => document.getElementById("bot-draft")?.focus(),
  });
  useEffect(() => {
    if (consult.requested) { update({ consultRequested: true }); consult.clear(); }
  }, [consult.requested]);
  const addReference = (kind: "refTasks" | "refFiles", value: RefTaskItem | RefFileItem) => {
    const current = useAppStore.getState().botComposerDrafts[scope];
    if (!current) return;
    if (kind === "refTasks") {
      const task = value as RefTaskItem;
      // Persist only the same recent context the shared prompt builder includes.
      const bounded = { ...task, messages: task.messages?.slice(-8).map(message => ({ ...message, text: message.text.slice(0, 800) })) };
      update({ refTasks: [...(current.refTasks ?? []).filter(item => item.id !== value.id), bounded] });
    }
    else update({ refFiles: [...(current.refFiles ?? []).filter(item => (item.path || item.id) !== ((value as RefFileItem).path || value.id)), value as RefFileItem] });
    setAddOpen(false);
  };
  const enhance = usePromptEnhance({ surface: "new-task", draftScope: scope,
    mode: "working", expertId: selection?.expertId || undefined, expertIds: selection?.expertId ? [selection.expertId] : [],
    allowedSkillNames: selection?.skillIds }, {
    getCurrentText: () => useAppStore.getState().botDrafts[scope] ?? "",
    onApply: next => {
      const state = useAppStore.getState();
      const liveScope = state.activeTeam ? `team:${state.activeTeam.templateId}` : state.activeBotId;
      if (liveScope === scope) state.setBotDraft(next);
    },
  });
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") enhance.cancelEnhance(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [enhance.cancelEnhance]);
  const selectedModel = catalog?.models.find(model => model.id === selection?.modelId);
  const chips = selection ? [
    ...(selection.expertId ? [{ kind: "expertId" as const, id: selection.expertId, name: catalog?.experts.find(item => item.id === selection.expertId)?.name ?? selection.expertId }] : []),
    ...([['skillIds','skills'],['mcpIds','mcps'],['connectorIds','connectors']] as const).flatMap(([kind, collection]) =>
      selection[kind].map(id => ({kind, id, name: catalog?.[collection].find(item => item.id === id)?.name ?? id}))),
  ] : [];
  return <div ref={root} className="bot-composer-capabilities">
    <div className="input-popup-anchor add-menu-anchor" ref={addAnchor}>
      <button type="button" className={`input-tool-btn${addOpen ? " active" : ""}`} aria-label="添加" title="添加"
        aria-expanded={addOpen} aria-haspopup="menu" disabled={attachmentBusy || !selection} onClick={() => { void refresh(); setModelOpen(false); setAddOpen(!addOpen); }}><IconPlus size={16} /></button>
      {addOpen && <InputAddMenu contextMode="bot" anchorRef={addAnchor} rootRef={addRoot} onClose={() => setAddOpen(false)}
        selectedExpertId={selection?.expertId} onAttachFile={attach} conversationFiles={conversationFiles}
        onSelectConsult={() => { setAddOpen(false); void consult.select(); }} consultDisabled={Boolean(selection?.externalAgentId)}
        onSelectRefTask={task => addReference("refTasks", task)} onSelectRefFile={file => addReference("refFiles", file)}
        onSelectExternalAgent={agent => { update({ externalAgentId: agent.id, consultRequested: false }); consult.clear(); setAddOpen(false); }}
        onSelectExpert={id => { update({expertId:id}); setAddOpen(false); }}
        onSelectSkill={skill => add("skillIds", skill.id)} onSelectMcp={mcp => add("mcpIds", mcp.name)}
        onSelectConnector={connector => add("connectorIds", connector.id)} />}
    </div>
    <div className="bot-composer-capability-chips" aria-label="本条消息能力">
      {selection?.consultRequested && <span className="attach-chip"><span className="attach-chip-name">多模型会诊 · 本条</span><button type="button" className="attach-chip-x" aria-label="移除多模型会诊" onClick={() => update({consultRequested: false})}><IconX size={12} /></button></span>}
      {selection?.externalAgentId && <span className="attach-chip"><span className="attach-chip-name">外部 Agent · {externalAgents.find(item => item.id === selection.externalAgentId)?.name ?? selection.externalAgentId}</span><button type="button" className="attach-chip-x" aria-label="移除外部 Agent" onClick={() => update({externalAgentId: undefined})}><IconX size={12} /></button></span>}
      {selection?.refTasks?.map(task => <span key={`task:${task.id}`} className="attach-chip" title={`引用任务：${task.title}`}><span className="attach-chip-name">{task.title}</span><button type="button" className="attach-chip-x" aria-label={`移除引用任务 ${task.title}`} onClick={() => update({refTasks: selection.refTasks?.filter(item => item.id !== task.id)})}><IconX size={12} /></button></span>)}
      {selection?.refFiles?.map(file => <span key={`file:${file.id}`} className="attach-chip" title={file.path ?? file.name}><span className="attach-chip-name">{file.name}</span><button type="button" className="attach-chip-x" aria-label={`移除引用文件 ${file.name}`} onClick={() => update({refFiles: selection.refFiles?.filter(item => item.id !== file.id)})}><IconX size={12} /></button></span>)}
      {chips.map(chip => <span key={`${chip.kind}:${chip.id}`} className="attach-chip" title={`${chip.name} · 用于本条消息及其后台任务${chip.kind === "connectorIds" ? " · 已选连接器；CLI/登录未验证" : ""}`}>
        <span className="attach-chip-name">{chip.name}</span><button type="button" className="attach-chip-x" aria-label={`移除 ${chip.name}`}
          onClick={() => update(chip.kind === "expertId" ? {expertId:""} : {[chip.kind]:selection![chip.kind].filter(id => id !== chip.id)})}><IconX size={12} /></button></span>)}
    </div>
    <div className="input-popup-anchor bot-composer-model">
      <button type="button" className="pill-select ghost as-btn model-trigger" aria-label="选择 Bot 模型" aria-expanded={modelOpen}
        disabled={!selection} onClick={() => { void refresh(); setAddOpen(false); setModelOpen(!modelOpen); }}>
        {selectedModel && <ModelBrandIcon modelName={selectedModel.name} size={16} />}<span className="model-trigger-label">{selectedModel?.name ?? (selection?.modelId || "跟随默认模型")}</span><IconChevronDown size={12} /></button>
      {modelOpen && <ModelMenu label="Bot 模型列表" models={(catalog?.models ?? []).filter(item => item.available).map(item => models.find(model => model.id === item.id) ?? {id:item.id,name:item.name,vendor:"",supportsImages:false,supportsReasoning:false})}
        modelId={selection?.modelId} preferences={selection?.modelId ? { [selection.modelId]: { reasoning: selection.reasoningPreference } } : {}}
        explicit={Boolean(selection?.modelId)} followLabel="跟随 Bot 默认模型"
        onSelect={id => update({modelId:id, reasoningPreference:globalPreferences[id]?.reasoning})}
        onPreference={(id, preference) => update({modelId:id, reasoningPreference:preference})}
        onFollow={() => { update({modelId:"",reasoningPreference:undefined});setModelOpen(false); }}
        onConfigure={() => {setModelOpen(false);useAppStore.getState().setSettingsOpen(true,"models");}}
        onClose={() => setModelOpen(false)} /> }
    </div>
    <PromptEnhanceControl surface="new-task" status={enhance.status} notice={enhance.notice} empty={!text.trim()}
      canUndo={Boolean(enhance.undo && text === enhance.undo.applied)} onEnhance={() => enhance.requestEnhance(text, selection?.modelId || undefined)} onUndo={() => enhance.undoEnhance(text)} />
    {consult.notice && <div className="bot-composer-capability-notice" role="status">{consult.notice}{consult.needsConfiguration && <button type="button" onClick={consult.openConfiguration}>配置多模型会诊</button>}</div>}
    {error && <div className="bot-composer-capability-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>重试</button></div>}
  </div>;
}
