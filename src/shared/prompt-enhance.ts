/**
 * Prompt Enhance（Instruction Enhancement）共享纯函数：主进程与单测同源。
 *
 * sanitizeEnhancedPrompt：对模型返回做**非常轻量**的外层清洗——
 * 只剥完整 markdown 代码围栏（成对 ``` / ~~~）与常见「增强结果」单行前缀，
 * 不重写内容、不做结构推断。
 */

/** 常见「增强结果」单行前缀（中英文冒号），出现时剥掉 */
const ENHANCE_PREFIX_RE =
  /^(?:完善后的提示词|优化后的提示词|改善后的提示词|完善后的内容|增强后的提示词|增强后的Prompt|改写结果|Enhanced prompt)\s*[:：]\s*/i;

export function sanitizeEnhancedPrompt(text: string): string {
  let out = text.trim();
  // 仅剥离「成对」完整代码围栏（可带语言标记）：开围栏 + 内容 + 同种闭围栏
  const fenced = out.match(/^\s*(```|~~~)[^\n]*\n?([\s\S]*?)\n?\s*\1\s*$/);
  if (fenced) out = fenced[2]!.trim();
  // 剥常见单行前缀
  out = out.replace(ENHANCE_PREFIX_RE, "");
  return out.trim();
}
