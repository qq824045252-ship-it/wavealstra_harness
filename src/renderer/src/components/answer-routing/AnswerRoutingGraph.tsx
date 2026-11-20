import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { AnswerRule, AnswerRuleDraft, AnswerRuleUse } from "@shared/answer-routing";
import "./AnswerRoutingGraph.css";

type Preview = { matched: boolean; input?: string; phrase?: string; details?: string[] };
type Rule = AnswerRuleDraft & Partial<Pick<AnswerRule, "id" | "revision">>;
type ReplyStatus = "completed" | "aborted" | "error" | undefined;
type Props =
  | { rule: Rule; preview?: Preview | null; evidenceLabel?: string }
  | { run: AnswerRuleUse; question?: string; replyStatus?: ReplyStatus };
type Tone = "neutral" | "accent" | "success" | "warning" | "muted";
type Node = {
  id: string;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  tone: Tone;
  details: [string, string][];
};
type Edge = { from: string; to: string; label?: string };

const WIDTH = 522;
const NODE_WIDTH = 174;
const NODE_HEIGHT = 58;
const CENTER = (WIDTH - NODE_WIDTH) / 2;
const EVIDENCE_STATUS = {
  read: "已读取资料",
  skipped: "已跳过读取",
  "not-found": "找不到资料",
  denied: "无权读取",
  failed: "读取失败",
  revoked: "资料授权已撤销",
} as const;

export function routingRunStatus(run: AnswerRuleUse): string {
  if (run.routeStatus === "revoked") return "调度已撤销";
  if (run.evidence) return EVIDENCE_STATUS[run.evidence.status];
  return run.routeStatus === "applied" ? "仅提供回答做法" : "历史调度记录";
}

function definitionGraph(rule: Rule, preview?: Preview | null, evidenceLabel?: string) {
  const reference = evidenceLabel ?? rule.evidenceLibraryItemId ?? rule.evidenceFile;
  const tookRule = preview?.matched;
  const active = tookRule !== false && rule.enabled;
  const nodes: Node[] = [
    { id: "input", title: "用户提问", subtitle: preview?.input || "读取本轮提问", x: CENTER, y: 20, tone: "neutral",
      details: [["提问", preview?.input || "取本轮用户的原始问题进行匹配。"]] },
    { id: "match", title: "匹配规则", subtitle: preview ? (tookRule ? "测试命中" : "本次未采用") : (rule.enabled ? rule.title : "规则已停用"),
      x: CENTER, y: 110, tone: active ? "accent" : "muted", details: [
        ["规则", rule.title || "未命名"], ["触发词", rule.include.join("、") || "未设置"],
        ["排除词", rule.exclude.join("、") || "无"], ["范围", rule.projectId ? "指定项目" : "全局"],
        ["测试结果", preview?.details?.join("\n") || preview?.phrase || ""],
      ] },
    { id: "other", title: "常规调度", subtitle: "继续匹配其他规则或直接回答", x: 326, y: 212,
      tone: active ? "muted" : "neutral", details: [["路径", "这一条未采用时，由其他规则或默认流程接手。"]] },
    { id: "apply", title: reference ? "检查并预读资料" : "提供回答做法", subtitle: reference || "使用本规则的做法",
      x: 22, y: 212, tone: active ? "accent" : "muted", details: [
        ["来源", reference], ["来源类型", reference ? (rule.evidenceLibraryItemId ? "项目资料库" : "任务目录") : ""],
        ["做法", rule.instruction || "未设置"],
        ["失败处理", reference ? (rule.evidenceFailure === "mark-unverified" ? "标注待核实" : "从获准的其他来源核实") : ""],
        ["优先级", "以用户本轮的明确要求为先。"],
      ] },
    { id: "reply", title: "交给模型回答", subtitle: "运行时生成回答", x: CENTER, y: 306, tone: "neutral",
      details: [["状态", preview ? "测试只检查匹配结果。资料读取和回答均在实际对话中执行。" : "对话运行时由模型根据本轮上下文生成回答。"]] },
  ];
  const edges: Edge[] = [
    { from: "input", to: "match" }, { from: "match", to: "apply", label: "采用" },
    { from: "match", to: "other", label: "未采用" }, { from: "apply", to: "reply" }, { from: "other", to: "reply" },
  ];
  return { nodes, edges };
}

