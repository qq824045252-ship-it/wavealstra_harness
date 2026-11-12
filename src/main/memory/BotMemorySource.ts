import type { AppDatabase } from "../db/AppDatabase";
import { LOCAL_USER_ID } from "../../shared/bot-work";

/** A foreground conversation is a real memory source, never a fabricated Task row. */
export function botMemorySource(db: AppDatabase, conversationId: string, userId = LOCAL_USER_ID) {
  return db.connection.prepare(`SELECT c.conversation_id,c.bot_id,c.team_id,c.user_id,b.status
    FROM bot_conversations c JOIN bots b ON b.bot_id=c.bot_id AND b.user_id=c.user_id
    WHERE c.conversation_id=? AND c.user_id=?`).get(conversationId, userId) as {
      conversation_id: string; bot_id: string; team_id: string | null; user_id: string; status: string;
    } | undefined;
}

/** One conservative scope boundary for direct writes, extraction, forgetting and
 * historical references. A wording variant must never promote a temporary fact. */
export function botMemoryConversationOnly(text: string): boolean {
  const wording = text.replace(/\bnot\s+only\b/gi, "notexclusive");
  const conversation = "(?:本(?:次|轮)?|这(?:次|轮|个)?|当前|此(?:次|轮)?)(?:对话|会话|聊天)";
  return new RegExp(`(?<!不)(?:仅|只)(?:限)?(?:于|在|对|用于)?${conversation}|${conversation}(?:中|内|里)?(?:有效|适用)(?:而已|即可|就好)|(?:有效期|适用范围)(?:仅限|为|是)?${conversation}`).test(wording)
    || /\b(?:only\s+(?:for\s+|in\s+|within\s+)?(?:this|the current)\s+(?:conversation|chat|session)|(?:for\s+|in\s+)?(?:this|the current)\s+(?:conversation|chat|session)\s+only)\b/i.test(wording)
    || /(?:不要|不得|不能|不许|别)(?:再|继续)?(?:在|带到|用于|延续到|应用于)?(?:新的?|其他|下次|后续)(?:对话|会话|聊天)|不跨(?:对话|会话|聊天)|(?:新的?|下次|后续)(?:对话|会话|聊天)(?:中|内|里)?(?:不要|不得|不能|不再|不应)(?:再|继续)?(?:使用|保留|记住|应用)/.test(wording)
    || /\b(?:do not|don't|never)\s+(?:carry|share|reuse|retain|remember)\b.{0,48}\b(?:other|future|new)\s+(?:chats?|conversations?|sessions?)\b/i.test(wording);
}

/** Explicit "do not keep this" wording. Kept separate from secret syntax so a
 * technical discussion can be captured while a real opt-out still wins. */
const BOT_MEMORY_OPT_OUT = /不要(?:记住|记录|保存|存储)|别(?:记住|保存)|do not (?:remember|store|save)|don.t (?:remember|store|save)/i;

/** Topic labels that only appear when a credential or sensitive personal record is at stake. */
const BOT_MEMORY_SENSITIVE_TOPIC = /(?:api[ _-]?key|password|passwd|secret|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|recovery[ _-]?(?:code|seed)|私钥|恢复码|助记词|密钥|密码|口令|令牌|验证码|身份证|护照|银行卡|信用卡|病历|诊断|用药|医疗|健康状况|银行账户|存款|资产|medical|diagnosis|medication|diabetes|insulin|cancer|hiv|antidepressant|糖尿病|胰岛素|癌症|艾滋|抑郁|passport|social security|credit card|bank account|保密|机密)/i;

/** Secret-bearing syntax. A bare `cookie` term or a standalone Git SHA/hash is a
 * technical identifier, not a credential, so only value-shaped occurrences block. */
const BOT_MEMORY_SECRET_VALUE = new RegExp([
  String.raw`\b(?:set[ _-]?cookie|(?:^|[^\w])cookie)\s*[:=：]\s*\S{6,}`,
  String.raw`\b(?:authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{16,}`,
  String.raw`\b(?:session|auth|csrf|xsrf|tracking)[ _-]?(?:id|key|token|cookie)\s*[:=：]\s*\S{8,}`,
  String.raw`\b(?:token|secret|key|password|passwd|signature)\s*[:=]\s*["']?[A-Fa-f0-9]{32,}\b`,
].join("|"), "i");

/** Conservative capture boundary: never copy secrets or one-off private details into memory evidence. */
export function botMemoryTextEligible(text: string): boolean {
  if (!text.trim()) return false;
  if (BOT_MEMORY_OPT_OUT.test(text) || BOT_MEMORY_SENSITIVE_TOPIC.test(text) || BOT_MEMORY_SECRET_VALUE.test(text)) return false;
  return !/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i.test(text)
    && !/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)
    && !/\b\d{3}[- ]\d{2}[- ]\d{4}\b/.test(text)
    && !/(?<![\w-])(?:\d[ -]?){13,19}(?![\w-])/.test(text);
}

/** Forget is a deletion request, not a new negative preference. Mixed requests may
 * write only the independently quoted, explicitly new remember clause. */
export function botMemoryWriteEvidenceAllowed(userText: string, evidence: string): boolean {
  const forgetting = /(?:忘记|删除.{0,24}记忆|清除.{0,24}记忆|\bforget\b|\bdelete\b.{0,32}\bmemor)/i;
  if (!forgetting.test(userText)) return true;
  if (!evidence.trim() || forgetting.test(evidence)) return false;
  return userText.split(/[，,、。；;！!？?\n]/).some(clause =>
    clause.includes(evidence.trim()) && /(?:记住|记下|保存|remember|memorize|save)/i.test(clause)
    && !/(?:不要|别|勿|不再|无需).{0,8}(?:记住|记下|保存)|(?:do not|don['’]?t|never)\s+(?:remember|memorize|save)/i.test(clause)
    && !forgetting.test(clause));
}
