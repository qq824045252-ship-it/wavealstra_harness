import type { BlueprintDefinition, WorkspaceBlueprintNode } from "@shared/blueprint-types";
import { blueprintSummaryParts } from "@/lib/blueprintUi";
import { IconChevronRight, IconFile, IconFolder, IconListTodo, IconPuzzle } from "@/components/common/icons";
import "./BlueprintDialog.css";

function WorkspacePreview({ node, root = false }: { node: WorkspaceBlueprintNode; root?: boolean }): React.JSX.Element {
  const children = node.children ?? [];
  const tasks = node.tasks ?? [];
  const gadgets = node.gadgets ?? [];
  const files = node.files ?? [];
  const libraryCount = node.libraryBindings?.length ?? 0;
  const resourceCount = children.length + tasks.length + gadgets.length + files.length + libraryCount + Number(!!node.defaultContext);

  return (
    <li>
      <details className="blueprint-workspace-node" open={root || undefined}>
        <summary>
          <IconChevronRight className="blueprint-tree-chevron" size={13} />
          <IconFolder size={16} />
          <span>{node.name}</span>
          {resourceCount > 0 && <small>{resourceCount} 项</small>}
        </summary>
        <ul className="blueprint-workspace-items">
          {children.map((child) => <WorkspacePreview key={child.key} node={child} />)}
          {tasks.map((task) => <li key={task.key}><IconListTodo size={14} /><span>{task.title}</span><small>任务</small></li>)}
          {gadgets.map((gadget) => <li key={gadget.key}><IconPuzzle size={14} /><span>{gadget.name}</span><small>Gadget</small></li>)}
          {files.map((file) => <li key={file.path}><IconFile size={14} /><span>{file.path}</span><small>模板文件</small></li>)}
          {node.defaultContext && <li><IconListTodo size={14} /><span>工作区上下文</span></li>}
          {libraryCount > 0 && <li><IconFolder size={14} /><span>{libraryCount} 项资料库绑定</span></li>}
          {resourceCount === 0 && <li className="blueprint-tree-empty">此工作区没有其他模板项</li>}
        </ul>
      </details>
    </li>
  );
}

export default function BlueprintDefinitionPreview({ definition }: { definition: BlueprintDefinition }): React.JSX.Element {
  const summary = blueprintSummaryParts(definition);
  const workspace = definition.kind === "gadget" ? undefined : definition.workspace;
  const gadgets = definition.kind === "gadget" ? [definition.gadget] : definition.kind === "composite" ? definition.gadgets ?? [] : [];

  return (
    <>
      {summary.length > 0 && <ul className="blueprint-summary-chips" aria-label="捕获概况">
        {summary.map((item) => <li key={item}>{item}</li>)}
      </ul>}
      <ul className="blueprint-workspace-tree" aria-label="Blueprint 内容结构">
        {workspace && <WorkspacePreview node={workspace} root />}
        {gadgets.map((gadget) => (
          <li key={gadget.key} className="blueprint-gadget-preview">
            <IconPuzzle size={16} /><span>{gadget.name}</span><small>{gadget.sourceFiles.length} 个源文件</small>
          </li>
        ))}
      </ul>
    </>
  );
}
