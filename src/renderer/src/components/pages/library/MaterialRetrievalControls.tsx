import { useEffect, useId, useState } from "react";
import type { LibraryScopedDeepSearchRequest, LibraryDeepSearchResult } from "@shared/library-ipc";
import type { MaterialRetrievalMode, MaterialRetrievalScope } from "@shared/materialRetrieval";
import { useAppStore } from "@/store/appStore";
import "./material-retrieval-controls.css";

const modeLabel: Record<MaterialRetrievalMode, string> = {
  keyword: "关键词检索",
  hybrid: "混合检索",
};

function retrievalError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  return cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "") || fallback;
}

export function MaterialRetrievalRow({ scope, readOnly }: {
  scope: MaterialRetrievalScope;
  readOnly?: boolean;
}): React.JSX.Element {
  const description = useId();
  const { kind, id } = scope;
  const api = window.api?.materialRetrieval;
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const [value, setValue] = useState<Awaited<ReturnType<NonNullable<typeof api>["getScope"]>>>();
  const sourceName = useAppStore((state) => state.spaces.find((space) => space.id === value?.sourceId)?.name);
  const source = value?.override ? "本级覆盖" : value?.source === "space" ? sourceName ?? "上级空间" : "全局设置";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!api || settingsOpen) return;
    let active = true;
    void api.getScope({ kind, id }).then((result) => {
      if (active) setValue(result);
    }).catch((cause: unknown) => {
      if (active) setError(retrievalError(cause, "检索设置读取失败"));
    });
    return () => { active = false; };
  }, [api, kind, id, reload, settingsOpen]);

  async function change(next: MaterialRetrievalMode | null): Promise<void> {
    if (!api || busy || readOnly) return;
    setBusy(true);
    setError("");
    try {
      setValue(await api.setScope({ kind, id }, next));
    } catch (cause) {
      setError(retrievalError(cause, "检索设置保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="material-retrieval-setting">
    <label>
      <span>检索方式</span>
      <select value={value ? value.override ?? "inherit" : ""} aria-describedby={description}
        disabled={!value || busy || readOnly} onChange={(event) => {
          const next = event.target.value;
          if (next === "inherit" || next === "keyword" || next === "hybrid") {
            void change(next === "inherit" ? null : next);
          }
        }}>
        {!value && <option value="">{!api || error ? "暂不可用" : "读取中…"}</option>}
        <option value="inherit">继承上级设置</option>
        <option value="keyword">{modeLabel.keyword}</option>
        <option value="hybrid">{modeLabel.hybrid}</option>
      </select>
    </label>
    <small id={description} role="status">{value && `当前生效 · ${modeLabel[value.effective]} · ${source}`}{readOnly && " · 已归档"}</small>
    {error && <small role="alert">{error}</small>}
    {error && !value && <button type="button" className="btn" onClick={() => { setError(""); setReload(reload + 1); }}>重试</button>}
  </div>;
}

/** Mount with a key derived from the query and scope so results cannot leak across searches. */
export function MaterialDeepSearch({ request, onOpen }: {
  request: LibraryScopedDeepSearchRequest;
  onOpen: (itemId: string) => void;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<LibraryDeepSearchResult>();
  const [error, setError] = useState("");
  const openSettings = useAppStore((state) => state.setSettingsOpen);
  const modelConfigurationError = /^请先在资料检索设置中选择深搜判断模型$|^深搜判断模型不可用/.test(error);
  const [evidence, setEvidence] = useState<{
    key: string; status: "loading" | "ready" | "failed"; text?: string;
  }>();

  async function readEvidence(hit: LibraryDeepSearchResult["hits"][number], key: string): Promise<void> {
    if (pending || evidence?.status === "loading") return;
    setEvidence({ key, status: "loading" });
    try {
      const api = window.api?.library;
      if (!api?.readScopedEvidence) throw new Error("证据读取暂不可用");
      const { text } = await api.readScopedEvidence({
        owner: request.owner, reference: request.reference, filter: request.filter, itemId: hit.itemId, source: hit.source,
      });
      setEvidence({ key, status: "ready", text });
    } catch (cause) {
      setEvidence({ key, status: "failed", text: retrievalError(cause, "证据读取失败") });
    }
  }

  async function search(): Promise<void> {
    if (pending || evidence?.status === "loading" || !request.query.trim()) return;
    setResult(undefined);
    setEvidence(undefined);
    setError("");
    setPending(true);
    try {
      const api = window.api?.library;
      if (!api?.scopedDeepSearch) throw new Error("深度检索服务暂不可用");
      setResult(await api.scopedDeepSearch(request));
    } catch (cause) {
      setError(retrievalError(cause, "深度检索失败，请重试"));
    } finally {
      setPending(false);
    }
  }

  return <section className="material-deep-search" aria-label="深度检索">
    <div className="material-deep-search-action">
      <button type="button" className="btn" disabled={pending || evidence?.status === "loading" || !request.query.trim()} onClick={() => void search()}>
        深度检索
      </button>
      {result && <button type="button" className="btn" disabled={evidence?.status === "loading"} onClick={() => { setResult(undefined); setEvidence(undefined); }}>清除结果</button>}
      {pending && <small role="status">正在检索证据…</small>}
    </div>
    {error && <div className="material-deep-search-error">
      <span role="alert">{error}</span>
      {modelConfigurationError && <button type="button" className="btn" onClick={() => openSettings(true, "materialRetrieval")}>打开资料检索设置</button>}
    </div>}
    {result && <div className="material-deep-search-results">
      <p role="status">{result.hits.length ? `找到 ${result.hits.length} 段证据 · 检索 ${result.rounds} 轮` : "没有找到相关证据。可换个搜索词再试。"}</p>
      {result.hits.length > 0 && <ul aria-label="检索证据">{result.hits.map((hit) => {
        const key = `${hit.itemId}:${hit.source.startOffset}:${hit.source.endOffset}:${hit.round}`;
        const opened = evidence?.key === key ? evidence : undefined;
        return <li key={key}>
          <button type="button" className="material-deep-search-source" aria-expanded={opened?.status === "ready"}
            disabled={evidence?.status === "loading"} onClick={() => void readEvidence(hit, key)} title="读取当前原文证据">{hit.title}</button>
          <small>第 {hit.round} 轮 · 正文偏移 {hit.source.startOffset}–{hit.source.endOffset}</small>
          {opened?.status === "loading" && <small role="status">正在读取原文证据…</small>}
          {opened?.status === "failed" && <small role="alert">{opened.text}</small>}
          <p>{opened?.status === "ready" ? opened.text : hit.text}</p>
          {opened?.status === "ready" && <div><button type="button" className="btn" onClick={() => onOpen(hit.itemId)}>打开资料</button></div>}
        </li>;
      })}</ul>}
    </div>}
  </section>;
}
