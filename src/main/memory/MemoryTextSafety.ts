/**
 * Shared secret boundary for every layer that may keep text: Bot capture/history and
 * the Memory Kernel write path. Ordinary technical identifiers (a lone `cookie` term,
 * a commit SHA or content hash) are not credentials; only credential-shaped values are.
 * Keeping one implementation prevents an entry that accepts a message from writing it
 * into L1 only for the kernel to reject the same text (or the reverse).
 */

/** Topic labels that only appear when a credential or sensitive personal record is at stake. */
const SENSITIVE_TOPIC = /(?:api[ _-]?key|password|passwd|secret|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|recovery[ _-]?(?:code|seed)|私钥|恢复码|助记词|密钥|密码|口令|令牌|验证码|身份证|护照|银行卡|信用卡|病历|诊断|用药|医疗|健康状况|银行账户|存款|资产|medical|diagnosis|medication|diabetes|insulin|cancer|hiv|antidepressant|糖尿病|胰岛素|癌症|艾滋|抑郁|passport|social security|credit card|bank account|保密|机密)/i;

/** Secret-bearing syntax: a credential header, assignment or labelled long value.
 * The cookie branch deliberately has no leading `\b`: it must also match after a
 * newline, a Chinese label, a quote (curl / JSON) or any other non-word character. */
const SECRET_VALUE = new RegExp([
  String.raw`(?:^|[^\w])(?:set[ _-]?cookie|cookie)["']?\s*[:=：]\s*["']?[A-Za-z0-9._~+/=-]{8,}`,
  String.raw`\b(?:authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{16,}`,
  String.raw`\b(?:session|auth|csrf|xsrf|tracking)[ _-]?(?:id|key|token|cookie)\s*[:=：]\s*\S{8,}`,
  String.raw`\b(?:token|secret|key|password|passwd|signature)\s*[:=]\s*["']?[A-Fa-f0-9]{32,}\b`,
].join("|"), "i");

const PREFIXED_KEY = /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;
/** Card-like digit runs. The lookarounds keep a SHA tail such as `…a7623364242298`
 * from being read as a card number. */
const CARD = /(?<![\w-])(?:\d[ -]?){13,19}(?![\w-])/;

/** True when the text must not be copied into memory evidence, a record or a prompt. */
export function hasSensitiveMemoryContent(text: string): boolean {
  if (!text.trim()) return false;
  return SENSITIVE_TOPIC.test(text) || SECRET_VALUE.test(text) || PREFIXED_KEY.test(text)
    || JWT.test(text) || SSN.test(text) || CARD.test(text);
}
