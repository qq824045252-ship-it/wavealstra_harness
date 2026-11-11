import CreateScopedMemory from "./CreateScopedMemory";
import { KIND_LABEL, SCOPE_LABEL, STATUS_LABEL, OP_LABEL } from "./memoryScopeLabels";
import PublicMemorySharing from "./PublicMemorySharing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryCandidateDto,
  MemoryCoreProfileDto,
  MemoryDismissedProjectionDto,
  MemoryKernelStats,
  MemoryProjectionProposalDto,
  MemoryProjectionDeleteRequest,
  MemoryKind,
  MemoryRecordDto,
  MemoryRevisionDto,
  MemoryScenarioDto,
  MemoryScopeDto,
  MemoryScopeType,
  MemoryStatus,
  MemoryUpdateRequest,
} from "@shared/memory-kernel";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import MemoryL0Explorer from "./MemoryL0Explorer";
import MemoryOrganizationPanel from "./MemoryOrganizationPanel";
import { useTextPrompt } from "@/components/common/useTextPrompt";
import { useAppStore } from "@/store/appStore";


function fmt(ts?: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const opts: Intl.DateTimeFormatOptions = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return new Intl.DateTimeFormat("zh-CN", opts).format(d);
}

function scopeText(memory: MemoryRecordDto): string {
  return memory.scopes
    .map((scope) => `${SCOPE_LABEL[scope.scopeType] ?? scope.scopeType}${scope.binding === "promoted" ? "↑" : ""}`)
    .join(" · ");
}

type MemoryLayer = "l0" | "l1" | "l2" | "l3";

function projectionRecordKey(kind: MemoryProjectionDeleteRequest["kind"], type: "target" | "proposal", id: string): string {
  return `${kind}:${type}:${id}`;
}

