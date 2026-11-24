import "./DotsResult.css";
import type { SavedArtifactRequest } from "@shared/saved-artifact";
import { lazy, Suspense, useEffect, useState } from "react";
import { DOTS_TASK_ID, type DotsDelegation, type DotsTaskDelivery } from "@shared/dots";
import { useAppStore } from "@/store/appStore";
import ChatMarkdown from "./ChatMarkdown";
import { openDotsActivityTarget, openDotsTask } from "@/lib/taskBoardVisits";
import { toRendererArtifact } from "@/lib/artifactIngest";
import { inferArtifactKind } from "@/lib/workspace";
import { ArtifactChip } from "../common/FileBadge";
import { IconDots } from "../common/icons";

const WorkFilePreview = lazy(() => import("../pages/WorkFilePreview"));
const labels = { pending: "已排队", running: "执行中", blocked: "需要你回复", completed: "已完成", failed: "失败", superseded: "已改向" };

export function useDotsDelegations(sourceKey: string | undefined) {
  const [rows, setRows] = useState<DotsDelegation[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const api = window.api?.dots;
    if (!sourceKey || !api) return;
    const sourceIds: string[] = JSON.parse(sourceKey);
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void api.list(sourceIds).then(items => {
        if (current !== generation) return;
        setRows(items);
        setError("");
      }).catch(reason => { if (current === generation) setError(String(reason)); });
    };
    const unsubscribe = api.onChanged(refresh);
    refresh();
    return () => { generation++; unsubscribe(); };
  }, [sourceKey]);
  return { rows, error };
}

export function DotsSavedFilePreview({ file, onClose }: { file: SavedArtifactRequest; onClose: () => void }) {
  return <div className="dots-result"><Suspense fallback={<span role="status">正在打开文件…</span>}>
    <WorkFilePreview target={file.snapshotPath} file={{ ref: file.snapshotPath, name: file.name, previewManifestPath: file.manifestPath }}
      onClose={onClose} />
  </Suspense></div>;
}

export function useTaskDotsDelivery(taskId: string | undefined) {
  const [loaded, setLoaded] = useState<{ taskId: string; delivery?: DotsTaskDelivery }>();
  useEffect(() => {
    const api = window.api?.dots;
    if (!taskId || !api?.taskDelivery) return;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void api.taskDelivery(taskId).then(delivery => {
        if (current === generation) setLoaded({ taskId, delivery });
      }).catch(error => {
        if (current !== generation) return;
        setLoaded({ taskId });
        console.warn("[Dots] 读取最近交付失败", error);
      });
    };
    const unsubscribe = api.onChanged(refresh);
    refresh();
    return () => { generation++; unsubscribe(); };
  }, [taskId]);
  return loaded?.taskId === taskId ? loaded?.delivery : undefined;
}

export function DotsDeliveryLink({ deliveryKey }: { deliveryKey: string }) {
  const [error, setError] = useState("");
  return <>
    <button type="button" className="icon-btn" title="查看 Dots 交付消息" aria-label="查看 Dots 交付消息"
      onClick={() => {
        setError("");
        void openDotsActivityTarget(DOTS_TASK_ID, { messageId: deliveryKey }).catch(reason => setError(String(reason)));
      }}>
      <IconDots size={14} />
    </button>
    {error && <span className="msg-generate-error" role="alert" title={error}>打开 Dots 交付失败</span>}
  </>;
}

function TaskLink({ row, onError }: { row: {taskId: string; title: string}; onError: (error: string) => void }) {
  return <button type="button" className="md-link" onClick={() => {
    onError("");
    void openDotsTask(row.taskId).catch(reason => onError(String(reason)));
  }}>{row.title}</button>;
}

export function DotsResult({ row, selected, onPreview }: {
  row: DotsDelegation; selected: boolean; onPreview: (file: SavedArtifactRequest) => void;
}): React.JSX.Element | null {
  const [error, setError] = useState("");
  const waiting = row.dependencyWait || row.status === "pending" || row.status === "running" || row.status === "superseded";
  if (!waiting && row.proactiveReply) return null;
  const files = row.status === "completed" && row.artifacts.length > 0;
  return <div className="dots-result" data-delegation-id={row.id} data-status={row.status}>
    {!files && <><TaskLink row={row} onError={setError} /><span className="dots-result-status">{row.dependencyWait ? "等待依赖" : labels[row.status]}</span></>}
    {!files && row.text && row.status !== "running" && row.status !== "superseded" && <ChatMarkdown text={row.text} streaming={false} resolveTaskFiles={false} />}
    {files && <DotsDeliveryFiles row={row} selected={selected} onPreview={onPreview} />}
    {error && <div role="alert">{error}</div>}
  </div>;
}

export function DotsDeliveryFiles({ row, selected, onPreview }: {
  row: Pick<DotsDelegation,"taskId"|"artifacts"|"title">; selected: boolean; onPreview: (file: SavedArtifactRequest) => void;
}): React.JSX.Element {
  const [error, setError] = useState("");
  const descriptors = useAppStore(s => s.artifactProjection.artifactsByTask[row.taskId]);
  const needsDescriptors = row.artifacts.some(file => !file.saved);
  useEffect(() => {
    if (needsDescriptors) void useAppStore.getState().hydrateArtifacts(row.taskId);
  }, [row.taskId, needsDescriptors]);
  return <div className="dots-result">
    {row.artifacts.length > 0 && <div className="artifact-chips">{row.artifacts.map(file => {
      const saved = file.saved;
      const descriptor = saved ? undefined : descriptors?.find(item => item.taskId === row.taskId && item.id === file.id);
      const artifact = descriptor ? toRendererArtifact(descriptor) : { id: file.id, name: file.name, content: "", kind: inferArtifactKind(file.name, "") };
      const openSaved = async () => {
        const api = window.api?.savedArtifact;
        if (!saved || !api) throw new Error("交付文件不可用");
        await api.openSystem(saved);
      };
      const preview = async () => {
        setError("");
        if (saved) {
          onPreview(saved);
          return;
        }
        if (!descriptor) {
          void useAppStore.getState().hydrateArtifacts(row.taskId);
          throw new Error("来源任务的文件尚不可用");
        }
        if (useAppStore.getState().activeTaskId === DOTS_TASK_ID) useAppStore.getState().openArtifact(descriptor.id);
      };
      return <ArtifactChip key={file.id} artifact={saved ? { ...artifact, path: saved.snapshotPath } : artifact}
        onPreview={() => void preview().catch(reason => setError(String(reason)))}
        onSystemOpen={saved ? () => void openSaved().catch(reason => setError(String(reason))) : undefined} />;
    })}</div>}
    {selected && <TaskLink row={row} onError={setError} />}
    {error && <div role="alert">{error}</div>}
  </div>;
}
