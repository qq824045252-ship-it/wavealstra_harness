import type { AgentPromptRequest } from "../../shared/agent-ipc";
import { isDotsAutomaticInput } from "../../shared/dots";
import type { ForegroundInput } from "./DotsForegroundReads";

const denyForwarding = /(?:不要|别|不必|不用|无需|不许|禁止)\s*(?:再\s*)?(?:(?:把|让)[^,，。.!！？?;；\n]{1,40}任务\s*)?(?:委派|派工|派任务|转交|转发|追问|跟进|接续|续办)|(?:只|仅)(?:讨论|聊|查询|查进度)|do not (?:delegate|forward|follow up|resume|continue|retry|rerun)|(?:discussion|chat) only/iu;
const denyContinuation = /(?:不要|别|不必|不用|无需|不许|禁止)\s*(?:再\s*)?((?:把|让).{1,40}任务\s*)?(?:继续|接着|恢复|重跑|重试|重新(?:跑|执行|开始|做)|再(?:跑|试)一[次遍轮])\s*(.*)$/u;
const validationStep = /^(?:(?:运行|执行|做|重跑|重试)\s*)?(?:(?:已(?:经)?|此前|之前|刚才)?(?:通过|成功)的\s*)?(?:(?:同(?:一)?版本|相同版本)\s*)?(?:(?:类型|回归|单元|冒烟|构建|格式)\s*)?(?:检查|测试|校验|验证)$/u;
const onlyHere = /(?:只|仅)(?:在|用)(?:这个|当前|本)对话(?:中|里)?\s*(.*)$/u;
const deliveryHere = /^(?:回传|返回|交付|汇报)(?:本次|这次|最终|已完成的)?(?:结果|成果|文件|附件|报告|结论)(?:给我)?$/u;
const stopDirective = /^(?:(?:请|先|还是)\s*)*(?:停(?:一下|下|掉|止)?|暂停|取消|算了|不用了|别做了|到此为止)(?:\s*(?:这(?:件事|个任务|次)|原任务|不用了|吧|下来))?[\s。！!]*$/u;
const directionPrefix = String.raw`(?:(?:好|行|可以|确认|请|麻烦|帮我|给我|我(?:要|想让|希望)你|你|现在|先|再|顺便)[,，\s]*)*`;
const taskReference = String.raw`(?:(?:刚才|之前|上一个|前一个|这|那|原|该)[^,，。.!！？?;；\n]{0,24}(?:任务|事项|交办|件事)|(?:剩下|余下|未完成|没做完)的(?:事|工作|部分)?)`;
const targetBeforeAction = String.raw`(?:把|让)\s*${taskReference}\s*`;
const workVerb = "(?:做|办|处理|完善|完成|执行|干|跑)";
const continuationVerb = "(?:继续|接着|恢复|重试|重跑|重新(?:跑|执行|开始|做)|再(?:跑|试)一[次遍轮])";
const restartVerb = "(?:恢复|重试|重跑|重新(?:跑|执行|开始|做)|再(?:跑|试)一[次遍轮])";
const resumeDirective = new RegExp(String.raw`^${directionPrefix}(?:${targetBeforeAction}(?:${continuationVerb}\s*${workVerb}|完成|${workVerb}完)|(?:继续|接着)(?=\s*(?:${targetBeforeAction}${workVerb}|${taskReference}|${workVerb}|$|[,，。.!！]))|${restartVerb})`, "u");
const multipleTargets = /(?:所有|每个|各个|[两二三四五六七八九十\d]+[个项件]|这[些批]|那[些批]|几个|多个)[^，。！？]{0,6}(?:任务|事项|交办)|(?:任务|事项|交办)[^，。！？]{0,12}(?:和|与|、|及)\s*[^，。！？]{0,12}(?:任务|事项|交办)/u;
const resumeQuestion = /[?？]|(?:可否|能否|能不能|可不可以|要不要|是不是|是否|需要多久|还要多久)|(?:吗|么|如何|继续多久)[.!。！]*$/u;
const inspectProgress = /(?:继续|接着)\s*(?:查看|查|追查|排查|诊断|调查|分析|解释|看|确认进度)|continue\s+(?:to\s+)?(?:check|look|investigat|explain)/iu;
const followUpDirective = new RegExp(String.raw`^${directionPrefix}(?:(?:跟|问)一下(?:原任务|原交办|原事项)|(?:给|向)原任务(?:再)?(?:追问|跟进)|追问|跟进|follow up\b)`, "iu");
const englishResume = /^(?:please\s+|go ahead and\s+)?(?:resume|retry|rerun|restart|continue)\b/i;
const reportedSpeech = /(?:这个词|是什么意思|指的是什么|怎么用|怎么做|是为什么|说过|比如|举例|假[设如]|之前先|(?:不了|还是停|失败了)[.!。]*$)/u;
const reportedContext = /(?:比如|举例|假设|假如|如果|假定|示例|例子|引用|原话是|说过|有人说|\b(?:for example|suppose|if|quote)\b)/iu;
const supplementalCaption = /^(?:补(?:一张|个)?图|(?:这是|附上|补上|看)(?:这张)?(?:截图|图)|如图|就这个|还是没变|还是没看到效果(?:啊)?|乱七八糟(?:的)?)[\s。！!]*$/u;
const screenshotDescription = /^(?:这(?:张图|个界面|个页面)|截图|图里|图上|界面|页面|布局|状态栏|顶栏|底栏|回复区|画面)[^?？；;\n]{1,100}$/u;
const unrelatedRequest = /(?:麻烦|帮我|请你?|顺手|顺便|另一个|另外|接下来|务必|先去|删除|部署|提交|推送|重跑|派活|帮忙|改成|换成|发给)/u;
const attachmentOnlyText = /^## 用户附带文件\s*\n(?:\s*- [^\n]+(?:\n|$))+$/u;
const imagePath = /\.(?:png|jpe?g|gif|webp|bmp)$/iu;