function runGraph(run: AnswerRuleUse, question: string | undefined, replyStatus: ReplyStatus) {
  const evidence = run.evidence;
  const status = routingRunStatus(run);
  const outcome = replyStatus === "completed" ? "回答已生成" : replyStatus === "aborted" ? "回答生成已中止"
    : replyStatus === "error" ? "回答生成出错" : "回答结果未确认";
  const nodes: Node[] = [
    { id: "input", title: "本轮提问", subtitle: question || "查看本轮输入", x: CENTER, y: 20, tone: "neutral",
      details: [["提问", question || ""], ["输入 ID", run.inputId]] },
    { id: "match", title: "匹配到规则", subtitle: `${run.title} · v${run.revision}`, x: CENTER, y: 110, tone: "accent",
      details: [["规则", run.title], ["规则版本", String(run.revision)], ["触发词", run.phrase || ""], ["记录时间", new Date(run.at).toLocaleString()]] },
    { id: "apply", title: status, subtitle: evidence?.label || evidence?.path || evidence?.reference || run.detail, x: CENTER, y: 200,
      tone: run.routeStatus === "revoked" ? "warning" : evidence ? (evidence.status === "read" ? "success" : evidence.status === "skipped" ? "muted" : "warning") : "neutral",
      details: [["记录", run.detail], ["来源类型", evidence ? (evidence.kind === "task-file" ? "任务目录" : "项目资料库") : ""],
        ["资料名称", evidence?.label || ""],
        ["资料引用", evidence?.reference || ""], ["读取路径", evidence?.path || ""], ["原因", evidence?.reason || ""],
        ["资料版本（SHA-256）", evidence?.contentHash || ""],
        ["读取时间", evidence?.readAt ? new Date(evidence.readAt).toLocaleString() : ""]] },
    { id: "reply", title: outcome, subtitle: "回答内容见上方", x: CENTER, y: 290,
      tone: replyStatus === "completed" ? "success" : replyStatus ? "warning" : "muted",
      details: [["结果", outcome], ["证据范围", "调度记录显示系统提供的规则和资料。模型对资料的实际采纳无法从此记录确认。"]] },
  ];
  const edges: Edge[] = [{ from: "input", to: "match" }, { from: "match", to: "apply" }, { from: "apply", to: "reply" }];
  return { nodes, edges };
}

export default function AnswerRoutingGraph(props: Props): React.JSX.Element {
  const identity = "run" in props ? [props.run.taskId, props.run.inputId, props.run.revision]
    : [props.rule.id ?? props.rule.title, props.rule.revision];
  return <RoutingCanvas key={JSON.stringify(identity)} {...props} />;
}

