/**
 * ConversationBranchChip — 对话分支血缘入口（实施规划 §4.2）。
 *
 * - 新 Task 标题区：来源 chip「来自「{父任务}」」，点击切回父任务；
 *   父已删除时显示快照标题 + 已删除状态（新 Task 仍可继续）。
 * - 任意任务：子分支入口「查看分支（N）」，弹层列出直接子分支并可跳转。
 * 不改变侧栏树的层级结构（Workspace Tree 与对话血缘是两棵不同的树）。
 */
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { IconChevronDown, IconGitBranch } from "@/components/common/icons";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";

export default function ConversationBranchChip(): React.JSX.Element | null {
  const branchSource = useAppStore((s) => s.branchSource);
  const branchChildren = useAppStore((s) => s.branchChildren);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const [childrenOpen, setChildrenOpen] = useState(false);
  const childrenAnchorRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(childrenOpen, () => setChildrenOpen(false), childrenAnchorRef);

  // 切换任务时收起子分支弹层
  useEffect(() => {
    setChildrenOpen(false);
  }, [branchSource]);

  if (!branchSource && branchChildren.length === 0) return null;
  /** child 显示名：主进程返回的真实标题（childTitle）> 本地任务行 > 占位 */
  const titleOf = (child: (typeof branchChildren)[number]): string => {
    if (child.childTitle) return child.childTitle;
    const local = tasks.find((t) => t.id === child.childTaskId);
    return local?.title || "分支任务";
  };

  return (
    <span className="conv-branch-lineage">
      {branchSource && (
        <button
          type="button"
          className="conv-branch-chip"
          title={
            branchSource.parentExists
              ? `来自「${branchSource.parentTitle}」：点击回到源任务`
              : `来源任务已删除（原「${branchSource.parentTitle}」），本任务可继续使用`
          }
          onClick={() => {
            if (branchSource.parentExists) setActiveTask(branchSource.parentTaskId);
          }}
        >
          <IconGitBranch size={12} />
          <span className="conv-branch-chip-text">
            {branchSource.parentExists
              ? `来自「${branchSource.parentTitle}」`
              : "来源任务已删除"}
          </span>
        </button>
      )}
      {branchChildren.length > 0 && (
        <div className="conv-branch-children" ref={childrenAnchorRef}>
          <button
            type="button"
            className={`conv-branch-chip conv-branch-children-toggle${childrenOpen ? " is-open" : ""}`}
            aria-expanded={childrenOpen}
            onClick={() => setChildrenOpen((v) => !v)}
          >
            <IconGitBranch size={12} />
            <span className="conv-branch-chip-text">查看分支（{branchChildren.length}）</span>
            <IconChevronDown size={11} />
          </button>
          {childrenOpen && (
            <div className="conv-branch-children-menu" role="menu">
              {branchChildren.map((child) => (
                <button
                  key={child.childTaskId}
                  type="button"
                  role="menuitem"
                  className="conv-branch-children-item"
                  onClick={() => {
                    setChildrenOpen(false);
                    // 子任务行不一定在本地 tasks（可能由主进程/另一窗口创建）——先尝试本地，缺失时交给启动加载
                    setActiveTask(child.childTaskId);
                  }}
                >
                  <IconGitBranch size={12} />
                  <span className="conv-branch-children-item-title">{titleOf(child)}</span>
                  {child.childTaskId === activeTaskId && (
                    <span className="conv-branch-children-item-current">当前</span>
                  )}
                  <span className="conv-branch-children-item-time">
                    {new Date(child.createdAt).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}