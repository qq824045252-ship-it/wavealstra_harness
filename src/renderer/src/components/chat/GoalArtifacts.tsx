import { useEffect, useRef, useState } from "react";
import type { GoalSavedArtifactDto } from "@shared/conversation-goal";
import type { SavedArtifactPreview } from "@shared/saved-artifact";

const TEXT_FILE = /\.(?:txt|md|markdown|json|jsonl|csv|tsv|xml|ya?ml|log|py|js|ts|tsx|jsx|css|svg|sh|sql|ini|toml)$/i;
const HTML_FILE = /\.html?$/i;
const fileDate = (time: number): string => new Date(time).toLocaleString();

function artifactGroups(items: readonly GoalSavedArtifactDto[]): GoalSavedArtifactDto[][] {
  const groups = new Map<string, GoalSavedArtifactDto[]>();
  for (const item of items) {
    const group = groups.get(item.path) ?? [];
    group.push(item);
    groups.set(item.path, group);
  }
  // Keep the authority's order, including two registrations in the same millisecond.
  return [...groups.values()];
}

export default function GoalArtifacts({ taskId, goalId, artifacts, loading, onVerified }: {
  taskId: string;
  goalId: string;
  artifacts?: readonly GoalSavedArtifactDto[];
  loading: boolean;
  onVerified: () => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>();
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmation, setConfirmation] = useState<Record<string, number>>({});
  const [verifying, setVerifying] = useState<string>();
  const [error, setError] = useState<{ id: string; message: string }>();
  const openedFrom = useRef<HTMLButtonElement>(null);
  const groups = artifactGroups(artifacts ?? []);
  const names = new Map<string, number>();
  for (const group of groups) {
    const name = group[0].request.name;
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const closePreview = () => {
    setSelectedId(undefined);
    openedFrom.current?.focus();
  };
  const markRead = (id: string) => setReadIds(previous => previous.has(id) ? previous : new Set([...previous, id]));
  const verify = async (item: GoalSavedArtifactDto): Promise<void> => {
    if (verifying || !readIds.has(item.id)) return;
    setVerifying(item.id);
    setError(undefined);
    try {
      const receipt = await window.api?.conversationRuntime?.verifyGoalArtifact(taskId, goalId, item.id);
      if (receipt?.id !== item.id || !receipt.verification) throw new Error("该版本的核验未保存，请刷新后重试");
      const verifiedAt = receipt.verification.verifiedAt;
      setConfirmation(previous => ({ ...previous, [item.id]: verifiedAt }));
      onVerified();
    } catch (cause) {
      setError({ id: item.id, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setVerifying(undefined);
    }
  };

  return <section className="goal-artifact-section" aria-label="成果与版本">
    <h3>成果与版本</h3>
    {!groups.length && <p role={loading ? "status" : undefined}>{loading ? "正在读取成果…" : "暂无可打开的保存版本"}</p>}
    {groups.map(group => {
      const file = group[0];
      const sameNameElsewhere = (names.get(file.request.name) ?? 0) > 1;
      return <section key={file.path} className="goal-artifact">
        <h4>{file.request.name}</h4>
        {sameNameElsewhere && <small>{file.path.replace(/[/\\][^/\\]+$/, "")}</small>}
        <ul>
          {group.map((item, index) => {
            const version = item.version;
            const verifiedAt = confirmation[item.id] ?? item.verification?.verifiedAt;
            const selected = selectedId === item.id;
            return <li key={item.id}>
              <div className="goal-artifact-version">
                <span>
                  <span><strong>版本 {version}</strong>{index === 0 && " · 最新"}</span>
                  <small>{fileDate(item.registeredAt)}</small>
                </span>
                <span className={verifiedAt != null ? "goal-artifact-confirmed" : undefined} aria-live="polite">
                  {verifiedAt != null ? "我已核验" : "待核验"}
                </span>
                <div className="goal-artifact-actions">
                  <button type="button" aria-expanded={selected} aria-label={`打开 ${item.request.name} 版本 ${version}`}
                    onClick={event => {
                      openedFrom.current = event.currentTarget;
                      setSelectedId(item.id);
                    }}>打开版本 {version}</button>
                  {!selected && readIds.has(item.id) && verifiedAt == null && <button type="button" disabled={verifying !== undefined}
                    onClick={() => void verify(item)}>我已核验此版本</button>}
                </div>
              </div>
              {verifiedAt != null && <small>核验时间 {fileDate(verifiedAt)}</small>}
              {error?.id === item.id && <p role="alert">{error.message}</p>}
              {selected && <GoalArtifactPreview key={item.id} item={item} version={version} taskId={taskId} goalId={goalId}
                onClose={closePreview} onRead={() => markRead(item.id)}>
                {readIds.has(item.id) && verifiedAt == null && <button type="button" disabled={verifying !== undefined}
                  onClick={() => void verify(item)}>我已核验此版本</button>}
              </GoalArtifactPreview>}
            </li>;
          })}
        </ul>
      </section>;
    })}
  </section>;
}

function GoalArtifactPreview({ item, version, taskId, goalId, onClose, onRead, children }: {
  item: GoalSavedArtifactDto;
  version: number;
  taskId: string;
  goalId: string;
  onClose: () => void;
  onRead: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null);
  const callback = useRef(onRead);
  callback.current = onRead;
  const [content, setContent] = useState<string>();
  const [html, setHtml] = useState<SavedArtifactPreview>();
  const [error, setError] = useState("");
  const [systemNotice, setSystemNotice] = useState("");
  const [opening, setOpening] = useState(false);
  const htmlFile = HTML_FILE.test(item.request.name);
  const textFile = TEXT_FILE.test(item.request.name);
  useEffect(() => {
    close.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    let token: string | undefined;
    const saved = window.api?.savedArtifact;
    const load = async (): Promise<void> => {
      try {
        if (htmlFile) {
          if (!saved) throw new Error("文件预览服务不可用");
          const result = await saved.prepare(item.request);
          if (!active) { void saved.release(result.token).catch(() => {}); return; }
          token = result.token;
          setHtml(result);
        } else if (textFile) {
          const result = await window.api?.conversationRuntime?.readGoalArtifactText(taskId, goalId, item.id);
          if (!active) return;
          if (result === undefined) throw new Error("无法读取此保存版本");
          setContent(result);
          callback.current();
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => { active = false; if (token) void saved?.release(token).catch(() => {}); };
  }, [taskId, goalId, item.id, item.request.snapshotPath, item.request.manifestPath, item.request.name, htmlFile, textFile]);

  const openSystem = async () => {
    if (opening) return;
    setOpening(true);
    setSystemNotice("");
    try {
      const saved = window.api?.savedArtifact;
      if (!saved) throw new Error("系统打开接口不可用");
      await saved.openSystem(item.request);
      setSystemNotice("已请求系统打开此版本。查看完成后可返回确认核验。");
      callback.current();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  };

  return <section className="goal-artifact-preview" aria-label={`${item.request.name} 版本 ${version}`}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header>
      <strong>{item.request.name} · 版本 {version}</strong>
      <div className="goal-artifact-actions">
        {children}
        <button ref={close} type="button" onClick={onClose}>返回 Goal</button>
      </div>
    </header>
    {error && <p role="alert">{error}</p>}
    {html ? <iframe title={`${item.request.name} 版本 ${version}`} src={html.url}
      sandbox="allow-scripts allow-same-origin" onLoad={() => callback.current()} /> :
      content !== undefined ? <pre tabIndex={0}>{content || "文件为空。"}</pre> :
      !error && (htmlFile || textFile) ? <p role="status">正在读取保存版本…</p> : null}
    {html?.warnings.map(warning => <p key={warning} role="status">{warning}</p>)}
    <button type="button" disabled={opening} onClick={() => void openSystem()}>用系统应用打开此版本</button>
    {systemNotice && <p role="status">{systemNotice}</p>}
  </section>;
}
