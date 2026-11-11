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

/** Conservative capture boundary: never copy secrets or one-off private details into memory evidence. */
export function botMemoryTextEligible(text: string): boolean {
  return Boolean(text.trim()) && !/(?:api[ _-]?key|password|passwd|secret|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|recovery[ _-]?(?:code|seed)|cookie|私钥|恢复码|助记词|密钥|密码|口令|令牌|验证码|身份证|护照|银行卡|信用卡|病历|诊断|用药|医疗|健康状况|银行账户|存款|资产|medical|diagnosis|medication|diabetes|insulin|cancer|hiv|antidepressant|糖尿病|胰岛素|癌症|艾滋|抑郁|passport|social security|credit card|bank account|保密|机密|不要(?:记住|记录|保存|存储)|别(?:记住|保存)|do not (?:remember|store|save)|don.t (?:remember|store|save))/i.test(text)
    && !/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i.test(text)
    && !/\b\d{3}[- ]\d{2}[- ]\d{4}\b/.test(text)
    && !/(?:\d[ -]?){13,19}/.test(text)
    && !/\b[A-Fa-f0-9]{40,}\b/.test(text);
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