/** Unified Memory Kernel manager: inspect, edit and hard-delete one truth source across all scopes. */
export default function MemoryKernelExplorer({ focusMemoryId, fixedBotId, fixedScope }: { focusMemoryId?: string | null; fixedBotId?: string; fixedScope?: { scopeType: MemoryScopeType; scopeId?: string } }): React.JSX.Element {
  const fixedType = fixedScope?.scopeType ?? (fixedBotId ? "bot" : undefined);
  const fixedId = fixedScope?.scopeId ?? fixedBotId;
  const scopeName = fixedType === "bot" ? "此 Bot" : fixedType === "team" ? "此团队" : fixedType === "conversation" ? "本次对话" : fixedType === "work" ? "此事项" : fixedType === "project" ? "此项目" : "全局";
  const spaces = useAppStore((s) => s.spaces);
  const projects = useAppStore((s) => s.projects);
  const tasks = useAppStore((s) => s.tasks);
  const bots = useAppStore((s) => s.botIdentities);
  const [layer, setLayer] = useState<MemoryLayer>("l1");
  const [l0FocusId, setL0FocusId] = useState<string | null>(null);
  const [l0ResetVersion, setL0ResetVersion] = useState(0);
  const [confirmDeleteAllTurns, setConfirmDeleteAllTurns] = useState(false);
  const [records, setRecords] = useState<MemoryRecordDto[]>([]);
  const [stats, setStats] = useState<MemoryKernelStats | null>(null);
  const [review, setReview] = useState<MemoryCandidateDto[]>([]);
  const [scenarios, setScenarios] = useState<MemoryScenarioDto[]>([]);
  const [profiles, setProfiles] = useState<MemoryCoreProfileDto[]>([]);
  const [dismissed, setDismissed] = useState<MemoryDismissedProjectionDto[]>([]);
  const [proposals, setProposals] = useState<MemoryProjectionProposalDto[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [botScopeId, setBotScopeId] = useState("");
  const [kind, setKind] = useState("all");
  const [lifecycle, setLifecycle] = useState("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<MemoryRevisionDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showProjectionHistory, setShowProjectionHistory] = useState(false);
  const [focusedScenarioId, setFocusedScenarioId] = useState<string | null>(null);
  const scenarioFocusRef = useRef<HTMLDivElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const [pendingProjectionDelete, setPendingProjectionDelete] = useState<{ request: MemoryProjectionDeleteRequest; label: string; selectionCount?: number } | null>(null);
  const [selectedProjectionKeys, setSelectedProjectionKeys] = useState<Set<string>>(() => new Set());
  const projectionSelectAllRef = useRef<HTMLInputElement | null>(null);
  const [pendingForgetCandidate, setPendingForgetCandidate] = useState<MemoryCandidateDto | null>(null);
  const [pendingDetach, setPendingDetach] = useState<MemoryScopeDto | null>(null);
  const [promoteType, setPromoteType] = useState<"global" | "workspace" | "project">("global");
  const [promoteTarget, setPromoteTarget] = useState("");
  const { requestText, textPromptDialog } = useTextPrompt();
  const selectedIdRef = useRef<string | null>(null);
  const sourceFocusIdRef = useRef<string | null>(null);
  const recordRequestRef = useRef(0);
  const loadRequestRef = useRef(0);

  const clearSelection = useCallback((): void => {
    selectedIdRef.current = null;
    sourceFocusIdRef.current = null;
    setSelectedId(null);
    setHistory([]);
  }, []);

  // Server-side filtering: the query runs over the whole store, not a 500-row window.
  const fetchRecords = useCallback(async (): Promise<MemoryRecordDto[]> => {
    const api = window.api?.memory;
    if (!api) return [];
    const sourceId = sourceFocusIdRef.current;
    const items = await api.list({
      query: debouncedQuery || undefined,
      scopeType: fixedType ? fixedType : scope === "all" ? undefined : (scope as MemoryScopeType),
      scopeId: fixedId ?? (scope === "bot" && botScopeId ? botScopeId : undefined),
      kind: kind === "all" ? undefined : (kind as MemoryKind),
      status: lifecycle === "all" ? undefined : (lifecycle as MemoryStatus),
      limit: 500,
    });
    if (!fixedType && sourceId && !debouncedQuery && scope === "all" && kind === "all" && lifecycle === "all" && !items.some((item) => item.id === sourceId)) {
      const source = await api.get(sourceId);
      if (source) return [source, ...items];
    }
    return fixedType ? items.filter(item => item.scopes.some(s => s.scopeType === fixedType && (s.scopeId ?? undefined) === fixedId)) : items;
  }, [debouncedQuery, scope, botScopeId, kind, lifecycle, fixedType, fixedId]);

  const fetchRecordsRef = useRef(fetchRecords);
  useEffect(() => { fetchRecordsRef.current = fetchRecords; }, [fetchRecords]);

  const load = useCallback(async (): Promise<void> => {
    const api = window.api?.memory;
    if (!api) return;
    const request = ++loadRequestRef.current;
    const recordRequest = ++recordRequestRef.current;
    setLoading(true);
    setRefreshVersion((v) => v + 1);
    try {
      const [items, nextStats, reviewItems, scenarioItems, profileItems, dismissedItems, proposalItems] = await Promise.all([
        fetchRecordsRef.current(),
        fixedType ? Promise.resolve(null) : api.stats(),
        fixedType ? Promise.resolve([]) : api.candidates("needs_review", 100),
        fixedType ? Promise.resolve([]) : api.scenarios(300),
        fixedType ? Promise.resolve([]) : api.coreProfiles(100),
        fixedType ? Promise.resolve([]) : api.dismissedProjections(),
        fixedType ? Promise.resolve([]) : api.projectionProposals(),
      ]);
      if (request !== loadRequestRef.current) return;
      if (recordRequest === recordRequestRef.current) {
        setRecords(items);
        const sel = selectedIdRef.current;
        if (sel && !items.some((item) => item.id === sel)) clearSelection();
      }
      setStats(nextStats);
      setReview(reviewItems);
      setScenarios(scenarioItems);
      setProfiles(profileItems);
      setDismissed(dismissedItems);
      setProposals(proposalItems);
    } catch (error) {
      if (request === loadRequestRef.current) setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [clearSelection, fixedType, fixedId]);

  useEffect(() => {
    void load();
    return () => { loadRequestRef.current++; recordRequestRef.current++; };
  }, [load]);

  // Filter changes refresh only the record list, not the whole 9-query panel.
  useEffect(() => {
    let cancelled = false;
    const request = ++recordRequestRef.current;
    fetchRecords()
      .then((items) => {
        if (cancelled || request !== recordRequestRef.current) return;
        setRecords(items);
        const sel = selectedIdRef.current;
        if (sel && !items.some((item) => item.id === sel)) clearSelection();
      })
      .catch((error) => { if (!cancelled && request === recordRequestRef.current) setStatus(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [fetchRecords, clearSelection]);

  // Extraction/agent writes broadcast memoryChanged; keep the open explorer in sync (debounced).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.api?.db?.onMemoryChanged?.(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 350);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const selected = records.find((item) => item.id === selectedId) ?? null;
  const filtering = Boolean(debouncedQuery) || scope !== "all" || kind !== "all" || lifecycle !== "all";
  const listIsPartial = filtering || (stats?.total ?? 0) > records.length;
  const projectionKind = layer === "l2" ? "scenario" : layer === "l3" ? "profile" : null;
  const visiblePendingProposals = proposals.filter((item) => item.status === "pending" && (!projectionKind || item.kind === projectionKind));
  const visibleRejectedProposals = proposals.filter((item) => item.status === "rejected" && (!projectionKind || item.kind === projectionKind));
  const visibleDismissed = dismissed.filter((item) => !projectionKind || item.kind === projectionKind);

  const selectableProjections = useMemo(() => {
    if (!projectionKind) return [];
    const targets = (projectionKind === "scenario" ? scenarios : profiles)
      .filter((item) => showProjectionHistory || item.status === "active")
      .map((item) => item.id);
    targets.push(...dismissed.filter((item) => item.kind === projectionKind).map((item) => item.id));
    return [
      ...[...new Set(targets)].map((id) => ({ key: projectionRecordKey(projectionKind, "target", id), id, type: "target" as const })),
      ...proposals.filter((item) => item.kind === projectionKind && (item.status === "pending" || item.status === "rejected"))
        .map((item) => ({ key: projectionRecordKey(projectionKind, "proposal", item.id), id: item.id, type: "proposal" as const })),
    ];
  }, [projectionKind, scenarios, profiles, dismissed, proposals, showProjectionHistory]);
  const selectedProjections = selectableProjections.filter((item) => selectedProjectionKeys.has(item.key));
  const allProjectionsSelected = selectableProjections.length > 0 && selectedProjections.length === selectableProjections.length;

  useEffect(() => {
    const visibleKeys = new Set(selectableProjections.map((item) => item.key));
    setSelectedProjectionKeys((previous) => {
      const retained = new Set([...previous].filter((key) => visibleKeys.has(key)));
      return retained.size === previous.size ? previous : retained;
    });
  }, [selectableProjections]);

  useEffect(() => {
    if (projectionSelectAllRef.current) projectionSelectAllRef.current.indeterminate = selectedProjections.length > 0 && !allProjectionsSelected;
  }, [selectedProjections.length, allProjectionsSelected, projectionKind]);

  const projectionCheckbox = (recordKind: MemoryProjectionDeleteRequest["kind"], type: "target" | "proposal", id: string, label: string): React.JSX.Element => {
    const key = projectionRecordKey(recordKind, type, id);
    return <label className="memory-projection-select">
      <input type="checkbox" aria-label={`选择${label}`} checked={selectedProjectionKeys.has(key)} disabled={busy || loading} onChange={(event) => {
        const checked = event.currentTarget.checked;
        setSelectedProjectionKeys((previous) => {
          const next = new Set(previous);
          if (checked) next.add(key); else next.delete(key);
          return next;
        });
      }} />
    </label>;
  };

  const promoteChoices = useMemo((): Array<{ id: string; label: string }> => {
    if (!selected || promoteType === "global") return [];
    const bound = new Set(selected.scopes.map((s) => `${s.scopeType}:${s.scopeId ?? ""}`));
    if (promoteType === "workspace") {
      return spaces
        .filter((s) => !(Boolean((s as { effectiveArchived?: boolean }).effectiveArchived ?? s.archived)) && !bound.has(`workspace:${s.id}`))
        .map((s) => ({ id: s.id, label: s.name }));
    }
    return projects
      .filter((p) => !p.archived && !bound.has(`project:${p.id}`))
      .map((p) => ({ id: p.id, label: p.name }));
  }, [selected, promoteType, spaces, projects]);

  const alreadyGlobal = Boolean(selected?.scopes.some((s) => s.scopeType === "global"));

  const select = (id: string): void => {
    sourceFocusIdRef.current = null;
    selectedIdRef.current = id;
    setSelectedId(id);
    setHistory([]);
  };

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    if (!selectedId) return;
    void window.api?.memory?.history(selectedId).then((items) => {
      if (!cancelled && selectedIdRef.current === selectedId) setHistory(items);
    }).catch(() => { /* The record remains readable when revision history is unavailable. */ });
    return () => { cancelled = true; };
  }, [selectedId, selected?.updatedAt, refreshVersion]);

  const openL1Memory = useCallback(async (id: string): Promise<void> => {
    recordRequestRef.current++;
    sourceFocusIdRef.current = id;
    selectedIdRef.current = id;
    setSelectedId(id);
    setHistory([]);
    setLayer("l1");
    setQuery("");
    setDebouncedQuery("");
    setScope("all");
    setKind("all");
    setLifecycle("all");
    try {
      const memory = await window.api?.memory?.get(id);
      if (selectedIdRef.current !== id) return;
      if (!memory || (fixedType && !memory.scopes.some(s => s.scopeType === fixedType && (s.scopeId ?? undefined) === fixedId))) { clearSelection(); setStatus("来源记忆已删除，历史候选仅保留审核快照。"); return; }
      setRecords((current) => [memory, ...current.filter((item) => item.id !== id)]);
    } catch (error) {
      if (selectedIdRef.current === id) setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [clearSelection, fixedType, fixedId]);

  useEffect(() => { if (focusMemoryId) void openL1Memory(focusMemoryId); }, [focusMemoryId, openL1Memory]);
  useEffect(() => {
    if (layer === "l2" && focusedScenarioId) {
      scenarioFocusRef.current?.focus({ preventScroll: true });
      scenarioFocusRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [layer, focusedScenarioId]);

  const openL0Evidence = (turnId: string): void => {
    setL0FocusId(turnId);
    setLayer("l0");
  };

  const generateProposals = async (level: "l2" | "l3"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatus(level === "l2" ? "正在生成场景提案…" : "正在生成画像提案…");
    try {
      const api = window.api?.memory;
      const result = level === "l2" ? await api?.generateL2Proposals() : await api?.generateL3Proposals();
      if (result) setStatus(result.completed ? `生成完成：覆盖 ${result.scopesProcessed} 个作用域，新增 ${result.outputs} 条待批准提案。` : "生成未完成（记忆开关或模型未就绪）。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const decideProposal = async (item: MemoryProjectionProposalDto, action: "approve" | "reject" | "restore"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const api = window.api?.memory;
      if (action === "approve") {
        await api?.approveProjectionProposal(item.id);
        setStatus(`已批准「${item.title}」，投影已生效。`);
      } else if (action === "reject") {
        await api?.rejectProjectionProposal(item.id);
        setStatus(`已拒绝「${item.title}」，同内容提案不再出现。`);
      } else {
        await api?.restoreProjectionProposal(item.id);
        setStatus(`已将「${item.title}」移回待批准。`);
      }
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const dismissProjection = async (id: string, kind: "scenario" | "profile", title: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await window.api?.memory?.dismissProjection(id, kind);
      setStatus(`已屏蔽「${title}」；同内容投影不会再自动重建。`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const restoreProjection = async (item: MemoryDismissedProjectionDto): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await window.api?.memory?.restoreProjection(item.id);
      setStatus(`已解除屏蔽「${item.title}」，可重新生成提案并批准。`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteProjectionRecords = async (): Promise<void> => {
    const api = window.api?.memory;
    if (busy || !api || !pendingProjectionDelete) return;
    const { request } = pendingProjectionDelete;
    setPendingProjectionDelete(null);
    setBusy(true);
    try {
      const result = await api.deleteProjectionRecords(request);
      setSelectedProjectionKeys((previous) => new Set([...previous].filter((key) => {
        if (request.all) return !key.startsWith(`${request.kind}:`);
        return !request.targetIds?.some((id) => key === projectionRecordKey(request.kind, "target", id))
          && !request.proposalIds?.some((id) => key === projectionRecordKey(request.kind, "proposal", id));
      })));
      if (request.kind === "scenario" && (request.all || request.targetIds?.includes(focusedScenarioId ?? ""))) setFocusedScenarioId(null);
      const label = request.kind === "scenario" ? "场景" : "画像";
      setStatus(`已删除 ${result.projections + result.dismissals + result.proposals} 条${label}记录。`
        + (result.invalidatedProfiles ? `关联的 ${result.invalidatedProfiles} 份画像已失效。` : "")
        + (result.dependentProposals ? `已清理 ${result.dependentProposals} 条关联画像提案。` : ""));
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedShared = Boolean(fixedType && selected?.scopes.some((s) => s.scopeType !== fixedType || (s.scopeId ?? undefined) !== fixedId));

  const editSelected = async (): Promise<void> => {
    if (!selected || busy || selectedShared) return;
    const title = await requestText({
      title: "编辑记忆",
      label: "标题",
      initialValue: selected.title,
      multiline: false,
      allowEmpty: false,
      maxLength: 240,
      confirmLabel: "下一步",
    });
    if (title === null) return;
    const content = await requestText({
      title: "编辑记忆",
      label: "内容（可留空）",
      initialValue: selected.content,
      multiline: true,
      allowEmpty: true,
      maxLength: 6000,
      confirmLabel: "保存",
    });
    if (content === null) return;
    setBusy(true);
    try {
      await window.api?.memory?.update({
        id: selected.id,
        title: title.trim(),
        content: content.trim(),
        changedBy: "manual",
        changeReason: "settings memory manager edit",
      });
      setStatus("记忆已更新。");
      await load();
      await select(selected.id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const patchSelected = async (patch: Partial<Pick<MemoryUpdateRequest, "kind" | "status">>): Promise<void> => {
    if (!selected || busy || selectedShared) return;
    setBusy(true);
    try {
      await window.api?.memory?.update({ id: selected.id, ...patch, changedBy: "manual", changeReason: "settings memory manager field edit" });
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const scopeDisplayName = (s: { scopeType: MemoryScopeType; scopeId?: string }): string => {
    if (!s.scopeId) return "";
    if (s.scopeType === "workspace") return spaces.find((item) => item.id === s.scopeId)?.name ?? s.scopeId;
    if (s.scopeType === "project") return projects.find((item) => item.id === s.scopeId)?.name ?? s.scopeId;
    if (s.scopeType === "task") return tasks.find((item) => item.id === s.scopeId)?.title ?? s.scopeId;
    if (s.scopeType === "bot") return bots.find((item) => item.botId === s.scopeId)?.displayName ?? s.scopeId;
    return s.scopeId;
  };

  const detachScopeBinding = async (s: MemoryScopeDto): Promise<void> => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const result = await window.api?.memory?.detachScope(selected.id, s.scopeType, s.scopeId);
      if (result?.forgotten) {
        clearSelection();
        setStatus("已移除最后的作用域，记忆已硬删除。");
      } else {
        setStatus("作用域绑定已移除。");
      }
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const requestDetach = (s: MemoryScopeDto): void => {
    if (!selected) return;
    if (selected.scopes.length <= 1) setPendingDetach(s);
    else void detachScopeBinding(s);
  };

  const retryFailed = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const reset = (await window.api?.memory?.retryFailedTurns()) ?? 0;
      setStatus(reset > 0 ? `已重新排队 ${reset} 条失败对话，正在后台重试。` : "没有可重试的对话；回收区任务和已归档项目不会提炼。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const extractPending = async (): Promise<void> => {
    const api = window.api?.memory;
    if (busy || !api) return;
    setBusy(true);
    setStatus("正在处理待提炼对话…回收区任务和已归档项目会跳过。");
    try {
      const result = await api.extractPendingTurns();
      setStatus(`${result.interrupted ? "处理已中断" : "处理完成"}：提炼 ${result.processedTurns} 条，失败 ${result.failedTurns} 条，跳过 ${result.skippedTasks} 个不可提炼任务。`);
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const promoteSelected = async (): Promise<void> => {
    if (!selected || busy) return;
    if (promoteType !== "global" && !promoteTarget) return;
    setBusy(true);
    try {
      await window.api?.memory?.promote(selected.id, promoteType, promoteType === "global" ? undefined : promoteTarget);
      setPromoteTarget("");
      setStatus("作用域已更新。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteAllTurns = async (): Promise<void> => {
    const api = window.api?.memory;
    if (busy || !api) return;
    setConfirmDeleteAllTurns(false);
    setBusy(true);
    try {
      const deleted = await api.deleteAllTurns();
      setL0FocusId(null);
      setL0ResetVersion((version) => version + 1);
      setStatus(`已删除全部 ${deleted} 条对话来源。已生成记忆及其证据摘录仍保留。`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedTurns = async (ids: string[]): Promise<boolean> => {
    const api = window.api?.memory;
    if (busy || !api || !ids.length) return false;
    setBusy(true);
    try {
      const deleted = await api.deleteTurns(ids);
      if (l0FocusId && ids.includes(l0FocusId)) setL0FocusId(null);
      setStatus(`已删除 ${deleted} 条选中的对话来源。已生成记忆及其证据摘录仍保留。`);
      await load();
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runCandidateDecision = async (id: string, action: "approve" | "reject"): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.api?.memory?.resolveCandidate(id, action);
      if (result?.status === "committed") setStatus("候选已批准并写入记忆。");
      else if (result?.status === "rejected") setStatus(action === "approve" ? "与现有记忆重复，候选已按重复关闭。" : "候选已拒绝。");
      else setStatus("候选仍需复核。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const decideCandidate = (item: MemoryCandidateDto, action: "approve" | "reject"): void => {
    if (action === "approve" && item.operationHint === "forget") {
      setPendingForgetCandidate(item);
      return;
    }
    void runCandidateDecision(item.id, action);
  };

  const deleteMemories = async (ids: string[]): Promise<void> => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    try {
      if (fixedType) {
        for (const id of ids) await window.api?.memory?.detachScope(id, fixedType, fixedId);
      } else await window.api?.memory?.forget(ids);
      clearSelection();
      setStatus(fixedType ? `已从${scopeName}移除记忆，其他作用域的记忆不受影响。` : ids.length === 1 ? "记忆已硬删除。" : "已硬删除 " + ids.length + " 条记忆。");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      await load();
    } finally {
      setPendingDelete(null);
      setBusy(false);
    }
  };

  const reindex = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatus("正在补齐语义索引…");
    try {
      const result = await window.api?.memory?.reindexSemantic(2000);
      if (result) setStatus(`语义索引完成：${result.indexed} 条成功，${result.failed} 条失败/不可用`);
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section memory-explorer" style={{ marginTop: 14 }}>
      {!fixedType && <MemoryOrganizationPanel activeCount={stats?.active ?? 0} onChanged={load} onOpen={(id) => void openL1Memory(id)}
        scopeName={(s) => `${SCOPE_LABEL[s.scopeType]}${s.scopeId ? ` · ${scopeDisplayName(s)}` : ""}`} />}
      {!fixedType && <div className="memory-overview" aria-label="记忆概览">
        <div><strong>{stats?.active ?? 0}</strong><span>有效记忆</span></div>
        <div><strong>{Math.max(0, (stats?.total ?? 0) - (stats?.active ?? 0))}</strong><span>历史记录</span></div>
        <div><strong>{stats?.candidates?.["needs_review"] ?? review.length}</strong><span>待复核</span></div>
      </div>}
      <div className="settings-section-head">
        <div>
          <div className="settings-section-title">{fixedType ? `${scopeName}的记忆` : "记忆内容与来源"}</div>
          <div className="settings-section-desc">
            {fixedType ? fixedType === "bot" ? "同一 Bot 的新旧对话共享这些记忆；其他 Bot 不会自动读取。" : fixedType === "global" ? "只有明确共享的条目会供 Bot 和团队读取；旧全局记忆默认不共享。" : "仅管理当前归属的记忆，不会读取或修改其他 Bot 的私人记忆。" : "默认查看有效记忆。原始对话、证据和历史版本保留，可随时追溯。"}
          </div>
        </div>
      </div>
      <div className="settings-section-card" style={{ padding: 12 }}>
        {!fixedType && <div className="ext-subnav" role="tablist" aria-label="记忆层级" style={{ marginBottom: 10 }}>
          {([
            ["l1", "记忆条目", stats?.total ?? records.length],
            ["l0", "对话来源", stats?.l0Turns ?? 0],
            ["l2", "有效场景", stats?.scenarios ?? 0],
            ["l3", "有效画像", stats?.coreProfiles ?? 0],
          ] as const).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={layer === id}
              className={`ext-subnav-btn ${layer === id ? "active" : ""}`}
              onClick={() => setLayer(id)}
            >
              {label} · {count}
            </button>
          ))}
        </div>}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
          {layer === "l0" ? <span className="memory-count">待提炼 {stats?.pendingTurns ?? 0}</span> : null}
          {layer === "l0" && (stats?.failedTurns ?? 0) > 0 ? <span className="memory-count">失败 {stats?.failedTurns}</span> : null}
          {layer === "l1" && (stats?.candidates?.["needs_review"] ?? review.length) > 0 ? (
            <span className="memory-count">待复核 {stats?.candidates?.["needs_review"] ?? review.length}</span>
          ) : null}
          <span style={{ flex: 1 }} />
          {layer === "l1" ? (
            <>
              {fixedType && <CreateScopedMemory key={fixedType + ":" + fixedId} scopeType={fixedType} scopeId={fixedId} onChanged={load} />}
              {!fixedType && <button type="button" className="btn" disabled={busy} onClick={() => void reindex()}>补齐语义索引</button>}
              <button
                type="button"
                className="btn danger"
                disabled={busy || records.length === 0}
                onClick={() => setPendingDelete({
                  ids: records.map((item) => item.id),
                  label: listIsPartial ? "当前筛选结果 " + records.length + " 条记忆" : "全部 " + records.length + " 条记忆",
                })}
              >
                {fixedType ? `清除${scopeName}的记忆` : listIsPartial ? "删除筛选结果" : "删除全部记忆条目"}
              </button>
            </>
          ) : null}
          {layer === "l0" && (stats?.failedTurns ?? 0) > 0 ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void retryFailed()}>重试失败提炼</button>
          ) : null}
          {layer === "l0" && (stats?.pendingTurns ?? 0) > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void extractPending()}>处理待提炼对话</button>}
          {layer === "l0" && <button type="button" className="btn danger" disabled={busy || loading || !stats?.l0Turns} onClick={() => setConfirmDeleteAllTurns(true)}>删除全部对话来源</button>}
          {(layer === "l2" || layer === "l3") && <button type="button" className="btn" disabled={busy || loading} aria-pressed={showProjectionHistory} onClick={() => setShowProjectionHistory((v) => !v)}>{showProjectionHistory ? "收起历史" : "查看过期历史"} · {(layer === "l2" ? scenarios : profiles).filter((item) => item.status !== "active").length}</button>}
          <button type="button" className="btn" disabled={busy || loading} onClick={() => void load()}>{loading ? "刷新中…" : "刷新"}</button>
        </div>

        {status ? <div className="memory-status" role="status">{status}</div> : null}

        {projectionKind && <div className="memory-toolbar memory-projection-toolbar">
          <label className="memory-select-all">
            <input ref={projectionSelectAllRef} type="checkbox" checked={allProjectionsSelected} disabled={busy || loading || selectableProjections.length === 0} onChange={(event) => setSelectedProjectionKeys(event.currentTarget.checked ? new Set(selectableProjections.map((item) => item.key)) : new Set())} />
            全选当前列表
          </label>
          <span className="memory-count">已选 {selectedProjections.length} 条</span>
          <div className="memory-toolbar-actions">
            <button type="button" className="btn" disabled={busy || loading || selectedProjections.length === 0} onClick={() => setSelectedProjectionKeys(new Set())}>清空选择</button>
            <button type="button" className="btn danger" disabled={busy || loading || selectedProjections.length === 0} onClick={() => setPendingProjectionDelete({
              request: {
                kind: projectionKind,
                targetIds: selectedProjections.filter((item) => item.type === "target").map((item) => item.id),
                proposalIds: selectedProjections.filter((item) => item.type === "proposal").map((item) => item.id),
              },
              label: projectionKind === "scenario" ? "场景记录" : "画像记录",
              selectionCount: selectedProjections.length,
            })}>删除选中（{selectedProjections.length}）</button>
            <button type="button" className="btn danger" disabled={busy || loading} onClick={() => setPendingProjectionDelete({ request: { kind: projectionKind, all: true }, label: projectionKind === "scenario" ? "全部场景记录" : "全部画像记录" })}>删除全部{projectionKind === "scenario" ? "场景" : "画像"}记录</button>
          </div>
        </div>}

        {layer === "l0" ? (
          <MemoryL0Explorer key={l0ResetVersion} focusTurnId={l0FocusId} refreshVersion={refreshVersion} busy={busy} onDeleteTurns={deleteSelectedTurns} onOpenMemory={(id) => void openL1Memory(id)} />
        ) : null}

        <div style={{ display: layer === "l1" ? "block" : "none", marginBottom: 10 }}>
          {!fixedType && <div className="memory-scope-filter">
            <label htmlFor="memory-scope-filter">浏览范围</label>
            <select id="memory-scope-filter" className="new-project-input" aria-label="筛选记忆范围" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="all">全部范围 · {stats?.total ?? records.length}</option>
              <option value="global">全局 · {stats?.byScope?.global ?? 0}</option>
              <option value="project">项目 · {stats?.byScope?.project ?? 0}</option>
              <option value="workspace">工作空间 · {stats?.byScope?.workspace ?? 0}</option>
              <option value="task">任务级 · {stats?.byScope?.task ?? 0}</option>
              <option value="bot">Bot 私人记忆 · {stats?.byScope?.bot ?? 0}</option>
              {(["team", "conversation", "work"] as const).map(type => <option key={type} value={type}>{SCOPE_LABEL[type]} · {stats?.byScope?.[type] ?? 0}</option>)}
            </select>
            {scope === "bot" && <select className="new-project-input" aria-label="筛选 Bot 记忆" value={botScopeId} onChange={(event) => setBotScopeId(event.target.value)}>
              <option value="">全部 Bot</option>
              {bots.map((bot) => <option key={bot.botId} value={bot.botId}>{bot.displayName}</option>)}
            </select>}
            <span>仅筛选列表，AI 整理始终覆盖全部范围</span>
          </div>}
          <div className="memory-filters">
            <input
              className="new-project-input"
              aria-label="搜索记忆条目"
              value={query}
              placeholder={fixedType ? `搜索${scopeName}的记忆` : scope === "all" ? "搜索全部记忆条目" : scope === "bot" ? "搜索 Bot 私人记忆" : `搜索${SCOPE_LABEL[scope] ?? scope}记忆`}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select className="new-project-input" aria-label="筛选记忆类型" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="all">全部类型</option>
              {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select className="new-project-input" aria-label="筛选记忆状态" value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
              <option value="all">全部状态</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>

        <div className="memory-split" style={{ display: layer === "l1" ? undefined : "none", minHeight: 220 }}>
          <div className="memory-record-list">
            {records.length === 0 ? (
              <div className="memory-empty" style={{ padding: 14 }}>{filtering ? "暂无匹配记忆" : "暂无记忆"}</div>
            ) : records.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void select(item.id)}
                className={`memory-record-row ${selectedId === item.id ? "active" : ""}`}
                aria-pressed={selectedId === item.id}
              >
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</strong>
                  <span style={{ flex: 1 }} />
                  <span className="memory-source manual">{KIND_LABEL[item.kind] ?? item.kind}</span>
                </div>
                {item.content && <div className="memory-record-excerpt">{item.content}</div>}
                <div className="settings-row-desc" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.scopes.map((s) => `${SCOPE_LABEL[s.scopeType] ?? s.scopeType}${s.scopeId ? "·" + scopeDisplayName(s) : ""}${s.binding === "promoted" ? "↑" : ""}`).join(" · ")} · {STATUS_LABEL[item.status] ?? item.status} · {fmt(item.updatedAt)}
                </div>
              </button>
            ))}
            {records.length >= 500 ? <div className="settings-row-desc" style={{ padding: "6px 10px" }}>结果已达 500 条上限，请用筛选缩小范围</div> : null}
          </div>

          <div className="memory-record-detail">
            {!selected ? (
              <div className="memory-empty">选择一条记忆查看来源、证据与修改历史。</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{selected.title}</div>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn" disabled={busy || selectedShared} onClick={() => void editSelected()}>编辑</button>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() => setPendingDelete({ ids: [selected.id], label: "记忆「" + selected.title + "」" })}
                  >
                    删除
                  </button>
                </div>
                {selectedShared && <p className="settings-row-desc">此条是历史共享记忆。在此仅能移除当前归属的关联，不修改其他作用域；如需更正共享内容，请到全局记忆设置。</p>}
                {selected.scopes.some(s => s.scopeType === "global") && <PublicMemorySharing memory={selected} disabled={busy || selectedShared} onChanged={load} />}
                {selected.content ? <div style={{ whiteSpace: "pre-wrap", marginBottom: 9 }}>{selected.content}</div> : null}
                <div className="settings-row-desc" style={{ lineHeight: 1.65 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    类型：
                    <select className="new-project-input" style={{ width: "auto", padding: "2px 4px" }} value={selected.kind} disabled={busy || selectedShared} onChange={(e) => void patchSelected({ kind: e.target.value as MemoryKind })}>
                      {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    状态：
                    <select className="new-project-input" style={{ width: "auto", padding: "2px 4px" }} value={selected.status} disabled={busy || selectedShared} onChange={(e) => void patchSelected({ status: e.target.value as MemoryStatus })}>
                      {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </div>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                    作用域：
                    {selected.scopes.map((s) => (
                      <span key={`${s.scopeType}:${s.scopeId ?? ""}:${s.binding}`} className="memory-source manual" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                        {SCOPE_LABEL[s.scopeType] ?? s.scopeType}{s.scopeId ? `·${scopeDisplayName(s)}` : ""}{s.binding === "promoted" ? "↑" : ""}
                        {!fixedType && <button
                          type="button"
                          aria-label="解绑作用域"
                          disabled={busy}
                          onClick={() => requestDetach(s)}
                          style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}
                        >×</button>}
                      </span>
                    ))}
                  </div>
                  {!fixedType && <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                    <select className="new-project-input" style={{ width: "auto", padding: "2px 4px" }} value={promoteType} disabled={busy} onChange={(e) => { setPromoteType(e.target.value as "global" | "workspace" | "project"); setPromoteTarget(""); }}>
                      <option value="global">绑定全局</option>
                      <option value="workspace">绑定工作空间</option>
                      <option value="project">绑定项目</option>
                    </select>
                    {promoteType !== "global" ? (
                      <select className="new-project-input" style={{ width: "auto", maxWidth: 180, padding: "2px 4px" }} value={promoteTarget} disabled={busy || promoteChoices.length === 0} onChange={(e) => setPromoteTarget(e.target.value)}>
                        <option value="">{promoteChoices.length ? "选择目标…" : "无可绑定目标"}</option>
                        {promoteChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
                      </select>
                    ) : null}
                    <button type="button" className="btn" disabled={busy || (promoteType === "global" ? alreadyGlobal : !promoteTarget)} onClick={() => void promoteSelected()}>提升作用域</button>
                  </div>}
                  <div>重要度：{selected.importance} · 置信度：{selected.confidence.toFixed(2)} · 显式：{selected.explicit ? "是" : "否"}</div>
                  <div>来源：{selected.sourceType}{selected.sourceTaskId ? ` · ${selected.sourceTaskId}` : ""}</div>
                  <div>召回：{selected.recallCount} 次 · 最近 {fmt(selected.lastRecalledAt)}</div>
                </div>
                <details className="memory-detail-fold"><summary>证据 · {selected.evidence.length}</summary>
                <div className="settings-row-desc">
                  {selected.evidence.length ? selected.evidence.map((ev) => (
                    <div key={ev.id} style={{ marginBottom: 4 }}>
                      {ev.evidenceKind === "conversation" ? (
                        <>
                          {!fixedType && <button type="button" className="btn" onClick={() => void openL0Evidence(ev.refId)}>
                            查看对话原文
                          </button>}
                          {ev.excerpt ? <div style={{ whiteSpace: "pre-wrap", marginTop: 3 }}>{ev.excerpt}</div> : null}
                        </>
                      ) : (
                        <span>{ev.evidenceKind} · {ev.refTitle ?? ev.refId}</span>
                      )}
                    </div>
                  )) : "暂无证据"}
                </div>
                </details>
                <details className="memory-detail-fold"><summary>关联记忆 · {selected.relations.length}</summary>
                <div className="settings-row-desc">
                  {selected.relations.length ? selected.relations.map((rel) => (
                    <div key={rel.id}>{rel.relation} · {rel.fromMemoryId === selected.id ? rel.toMemoryId : rel.fromMemoryId}</div>
                  )) : "暂无关系"}
                </div>
                </details>
                <details className="memory-detail-fold"><summary>修改历史 · {history.length}</summary>
                <div className="settings-row-desc">
                  {history.length ? history.map((rev) => (
                    <div key={rev.id} style={{ marginBottom: 5 }}>
                      r{rev.revision} · {fmt(rev.createdAt)} · {STATUS_LABEL[rev.status] ?? rev.status} · {rev.changedBy}
                      {rev.changeReason ? ` · ${rev.changeReason}` : ""}
                    </div>
                  )) : "暂无修改记录"}
                </div>
                </details>
              </>
            )}
          </div>
        </div>

        <div style={{ display: layer === "l2" ? "block" : "none", marginTop: 10, border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontWeight: 600 }}>场景</div>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" disabled={busy} onClick={() => void generateProposals("l2")}>生成场景提案</button>
          </div>
          <div className="settings-row-desc" style={{ marginBottom: 8 }}>
            根据记忆条目整理相关场景，生成并批准后才会使用。删除场景会清理相关提案和屏蔽记录，保留来源记忆。
          </div>
          {scenarios.filter((item) => showProjectionHistory || item.status === "active").length === 0 ? (
            <div className="memory-empty">暂无有效场景。点击「生成场景提案」整理当前记忆。</div>
          ) : scenarios.filter((item) => showProjectionHistory || item.status === "active").map((scenario) => (
            <div key={scenario.id} tabIndex={-1} ref={scenario.id === focusedScenarioId ? scenarioFocusRef : undefined} className={scenario.id === focusedScenarioId ? "memory-projection-focus" : undefined} style={{ padding: "8px 0", borderTop: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {projectionCheckbox("scenario", "target", scenario.id, `场景：${scenario.title}`)}
                <strong>{scenario.title}</strong>
                <span className="memory-source manual">{SCOPE_LABEL[scenario.scopeType] ?? scenario.scopeType}{scenario.scopeId ? `·${scopeDisplayName(scenario)}` : ""}</span>
                {scenario.status === "stale" ? <span className="memory-source manual">已过期 · 不再使用</span> : null}
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" disabled={busy} onClick={() => void dismissProjection(scenario.id, "scenario", scenario.title)}>屏蔽</button>
                <button type="button" className="btn danger" aria-label={`删除场景：${scenario.title}`} disabled={busy} onClick={() => setPendingProjectionDelete({ request: { kind: "scenario", targetIds: [scenario.id] }, label: scenario.title })}>删除</button>
              </div>
              <div className="settings-row-desc" style={{ whiteSpace: "pre-wrap", marginTop: 3 }}>
                {scenario.summary}
              </div>
              <div className="settings-row-desc" style={{ marginTop: 5 }}>
                <span>来源记忆 {scenario.sourceMemoryIds.length} 条 · {fmt(scenario.updatedAt)}</span>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                  {scenario.sourceMemoryIds.map((id) => {
                    const source = records.find((item) => item.id === id);
                    return (
                      <button key={id} type="button" className="btn" onClick={() => void openL1Memory(id)}>
                        {source?.title ?? id.slice(0, 14)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: layer === "l3" ? "block" : "none", marginTop: 10, border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontWeight: 600 }}>核心画像</div>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn" disabled={busy} onClick={() => void generateProposals("l3")}>生成画像提案</button>
          </div>
          <div className="settings-row-desc" style={{ marginBottom: 8 }}>
            根据已批准的场景整理长期特征。每个记忆范围最多一份画像，批准后才会使用。
          </div>
          {profiles.filter((item) => showProjectionHistory || item.status === "active").length === 0 ? (
            <div className="memory-empty">尚未形成高层画像。</div>
          ) : profiles.filter((item) => showProjectionHistory || item.status === "active").map((profile) => (
            <div key={profile.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                {projectionCheckbox("profile", "target", profile.id, `画像：${profile.title}`)}
                <strong>{profile.title}</strong>
                <span className="memory-source manual">{SCOPE_LABEL[profile.scopeType] ?? profile.scopeType}{profile.scopeId ? `·${scopeDisplayName(profile)}` : ""}</span>
                {profile.status === "stale" ? <span className="memory-source manual">已过期 · 不再使用</span> : null}
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" disabled={busy} onClick={() => void dismissProjection(profile.id, "profile", profile.title)}>屏蔽</button>
                <button type="button" className="btn danger" aria-label={`删除画像：${profile.title}`} disabled={busy} onClick={() => setPendingProjectionDelete({ request: { kind: "profile", targetIds: [profile.id] }, label: profile.title })}>删除</button>
              </div>
              <div className="settings-row-desc" style={{ whiteSpace: "pre-wrap", marginTop: 3 }}>
                {profile.content}
              </div>
              <div className="settings-row-desc" style={{ marginTop: 5 }}>
                <span>来源场景 {profile.sourceScenarioIds.length} 个 · {fmt(profile.updatedAt)}</span>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                  {profile.sourceScenarioIds.map((id) => {
                    const source = scenarios.find((item) => item.id === id);
                    return (
                      <button key={id} type="button" className="btn" onClick={() => { if (!source) { setStatus("来源场景已删除。"); return; } setShowProjectionHistory(source.status !== "active"); setFocusedScenarioId(id); setLayer("l2"); }}>
                        {source?.title ?? id.slice(0, 14)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>

        {(layer === "l2" || layer === "l3") && visiblePendingProposals.length > 0 ? (
          <div style={{ marginTop: 10, border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>待批准提案 {visiblePendingProposals.length}</div>
            <div className="settings-row-desc" style={{ marginBottom: 8 }}>
              场景和画像提案经你批准后才会用于后续回答；拒绝的同内容提案不再出现。
            </div>
            {visiblePendingProposals.map((item) => (
              <div key={item.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  {projectionCheckbox(item.kind, "proposal", item.id, `提案：${item.title}`)}
                  <span className="memory-source manual">{item.kind === "scenario" ? "场景" : "画像"}</span>
                  <strong>{item.title}</strong>
                  <span className="memory-source manual">{SCOPE_LABEL[item.scopeType] ?? item.scopeType}{item.scopeId ? `·${scopeDisplayName(item)}` : ""}</span>
                  <span className="settings-row-desc">来源 {item.sourceIds.length} · {fmt(item.updatedAt)}</span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn" disabled={busy} onClick={() => void decideProposal(item, "reject")}>拒绝</button>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void decideProposal(item, "approve")}>批准</button>
                  <button type="button" className="btn danger" aria-label={`删除提案：${item.title}`} disabled={busy} onClick={() => setPendingProjectionDelete({ request: { kind: item.kind, proposalIds: [item.id] }, label: item.title })}>删除</button>
                </div>
                <div className="settings-row-desc" style={{ whiteSpace: "pre-wrap", marginTop: 3 }}>{item.body}</div>
              </div>
            ))}
          </div>
        ) : null}

        {(layer === "l2" || layer === "l3") && (visibleDismissed.length > 0 || visibleRejectedProposals.length > 0) ? (
          <div style={{ marginTop: 10, border: "1px solid var(--border-subtle, rgba(128,128,128,.2))", borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>已屏蔽 / 已拒绝 {visibleDismissed.length + visibleRejectedProposals.length}</div>
            <div className="settings-row-desc" style={{ marginBottom: 8 }}>
              屏蔽的投影不会再自动重建；拒绝的提案恢复到待批准可重新审批。
            </div>
            {visibleDismissed.map((item) => (
              <div key={item.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
                {projectionCheckbox(item.kind, "target", item.id, `屏蔽记录：${item.title}`)}
                <span className="memory-source manual">{item.kind === "scenario" ? "场景" : "画像"}</span>
                <strong>{item.title}</strong>
                <span className="memory-source manual">{SCOPE_LABEL[item.scopeType] ?? item.scopeType}{item.scopeId ? `·${scopeDisplayName(item)}` : ""}</span>
                <span className="memory-source manual">已屏蔽</span>
                <span className="settings-row-desc">{fmt(item.dismissedAt)}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" disabled={busy} onClick={() => void restoreProjection(item)}>恢复</button>
                <button type="button" className="btn danger" aria-label={`删除屏蔽记录：${item.title}`} disabled={busy} onClick={() => setPendingProjectionDelete({ request: { kind: item.kind, targetIds: [item.id] }, label: item.title })}>删除</button>
              </div>
            ))}
            {visibleRejectedProposals.map((item) => (
              <div key={item.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--border-subtle, rgba(128,128,128,.12))" }}>
                {projectionCheckbox(item.kind, "proposal", item.id, `提案：${item.title}`)}
                <span className="memory-source manual">{item.kind === "scenario" ? "场景" : "画像"}</span>
                <strong>{item.title}</strong>
                <span className="memory-source manual">{SCOPE_LABEL[item.scopeType] ?? item.scopeType}{item.scopeId ? `·${scopeDisplayName(item)}` : ""}</span>
                <span className="memory-source manual">已拒绝</span>
                <span className="settings-row-desc">{fmt(item.updatedAt)}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" disabled={busy} onClick={() => void decideProposal(item, "restore")}>恢复为待批准</button>
                <button type="button" className="btn danger" aria-label={`删除提案：${item.title}`} disabled={busy} onClick={() => setPendingProjectionDelete({ request: { kind: item.kind, proposalIds: [item.id] }, label: item.title })}>删除</button>
              </div>
            ))}
          </div>
        ) : null}

        {layer === "l1" && review.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>待复核候选 {stats?.candidates?.["needs_review"] ?? review.length}</div>
            <div className="settings-row-desc" style={{ marginBottom: 4 }}>
              这些内容需要你确认。批准后会按标注的操作新建、更新或处理相关记忆；拒绝后不会保存为记忆。
            </div>
            <div>
              {review.slice(0, 8).map((item) => (
                <div key={item.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--border-subtle, rgba(128,128,128,.1))" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="memory-source manual">{OP_LABEL[item.operationHint] ?? item.operationHint}</span>
                    <span className="memory-source manual">{KIND_LABEL[item.kind] ?? item.kind}</span>
                    <strong>{item.title}</strong>
                    <span className="settings-row-desc">置信度 {item.confidence.toFixed(2)} · {SCOPE_LABEL[item.scopeType] ?? item.scopeType}{item.replaces ? ` · 目标：${item.replaces}` : ""}</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="btn" disabled={busy} onClick={() => decideCandidate(item, "reject")}>拒绝</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => decideCandidate(item, "approve")}>{item.operationHint === "forget" ? "批准删除" : "批准"}</button>
                  </div>
                  {item.content ? <div className="settings-row-desc" style={{ marginTop: 3, whiteSpace: "pre-wrap" }}>{item.content}</div> : null}
                </div>
              ))}
              {review.length > 8 ? <div className="settings-row-desc" style={{ marginTop: 4 }}>另有 {review.length - 8} 条未展开</div> : null}
            </div>
          </div>
        ) : null}
      </div>
      {textPromptDialog}
      <ConfirmDialog
        open={pendingProjectionDelete !== null}
        title={pendingProjectionDelete?.request.all ? `删除${pendingProjectionDelete.label}？` : pendingProjectionDelete?.selectionCount ? `删除选中的 ${pendingProjectionDelete.selectionCount} 条记录？` : "删除这条记录？"}
        body={pendingProjectionDelete && <>
          {pendingProjectionDelete.request.all
            ? `将永久删除全部${pendingProjectionDelete.request.kind === "scenario" ? "场景" : "画像"}记录，包括有效记录、过期历史、屏蔽记录以及待批准／已拒绝提案，不受当前显示数量限制。`
            : pendingProjectionDelete.selectionCount
              ? `将永久删除选中的 ${pendingProjectionDelete.selectionCount} 条${pendingProjectionDelete.label}。${pendingProjectionDelete.request.targetIds?.length ? "所选记录的相关提案和屏蔽记录也会清理。" : ""}`
              : `将永久删除「${pendingProjectionDelete.label}」${pendingProjectionDelete.request.targetIds?.length ? "及其相关提案和屏蔽记录" : "这条提案"}。`}
          此操作不可恢复。<br />
          对话来源和记忆条目仍保留。{pendingProjectionDelete.request.kind === "scenario" && (pendingProjectionDelete.request.all || pendingProjectionDelete.request.targetIds?.length) ? "引用这些场景的画像会失效，相关画像提案会清理。" : ""}<br />
          删除前正在生成的相关提案会被丢弃。之后手动生成并批准，可再次形成新的场景或画像。
        </>}
        confirmLabel={pendingProjectionDelete?.request.all ? "确认删除全部记录" : pendingProjectionDelete?.selectionCount ? "确认删除选中记录" : "确认删除记录"}
        danger
        onCancel={() => setPendingProjectionDelete(null)}
        onConfirm={() => void deleteProjectionRecords()}
      />
      <ConfirmDialog
        open={confirmDeleteAllTurns}
        title="删除全部对话来源？"
        body={<>
          将永久删除全部任务当前保存的对话来源原文（当前共 {stats?.l0Turns ?? 0} 条），包括待提炼、提炼中和回收区记录，不受当前筛选或显示条数限制。此操作不可恢复。
          <br />
          任务聊天记录、已生成的记忆及其证据摘录、技能和审核快照仍保留。删除前尚未完成的提炼结果会被丢弃。
          <br />
          记忆开启时，后续新对话仍会继续记录。
        </>}
        confirmLabel="确认删除全部来源"
        danger
        onCancel={() => setConfirmDeleteAllTurns(false)}
        onConfirm={() => void deleteAllTurns()}
      />
      <ConfirmDialog
        open={pendingDetach !== null}
        title="解绑最后的作用域？"
        body={pendingDetach ? <>该记忆仅属于「{SCOPE_LABEL[pendingDetach.scopeType] ?? pendingDetach.scopeType}」。解除最后的归属后，整条记忆（含证据、修改历史、关系）将被删除，不可恢复。</> : null}
        confirmLabel="解绑并删除"
        danger
        onCancel={() => setPendingDetach(null)}
        onConfirm={() => {
          const scope = pendingDetach;
          setPendingDetach(null);
          if (scope) void detachScopeBinding(scope);
        }}
      />
      <ConfirmDialog
        open={pendingForgetCandidate !== null}
        title="批准删除建议？"
        body={pendingForgetCandidate ? <>该候选建议执行 forget：将硬删除与「{pendingForgetCandidate.title}」最相似的一条现有记忆，且不可恢复。</> : null}
        confirmLabel="批准删除"
        danger
        onCancel={() => setPendingForgetCandidate(null)}
        onConfirm={() => {
          const candidate = pendingForgetCandidate;
          setPendingForgetCandidate(null);
          if (candidate) void runCandidateDecision(candidate.id, "approve");
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.ids.length === 1 ? "删除这条记忆？" : "批量删除记忆？"}
        body={
          pendingDelete ? (
            <>
              {fixedType ? `将从${scopeName}移除${pendingDelete.label}。若记忆还有其他作用域，其内容保留；仅属于当前归属的条目将删除。` : <>将删除{pendingDelete.label}，同时清理其归属范围、证据、修改历史、关系和检索索引。</>}
              <br />
              此操作不可恢复。
              <br />
              原始对话及已生成的技能文件仍保留；关联场景、画像和技能候选会失效，历史快照仅供审核。
            </>
          ) : null
        }
        confirmLabel={pendingDelete?.ids.length === 1 ? "删除" : "批量删除"}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void deleteMemories(pendingDelete?.ids ?? [])}
      />
    </section>
  );
}
