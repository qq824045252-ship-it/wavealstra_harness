import type { PstackSettings } from "./types";

const programBlocks = ["Arm the program", "Spawn owners", "PR mechanics", "Verdict and merge", "Boot recipe"];
const unitBlocks = ["Depends on.", "Files.", "Build.", "You see.", "Verify, unit.", "Verify, live.", "Verify, perf.", "Review gate.", "Merge."];
const appendices = ["Appendix A. Prototype evidence", "Appendix B. Alternatives rejected", "Appendix C. Risks", "Appendix D. Links and reading list"];
const defaultLanes = 10;
const defaultIntro = 9;
export const PSTACK_PLAN_DEFAULTS = { liveLanes: defaultLanes, introLines: defaultIntro };

export const PSTACK_PLAN_GUIDE = [
  "正文可使用中文。保留以下英文标题及顺序，以便内置计划检查器核对。",
  "# <计划标题>，随后用不超过 introLines 行的内容介绍目标。",
  "## How to read this 写明每一项均附证据、仅在证据存在时勾选，并指出执行剧本。",
  "## Program checklist 按顺序写五个三级标题：" + programBlocks.join("、") + "。分别交代启动授权、负责人、变更操作、验证与合并、验收环境。",
  "每项变更单独写 ## <任务标题>，按顺序写粗体子块：" + unitBlocks.map(name => "**" + name + "**").join(" ") + "。",
  "Depends on. 行写依赖项或 None。Files.、Build.、You see.、Verify, unit.、Merge. 各含至少一个带实际动作的 Markdown 复选框。",
  "Verify, live. 标明当前 head 与实际模型，每个验收场景独占一行，编号 1 到 liveLanes，例如 - [ ] Lane 1. 运行回归用例。保存 `evidence/repro.png`。通过条件：界面显示成功。每行需独立的证据位置与通过条件。",
  "Verify, perf. 的复选框按 Metric.、Probe.、Baseline.、Rule. 顺序，填写指标、探针、基线、判定规则；不能有效比较时写明真实原因和绝对预算。",
  "Review gate. 由用户验收时包含截图、视频和等待确认的复选项；无需人工关口时行内填 None.。",
  "## Close the program 写核实所有产物和交付的收尾清单。其后按顺序写二级标题 " + appendices.join("、") + "，各栏填写事实或适用性理由。",
].join("\n");

interface Line { n: number; text: string }
interface Section extends Line { body: Line[] }

function linesOutsideFences(text: string): Line[] {
  let fence = "";
  return text.split(/\r?\n/).flatMap((text, i) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && text.trim() === marker) fence = "";
      return [];
    }
    if (marker) { fence = marker; return []; }
    return [{ n: i + 1, text }];
  });
}

function sections(lines: Line[], title: RegExp): Section[] {
  const result: Section[] = [];
  for (const line of lines) {
    const head = title.exec(line.text);
    if (head) result.push({ n: line.n, text: head[1].trim(), body: [] });
    else result.at(-1)?.body.push(line);
  }
  return result;
}

function boxes(lines: Line[]): Line[] {
  return lines.flatMap(({ n, text }) => {
    const m = /^\s*- \[[ xX]\]\s+(.+?)\s*$/.exec(text);
    return m ? [{ n, text: m[1] }] : [];
  });
}