function clauses(text: string): string[] {
  return text.split(/(?<=[,，。.!！？?;；\n])/u).map(part => part.trim());
}

export function dotsInstructionText(text: string): string {
  let fence: string | undefined;
  return text.split("\n").map(line => {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = undefined;
      return "";
    }
    if (marker) {
      fence = marker;
      return "";
    }
    return /^[ \t]*>/u.test(line) ? "" : line;
  }).join("\n");
}

export function dotsForwardingDenied(text: string): boolean {
  const normalized = dotsInstructionText(text).normalize("NFKC").trim();
  return denyForwarding.test(normalized) || clauses(normalized).some(clause => {
    if (stopDirective.test(clause.replace(/[,，;；]+$/u, ""))) return true;
    const statement = clause.replace(/[,，.。！？!?;；]+$/u, "").trim();
    const localScope = onlyHere.exec(statement);
    if (localScope && !deliveryHere.test(localScope[1] ?? "")) return true;
    const continuation = denyContinuation.exec(statement);
    return Boolean(continuation && (continuation[1] || !validationStep.test(continuation[2] ?? "")));
  });
}

function isFollowUpDirective(clause: string): boolean {
  const normalized = clause.normalize("NFKC");
  const ongoing = /(?:继续|接着)|^\s*(?:please\s+)?continue\b/iu.test(normalized);
  return ongoing && isResumeDirective(normalized) || followUpDirective.test(normalized) && isSingleDirective(normalized);
}

function isSingleDirective(clause: string): boolean {
  return !multipleTargets.test(clause) && !resumeQuestion.test(clause) && !reportedSpeech.test(clause);
}

function isResumeDirective(clause: string): boolean {
  const normalized = clause.normalize("NFKC");
  return isSingleDirective(normalized) && !inspectProgress.test(normalized)
    && (resumeDirective.test(normalized) || englishResume.test(normalized));
}

function groundedDirectives(original: string, isDirective: (text: string) => boolean): string[] {
  const instruction = dotsInstructionText(original);
  if (multipleTargets.test(instruction.normalize("NFKC"))) return [];
  const parts = clauses(instruction).filter(Boolean);
  return parts.filter((part, index) => isDirective(part)
    && !parts.slice(0, index).some(preceding => reportedContext.test(preceding)));
}

function resumeQuote(original: string, quote?: string): string | undefined {
  if (dotsForwardingDenied(original)) return;
  const instructions = groundedDirectives(original, isResumeDirective);
  const directive = instructions.length === 1 ? instructions[0] : undefined;
  if (!directive || !quote) return directive;
  const plain = (text: string) => text.normalize("NFKC").trim().replace(/[,。.!;]+$/u, "");
  return plain(directive) === plain(quote) || original.includes(quote.trim()) && plain(quote).includes(plain(directive))
    ? directive : undefined;
}

/** Resume a single identified task only when the current user message authorizes it. */
export function hasDotsResumeInstruction(original: string | undefined, quote?: string): boolean {
  return Boolean(original && resumeQuote(original, quote));
}

export function dotsResumeInput(inputs: readonly ForegroundInput[], quote?: string) {
  if (inputs.some(input => isDotsAutomaticInput(input.id) || dotsForwardingDenied(input.text))) return;
  const directives = inputs.flatMap(source => {
    const assignmentQuote = resumeQuote(source.text);
    return assignmentQuote ? [{ source, assignmentQuote }] : [];
  });
  const unique = directives.length === 1 ? directives[0] : undefined;
  return unique && resumeQuote(unique.source.text, quote) ? unique : undefined;
}

export function dotsFollowUpInput(inputs: readonly ForegroundInput[]) {
  if (inputs.some(input => isDotsAutomaticInput(input.id) || dotsForwardingDenied(input.text)))
    throw new Error("本轮没有授权把追问发给原任务。请用 task 查看当前状态。");
  const directives = inputs.flatMap(source => groundedDirectives(source.text, isFollowUpDirective).map(assignmentQuote => ({ source, assignmentQuote })));
  if (directives.length !== 1) throw new Error("请从当前对话找到一条明确的追问原话。查询进度请使用 task。");
  const { source, assignmentQuote } = directives[0]!;
  const attachments = new Map<string, NonNullable<AgentPromptRequest["attachments"]>[number]>();
  const captions: string[] = [];
  for (const input of inputs) {
    const images = (input.attachments ?? []).filter(attachment => imagePath.test(attachment.path));
    const caption = input.text.trim();
    const text = caption.normalize("NFKC");
    const attachmentOnly = attachmentOnlyText.test(text);
    const describesScreenshot = screenshotDescription.test(text) && !unrelatedRequest.test(text);
    if (input !== source) {
      if (!images.length || (text && !supplementalCaption.test(text) && !attachmentOnly && !describesScreenshot))
        throw new Error("本轮有其他要求，无法确认它们只是在补图。请确认要对原任务追问什么。");
      if (caption && !attachmentOnly) captions.push(caption);
    }
    for (const attachment of images) attachments.set(attachment.path, attachment);
  }
  return { source, assignmentQuote, attachments: [...attachments.values()], captions };
}
