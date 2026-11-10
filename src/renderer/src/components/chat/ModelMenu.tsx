import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelConfig } from "@/types";
import type { ModelPreferencesDto, ModelReasoningPreferenceDto } from "@shared/model-metadata";
import { reasoningEffortLabel, reasoningEffortValues, reasoningPreferenceSummary, hasReasoningOption } from "@shared/model-metadata";
import { IconCheck, IconSparkles, IconPencil, IconChevronDown } from "@/components/common/icons";
import ModelBrandIcon from "@/components/common/ModelBrandIcon";
import { ModelOptionButton } from "./ModelOptionButton";
import { layoutRect, layoutViewportSize, placeFixedSideFlyout, placeStackOrSide } from "@/lib/placeFixedMenu";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import "./ModelMenu.css";
import { maxReasoningPreference } from "@shared/model-menu";

/** Shared ordinary/Bot model menu. Hosts own selection persistence; no active-task fallback. */
export function ModelMenu({ models: availableModels, modelId: activeModelId, preferences: modelPreferences,
  label = "模型列表", explicit: modelExplicit, followLabel = "跟随场景建议（Tag/Mode）", onSelect: setActiveModel,
  onPreference: setModelReasoningPreference, onFollow: followSuggestedModel, onConfigure, onClose }: {
  label?: string; models: ModelConfig[]; modelId?: string; preferences: ModelPreferencesDto; explicit: boolean; followLabel?: string;
  onSelect(id: string): void; onPreference(id: string, value: ModelReasoningPreferenceDto | undefined): void;
  onFollow(): void; onConfigure(): void; onClose(): void;
}) {
  const modelOpen = true;
  const [query, setQuery] = useState("");
  /** 模型列表悬停项 id，用于自动弹出思考等级菜单 */
  const [hoverModelId, setHoverModelId] = useState<string | null>(null);
  /** 预览卡：顶边对齐当前模型行，落在列表左侧 */
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  /** 思考强度子菜单：挂在「思考强度」行下方，不改预览卡 */
  const [detailPos, setDetailPos] = useState<{ top: number; left: number } | null>(null);
  const [thinkingDetailOpen, setThinkingDetailOpen] = useState(false);
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const modelOptionsRef = useRef<HTMLDivElement>(null);
  const thinkingFlyoutRef = useRef<HTMLDivElement>(null);
  const thinkingEntryRef = useRef<HTMLButtonElement>(null);
  const thinkingDetailRef = useRef<HTMLDivElement>(null);
  const flyoutRowRef = useRef<HTMLElement | null>(null);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeAllPopups = onClose;
  useDismissOnClickOutside(true, onClose, modelPopupRef, [thinkingFlyoutRef, thinkingDetailRef]);
  useEffect(() => () => { if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current); }, []);
  const active = availableModels.find(item => item.id === activeModelId);
  const maxPreference = maxReasoningPreference(active?.metadata);
  const isMax = Boolean(maxPreference && JSON.stringify(modelPreferences[activeModelId ?? ""]?.reasoning) === JSON.stringify(maxPreference));
  const toggleMax = () => { if (active && maxPreference) setModelReasoningPreference(active.id, isMax ? undefined : maxPreference); };
  const samePos = (
    prev: { top: number; left: number } | null,
    next: { top: number; left: number },
  ): boolean => Boolean(prev && prev.top === next.top && prev.left === next.left);

  const positionThinkingFlyout = (
    rowEl: HTMLElement | null,
    detailOpen = thinkingDetailOpen,
  ): void => {
    const popup = modelPopupRef.current;
    if (!rowEl || !popup) return;
    const viewport = layoutViewportSize();
    const flyout = thinkingFlyoutRef.current;
    const next = placeFixedSideFlyout({
      row: layoutRect(rowEl),
      avoid: layoutRect(popup),
      flyoutWidth: flyout?.offsetWidth ?? 220,
      flyoutHeight: flyout?.offsetHeight ?? 72,
      viewport,
    });
    setFlyoutPos((prev) => (samePos(prev, next) ? prev : next));

    if (!detailOpen) {
      setDetailPos((prev) => (prev == null ? prev : null));
      return;
    }
    const detail = thinkingDetailRef.current;
    const dnext = placeStackOrSide({
      preview: {
        top: next.top,
        left: next.left,
        width: flyout?.offsetWidth ?? 220,
        height: flyout?.offsetHeight ?? 72,
      },
      menuWidth: detail?.offsetWidth ?? 200,
      menuHeight: detail?.offsetHeight ?? 52,
      viewport,
    });
    setDetailPos((prev) => (samePos(prev, dnext) ? prev : dnext));
  };

  const openThinkingFlyout = (modelId: string, rowEl: HTMLElement | null): void => {
    if (hoverLeaveTimer.current) {
      clearTimeout(hoverLeaveTimer.current);
      hoverLeaveTimer.current = null;
    }
    flyoutRowRef.current = rowEl;
    const keepDetail = hoverModelId === modelId && thinkingDetailOpen;
    if (!keepDetail) setThinkingDetailOpen(false);
    setHoverModelId(modelId);
    positionThinkingFlyout(rowEl, keepDetail);
  };

  const scheduleCloseThinkingFlyout = (): void => {
    if (hoverLeaveTimer.current) clearTimeout(hoverLeaveTimer.current);
    hoverLeaveTimer.current = setTimeout(() => {
      setHoverModelId(null);
      setFlyoutPos(null);
      setDetailPos(null);
      setThinkingDetailOpen(false);
      flyoutRowRef.current = null;
    }, 200);
  };

  /** Product capability truth comes from model metadata, not Pi transport levels. */
  const reasoningOptionsForModel = (m: ModelConfig) => m.metadata?.reasoningOptions ?? [];
  const canThinkOn = (m: ModelConfig): boolean =>
    Boolean(m.supportsReasoning && reasoningOptionsForModel(m).length > 0);

  useLayoutEffect(() => {
    if (!modelOpen || !hoverModelId) return;
    positionThinkingFlyout(flyoutRowRef.current);
  }, [modelOpen, hoverModelId, thinkingDetailOpen]);

  useEffect(() => {
    if (!modelOpen || !hoverModelId) return;
    const onMove = (): void => positionThinkingFlyout(flyoutRowRef.current);
    const scroller = modelOptionsRef.current;
    scroller?.addEventListener("scroll", onMove, { passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      scroller?.removeEventListener("scroll", onMove);
      window.removeEventListener("resize", onMove);
    };
  }, [modelOpen, hoverModelId]);
  return <>            {modelOpen && (
              <div
                className="input-popup model-popup" role="listbox" aria-label={label}
                ref={modelPopupRef}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="model-max-row">
                  <span className="model-max-label">
                    <span className="model-max-icon">M</span>
                    Max 模式
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isMax}
                    aria-label="Max 模式" disabled={!maxPreference} title={maxPreference ? "使用模型声明的最高思考等级" : "此模型未声明可用思考等级"}
                    className={`switch model-max-switch ${isMax ? "on" : ""}`}
                    onClick={() => toggleMax()}
                  />
                </div>
                <input className="model-menu-search" aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} />
                <div className="model-options" ref={modelOptionsRef}>
                  {/* F2：显式模型标记的复位路径 —— 跟随 Tag/Mode 建议（不写全局默认） */}
                  <button
                    type="button"
                    className={`model-option follow-suggestion ${!modelExplicit ? "active" : ""}`}
                    title={followLabel}
                    onClick={() => { followSuggestedModel(); onClose(); }}
                  >
                    <IconSparkles size={15} className="model-option-icon" />
                    <span className="model-option-name">
                      {followLabel}
                    </span>
                    {!modelExplicit && <IconCheck size={14} className="model-option-check" />}
                  </button>
                  {availableModels.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase())).map((m) => {
                    const selected = m.id === activeModelId;
                    const canThink = canThinkOn(m);
                    const showFlyout = hoverModelId === m.id && canThink;
                    return (
                      <div
                        key={m.id}
                        className={`model-option-wrap ${showFlyout ? "flyout-open" : ""}`}
                        onFocus={(e) => { if (canThink) openThinkingFlyout(m.id, e.currentTarget); }}
                        onPointerDown={(e) => { flyoutRowRef.current = e.currentTarget; }}
                        onMouseEnter={(e) => {
                          if (canThink) openThinkingFlyout(m.id, e.currentTarget);
                        }}
                        onMouseLeave={scheduleCloseThinkingFlyout}
                      >
                        <ModelOptionButton role="option" name={m.name} selected={selected}
                          icon={<ModelBrandIcon modelName={m.name} vendor={m.vendor} size={16} />}
                          onClick={() => { setActiveModel(m.id); if (canThink) openThinkingFlyout(m.id, flyoutRowRef.current); else closeAllPopups(); }} />
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="input-popup-config"
                  onClick={() => {
                    onConfigure();
                    onClose();
                    setHoverModelId(null);
                    setFlyoutPos(null);
                    setDetailPos(null);
                    setThinkingDetailOpen(false);
                  }}
                >
                  <IconPencil size={14} /> 配置自定义模型
                </button>
              </div>
            )}
            {modelOpen &&
              (() => {
                const hoverModel = availableModels.find((m) => m.id === hoverModelId);
                if (!hoverModel || !flyoutPos || typeof document === "undefined") return null;
                const options = reasoningOptionsForModel(hoverModel);
                if (!hoverModel.supportsReasoning || options.length === 0) return null;
                const selected = hoverModel.id === activeModelId;
                const preference = modelPreferences[hoverModel.id]?.reasoning;
                const effortValues = reasoningEffortValues(options);
                const hasToggle = hasReasoningOption(options, "toggle");
                const budgetOption = options.find((option) => option.type === "budget_tokens");
                const summary = reasoningPreferenceSummary(preference, hoverModel.metadata);
                const thinkingOn =
                  preference?.enabled === false || preference?.effort === "none"
                    ? false
                    : true;
                const keepFlyout = (): void => {
                  if (hoverLeaveTimer.current) {
                    clearTimeout(hoverLeaveTimer.current);
                    hoverLeaveTimer.current = null;
                  }
                };
                const applyPreference = (next: typeof preference, close = false): void => {
                  if (!selected) setActiveModel(hoverModel.id);
                  setModelReasoningPreference(hoverModel.id, next);
                  if (close) closeAllPopups();
                };
                return (
                  <>
                    {createPortal(
                      <div
                        ref={thinkingFlyoutRef}
                        className="model-thinking-flyout"
                        style={{ top: flyoutPos.top, left: flyoutPos.left }}
                        onMouseEnter={keepFlyout}
                        onMouseLeave={scheduleCloseThinkingFlyout}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="model-thinking-title" title={hoverModel.name}>
                          {hoverModel.name}
                        </div>
                        <div className="model-thinking-divider" />
                        <button
                          ref={thinkingEntryRef}
                          type="button"
                          className={`model-thinking-entry ${thinkingDetailOpen ? "open" : ""}`}
                          onMouseEnter={() => setThinkingDetailOpen(true)}
                          onClick={() => setThinkingDetailOpen(true)}
                        >
                          <span>思考偏好</span>
                          <span className="model-thinking-entry-val">
                            <span className="model-thinking-entry-key">{summary}</span>
                            <IconChevronDown
                              size={12}
                              style={{ transform: "rotate(-90deg)" }}
                            />
                          </span>
                        </button>
                      </div>,
                      document.body,
                    )}
                    {thinkingDetailOpen &&
                      createPortal(
                        <div
                          ref={thinkingDetailRef}
                          className="model-thinking-flyout model-thinking-detail"
                          style={{
                            top: detailPos?.top ?? 0,
                            left: detailPos?.left ?? 0,
                            visibility: detailPos ? "visible" : "hidden",
                          }}
                          onMouseEnter={keepFlyout}
                          onMouseLeave={scheduleCloseThinkingFlyout}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="model-thinking-level"
                            onClick={() => applyPreference(undefined, true)}
                          >
                            <span className="model-thinking-level-key">模型默认</span>
                            {!preference && <IconCheck size={14} />}
                          </button>

                          {hasToggle && (
                            <div className="model-thinking-row">
                              <span>Reasoning</span>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={thinkingOn}
                                aria-label="Reasoning"
                                className={`switch model-max-switch ${thinkingOn ? "on" : ""}`}
                                onClick={() => applyPreference({
                                  ...(preference ?? {}),
                                  enabled: !thinkingOn,
                                })}
                              />
                            </div>
                          )}

                          {effortValues.length > 0 && (
                            <>
                              <div className="model-thinking-section-label">{hoverModel.metadata?.reasoningControl === "toggle" ? "思考开关" : "Effort"}</div>
                              <div className="model-thinking-levels">
                                {effortValues.map((effort) => (
                                  <button
                                    type="button"
                                    key={effort}
                                    className={`model-thinking-level ${preference?.effort === effort ? "active" : ""}`}
                                    onClick={() => applyPreference({
                                      ...(preference ?? {}),
                                      ...(hasToggle ? { enabled: effort === "none" ? false : true } : {}),
                                      effort,
                                    }, true)}
                                  >
                                    <span className="model-thinking-level-key">
                                      {reasoningEffortLabel(effort, hoverModel.metadata)}
                                    </span>
                                    {preference?.effort === effort && <IconCheck size={14} />}
                                  </button>
                                ))}
                              </div>
                            </>
                          )}

                          {budgetOption && (
                            <>
                              <div className="model-thinking-section-label">Budget Tokens</div>
                              <div className="model-thinking-row">
                                <input
                                  type="number"
                                  min={budgetOption.min}
                                  max={budgetOption.max}
                                  value={preference?.budgetTokens ?? ""}
                                  placeholder="模型默认"
                                  onChange={(event) => {
                                    const raw = event.target.value;
                                    applyPreference({
                                      ...(preference ?? {}),
                                      ...(hasToggle ? { enabled: true } : {}),
                                      budgetTokens: raw ? Number(raw) : undefined,
                                    });
                                  }}
                                />
                              </div>
                              <div className="model-thinking-section-label">
                                {budgetOption.min != null || budgetOption.max != null
                                  ? `${budgetOption.min ?? "?"} – ${budgetOption.max ?? "?"}`
                                  : "模型未声明范围"}
                              </div>
                            </>
                          )}
                        </div>,
                        document.body,
                      )}
                  </>
                );
              })()}</>;
}
