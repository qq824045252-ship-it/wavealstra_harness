/**
 * TaskWriteGrantsMenu — 聊天头部「更多」任务菜单。
 *
 * 入口：聊天头部「更多」按钮。菜单内包含两项：
 * - 「执行诊断」：打开当前任务的执行诊断弹窗（模型/工具/等待/缓存记录，只读）；
 * - 「外部写入授权」：查看/撤销当前任务的授权写入目录。语义是权限管理，
 *   不属于 Artifact（产物）范畴，故不放在 Artifact Panel。
 *
 * 行为：
 * - 打开即从主进程加载当前任务已授权目录（listTaskWriteGrants）；
 * - 逐条显示 canonical 路径 + 授权时间；每条可「移除/撤销」；
 * - 撤销成功后立即刷新列表；撤销失败显示可理解错误，列表保持原样；
 * - 空状态：无授权目录时显示提示文案。
 *
 * 撤销的即时性：主进程 revokeTaskWriteGrant 在删除 DB 行的同时
 * 对存活会话的 TaskFileAccessPolicy 逐个内存移除 grant——
 * 当前会话内再次写同一目录会立即重新弹授权，不依赖会话重建。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskWriteGrantRow } from "../../../../shared/external-write";
import { useAppStore } from "@/store/appStore";
import { IconBarChart, IconTrash } from "@/components/common/icons";

export interface TaskWriteGrantsMenuProps {
  /** 当前任务 id（弹层只对激活任务生效；无任务不渲染） */
  taskId: string;
  onClose: () => void;
  /** 打开「执行诊断」弹窗（由 ChatView 持有弹窗开关） */
  onOpenDiagnostics: () => void;
}

const REVOKE_FAILED_NOTICE = "撤销失败，请重试";
const LOAD_FAILED_NOTICE = "授权列表加载失败，请重试";
const EMPTY_HINT = "当前任务还没有授权写入任务工作目录之外的文件夹。";
const SECTION_HINT =
  "Agent 写入任务工作目录之外的位置前会先请求授权；「始终允许此文件夹」的授权可在此撤销。撤销后立即生效。";

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

export default function TaskWriteGrantsMenu({
  taskId,
  onClose,
  onOpenDiagnostics,
}: TaskWriteGrantsMenuProps): React.JSX.Element {
  const listTaskWriteGrants = useAppStore((s) => s.listTaskWriteGrants);
  const revokeTaskWriteGrant = useAppStore((s) => s.revokeTaskWriteGrant);

  const [grants, setGrants] = useState<TaskWriteGrantRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingPath, setRevokingPath] = useState<string | null>(null);
  /** 代际：taskId 变化或重载时使在途撤销/加载结果失效（防跨任务污染） */
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const gen = ++generationRef.current;
    setError(null);
    try {
      const rows = await listTaskWriteGrants();
      if (gen !== generationRef.current) return;
      setGrants(rows);
      setLoaded(true);
    } catch {
      if (gen !== generationRef.current) return;
      setLoaded(true);
      setError(LOAD_FAILED_NOTICE);
    }
  }, [listTaskWriteGrants]);

  useEffect(() => {
    void load();
  }, [load, taskId]);

  const revoke = async (path: string): Promise<void> => {
    const gen = generationRef.current;
    setRevokingPath(path);
    setError(null);
    try {
      const ok = await revokeTaskWriteGrant(path);
      if (gen !== generationRef.current) return;
      if (!ok) {
        setError(REVOKE_FAILED_NOTICE);
        setRevokingPath(null);
        return;
      }
      // 撤销成功：列表立即刷新（主进程已把 DB 行与存活会话 policy 同步移除）
      await load();
      setRevokingPath(null);
    } catch {
      if (gen !== generationRef.current) return;
      setError(REVOKE_FAILED_NOTICE);
      setRevokingPath(null);
    }
  };

  return (
    <div className="task-grants-popup task-menu-popup" role="dialog" aria-label="任务菜单">
      <div className="task-grants-title">任务菜单</div>
      <div className="task-menu-list">
        <button
          type="button"
          className="task-menu-item"
          data-testid="task-menu-diagnostics"
          title="查看模型、工具、等待与缓存记录"
          onClick={onOpenDiagnostics}
        >
          <IconBarChart size={14} />
          <span className="task-menu-item-label">执行诊断</span>
          <span className="task-menu-item-hint">模型 / 工具 / 等待 / 缓存记录</span>
        </button>
      </div>
      <div className="task-menu-sep" />
      <div className="task-grants-title">外部写入授权</div>
      <div className="task-grants-hint">{SECTION_HINT}</div>
      {error && (
        <div className="task-grants-error" role="status">
          {error}
        </div>
      )}
      <div className="task-grants-list">
        {!loaded ? (
          <div className="task-grants-empty">加载中…</div>
        ) : grants.length === 0 ? (
          <div className="task-grants-empty">{EMPTY_HINT}</div>
        ) : (
          grants.map((g) => (
            <div className="task-grants-item" key={g.path}>
              <div className="task-grants-item-main">
                <span className="task-grants-path" title={g.path}>
                  {g.path}
                </span>
                {formatTime(g.createdAt) && (
                  <span className="task-grants-time">授权于 {formatTime(g.createdAt)}</span>
                )}
              </div>
              <button
                type="button"
                className="task-grants-revoke"
                disabled={revokingPath != null}
                title="撤销此文件夹授权"
                aria-label={`撤销授权：${g.path}`}
                onClick={() => void revoke(g.path)}
              >
                <IconTrash size={13} />
                <span>{revokingPath === g.path ? "撤销中…" : "移除"}</span>
              </button>
            </div>
          ))
        )}
      </div>
      <button type="button" className="task-grants-close" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}
