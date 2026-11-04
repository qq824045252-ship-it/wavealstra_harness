/**
 * 工作空间文件树 / 产物列：右键删除 + 拖动的源码契约。
 * 运行：pnpm exec esbuild ... 或 node 经 test-guard。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  joinWorkspaceAbs,
  normalizeComparePath,
  toWorkspaceRelative,
} from "../src/renderer/src/lib/workspace";
import {
  beginWorkspaceFileDrag,
  decodeWorkspaceFileDrag,
  encodeWorkspaceFileDrag,
  endWorkspaceFileDrag,
  isFileLikeDrag,
  peekWorkspaceFileDrag,
} from "../src/renderer/src/lib/workspaceFileDrag";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

check(
  "joinWorkspaceAbs 拼接相对路径",
  joinWorkspaceAbs("C:\\ws", "docs/a.md").replace(/\//g, "\\") === "C:\\ws\\docs\\a.md",
);
check("toWorkspaceRelative 从绝对路径还原", toWorkspaceRelative("C:\\ws", "C:\\ws\\docs\\a.md") === "docs/a.md");
check("toWorkspaceRelative 拒绝逃逸", toWorkspaceRelative("C:\\ws", "C:\\other\\a.md") === "");
check(
  "normalizeComparePath 忽略分隔符与大小写",
  normalizeComparePath("C:\\WS\\Docs\\") === "c:/ws/docs",
);
check(
  "encode/decode workspace file drag 往返",
  decodeWorkspaceFileDrag(encodeWorkspaceFileDrag(["C:/ws/a.md", " "])).join("|") === "C:/ws/a.md",
);
beginWorkspaceFileDrag(["C:/ws/a.md"]);
check("拖拽会话可读", peekWorkspaceFileDrag().join("|") === "C:/ws/a.md" && isFileLikeDrag([]));
endWorkspaceFileDrag();
check("拖拽会话结束即清空", peekWorkspaceFileDrag().length === 0);

const wsView = read("src/renderer/src/components/artifact/WorkspaceFilesView.tsx");
check("工作空间文件树有右键菜单", wsView.includes("onContextMenu") && wsView.includes("PopupContextMenu"));
check("工作空间文件树菜单含删除", wsView.includes("删除") && wsView.includes("trashWorkspacePath"));
check("工作空间文件树可拖出", wsView.includes("startNativeFileDrag") && wsView.includes("draggable"));
check(
  "工作空间文件同时走系统拖出与内部落点",
  wsView.includes("beginWorkspaceFileDrag") &&
    wsView.includes("startNativeFileDrag") &&
    !wsView.includes("altKey"),
);
check("工作空间文件树可拖入文件夹", wsView.includes("onDrop") && wsView.includes("moveWorkspacePath"));

const rail = read("src/renderer/src/components/artifact/ArtifactRail.tsx");
check("产物列有右键菜单", rail.includes("onContextMenu") && rail.includes("PopupContextMenu"));
check("产物列菜单含删除", rail.includes("删除") && rail.includes("removeArtifact"));
check("产物列可拖出", rail.includes("startNativeFileDrag") && rail.includes("draggable"));
check("概览产物行用 div 拖动", rail.includes('role="button"') && rail.includes("draggedRef"));
const md = read("src/renderer/src/components/common/Markdown.tsx");
check("对话绝对路径可拖", md.includes("LocalFileChip") && md.includes("looksLikeLocalFilePath"));
const bar = read("src/renderer/src/components/artifact/FileActionBar.tsx");
check("文件栏文件名可拖", bar.includes("startNativeFileDrag"));

const taskItem = read("src/renderer/src/components/sidebar/TaskItem.tsx");
check("侧栏任务支持右键菜单", taskItem.includes("onContextMenu") && taskItem.includes("setMenuOpen(true)"));
check("侧栏任务可拖动", taskItem.includes("draggable={!editing}") && taskItem.includes("application/x-mybuddy-task"));
check(
  "侧栏任务接受工作空间文件拖入",
  taskItem.includes("copyIntoTaskWorkspace") && taskItem.includes("pathsFromWorkspaceDrop"),
);

const sidebar = read("src/renderer/src/components/Sidebar.tsx");
check("空间行接受任务拖入", (sidebar.includes("handleRowDrop") || sidebar.includes("handleRootDrop")) && sidebar.includes("onDrop"));
check("空间行支持右键菜单", sidebar.includes("onContextMenu") && sidebar.includes("setSpaceMenuId"));

const dragHelper = read("src/renderer/src/lib/workspaceFileDrag.ts");
check(
  "工作空间文件拖拽 MIME 已定义",
  dragHelper.includes("application/x-mybuddy-workspace-file") &&
    dragHelper.includes("beginWorkspaceFileDrag") &&
    dragHelper.includes("peekWorkspaceFileDrag"),
);
const preload = read("src/preload/index.ts");
check("preload 暴露 copyIntoTaskWorkspace", preload.includes("copyIntoTaskWorkspace"));
const chatInput = read("src/renderer/src/components/chat/ChatInput.tsx");
check("输入框接受工作空间文件 MIME", chatInput.includes("pathsFromWorkspaceDrop"));

const libraryManager = read("src/renderer/src/components/pages/library/ScopedLibraryManager.tsx");
const libraryRows = read("src/renderer/src/components/pages/library/ScopedLibraryRows.tsx");
check("所属资料主区可拖入文件", libraryManager.includes("onDrop=") && libraryManager.includes("access.importFiles"));
check("所属资料用 getPathForFile 解析拖入路径", libraryManager.includes("getPathForFile"));
check("资料文件夹行可接收拖入", libraryRows.includes('row.kind === "folder"') && libraryRows.includes("onDrop="));
const libraryCss = read("src/renderer/src/styles/library.css");
check("所属资料有拖入高亮样式", libraryCss.includes("library-drop-overlay") && libraryCss.includes(".scoped-library-manager.drag-over"));
const workspace = read("src/renderer/src/components/pages/project/ProjectWorkspace.tsx");
check("项目工作区不再内嵌资料库页", !workspace.includes("ProjectLibrary") && !workspace.includes('tab === "library"'));

const standalone = read("src/renderer/src/components/workspace/WorkspaceFilesStandalone.tsx");
check(
  "WorkspaceFilesStandalone 派生 space",
  standalone.includes("spaces.find") && standalone.includes("space?.path"),
);
check(
  "WorkspaceFilesStandalone 定义 filesUnavailableReason",
  standalone.includes("filesUnavailableReason") && standalone.includes("missing-space") && standalone.includes("archived") && standalone.includes("path-missing") && standalone.includes("unbound"),
);
check(
  "WorkspaceFilesStandalone 复用工作空间文件树视图",
  standalone.includes("WorkspaceFilesView") && standalone.includes("spaceId={spaceId}"),
);
check(
  "WorkspaceFilesStandalone search input forwards query",
  standalone.includes('placeholder="搜索项目文件夹"') && standalone.includes("query={query}"),
);
check(
  "WorkspaceFilesStandalone 不可用状态先于文件视图返回",
  ["工作空间不存在", "已归档", "文件夹不可用", "尚未绑定文件夹"].every(
    (text) => standalone.indexOf(text) >= 0 && standalone.indexOf(text) < standalone.indexOf("<WorkspaceFilesView"),
  ),
);
check(
  "WorkspaceFilesStandalone 不直接读文件树（由 WorkspaceFilesView 负责）",
  !standalone.includes("listWorkspaceFiles"),
);
check(
  "WorkspaceFilesStandalone archived 优先于 pathMissing",
  standalone.indexOf("space.archived") < standalone.indexOf("space.pathMissing"),
);
check(
  "WorkspaceFilesStandalone 已归档文案",
  standalone.includes("已归档"),
);
check(
  "WorkspaceFilesStandalone 归档副文案",
  standalone.includes("归档空间暂不加载"),
);
check(
  "WorkspaceFilesStandalone 文件夹不可用文案",
  standalone.includes("文件夹不可用") || standalone.includes("工作区文件夹不可用"),
);
check(
  "WorkspaceFilesStandalone 文件夹已移动副文案",
  standalone.includes("已被移动") || standalone.includes("重命名或删除"),
);
check(
  "WorkspaceFilesStandalone 未绑定文案",
  standalone.includes("尚未绑定文件夹"),
);
check(
  "WorkspaceFilesStandalone 空间不存在文案",
  standalone.includes("工作空间不存在"),
);
check(
  "WorkspaceFilesView 仍经 listWorkspaceFiles 读取文件树",
  wsView.includes("listWorkspaceFiles"),
);
check(
  "WorkspaceFilesView 支持空间嵌入模式",
  wsView.includes("spaceId") && wsView.includes("joinWorkspaceAbs"),
);
check(
  "WorkspaceFilesView recursively filters folders",
  wsView.includes("filterTree") && wsView.includes("filterTree(n.children ?? [], query)"),
);
check(
  "工作空间文件树空目录仍提示暂无文件",
  wsView.includes("暂无文件"),
);

const failed = results.filter((r) => !r[1]);
console.log("\n" + "-".repeat(56));
console.log(`workspace-files-ui: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  for (const f of failed) console.error(`FAILED: ${f[0]}  ${f[2]}`);
  process.exitCode = 1;
}