function RoutingCanvas(props: Props): React.JSX.Element {
  const run = "run" in props;
  const mode = run ? "run" : props.preview ? "preview" : "definition";
  const diagram = run ? runGraph(props.run, props.question, props.replyStatus)
    : definitionGraph(props.rule, props.preview, props.evidenceLabel);
  const stage = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const arrow = useId();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [chosen, setChosen] = useState<string>();
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [view, setView] = useState<{ x: number; y: number; zoom: number }>();
  const inlineView = useRef<typeof view>(undefined);
  const returnFocus = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const drag = useRef<{ pointer: number; left: number; top: number; x: number; y: number } | undefined>(undefined);
  const nodeDrag = useRef<{ pointer: number; left: number; top: number; x: number; y: number; moving: boolean } | undefined>(undefined);
  const nodes = diagram.nodes.map(node => ({ ...node, ...positions[node.id] }));
  const selected = nodes.find(node => node.id === chosen) ?? nodes[mode === "run" ? 2 : 1];
  const diagramHeight = Math.max(...diagram.nodes.map(node => node.y)) + NODE_HEIGHT + 20;
  const minX = Math.min(...nodes.map(node => node.x)) - 22;
  const minY = Math.min(...nodes.map(node => node.y)) - 20;
  const layoutWidth = Math.max(...nodes.map(node => node.x)) + NODE_WIDTH + 22 - minX;
  const layoutHeight = Math.max(...nodes.map(node => node.y)) + NODE_HEIGHT + 20 - minY;
  const fitZoom = Math.min(1.15, Math.max(0.25, Math.min((size.width - 20) / layoutWidth, size.height / layoutHeight)));
  const current = view ?? { zoom: fitZoom, x: (size.width - layoutWidth * fitZoom) / 2 - minX * fitZoom,
    y: (size.height - layoutHeight * fitZoom) / 2 - minY * fitZoom };

  useLayoutEffect(() => {
    if (expanded) dialog.current?.showModal();
    else if (returnFocus.current) {
      returnFocus.current = false;
      expandButton.current?.focus({ preventScroll: true });
    }
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (width && height) setSize(previous => previous.width === width && previous.height === height
        ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);

  const zoomBy = (factor: number) => {
    const zoom = Math.min(2.5, Math.max(0.25, current.zoom * factor));
    const adjust = zoom / current.zoom;
    const x = size.width / 2;
    const y = size.height / 2;
    setView({ zoom, x: x - (x - current.x) * adjust, y: y - (y - current.y) * adjust });
  };

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    drag.current = { pointer: event.pointerId, left: event.clientX, top: event.clientY, x: current.x, y: current.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start?.pointer !== event.pointerId) return;
    setView({ ...current, x: start.x + event.clientX - start.left, y: start.y + event.clientY - start.top });
  };

  const endPan = () => {
    drag.current = undefined;
    setDragging(false);
  };

  const startNodeDrag = (event: PointerEvent<HTMLButtonElement>, node: Node) => {
    if (event.button !== 0) return;
    nodeDrag.current = { pointer: event.pointerId, left: event.clientX, top: event.clientY, x: node.x, y: node.y, moving: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNode = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    const start = nodeDrag.current;
    if (start?.pointer !== event.pointerId) return;
    const dx = event.clientX - start.left;
    const dy = event.clientY - start.top;
    if (!start.moving) {
      if (Math.hypot(dx, dy) < 4) return;
      start.moving = true;
      setChosen(id);
      setView(current);
    }
    setPositions(previous => ({ ...previous, [id]: {
      x: Math.max(6, Math.min(WIDTH - NODE_WIDTH - 6, start.x + dx / current.zoom)),
      y: Math.max(6, Math.min(diagramHeight - NODE_HEIGHT - 6, start.y + dy / current.zoom)),
    } }));
  };

  const endNodeDrag = () => { nodeDrag.current = undefined; };

  const handleKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const steps: Record<string, [number, number]> = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    setView({ ...current, x: current.x + step[0], y: current.y + step[1] });
  };

  const graph = <section className="routing-graph" data-routing-graph={mode} aria-label={run ? "本轮调度路径" : "规则流程图"}>
    <header className="routing-graph__header">
      <span>{run ? "本轮调度路径" : mode === "preview" ? "测试预览 · 仅匹配" : "规则流程"}</span>
      <div className="routing-graph__controls" role="group" aria-label="画布缩放">
        <button type="button" title="缩小" aria-label="缩小" onClick={() => zoomBy(1 / 1.25)}>−</button>
        <output aria-label="缩放比例">{Math.round(current.zoom * 100)}%</output>
        <button type="button" title="放大" aria-label="放大" onClick={() => zoomBy(1.25)}>+</button>
        <button type="button" onClick={() => setView(undefined)}>适配画布</button>
        <button type="button" disabled={!Object.keys(positions).length}
          onClick={() => { setPositions({}); setView(undefined); }}>恢复布局</button>
        {expanded ? <button type="button" onClick={() => dialog.current?.close()}>关闭大图</button>
          : <button type="button" ref={expandButton} onClick={() => {
            inlineView.current = view;
            returnFocus.current = true;
            setView(undefined);
            setExpanded(true);
          }}>展开画布</button>}
      </div>
    </header>
    <div className="routing-graph__stage" ref={stage} role="group" aria-label="流程画布，拖动节点调整布局，拖动空白处或使用方向键平移"
      tabIndex={0} onKeyDown={handleKeys} onPointerDown={startPan} onPointerMove={movePan}
      onPointerUp={event => { movePan(event); endPan(); }}
      onPointerCancel={endPan} onLostPointerCapture={endPan} data-dragging={dragging}>
      <div className="routing-graph__diagram" style={{ width: WIDTH, height: diagramHeight,
        transform: `translate(${current.x}px,${current.y}px) scale(${current.zoom})` }}>
        <svg width={WIDTH} height={diagramHeight} aria-hidden="true">
          <defs><marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker></defs>
          {diagram.edges.map(edge => {
            const from = nodes.find(node => node.id === edge.from)!;
            const to = nodes.find(node => node.id === edge.to)!;
            const across = Math.abs(to.y - from.y) < NODE_HEIGHT + 12 && Math.abs(to.x - from.x) > NODE_WIDTH;
            const right = to.x >= from.x;
            const down = to.y >= from.y;
            const start = across ? { x: from.x + (right ? NODE_WIDTH : 0), y: from.y + NODE_HEIGHT / 2 }
              : { x: from.x + NODE_WIDTH / 2, y: from.y + (down ? NODE_HEIGHT : 0) };
            const end = across ? { x: to.x + (right ? -3 : NODE_WIDTH + 3), y: to.y + NODE_HEIGHT / 2 }
              : { x: to.x + NODE_WIDTH / 2, y: to.y + (down ? -3 : NODE_HEIGHT + 3) };
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            const path = across ? `M ${start.x} ${start.y} H ${midX} V ${end.y} H ${end.x}`
              : `M ${start.x} ${start.y} V ${midY} H ${end.x} V ${end.y}`;
            return <g key={edge.from + edge.to} data-muted={from.tone === "muted" || to.tone === "muted"}>
              <path d={path} markerEnd={`url(#${arrow})`} />
              {edge.label && <text x={midX} y={midY - 6}>{edge.label}</text>}
            </g>;
          })}
        </svg>
        {nodes.map(node => <button type="button" className="routing-graph__node" key={node.id}
          style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
          data-tone={node.tone} aria-pressed={node.id === selected.id} aria-label={node.title}
          onPointerDown={event => startNodeDrag(event, node)} onPointerMove={event => moveNode(event, node.id)}
          onPointerUp={event => { moveNode(event, node.id); endNodeDrag(); }}
          onPointerCancel={endNodeDrag} onLostPointerCapture={endNodeDrag}
          onClick={() => setChosen(node.id)}>
          <strong>{node.title}</strong><small>{node.subtitle}</small>
        </button>)}
      </div>
    </div>
    <div className="routing-graph__details" aria-live="polite">
      <strong>{selected.title}</strong>
      <dl>{selected.details.filter(([, value]) => value).map(([label, value]) => <div key={label}>
        <dt>{label}</dt><dd>{value}</dd>
      </div>)}</dl>
    </div>
  </section>;
  return expanded ? <dialog className="routing-graph-dialog" ref={dialog} aria-label="调度流程大图"
    onClose={() => { setView(inlineView.current); setExpanded(false); }}>{graph}</dialog> : graph;
}
