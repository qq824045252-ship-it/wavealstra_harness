type Clause = Readonly<{ kind: "user" | "reference" | "prohibited" | "question"; text: string; start: number; end: number }>;
export type MemoryRemovalIntent = ({ kind: "forget"; clause: string; target: string; all: boolean }
  | { kind: "correct"; clause: string }) & { readonly document: MemoryInstructionDocument };
export type MemoryForgetSource = { createdAt: number; messageId: string; requestClauses?: readonly string[] };

export function memoryClauses(text: string): string[] {
  return text.split(/[，,、。；;！!？?\n]+/).map(clause => clause.trim()).filter(Boolean);
}

const DIRECT_OPERATION = /^(?:(?:请你?|麻烦你?|帮我|替我|现在)\s*)*(?:忘记|删除|清除|记住|记下|保存|更正|修正|纠正|替换)|^(?:不要|别)忘记|^(?:please\s+)?(?:forget|delete|remove|clear|remember|save|correct|update|replace)\b|^(?:don['’]?t|do not|never)\s+forget\b/i;
const EXECUTION_HEADER = /^(?:请\s*)?(?:执行|实际执行)(?:以下|下面|这些)?(?:操作|命令|指令)?[：:]?$|^(?:please\s+)?(?:execute|run)\s+(?:the\s+)?following/i;
const RESUME_EXECUTION = /(?:^|[。.!])\s*(?:现在|接下来)\s*(?:请)?(?:执行|实际执行|忘记|删除|清除)|^(?:now|next)\s+(?:please\s+)?(?:execute|forget|delete|clear)\b/i;
const REFERENCE_END = /^(?:(?:以上)?(?:示例|例子|文档|引用|引文|代码)(?:部分)?(?:已)?结束|end\s+(?:of\s+)?(?:example|quote|documentation|code))(?:[。.!：:]|\s|$)/i;
const PROHIBIT_EXECUTION = /(?:不要|禁止|切勿|无需|不必)(?:实际)?(?:执行|运行|操作)|\b(?:do not|don['’]?t|never)\s+(?:execute|run|act)\b/i;
const REFERENCE_HEADER = /^(?:(?:请|帮我)?(?:解释|分析|说明|阅读|检查|讨论))|^(?:以下|下面|这是|这里是)?(?:示例|例子|文档|引用|引文|代码|教程)|^(?:please\s+)?(?:explain|describe|analy[sz]e|review)\b|^(?:example|documentation|quote|code)\b/i;

/** Preserve inline quotation boundaries before splitting punctuation. Apostrophes
 * inside words are contractions, not quote delimiters. An unclosed quote remains
 * reference material rather than authorizing an embedded destructive command. */
function inlineReferences(text: string): Array<{ start: number; end: number }> {
  const pairs: Record<string, string> = { "“": "”", "‘": "’", '"': '"', "'": "'", "\`": "\`" };
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: Array<{ start: number; close: string }> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if ((char === "'" || char === "’") && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[i + 1] ?? "")) continue;
    // A possessive apostrophe inside another quote (James' preferences) must
    // not open a nested reference that swallows later independent commands.
    if (char === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "") && stack.at(-1)?.close !== "'") continue;
    if (text[i - 1] === "\\") continue;
    if (stack.at(-1)?.close === char) {
      const open = stack.pop()!;
      if (!stack.length) ranges.push({ start: open.start, end: i + 1 });
    } else if (pairs[char]) stack.push({ start: i, close: pairs[char] });
  }
  if (stack.length) ranges.push({ start: stack[0].start, end: text.length });
  return ranges;
}

function instructionParts(line: string, offset: number, references: readonly { start: number; end: number }[]) {
  const protectedAt = (i: number) => references.some(range => range.start <= offset + i && offset + i < range.end);
  const parts: Array<{ text: string; start: number; end: number; question: boolean; reference: boolean }> = [];
  let sentenceStart = 0;
  const sentence = (end: number, question: boolean) => {
    let start = sentenceStart;
    for (let i = start; i <= end; i++) {
      if (i !== end && (!/[，,、]/.test(line[i]) || protectedAt(i))) continue;
      const raw = line.slice(start, i); const text = raw.trim();
      const actual = start + raw.indexOf(text);
      if (text) parts.push({ text, start: offset + start, end: offset + i,
        question, reference: protectedAt(actual) });
      start = i + 1;
    }
    sentenceStart = end + 1;
  };
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length && (!/[。；;！!？?]/.test(line[i]) || protectedAt(i))) continue;
    const wording = line.slice(sentenceStart, i).trim();
    sentence(i, /[？?]/.test(line[i] ?? "") || /(?:会怎样|会怎么样|是什么|什么意思|吗|么)[。.]?$/.test(wording));
  }
  return parts;
}

/** The document owns execution authority, including block context and questions.
 * Destructive consumers accept intents from this owner, never classify a quote. */
export class MemoryInstructionDocument {
  private constructor(private readonly source: { text: string; clauses: readonly Clause[] }) {}
  get text() { return this.source.text; }
  get clauses() { return this.source.clauses; }

