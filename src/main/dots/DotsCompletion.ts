import { stat } from "node:fs/promises";
import type { DotsDelegation } from "../../shared/dots";
import { dotsDeliveryFormatCheck, onlyDeliveryFilename } from "./DotsWorkerOutcome";

export interface DotsCompletionRequirements {
  files: string[];
  checks: string[];
  requireCommit: boolean;
}

function instructions(text: string): string[] {
  return text.replace(/^\s*>.*$/gm, "").replace(/\x60{3}[\s\S]*?(?:\x60{3}|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .split(/[。！？；;\n]+|[,，](?=\s*(?:请|不要|不必|无需|但|同时|务必|再))/u).map(part => part.trim()).filter(Boolean);
}

const namedFile = /^(?:[「『“"\x60]([^「」『』“”"\x60/\\:*?<>|\r\n]{1,128})[」』”"\x60]|([\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,117}\.[a-z0-9]{1,12}))/iu;
const extension = /\.(?:xlsx?|csv|tsv|docx?|pptx?|md|pdf|txt|rtf|json|html?|png|jpeg|jpg|svg|webp|zip|xml|drawio)$/iu;

function deliveredFiles(clause: string): string[] {
  const names: string[] = [];
  const directives = clause.matchAll(/(?:交付|附上|给我|只给|只要|deliver|attach|send me)\s*(?:文件\s*[:：]?\s*)?/giu);
  for (const directive of directives) {
    if (/(?:已|曾|上次|历史|previously\s+)$/iu.test(clause.slice(0, directive.index))) continue;
    let remaining = clause.slice(directive.index + directive[0].length);
    for (;;) {
      const match = namedFile.exec(remaining);
      const name = match?.[1] ?? match?.[2];
      if (!match || !name || !extension.test(name)) break;
      names.push(name);
      remaining = remaining.slice(match[0].length);
      const separator = /^\s*(?:、|,|，|以及|和|与|及|and\b)\s*/iu.exec(remaining);
      if (!separator) break;
      remaining = remaining.slice(separator[0].length);
    }
  }
  return names;
}

const negative = /(?:不要|不必|无需|不需要|禁止|不用|不能|不允许|do not|don't|optional|如果|假如|(?:^|\s)if\b|例如|比如)/iu;

/** Only mechanically distinguishable commitments in the actual source. Do not infer a new one from a status report. */
export function dotsCompletionRequirements(assignment: string, deliveryInstruction?: string): DotsCompletionRequirements {
  const clauses = instructions(assignment).filter(clause => !negative.test(clause));
  const required = new Set(clauses.flatMap(deliveredFiles));
  for (const clause of instructions(deliveryInstruction ?? "")) if (!negative.test(clause))
    for (const name of deliveredFiles(clause)) required.add(name);
  const onlyFile = onlyDeliveryFilename(deliveryInstruction);
  if (onlyFile) required.add(onlyFile);
  return { files: [...required], checks: projectChecks(clauses), requireCommit: requiresLocalCommit(clauses) };
}

export function missingDotsPartitionRequirements(assignment: string, partitions: readonly string[]): string[] {
  const original = dotsCompletionRequirements(assignment);
  const scopes = partitions.map(quote => dotsCompletionRequirements(quote));
  const files = new Set(scopes.flatMap(scope => scope.files));
  const checks = new Set(scopes.flatMap(scope => scope.checks));
  return [
    ...original.files.filter(file => !files.has(file)),
    ...original.checks.filter(check => !checks.has(check)),
    ...(original.requireCommit && !scopes.some(scope => scope.requireCommit) ? ["本地提交"] : []),
  ];
}

function projectChecks(clauses: readonly string[]) {
  return [...new Set(clauses.flatMap(clause => {
    const command = /\b(?:project_verify|pnpm(?:\s+run)?)\b/iu.exec(clause);
    if (!command) return [];
    return [...clause.slice(command.index + command[0].length)
      .matchAll(/(?<![\w:-])(?:typecheck|test:[a-zA-Z0-9][a-zA-Z0-9:_-]*)(?![\w:-])/gu)].map(match => match[0]);
  }))];
}

function requiresLocalCommit(clauses: readonly string[]) {
  return clauses.some(clause => /(?:并|再|最后|务必|做(?:一次)?|进行|完成|执行)\s*(?:一次\s*)?(?:git\s*)?本地提交|^(?:请\s*)?(?:git\s*)?本地提交\s*$|提交后.{0,16}(?:运行|验收|校验)|(?:^|\s)(?:make|create)\s+(?:a\s+)?local\s+(?:git\s+)?commit\b/iu.test(clause));
}

const planOnly = /(?:只|仅)(?:是|已)?(?:列出|写出|提供了?|给出|整理了?|完成了?)(?:了)?(?:.{0,10})(?:计划|思路|方案|设想|步骤草案)|(?:only\s+(?:outlined|planned|described|drafted)\b)/iu;
const deferredWork = /(?:具体|实际)?(?:代码|实现|改动|验证|验收|测试|修复|产物)(?:.{0,8})(?:后续|之后|稍后|下一轮)(?:再)?(?:补|做|实现|提交|验证|处理|修改|修复)|(?:后续|稍后|下一轮)(?:再)?(?:补齐|补做|补上|实现|修复|验证|验收|测试)/iu;
const unfinishedAction = /(?:尚未|仍未|还未|还没有|还没|未能|尚待|有待)(?:实际|全部|进一步)?(?:完成|实现|修复|修改|提交|交付|核对|验证|验收|处理|测试|补齐|执行)|(?:还|仍|尚且?)需(?:要)?(?:完成|实现|修复|修改|提交|交付|核对|验证|验收|处理|测试|补齐|执行)|(?:not yet|still (?:need to|pending)|(?:remains?|remain) to)\s+(?:implement|fix|complete|verify|deliver|commit|test)\b/iu;
const workerScope = /^(?:目前|本轮|此轮|这轮|当前|这次|我|原任务|本任务|本次|实际|已完成|仍|尚|只|仅|已经)\s*[、，,:：]?/u;
const caseWork = /(?:修复|实现|修好|解决|修改|验收|核对|交付|完成|制作|生成|处理|编写|测试|验证|优化|\b(?:fix|implement|verify|deliver|complete|generate|test)\b)/iu;

/** Worker admissions are blockers, not authority for a new action. Keep this narrow for informational replies. */
function incompleteAdmission(assignment: string, text: string): string | undefined {
  const currentTask = instructions(assignment).join(" ");
  if (!caseWork.test(currentTask)) return;
  const asksForPlan = /(?:只|仅)(?:要|需|要求)(?:一个|一份)?(?:计划|思路|方案)|(?:给我|给出|列出|写出|制定|设计|梳理|拟定|起草)(?:一个|一份)?[^。！？；;]{0,22}(?:计划|思路|方案)(?:[。！？；;\s，,]|$)|\b(?:outline|draft|propose|write)\s+(?:an?\s+)?(?:implementation |action |test )?plan\b/iu;
  const asksToExecute = /(?:按(?:照)?(?:此|该)?(?:计划|方案)|并|然后|再|接着|最后|同时)\s*(?:实际|直接|去)?(?:执行|实施|落地|实现|修改|修复|写代码|完成|运行|测试|验证|提交)|(?:落地|实施)\s*(?:上述|这个|该)?(?:计划|方案)(?:\s|$)|\b(?:and|then)\s+(?:execute|implement|run|test|commit)\b/iu;
  if (asksForPlan.test(currentTask) && !asksToExecute.test(currentTask)) return;
  const reports = instructions(text);
  for (const [index, report] of reports.entries()) {
    if (/^(?:可选|可进一步|将来可|如需|后续建议|建议后续|optional|if you want)/iu.test(report)) continue;
    if (planOnly.test(report)
      || deferredWork.test(report) || unfinishedAction.test(report) && (
        workerScope.test(report) || /(?:只|仅)(?:修好|修复|完成|实现|处理|修改|验证)了?/u.test(reports[index - 1] ?? "")
        || /(?:未完成项|剩余工作|仍待完成|还需处理)/u.test(report)
      )) return report.slice(0, 350);
  }
}

export async function dotsCompletionGaps(input: {
  requirements: DotsCompletionRequirements;
  assignment: string;
  deliveryInstruction?: string;
  result: string;
  executionRecord?: string;
  artifacts: readonly DotsDelegation["artifacts"][number][];
  verifiedChecks?: string[];
  verifiedCommit?: string;
}): Promise<{ gaps: string[]; repeatKey: string; missingFiles: string[]; fileOnly: boolean }> {
  const {requirements, assignment, deliveryInstruction, result, executionRecord, artifacts, verifiedChecks, verifiedCommit} = input;
  const gaps: string[] = [];
  const keys: string[] = [];
  const missingFiles: string[] = [];
  const verified = await Promise.all(requirements.files.map(async name => {
    const snapshots = new Set(artifacts.flatMap(file => file.saved?.name === name && file.saved.snapshotPath
      ? [file.saved.snapshotPath] : []));
    if (snapshots.size !== 1) return false;
    const path = snapshots.values().next().value!;
    return stat(path).then(file => file.isFile(), () => false);
  }));
  for (const [index, file] of requirements.files.entries()) if (!verified[index]) {
    missingFiles.push(file);
    gaps.push("缺少唯一可打开的交付文件「" + file + "」");
    keys.push("file:" + file);
  }
  const missingChecks = requirements.checks.filter(check => !verifiedChecks?.includes(check));
  if (missingChecks.length) {
    gaps.push("当前版本缺少通过的验收回执：" + missingChecks.join("、"));
    keys.push(...missingChecks.map(check => "check:" + check));
  }
  if (requirements.requireCommit && !verifiedCommit) {
    gaps.push("缺少已核实的本地提交");
    keys.push("commit");
  }
  if (dotsDeliveryFormatCheck(result, deliveryInstruction) === false) {
    gaps.push("正文未满足用户指定的交付格式");
    keys.push("format");
  }
  const admission = incompleteAdmission(assignment, [executionRecord, result].filter(Boolean).join("\n"));
  if (admission) {
    gaps.push("原任务报有未完成项：" + admission);
    keys.push("admitted");
  }
  return { gaps, repeatKey: keys.join("\n"), missingFiles, fileOnly: missingFiles.length > 0 && keys.length === missingFiles.length };
}

/** Existing work keeps the original assignment as its only authority. A scoped diagnostic can use ordinary phrasing. */
export function dotsProgressInScope(originals: readonly string[], next: string, anchor?: string): boolean {
  if (!next.trim()) return false;
  if (originals.some(source => source.includes(next))) return true;
  const externalOrNew = /(?:另一个|新的项目|其他项目|外部|发给|发布|部署|推送|删除|销毁|付款|下单|授权|新建账户|another project|deploy|publish|delete|send to|purchase|transfer funds)/iu;
  if (externalOrNew.test(next)) return false;
  if (!/^(?:排查|诊断|定位|分析|梳理|核对|检查|查找|identify|investigate|diagnose|inspect|check)\s*/iu.test(next)) return false;
  if (anchor && !originals.some(source => source.includes(anchor.trim()))) return false;
  const scope = anchor ? [anchor] : originals;
  const topics = next.match(/性能|瓶颈|启动|内存|延迟|吞吐|渲染|滚动|布局|回归|时间|账单|库存|报价|订单|供应商|性能指标|\b[a-z][a-z0-9_-]{3,}\b/giu) ?? [];
  return topics.some(topic => !/^(?:identify|investigate|diagnose|inspect|check)$/iu.test(topic) &&
    scope.some(source => source.toLowerCase().includes(topic.toLowerCase())));
}
