import { z } from "zod";

const observation = z.object({
  protocol: z.literal("watch-observation-v1"),
  status: z.enum(["observed", "unavailable"]),
  facts: z.array(z.object({ source: z.string().min(1), key: z.string().min(1), value: z.string() }).strict()).max(100),
  summary: z.string(),
}).strict();

export const WATCH_COMPARISON_INSTRUCTIONS = `comparisonState 是宿主的自动比较状态，与是否通知或静默无关，也不是限制你进行事实比较的审批。no_baseline 表示没有本轮之前可用的同一观察历史：只报告本轮事实，可说明首次观察或暂无历史可比，禁止声称“无变化”“与上轮一致”或“有变化”。本轮结果、同轮成员结果、任务说明和长期记忆不是上一轮基线。
unverified 仅表示尚未完成宿主的结构化自动比较，不表示历史记录不可信、没有比较依据或禁止比较。你应根据本轮真实读取和所给同源历史的明确值自行核对：例如此前 open=2、本轮 open=1，就直接报告减少1；此前和本轮都是3且明细一致，就直接报告数量和明细未变。完整原文或历史报告中同源同属性的明确数值/文本都可以支持具体比较，不必等待额外宿主证明。只有确有来源错配、读取失败、不完整、证据矛盾或缺少对应事实时，才说明具体比较局限；不得仅因 unverified 机械追加“宿主未核验”“暂不判定”“只能并列事实”等免责。unchanged / changed 表示宿主已自动核对可比较的读取证据相同 / 不同。
不要照抄结果摘要中没有依据的变化判断。没有历史不是需要补查的缺项，不为构造过去的基线重新执行。面向用户只说具体事实、变化和真实局限，不输出 comparisonState、unverified、宿主核验等内部字段或流程术语。`;

export const WATCH_OBSERVATION_INSTRUCTIONS = `本事项选择只在变化时通知。每次检查仍须执行真实只读工具，最终只返回一个 JSON 对象（不要另加说明）：
{"protocol":"watch-observation-v1","status":"observed","facts":[{"source":"实际来源的稳定路径或URL","key":"用户跟踪的属性，如file_content","value":"真实读取到的精确属性值"}],"summary":"变化时供用户阅读的简短报告"}。
facts 是稳定的业务事实，不是摘要措辞；不要包含检查时间、轮次、自己推算的哈希或会变化的汇报文案。文件内容使用精确原文。只有本次真实工具取得完整、可比较事实才使用 observed；来源读取失败、不完整、不能可靠比较则 status=unavailable，summary 说明缺口，不得用空值假装无变化。宿主负责建立基线、比较和静默，你不得自己发送通知。`;

/** Continuous rounds still perform the original actions; observation is the source proof, not a read-only execution mode. */
export const CONTINUOUS_WATCH_OBSERVATION_INSTRUCTIONS = WATCH_OBSERVATION_INSTRUCTIONS.replace(
  "每次检查仍须执行真实只读工具", "每轮先完成原用户要求的真实行动与产物更新，再用支持原生读取回执的工具核对来源（本地文件用 read；不要用 shell 输出代替来源读取）"
) + " 来源未变化也必须本轮重新读取，不能沿用历史摘要。需保留的产物必须回读并通过现有产物登记工具登记本轮快照；facts 只描述输入来源，不混入自行生成的简报。该协议不限制原目标中的写入，不替代成果文件；若有实际缺项必须在 summary 如实说明，不得宣称静默或自行发通知。";

export function parseWatchObservation(text: string) {
  try {
    const parsed = observation.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")));
    if (!parsed.success) return undefined;
    const value = parsed.data;
    const keys = value.facts.map(f => JSON.stringify([f.source, f.key]));
    if (value.status === "observed" && (!keys.length || new Set(keys).size !== keys.length)) return undefined;
    return value;
  } catch { return undefined; }
}
