// Keep quoted examples, commands and neutral references out of user intent.
// Handle each clause independently: "pre-merge check; do not merge" still
// requests a pre-merge check, while "do not review or merge" requests neither.
export function reviewIntent(messages: string[]) {
  let review = false, merge = false;
  for (const message of messages) {
    const prose = message.replace(/^\s*>[^\n]*/gm, "").replace(/\x60{3}[\s\S]*?\x60{3}|\x60[^\x60\n]*\x60/g, " ")
      .replace(/,\s*(or|and)\s+/gi, " $1 ");
    for (const clause of prose.split(/[,，。；;!?！？\n]|\.(?:\s|$)|\b(?:but|instead)\b|(?:但是|但要|不过)/i)) {
      const cn = clause.replace(/(?:代码|质量|独立)?(?:审查|评审|审阅|复核|合并|合入)(?:是)?(?:不需要|没必要|不用|不必|已取消)/g, " ")
        .replace(/(?:不(?:要|用|必|需要|允许|得)|无需|禁止|别|跳过|取消|免于|没有(?:要求|授权))[^，。；;.!?！？\n]{0,80}/g, " ");
      const affirmative = cn.replace(/\b(?:(?:code|quality|independent)\s+)?(?:review|audit|merg(?:e|ing))\s+(?:isn['’]t|is\s+not|was\s+not|is\s+unnecessary|is\s+optional)(?:\s+(?:required|requested|needed|permitted))?\b/gi, " ")
        .replace(/\b(?:do(?:es)?\s+not|do(?:es)?n['’]t|must\s+not|should\s+not|no\s+need\s+to|not\s+(?:to|requesting|asking)|no|never|without|skip|avoid|cancel)\b[\s\S]*$/i, " ");
      if (/(?:审查|评审|审阅|复核|审核)(?:代码|实现|补丁|变更|这|此|结论|结果)|(?:独立|代码|质量|严格|合并前)(?:地|的)?(?:审查|评审|审阅|复核|审核)|(?:请|帮我|需要|务必|执行|进行|做|安排|启动)[^，。；]{0,15}(?:审查|评审|审阅|复核)|严格(?:看(?:一?下|一看)?|检查|核查).*(?:代码|质量)/.test(affirmative)
        || /\b(?:review|audit)\s+(?:the\s+|my\s+|our\s+|this\s+|these\s+|that\s+|code\b|changes?\b|patch\b|[a-z\d_-]+\.[a-z\d]+)|\b(?:code|quality|independent|thermos)\s+(?:review|audit)\b|\b(?:run|perform|request|use)\s+(?:an?\s+)?thermos\b/i.test(affirmative)
        || /(?:看看?|核查|评估|检查|把关)(?:一?下)?(?:代码)?质量|(?:代码)?质量(?:怎么样|如何|好不好)/.test(affirmative)
        || /^\s*(?:please\s+)?(?:review|审查|评审|审核|严格看|质量)\s*$/i.test(affirmative)) review = true;
      if (/\b(?:pre[- ]?merge|before\s+(?:(?:we|you|I)\s+)?merg(?:e|ing)|ready\s+to\s+merge|merge\s+(?:this|the|our|my|it|branch|pr)\b)/i.test(affirmative)
        || /(?:合并|合入)(?:之?前|前置|检查|到|这|此|分支|主线|主干)|(?:请|需要|准备|可以|即将|执行|等待)(?:要|先|将)?(?:合并|合入)/.test(affirmative)) merge = true;
    }
  }
  return { review, merge };
}

export const MERGE_REVIEW_BLOCK = "Call pstack_delegate with purpose=thermos before merging this workspace.";