  static parse(text: string): MemoryInstructionDocument {
    const clauses: Clause[] = [];
    const references = inlineReferences(text);
    let context: Clause["kind"] = "user";
    let fence: string | undefined;
    let blockStart = 0;
    for (const line of text.matchAll(/[^\n]+|\n/g)) {
      if (line[0] === "\n") continue;
      const wording = line[0].trim();
      const marker = /^(`{3,}|~{3,})/.exec(wording)?.[1];
      if (marker) {
        clauses.push({ kind: "reference", text: wording, start: line.index, end: line.index + line[0].length });
        if (!fence) fence = marker[0];
        else if (marker[0] === fence) fence = undefined;
        continue;
      }
      const quoted = Boolean(fence) || /^\s*>/.test(line[0]) || /^(?: {4}|\t)/.test(line[0]);
      const endedReference = !quoted && REFERENCE_END.test(wording);
      const resumedExecution = !quoted && context === "user" && RESUME_EXECUTION.test(wording);
      if (endedReference || resumedExecution) {
        context = "user"; blockStart = clauses.length;
      }
      const introduction = !endedReference && !resumedExecution && !DIRECT_OPERATION.test(wording) && (REFERENCE_HEADER.test(wording) || /[：:]$/.test(wording));
      if (!quoted && context === "user" && introduction && !EXECUTION_HEADER.test(wording)) blockStart = clauses.length;
      if (!quoted && PROHIBIT_EXECUTION.test(wording)) {
        context = "prohibited";
        for (let i = blockStart; i < clauses.length; i++) clauses[i] = { ...clauses[i], kind: "prohibited" };
      } else if (!quoted && context === "user" && (EXECUTION_HEADER.test(wording) || resumedExecution)) {
        context = "user"; blockStart = clauses.length;
      } else if (!quoted && introduction) context = "reference";
      for (const part of instructionParts(line[0], line.index, references)) {
        clauses.push({ kind: quoted || part.reference ? "reference" : context === "user" && part.question ? "question" : context,
          text: part.text, start: part.start, end: part.end });
      }
    }
    return new MemoryInstructionDocument({ text, clauses });
  }

  allowsEvidence(evidence: string): boolean {
    if (!evidence.trim()) return false;
    let at = this.text.indexOf(evidence);
    while (at >= 0) {
      if (!this.clauses.some(clause => clause.kind !== "user" && clause.start < at + evidence.length && clause.end > at)) return true;
      at = this.text.indexOf(evidence, at + 1);
    }
    return false;
  }

  removalIntents(): MemoryRemovalIntent[] {
    return this.clauses.flatMap(({ kind, text: clause }): MemoryRemovalIntent[] => {
      if (kind !== "user") return [];
      const chinese = /^(?:(?:请你?|麻烦你?|帮我|替我|现在)\s*)*(?:忘记|删除|清除)(.+)$/i.exec(clause);
      const english = /^(?:please\s+)?(?:forget\s+|(?:delete|remove|clear)\s+)(.+)$/i.exec(clause);
      const match = chinese ?? english;
      if (match) {
        const raw = match[1].trim().replace(/[.!]+$/, "").trim();
        if (/(?:是什么|什么意思|怎么|如何|是不是|是否|能否|了吗|了么)|\b(?:what|how|whether)\b/i.test(raw)) return [];
        if (/^(?:命令|功能|接口|方法|测试|command\b|function\b|API\b|test\b)/i.test(raw)) return [];
        // "delete a file" is not a memory operation.
        if (!/^(?:(?:请你?|麻烦你?|帮我|替我|现在)\s*)*忘记|^(?:please\s+)?forget\s+/i.test(clause)
          && !/记忆|偏好|历史|\bmemor(?:y|ies)\b|\bpreference\b|\bhistory\b/i.test(raw)) return [];
        const all = /^(?:并(?:删除|清除))?\s*(?:我的?|当前(?:Bot|团队)的?|本次(?:对话|会话)的?)?\s*(?:(?:全部|所有)(?:的)?(?:旧)?(?:长期|共享)?(?:记忆|历史|内容)(?:记忆|内容)?|一切|所有事情)$/i.test(raw)
          || /^(?:everything|all\s+(?:my\s+)?(?:old\s+)?(?:memories|memory|history))$/i.test(raw);
        const target = raw.replace(/^(?:并(?:删除|清除))?\s*(?:我的?|有关|关于|the\s+|my\s+)?/i, "")
          .replace(/(?:这条|这项|这个)?记忆[。.!]*$/, "").trim();
        return target ? [{ kind: "forget", clause, target, all, document: this }] : [];
      }
      if (/^(?:请\s*)?(?:更正|修正|纠正|替换).{0,24}(?:偏好|记忆|长期|回复格式)|^(?:please\s+)?(?:correct|update|replace).{0,32}(?:preference|memory)/i.test(clause)) {
        return [{ kind: "correct", clause, document: this }];
      }
      return [];
    });
  }
}

export function memoryRememberClause(clause: string): boolean {
  return /(?:不要|别|永远不要)忘记|\b(?:don['’]?t|do not|never)\s+forget\b/i.test(clause)
    || /(?:记住|记下|保存|\bremember\b|\bmemorize\b|\bsave\b)/i.test(clause)
      && !/(?:不要|别|勿|不再|无需).{0,8}(?:记住|记下|保存)|(?:do not|don['’]?t|never)\s+(?:remember|memorize|save)/i.test(clause);
}
