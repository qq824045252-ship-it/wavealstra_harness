import type { AgentPromptRequest } from "../../shared/agent-ipc";
import { isDotsAutomaticInput } from "../../shared/dots";
import type { ForegroundInput } from "./DotsForegroundReads";

const denyForwarding = /(?:不要|别|不必|不用|无需|不许|禁止)\s*(?:再\s*)?(?:(?:把|让)[^,，。.!！？?;；\n]{1,40}任务\s*)?(?:委派|派工|派任务|转交|转发|追问|跟进|接续|续办|继续|接着|恢复|重跑|重试)|(?:只|仅)(?:在|用)(?:这个|当前|本)对话|(?:只|仅)(?:讨论|聊|查询|查进度)|do not (?:delegate|forward|follow up|resume|continue|retry|rerun)|(?:discussion|chat) only/iu;
const stopDirective = /^(?:请\s*)?(?:先\s*)?(?:停(?:一下|下|掉|止)?|暂停|取消)(?:\s*(?:这(?:件事|个任务|次)|原任务|不用了|吧|下来))?[\s。！!]*$/u;
const followUpDirective = /^(?:(?:好|可以|请|麻烦|你|帮我|给我|先|再)\s*)*(?:(?:跟|问)一下(?:原任务|原交办|原事项)|(?:给|向)原任务(?:再)?(?:追问|跟进)|追问|跟进|(?:接着|继续)(?:处理|完善|办|做|原任务|原交办)|follow up\b)/iu;
const supplementalCaption = /^(?:补(?:一张|个)?图|(?:这是|附上|补上|看)(?:这张)?(?:截图|图)|如图|就这个|还是没变|还是没看到效果(?:啊)?|乱七八糟(?:的)?)[\s。！!]*$/u;
const screenshotDescription = /^(?:这(?:张图|个界面|个页面)|截图|图里|图上|界面|页面|布局|状态栏|顶栏|底栏|回复区|画面)[^?？；;\n]{1,100}$/u;
const unrelatedRequest = /(?:麻烦|帮我|请你?|顺手|顺便|另一个|另外|接下来|务必|先去|删除|部署|提交|推送|重跑|派活|帮忙|改成|换成|发给)/u;
const attachmentOnlyText = /^## 用户附带文件\s*\n(?:\s*- [^\n]+(?:\n|$))+$/u;
const imagePath = /\.(?:png|jpe?g|gif|webp|bmp)$/iu;

function clauses(text: string): string[] {
  return text.split(/(?<=[,，。.!！？?;；\n])/u).map(part => part.trim());
}

export function dotsForwardingDenied(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return denyForwarding.test(normalized) || clauses(normalized).some(clause => stopDirective.test(clause.replace(/[,，;；]+$/u, "")));
}

function isFollowUpDirective(clause: string): boolean {
  const normalized = clause.normalize("NFKC");
  return followUpDirective.test(normalized)
    && !/[?？]|(?:吗|么)[。!！]?$/.test(normalized)
    && !/(?:这个词|是什么意思|指的是什么|怎么用|怎么做|是为什么|说过)/u.test(normalized);
}

export function dotsFollowUpInput(inputs: readonly ForegroundInput[]) {
  if (inputs.some(input => isDotsAutomaticInput(input.id) || dotsForwardingDenied(input.text)))
    throw new Error("本轮没有授权把追问发给原任务。请用 task 查看当前状态。");
  const directives = inputs.flatMap(source => clauses(source.text).filter(isFollowUpDirective).map(assignmentQuote => ({ source, assignmentQuote })));
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
