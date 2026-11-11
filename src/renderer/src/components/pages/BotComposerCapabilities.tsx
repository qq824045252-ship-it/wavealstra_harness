import { ModelMenu } from "@/components/chat/ModelMenu";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { BotSettingsView } from "@shared/bot-settings";
import type { BotComposerSelection } from "@shared/bot-conversation";
import InputAddMenu from "@/components/chat/InputAddMenu";
import ModelBrandIcon from "@/components/common/ModelBrandIcon";
import { IconPlus, IconX, IconChevronDown, IconPencil } from "@/components/common/icons";
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
      <button type="button" className={`input-tool-btn${addOpen ? " active" : ""}`} aria-label="添加" title="添加文件、专家、技能、MCP 或连接器"
        aria-expanded={addOpen} aria-haspopup="menu" disabled={attachmentBusy} onClick={() => { void refresh(); setModelOpen(false); setAddOpen(!addOpen); }}><IconPlus size={16} /></button>
      {addOpen && <InputAddMenu contextMode="bot" anchorRef={addAnchor} rootRef={addRoot} onClose={() => setAddOpen(false)}
        selectedExpertId={selection?.expertId} onAttachFile={attach}
        onSelectExpert={id => { update({expertId:id}); setAddOpen(false); }}
        onSelectSkill={skill => add("skillIds", skill.id)} onSelectMcp={mcp => add("mcpIds", mcp.name)}
        onSelectConnector={connector => add("connectorIds", connector.id)} />}
    </div>
    <div className="bot-composer-capability-chips" aria-label="本条消息能力">
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
    {error && <div className="bot-composer-capability-error" role="alert">{error}<button type="button" onClick={() => void refresh()}>重试</button></div>}
  </div>;
}
