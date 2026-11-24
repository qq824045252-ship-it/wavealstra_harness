import { createHash } from "node:crypto";
import type { DotsDelegation } from "../../shared/dots";
import { isProjectTest, STANDALONE_PROJECT_TESTS } from "../../shared/project-check";
import type { ProjectVerificationManager } from "../agent/durable/DurableProjectVerification";
import { checkDotsDeliveryFile } from "./DotsArtifactUsability";
import { dotsDeliveryFormatCheck, onlyDeliveryFilename, type DotsWorkEvidence } from "./DotsWorkerOutcome";

export interface DotsCompletionDeclaration {
  kind: "work" | "file" | "check" | "commit";
  quote: string;
  name?: string;
  sheet?: string;
  headers?: string[];
}

export interface DotsCompletionItem extends DotsCompletionDeclaration {
  id: string;
  label?: string;
}

export interface DotsCompletionRequirements {
  rulesVersion?: number;
  files: string[];
  checks: string[];
  checkManagers?: Record<string, ProjectVerificationManager[]>;
  requireCommit: boolean;
  requireTests?: true;
  items?: DotsCompletionItem[];
}

function instructions(text: string): string[] {
  return text.replace(/^\s*>.*$/gm, "").replace(/\x60{3}[\s\S]*?(?:\x60{3}|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .split(/[。！？；;\n]+|[,，](?=\s*(?:请|不要|不必|无需|但|同时|务必|再))|(?=\bbut\s+(?:do not|don't)\b|(?:但是?|而且|并且?)?(?:不要|无需|不必|不需要|禁止|不用|不允许|请勿))/iu)
    .map(part => part.trim()).filter(Boolean);
}

const namedFile = /^(?:[「『“"\x60]([^「」『』“”"\x60/\\:*?<>|\r\n]{1,128})[」』”"\x60]|([\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,117}\.[a-z0-9]{1,12}))/iu;
const extension = /\.(?:xlsx?|csv|tsv|docx?|pptx?|md|pdf|txt|rtf|json|html?|png|jpeg|jpg|svg|webp|zip|xml|drawio)$/iu;
const artifactDirective = /(?:交付|附上|给我|只给|只要|生成|制作|创建|产出|输出|导出|补齐|deliver|attach|send me|create|generate|export)/iu;
const projectTests = /(?:运行|执行|通过|跑(?:一遍|完)?|补跑)\s*(?:本地|全部|相关|必要|指定|回归|项目的?)?\s*测试|\b(?:run|execute|pass)\s+(?:all |the |relevant |required |project )?tests\b/iu;
const projectCheck = /(?<![\w:-])(?:typecheck|test(?::[a-zA-Z0-9][a-zA-Z0-9:_-]*)?)(?![\w:-])/gu;
const negative = /^(?:[-*•]\s*|\d+[.)、]\s*)?(?:(?:请|但是?|而且|并且?)\s*|\bbut\s+)*(?:不要|不必|无需|不需要|禁止|不用|不能|不允许|勿|别|do not|don't|optional|如果|假如|if\b|例如|比如|for example\b)/iu;
const countedWork = /(?:修复|处理|解决|改正|完成)(?:以下|这)?\s*([一二两三四五六七八九十]|\d{1,2})\s*(?:个|项|处)(?:问题|缺陷|修复项|改动|工作|事项)/u;
const workLead = /^(?:(?:请(?:你|您)?|帮我)\s*)?(?:(?:先|再|随后|同时|最后)\s*)?/u;
const workVerb = /(?:核对|检查|对照|整理|列出|补齐|补全|修复|修正|改写|修改|更新|编写|填写|汇总|核算|统计|翻译|校对)/u;
const workSequence = new RegExp("[,，、]?\\s*(?:并(?:且)?|然后|接着|随后|再|同时|以及)(?:请)?\\s*(?=" + workVerb.source + ")", "u");
const workAction = new RegExp("^" + workVerb.source + "\\s*\\S", "u");
const numberedWork = /^(?:\d+[.)、]|[-*•])\s*/u;

function positiveInstructions(text: string): string[] {
  return instructions(text).filter(clause => !negative.test(clause));
}

function deliveredFiles(clause: string): string[] {
  const names: string[] = [];
  const directives = clause.matchAll(new RegExp(artifactDirective.source +
    "\\s*(?:(?:一个|一份|一张|一版|一套|an?\\b|the\\b)\\s*)?(?:(?:空白|空的?)\\s*(?:模板|工作簿|工作表)\\s*|(?:blank|empty)\\s+(?:template|workbook|sheet)\\s+)?(?:文件\\s*[:：]?\\s*)?", "giu"));
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

export { isProjectTest as dotsProjectTestCheck };

function validFileName(name: string) {
  return /^[^<>:"/\\|?*\r\n]{1,128}$/u.test(name) && extension.test(name);
}

function ordinaryWorkParts(clause: string) {
  return clause.split(workSequence).map(part => part.trim()).filter(part =>
    workAction.test(part.replace(workLead, "")) && !/(?:是否|能否|有没有)/u.test(part) && !countedWork.test(part));
}

function itemId(item: DotsCompletionDeclaration, label?: string): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([item.kind, item.kind === "work" ? item.quote : item.name ?? "", label, item.sheet]))
    .digest("hex");
  return item.kind + "-" + hash.slice(0, 16);
}

const spreadsheetDirective = /(?:工作表(?:名(?:称)?)?|\b(?:worksheet|sheet)(?: name)?)\s*(?:叫(?:作)?|命名为|名称为|名为|为|是|[:：]|named\s+|called\s+|is\s+)\s*/iu;
const headerDirective = /(?:表头|列名|\b(?:headers?|column names?))\s*(?:包括|包含|分别为|为|是|[:：]|(?:are|include)\s+)\s*/iu;
const workbookBlank = /(?:空白|空的?)\s*(?:模板|工作簿|工作表)|\b(?:blank|empty)\s+(?:template|workbook|sheet)\b/iu;

function workbookRequirements(clauses: readonly string[], name: string) {
  const contexts: string[] = [];
  let active = false;
  for (const clause of clauses) {
    const files = deliveredFiles(clause);
    if (files.length) active = files.length === 1 && files[0] === name;
    if (active && (files.length || /^(?:工作表|表头|列名|worksheet|sheet|headers?|column names?)/iu.test(clause))) contexts.push(clause);
  }
  const source = contexts.join("；");
  const sheetMatch = spreadsheetDirective.exec(source);
  const headerMatch = headerDirective.exec(source);
  const unquote = (value: string) => value.trim().replace(/^[「『“"`]+|[」』”"`]+$/gu, "").trim();
  const sheet = sheetMatch && unquote(source.slice(sheetMatch.index + sheetMatch[0].length).split(/[,，、；]|\s+and\s+/iu, 1)[0] ?? "");
  const headers = headerMatch && source.slice(headerMatch.index + headerMatch[0].length)
    .split(/；|(?:[,，]\s*|\s+)(?=请|然后|随后|且|并|最后|格式|单位|数据|行数|工作表|then\b|with\b)/iu, 1)[0]
    ?.split(/[,，、]|\s*(?:以及|和|与|及)\s*|\s+and\s+/iu).map(unquote).filter(Boolean);
  return {
    ...(sheet && sheet.length <= 31 ? { sheet } : {}),
    ...(headers?.length && headers.length <= 30 && headers.every(header => header.length <= 120) ? { headers } : {}),
    allowEmpty: workbookBlank.test(source),
  };
}

function validateDeclaration(item: DotsCompletionDeclaration, sources: readonly string[]): DotsCompletionDeclaration {
  const quote = item.quote?.trim();
  const parts = instructions(quote ?? "");
  if (!quote || !parts.length || !sources.some(source => source.includes(quote) &&
    parts.every(part => positiveInstructions(source).some(clause => clause.includes(part)))))
    throw new Error("完成要求必须引用本项原交办中可执行的原话");
  const name = item.name?.trim();
  if (item.kind === "work") return { kind: item.kind, quote };
  if (item.kind === "file" && name && validFileName(name) && quote.includes(name) &&
    (artifactDirective.test(quote) || /文件名(?:为|是|叫)|保存为|命名为|\b(?:name|save) (?:it )?as\b/iu.test(quote))) {
    const sheet = item.sheet?.trim();
    const headers = item.headers?.map(header => header.trim());
    if ((sheet || headers?.length) && (!/\.xlsx$/iu.test(name) || sheet && (!/工作表|worksheet|\bsheet\b/iu.test(quote) || !quote.includes(sheet)) ||
      headers?.length && (!/表头|列名|字段|\b(?:headers?|columns?)\b/iu.test(quote) ||
        headers.some(header => !header || !quote.includes(header)))))
      throw new Error("工作表和表头必须来自对应 Excel 文件的原交办");
    return { kind: item.kind, quote, name, sheet, headers };
  }
  if (item.kind === "check" && (name ? (name === "typecheck" || isProjectTest(name)) &&
    (projectChecks(quote).includes(name) || name === "typecheck" && /typecheck|类型检查/iu.test(quote) ||
      isProjectTest(name) && projectTests.test(quote)) : projectTests.test(quote)))
    return { kind: item.kind, quote, name };
  if (item.kind === "commit" && requiresLocalCommit(quote)) return { kind: item.kind, quote };
  throw new Error("完成要求与原交办不一致：" + quote);
}

/** Freeze the actionable original text and any attributable declarations when the job is admitted. */
export function dotsCompletionRequirements(assignment: string, deliveryInstruction?: string,
  declarations: readonly DotsCompletionDeclaration[] = []): DotsCompletionRequirements {
  const clauses = positiveInstructions(assignment);
  const deliveryClauses = positiveInstructions(deliveryInstruction ?? "");
  const items = new Map<string, DotsCompletionItem>();
  const add = (item: DotsCompletionDeclaration, label?: string) => {
    const id = itemId(item, label);
    const prior = items.get(id);
    if (!prior) items.set(id, { id, ...item, ...(label && { label }) });
    else if (item.headers?.length) prior.headers = [...new Set([...(prior.headers ?? []), ...item.headers])];
  };
  for (const declaration of declarations) add(validateDeclaration(declaration, [assignment, deliveryInstruction ?? ""]));
  const declaredFiles = new Set([...items.values()].filter(item => item.kind === "file").map(item => item.name));
  const sources = [...clauses, ...deliveryClauses];
  for (const quote of sources) {
    for (const name of deliveredFiles(quote)) if (!declaredFiles.has(name)) {
      const details = /\.xlsx$/iu.test(name) ? workbookRequirements(sources, name) : undefined;
      add({ kind: "file", quote, name, sheet: details?.sheet, headers: details?.headers });
    }
    const checks = projectChecks(quote);
    for (const name of checks) add({ kind: "check", quote, name });
    if (!checks.some(isProjectTest) && projectTests.test(quote)) add({ kind: "check", quote });
    if (requiresLocalCommit(quote)) add({ kind: "commit", quote });
  }
  const onlyFile = onlyDeliveryFilename(deliveryInstruction);
  if (onlyFile && !declaredFiles.has(onlyFile)) add({ kind: "file", quote: deliveryInstruction!, name: onlyFile });
  const numbered = clauses.filter(clause => numberedWork.test(clause) && caseWork.test(clause));
  const ordinary = clauses.filter(clause => !numberedWork.test(clause)).flatMap(ordinaryWorkParts);
  const workKey = (quote: string) => quote.replace(numberedWork, "").replace(workLead, "");
  const registeredWork = new Set([...items.values()].map(item => workKey(item.quote)));
  for (const quote of [...numbered, ...(ordinary.length > 1 ? ordinary : [])]) {
    const key = workKey(quote);
    if (registeredWork.has(key)) continue;
    registeredWork.add(key);
    add({ kind: "work", quote });
  }
  const ordinal = "一二两三四五六七八九十";
  const counts = [1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const quote of clauses) {
    const amount = countedWork.exec(quote)?.[1];
    if (!amount) continue;
    const count = Number(amount) || counts[ordinal.indexOf(amount)] || 0;
    const known = [...items.values()].filter(item => item.kind === "work").length;
    for (let index = known + 1; index <= Math.min(count, 24); index++) add({ kind: "work", quote },
      count > 24 && index === 24 ? "第 24 至 " + count + " 项问题" : "第 " + index + " 项问题");
  }
  for (const item of [...items.values()]) {
    if (item.kind !== "file" || !item.name || !declaredFiles.has(item.name) || !/\.xlsx$/iu.test(item.name)) continue;
    const { sheet, headers } = workbookRequirements(sources, item.name);
    if (sheet || headers?.length) {
      if (!item.sheet && !item.headers?.length) items.delete(item.id);
      add({ kind: "file", name: item.name, quote: item.quote, sheet, headers });
    }
  }
  const contract = [...items.values()];
  const managers = new Map<string, Set<ProjectVerificationManager>>();
  for (const clause of [...clauses, ...deliveryClauses]) for (const { name, manager } of projectCommands(clause)) {
    const used = managers.get(name) ?? new Set<ProjectVerificationManager>();
    used.add(manager);
    managers.set(name, used);
  }
  return {
    rulesVersion: dotsCompletionRulesVersion,
    files: [...new Set(contract.flatMap(item => item.kind === "file" && item.name ? [item.name] : []))],
    checks: contract.flatMap(item => item.kind === "check" && item.name ? [item.name] : []),
    ...(managers.size && { checkManagers: Object.fromEntries([...managers].map(([name, used]) => [name, [...used]])) }),
    requireCommit: contract.some(item => item.kind === "commit"),
    ...(contract.some(item => item.kind === "check" && !item.name) && { requireTests: true }),
    ...(contract.length && { items: contract }),
  };
}

export const dotsCompletionRulesVersion = 2;

export function dotsCompletionInstruction(requirements: DotsCompletionRequirements): string {
  const items = requirements.items ?? [];
  if (!items.length) return "";
  const list = items.map(item => {
    if (item.kind === "work") return "- " + item.id + "（" + (item.label ?? item.quote) + "）";
    if (item.kind === "file") return "- 登记可打开的文件 " + item.name +
      (item.sheet ? "，工作表为 " + item.sheet : "") + (item.headers?.length ? "，表头包括 " + item.headers.join("、") : "");
    if (item.kind === "commit") return "- 交回本次任务的新提交 SHA";
    const managers = item.name ? requirements.checkManagers?.[item.name] : undefined;
    return "- " + (item.name ? "用 project_verify 运行 " + item.name + (managers?.length
      ? "（manager 填写 " + managers.join("、") + "）" : "") : "用 project_verify 运行与改动相关的项目测试");
  }).join("\n");
  const evidence = items.some(item => item.kind === "work")
    ? "\n结项时在 completedItems 中按 ID 提供每项实际完成的依据，别把准备做的事写成已完成。" : "";
  return "本次需要完成的事项：\n" + list + evidence;
}

function missingWorkItems(requirements: DotsCompletionRequirements, completedItems: readonly DotsWorkEvidence[] = []) {
  const evidence = new Map<string, string[]>();
  for (const item of completedItems) if (item.evidence.trim()) {
    const reports = evidence.get(item.id) ?? [];
    reports.push(item.evidence);
    evidence.set(item.id, reports);
  }
  return (requirements.items ?? []).filter(item => item.kind === "work" &&
    (!evidence.has(item.id) || evidence.get(item.id)!.some(report => incompleteWorkEvidence(item.quote, report))));
}

export function assertDotsWorkCompletion(requirements: DotsCompletionRequirements, completedItems?: readonly DotsWorkEvidence[]) {
  const missing = missingWorkItems(requirements, completedItems);
  if (missing.length) throw new Error("仍缺少逐项完成依据：" + missing.map(item => item.id + "（" + (item.label ?? item.quote) + "）").join("、"));
}

export function missingDotsPartitionRequirements(assignment: string, partitions: readonly string[]): string[] {
  const original = dotsCompletionRequirements(assignment);
  const scopes = partitions.map(quote => dotsCompletionRequirements(quote));
  const files = new Set(scopes.flatMap(scope => scope.files));
  const checks = new Set(scopes.flatMap(scope => scope.checks));
  const work = new Set(scopes.flatMap(scope => (scope.items ?? []).filter(item => item.kind === "work").map(item => item.id)));
  const positiveScopes = partitions.flatMap(positiveInstructions);
  return [
    ...original.files.filter(file => !files.has(file)),
    ...original.checks.filter(check => !checks.has(check)),
    ...(original.requireTests && !scopes.some(scope => scope.requireTests || scope.checks.some(isProjectTest)) ? ["相关项目测试"] : []),
    ...(original.requireCommit && !scopes.some(scope => scope.requireCommit) ? ["本地提交"] : []),
    ...(original.items ?? []).flatMap(item => item.kind === "work" && !work.has(item.id) &&
      (item.label || !positiveScopes.some(scope => scope.includes(item.quote.replace(numberedWork, ""))))
        ? [item.label ?? item.quote] : []),
  ];
}

function projectCommands(clause: string) {
  return [...clause.matchAll(/\b(npm|pnpm)\s+(?:-s\s+|--silent\s+)?(?:run\s+)?\x60?(typecheck|test(?::[a-zA-Z0-9][a-zA-Z0-9:_-]*)?)(?![\w:-])/giu)]
    .map(match => ({ manager: match[1].toLowerCase() as ProjectVerificationManager, name: match[2] }));
}

function projectChecks(clause: string) {
  const commands = projectCommands(clause).map(command => command.name);
  const executable = /(?:运行|执行|通过|补跑|跑(?:一遍)?|\b(?:run|execute)\b)\s*(?:本地\s*)?`?(python\s+-m\s+pytest|pytest|go\s+test(?:\s+\.\/\.\.\.)?|cargo\s+test)(?=$|[\s`,，。；;.!！？]|并|再)/giu;
  for (const match of clause.matchAll(executable)) {
    const command = match[1]!.toLowerCase().replace(/\s+/gu, " ");
    const test = Object.entries(STANDALONE_PROJECT_TESTS).find(([, value]) => value === command || command === "go test" && value === "go test ./...");
    if (test) commands.push(test[0]);
  }
  const native = /\bproject_verify\b/iu.exec(clause);
  if (native) {
    const names = clause.slice(native.index + native[0].length);
    commands.push(...[...names.matchAll(projectCheck)].map(match => match[0]));
    commands.push(...Object.keys(STANDALONE_PROJECT_TESTS).filter(name => names.split(/[^\w-]+/u).includes(name)));
  }
  if (/(?:运行|执行|通过|跑(?:一遍)?)\s*(?:项目的?)?类型检查/u.test(clause)) commands.push("typecheck");
  return [...new Set(commands)];
}

function requiresLocalCommit(clause: string) {
  return /(?:并|再|最后|务必|做(?:一次)?|进行|完成|执行)\s*(?:一次\s*)?(?:git\s*)?本地提交|^(?:请\s*)?(?:git\s*)?本地提交\s*$|提交后.{0,16}(?:运行|验收|校验)|(?:^|\s)(?:make|create)\s+(?:a\s+)?local\s+(?:git\s+)?commit\b|(?:^|并|再|最后|请)\s*(?:将|把)?\s*(?:代码|变更|改动|修复)?\s*提交(?:代码|变更|改动|修复)|\bgit\s+commit\b/iu.test(clause);
}

const planOnly = /(?:只|仅)(?:是|已)?(?:列出|写出|提供了?|给出|整理了?|完成了?)(?:了)?(?:.{0,10})(?:计划|思路|方案|设想|步骤草案)|(?:only\s+(?:outlined|planned|described|drafted)\b)/iu;
const deferredWork = /(?:具体|实际)?(?:代码|实现|改动|验证|验收|测试|修复|产物)(?:.{0,8})(?:后续|之后|稍后|下一轮)(?:再)?(?:补|做|实现|提交|验证|处理|修改|修复)|(?:后续|稍后|下一轮)(?:再)?(?:补齐|补做|补上|实现|修复|验证|验收|测试)/iu;
const unfinishedAction = /(?:尚未|仍未|还未|还没有|还没|未能|尚待|有待)(?:实际|全部|进一步)?(?:完成|实现|修复|修改|提交|交付|核对|验证|验收|处理|测试|补齐|执行)|(?:还|仍|尚且?)需(?:要)?(?:完成|实现|修复|修改|提交|交付|核对|验证|验收|处理|测试|补齐|执行)|(?:not yet|still (?:need to|pending)|(?:remains?|remain) to)\s+(?:implement|fix|complete|verify|deliver|commit|test)\b/iu;
const workerScope = /^(?:目前|本轮|此轮|这轮|当前|这次|我|原任务|本任务|本次|实际|已完成|仍|尚|只|仅|已经)\s*[、，,:：]?/u;
const caseWork = /(?:修复|实现|修好|解决|修改|验收|核对|交付|完成|制作|生成|处理|编写|测试|验证|优化|\b(?:fix|implement|verify|deliver|complete|generate|test)\b)/iu;
const reportedRemainder = /(?:第\s*[一二三四五六七八九十\d、，,\s第]+项|剩余(?:工作|事项)?)[^。！？\r\n]{0,12}(?:待处理|待完成|未完成|未做|待修复)/u;
const reportedUnrunCheck = /(?:检查|测试|校验|验收)(?:还|尚|仍)?(?:未|没(?:有)?)(?:运行|执行|通过|完成)|(?:尚|仍|还)?未(?:运行|执行|通过|完成)(?:任何)?(?:测试|验收|检查)/u;

function incompleteWorkEvidence(assignment: string, evidence: string): boolean {
  const pending = /^(?:(?:本项|该项|这项工作|当前|目前|仍然|仍|还)\s*[:：]?\s*)*(?:(?:尚未|仍未|还未|没有|未)(?:做|执行|开始|处理|完成|修复|核对|实现)|待(?:处理|完成|执行|修复|核对)|(?:准备|计划|打算|下一步(?:将|会)?)(?:着手|下一步)?\s*(?:开始|做|执行|修复|处理|核对|完成|实现)|(?:not (?:yet )?(?:started|done|completed|executed|fixed)|pending|to do|planning to|will (?:start|fix|implement|complete))\b)/iu;
  const onlyStatus = /^(?:已(?:完成|执行|处理|修复|核对)|完成了?|done|completed|fixed|verified)[\s。.!！]*$/iu;
  const workLabel = /^(?:(?:[-*•]|\d+[.)、])\s+)?[*_]*(?:(?:第[一二三四五六七八九十\d]+项|本项|该项)\s*[:：]\s*)?[*_]*/u;
  return onlyStatus.test(evidence.trim().replace(workLabel, "").replace(/[*_]+$/u, "")) ||
    instructions(evidence).some(report => pending.test(report.replace(workLabel, ""))) ||
    Boolean(incompleteAdmission(assignment, evidence));
}

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
    if (planOnly.test(report) || reportedRemainder.test(report) || reportedUnrunCheck.test(report)
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
  completedItems?: readonly DotsWorkEvidence[];
}): Promise<{ gaps: string[]; repeatKey: string; missingFiles: string[]; missingChecks: string[];
  missingCommit: boolean; missingWork: DotsCompletionItem[]; unfinishedWork: boolean; fileOnly: boolean }> {
  const {requirements, assignment, deliveryInstruction, result, executionRecord, artifacts, verifiedChecks, verifiedCommit, completedItems} = input;
  const gaps: string[] = [];
  const keys: string[] = [];
  const missingFiles: string[] = [];
  const verified = await Promise.all(requirements.files.map(async name => {
    const snapshots = new Set(artifacts.flatMap(file => file.saved?.name === name && file.saved.snapshotPath
      ? [file.saved.snapshotPath] : []));
    if (snapshots.size !== 1) return "需要唯一的已登记快照";
    const path = snapshots.values().next().value!;
    const sheets = (requirements.items ?? []).filter(item => item.kind === "file" && item.name === name && (item.sheet || item.headers?.length));
    const allowEmpty = /\.xlsx$/iu.test(name) && workbookRequirements([
      ...positiveInstructions(assignment), ...positiveInstructions(deliveryInstruction ?? ""),
    ], name).allowEmpty;
    return checkDotsDeliveryFile(path, name, sheets, allowEmpty);
  }));
  for (const [index, file] of requirements.files.entries()) if (verified[index]) {
    missingFiles.push(file);
    gaps.push("缺少唯一可打开的交付文件「" + file + "」：" + verified[index]);
    keys.push("file:" + file);
  }
  const missingChecks = requirements.checks.filter(check => !verifiedChecks?.includes(check));
  if (requirements.requireTests && !verifiedChecks?.some(isProjectTest) && !missingChecks.some(isProjectTest))
    missingChecks.push("test:*");
  if (missingChecks.length) {
    gaps.push("当前版本缺少通过的验收回执：" + missingChecks.map(name => name === "test:*" ? "相关项目测试" : name).join("、"));
    keys.push(...missingChecks.map(check => "check:" + check));
  }
  const missingCommit = requirements.requireCommit && !verifiedCommit;
  if (missingCommit) {
    gaps.push("缺少已核实的本地提交");
    keys.push("commit");
  }
  const missingWork = missingWorkItems(requirements, completedItems);
  for (const item of missingWork) {
    gaps.push("缺少已完成的依据：「" + (item.label ?? item.quote) + "」");
    keys.push(item.id);
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
  return { gaps, repeatKey: keys.join("\n"), missingFiles, missingChecks, missingCommit, missingWork,
    unfinishedWork: Boolean(admission && !reportedUnrunCheck.test(admission)),
    fileOnly: missingFiles.length > 0 && keys.length === missingFiles.length };
}

/** Existing work keeps the original assignment as its only authority. A scoped diagnostic can use ordinary phrasing. */
export function dotsProgressInScope(originals: readonly string[], next: string, anchor?: string, item?: DotsCompletionItem): boolean {
  next = next.trim();
  const authorized = originals.flatMap(positiveInstructions);
  if (!next || anchor && !authorized.some(source => source.includes(anchor.trim()))) return false;
  const scope = item ? positiveInstructions(item.quote) : anchor ? positiveInstructions(anchor) : authorized;
  if (anchor && item && !scope.some(part => anchor.includes(part) || part.includes(anchor.trim()))) return false;
  if (scope.some(source => source.includes(next))) return true;
  const externalOrNew = /(?:另一个|新的项目|其他项目|外部|发给|发布|部署|推送|删除|销毁|付款|下单|授权|新建账户|another project|deploy|publish|delete|send to|purchase|transfer funds)/iu;
  const addedAction = /(?:(?:并(?:且)?|然后|随后|接着|同时|以及|[,，、；;]|(?:把|将).{0,32})\s*(?:请|再|顺便)?\s*(?:格式化|上传|移动|改名|修改|改写|重写|补齐|提交|覆盖|写入)|\b(?:upload|move|rename|modify|rewrite|overwrite|commit)\b)/iu;
  if (externalOrNew.test(next) || addedAction.test(next)) return false;
  const diagnostic = /^(?:请\s*)?(?:排查|诊断|定位|分析|梳理|核对|检查|查找|\b(?:identify|investigate|diagnose|inspect|check)\b)\s*/iu;
  if (!diagnostic.test(next)) return false;
  const topicOf = (text: string) => text.replace(diagnostic, "")
    .split(/(?:并(?=且|补|完|修|验|核|检|发|删|把|将|格式化)|以及|；|，|\s+and\s+)/iu)[0].trim();
  if (topicOf(next) !== next.replace(diagnostic, "").trim()) return false;
  if (topicOf(next).length > 1 && scope.some(source => diagnostic.test(source) && topicOf(source) === topicOf(next))) return true;
  const topics = next.match(/导入|导出|性能|瓶颈|启动|内存|延迟|吞吐|渲染|滚动|布局|回归|时间|账单|库存|报价|订单|供应商|性能指标|\b[a-z][a-z0-9_-]{3,}\b/giu) ?? [];
  return topics.some(topic => !/^(?:identify|investigate|diagnose|inspect|check)$/iu.test(topic) &&
    scope.some(source => source.toLowerCase().includes(topic.toLowerCase())));
}