function unitProblems(unit: Section, lanes: number): string[] {
  const problems: string[] = [];
  const issue = (n: number, msg: string) => problems.push(`第 ${n} 行 · ${unit.text}：${msg}`);
  const blocks = sections(unit.body, /^\*\*([^*]+\.)\*\*.*$/);
  if (blocks.map(b => b.text).join("|") !== unitBlocks.join("|")) {
    issue(unit.n, "需要按顺序填写 " + unitBlocks.join(" / "));
    return problems;
  }
  const rest = (block: Section) => unit.body.find(line => line.n === block.n)!.text.split("**").slice(2).join("**").trim();
  for (const block of blocks) {
    const { n, text } = block;
    const checks = boxes(block.body);
    if (text === "Depends on.") {
      if (!rest(block)) issue(n, "需要填写依赖关系或 None");
    } else if (text === "Verify, live.") {
      const intro = rest(block);
      if (!/(?:head|提交|版本)/iu.test(intro) || !/(?:`[^`<>]+`|模型\s*[：:]\s*\S+)/u.test(intro)) issue(n, "现场验收必须指定当前版本与模型");
      const seen = new Set<number>();
      for (const line of checks) {
        const match = /^Lane\s+(\d+)\.\s+(.+)/i.exec(line.text);
        const nr = Number(match?.[1]);
        if (!match || nr < 1 || nr > lanes || seen.has(nr)) issue(line.n, "验收场景编号无效或重复");
        else seen.add(nr);
        if (!/(?:\bSave\s+|保存\s*)`[^`<>]+`/iu.test(line.text) || !/(?:\bPass when\b|通过条件)\s*[：:]?\s*\S/iu.test(line.text)) {
          issue(line.n, "场景必须写明保存的证据位置与通过条件");
        }
      }
      if (seen.size !== lanes) issue(n, `应有从 1 到 ${lanes} 的现场验收场景，已填写 ${seen.size} 个`);
    } else if (text === "Verify, perf.") {
      const parts = checks.map(line => /^(Metric|Probe|Baseline|Rule)\.\s*\S/.exec(line.text)?.[1]);
      if (parts.join("|") !== "Metric|Probe|Baseline|Rule") issue(n, "性能核验需要 Metric.、Probe.、Baseline.、Rule. 四个复选项");
    } else if (text === "Review gate.") {
      if (/^(None\.?|无)[。\s]*$/i.test(rest(block))) {
        if (checks.length) issue(n, "无需人工关口时不应另外要求审批");
      } else {
        const all = checks.map(line => line.text).join("\n");
        if (!/screenshot|截图/iu.test(all) || !/video|视频/iu.test(all) || !/operator|操作者|用户|人工/iu.test(all)) {
          issue(n, "人工评审须列出截图、视频和操作者确认；不适用时填写 None.");
        }
      }
    } else if (!checks.length) issue(n, text + " 需要可执行的复选项");
  }
  return problems;
}

/** Check the actual plan artifact. Host commands and model slugs depend on the current MyBuddy installation. */
export function validatePstackPlan(text: string, settings: PstackSettings): string[] {
  const params = settings.playbooks["multi-phase-plan"]?.parameters;
  const lanes = Number(params?.liveLanes ?? defaultLanes);
  const introLines = Number(params?.introLines ?? defaultIntro);
  const problems: string[] = [];
  const lines = linesOutsideFences(text);
  const h1 = lines.find(line => /^# \S/.test(line.text));
  const h2 = sections(lines, /^## (.+)$/);
  const [how, program] = h2;
  if (!h1 || (how && h1.n >= how.n)) problems.push("需要位于正文之前的 # 计划标题");
  if (!how || how.text !== "How to read this") problems.push("第一个二级标题应为 How to read this");
  if (h1 && how && lines.filter(l => l.n > h1.n && l.n < how.n && l.text.trim()).length > introLines) problems.push(`引言应不超过 ${introLines} 行`);
  if (how && !/evidence|证据/iu.test(how.body.map(l => l.text).join("\n"))) problems.push("How to read this 需要说明勾选任务所需的证据");
  if (!program || program.text !== "Program checklist") problems.push("第二个二级标题应为 Program checklist");
  if (program) {
    const steps = sections(program.body, /^### (.+)$/);
    if (steps.length !== programBlocks.length || steps.some((step, i) => !step.text.startsWith(programBlocks[i]))) {
      problems.push("Program checklist 缺少有序小节 " + programBlocks.join(" / "));
    }
    for (const step of steps) if (!step.body.some(l => l.text.trim())) problems.push(`第 ${step.n} 行 · ${step.text} 缺少实际操作`);
  }
  const close = h2.findIndex(s => s.text === "Close the program");
  if (close < 3) problems.push("需要至少一个变更单元，并以 Close the program 收尾");
  if (close >= 0) {
    for (const unit of h2.slice(2, close)) problems.push(...unitProblems(unit, lanes));
    if (!boxes(h2[close].body).length) problems.push("Close the program 需要最终核验复选项");
    const tail = h2.slice(close + 1);
    if (tail.map(s => s.text).join("|") !== appendices.join("|")) problems.push("收尾后需要四个有序附录：" + appendices.join(" / "));
    for (const s of tail) if (!s.body.some(l => l.text.trim())) problems.push(`第 ${s.n} 行 · ${s.text} 为空`);
  }
  return problems;
}
