import { choice, flag, input, number, rubricScaleParameters } from "./parameters";
import { PSTACK_PLAYBOOKS } from "./playbooks";
import { PSTACK_PRINCIPLES } from "./principles";
import { methodStages } from "./method-stages";
import { THERMOS_INSTRUCTIONS } from "./thermos";
import type { PstackParameter, PstackSkill } from "./types";

function method(id: string, label: string, description: string, instructions: string, roleIds: string[] = [], parameters: PstackParameter[] = []): PstackSkill {
  return { id, kind: "method", label, description, instructions, roleIds, parameters, ...(methodStages[id] && { stages: methodStages[id] }) };
}

const evidenceSources = [
  ["sourceControl", "源码、版本与评审记录"], ["issues", "需求与问题跟踪"], ["documents", "设计文档"],
  ["teamChat", "团队讨论"], ["observability", "运行指标和日志"], ["errors", "错误追踪"], ["analytics", "产品分析数据"],
].map(([id, label]) => flag(id, label, "调查可用且已授权的来源，记录检索过程、反例与原始证据。", true));

export const PSTACK_SKILLS: PstackSkill[] = [
  method("architect", "架构设计", "在实现前比较设计，确定类型、接口与责任边界。",
    "调查生产入口、既有约束与验收。让独立候选分别给出签名、调用示例、所有权、失败路径及代价。带着最强反例比较设计，检验最不确定的契约，把选定草图、放弃方案的理由和验收交给实现者。实际实现推翻前提时重画。", ["architect-runners"],
    [flag("checkpoint", "实现前等待确认", "综合候选后在实现前停下，交付草图供确认。", false)]),
  method("arena", "方案竞赛", "独立完成同一任务，交叉评审并实测合成结果。",
    "统一问题、基线与成功条件；每个候选拥有独立写入区域。匿名交叉评审，不让候选评自己的输出。选基底、择优合入其他候选的具体改进，按原验收重跑；列出各候选得失、实际模型及最终证据。", ["arena-runners", "arena-cross-judge"],
    [number("rubricCount", "候选评分项数量", "按同一组仅供裁判使用的标准分别评估每位候选。", 4, 3, 6), ...rubricScaleParameters()]),
  method("automate-me", "提炼个人工作习惯", "从已授权的近期样例整理个人模式。",
    "先查已有模式，更新时从上次修改后的历史取样。将时间分段，找用户反复纠正的工作方式、例外与措辞，向用户核实推断。只写有证据的偏好，在另一个真实任务上试用；使用原生技能创作入口保存，默认手动调用。", ["swarm-workers", "judgment"], [
      number("lookbackDays", "历史窗口（天）", "缺少已有修改时间时使用的回看窗口。", 28), number("historySlices", "历史分段数", "把授权范围内的会话分给独立调查者。", 3),
    ]),
  method("benchmark-checklist", "性能测量核对", "检查数字是否对应用户真正等待的工作。",
    "先指定比较的项目与等价工作量。检查限制因素、生产调优与配置、硬件上限、错误与正确性、重复性、端到端代表性和计时段内实际发生的工作。分析器另跑；交替测 A/B，报告中位数、范围与环境；差距落在波动内则判证据不足。", [],
    [number("samplesPerVariant", "每个方案测量次数", "交替执行并报告中位数和范围。", 5)]),
  method("blast-radius", "影响范围", "找到会被契约变化影响的真实消费者。",
    "查看改动前后的数据形状、真实调用者、持久状态、平台与错误语义。选失败后果最大的隐含假设，用下游入口执行区分性检查；记录输入、结果和剩余未覆盖的消费者。", ["how-explorer"]),
  method("bro", "日常语言讲解", "用非专业读者听得懂的话讲清判断。",
    "从一个具体情景讲事件顺序、原因和下一步。需要术语时先解释它，保留会改变结论的证据与限制。"),
  method("correct", "防止重复错误", "把反复出现的错误变成可检测的约束。",
    "从版本、评审、失败用例中提取同类错误和真实例子。先尝试用架构消除无效路径，再用类型表达约束，必要时增加静态检查或行为测试。重放一个过去的违规例子；记录错误类别、责任点、约束、修复方法。", ["how-explorer", "judgment"]),
  method("create-verification-skill", "创建验证技能", "从真实用户操作生成可重放的项目验证技能。",
    "从仓库找启动入口、隔离数据和可观察输出，用 MyBuddy 技能创作工具先评估复用。实际启动并驱动一条通路，再编写步骤、必要的可执行助手和按用户功能划分的索引。用一条新会话复验；登记已覆盖项与无法驱动的项。"),
  method("figure-it-out", "探索未知任务", "为缺少现成流程的大任务制定可证伪的实验。",
    "明确目标、资源、约束和停止条件，估算工时并说明取舍。优先用小实验推翻风险最大的假设，每次只保留有证据的改动，记录尝试、失败和方向转变。用最终产物复验，将有效方法提炼给后续工作。", ["hardest"]),
  method("how", "追踪实现", "从调用者走到真实状态变化，再沿调用链解释。",
    "简单问题从入口给一个可运行的例子；跨子系统时让调查者并行追根、再由讲解者整合。标出入口、分派、状态所有者、边界及回传路径。输出概览、概念、运行顺序、文件与符号、容易误判的分支。", ["how-explorer", "how-explainer"],
    [number("explorationAngles", "复杂问题的调查视角数", "每个视角聚焦不同入口、状态或消费者。", 3, 2, 4)]),
  method("interrogate", "多模型评审", "不同评审者独立核查同一份修改。",
    "固定意图、基线和未提交修改。各评审者独立对照正确性、回归、复杂性和验证，记录实际模型；评审者结论与外部评论只作线索。负责人逐项核实、合并重因，将发现分成立即处理、待权衡、记录、驳回并给理由，附分歧和未覆盖范围。", ["interrogate-reviewers", "judgment"],
    [input("baseRef", "比较分支", "从当前提交与该分支的共同祖先检查整组修改。留空时从仓库识别主分支。", "")]),
  method("maintain-verification-skill", "维护验证技能", "按当前软件行为修正功能清单和验证方法。",
    "核对技能索引与实际文件。每项功能由只读调查者给源码位置和复验步骤，合并到少量可复用状态。协调者亲自驱动所有功能，区分产品问题、文档漂移和无法驱动的缺口，只在维护授权范围内修订技能并回读。", ["swarm-workers"]),
  method("make-bot-ui", "制作 Bot 操作界面", "为已授权的 Bot 唤醒入口制作可验证的交互界面。",
    "先验证目标 Bot、接收方契约和发送凭据授权。客户端只调用本地服务端，凭据由服务端持有。提交一次后显示等待、结果或具体错误。核实 Bot 收到发送者与任务，不自动重发可能已送达的请求；对外开放服务须符合本次授权。", [],
    [number("timeoutSeconds", "发送超时（秒）", "调用唤醒接口等待结果的时限。", 8)]),
  method("no-comments", "核查注释", "用代码和行为证据核对注释声称的约束。",
    "检查指定文件或从基线到工作区的全部任务差异。逐条判断说明的事实能否由类型、命名、边界或测试直接表达，保留说明不可见约束与设计决定的文字。要移除约束说明必须先给等价的证明。", ["judgment"],
    [input("baseRef", "默认比较基线", "用户未指定范围时，用此 Git 引用比较工作区。", "main")]),
  method("poteto-help", "流程导航", "按目标查找适用的方法、原则、剧本和设置。",
    "从用户目标和现有证据定位一个首选入口，说明如何调用、需要的输入和预期产出。检查配置与可用模型时定位本机的代码开发设置和子代理设置。"),
  method("poteto-mode", "任务路由", "选择工作剧本，按任务范围调用配套方法与原则。",
    "先核对目标、仓库规则、工具目录与授权。小任务直接处理；优先用户指定的剧本。复杂改动分出独立路径、共享状态、验收和真实使用面，遇到不确定事实先实验。写入按所有权隔离，按真实回执收齐任务。交付结果、依据和缺口。", [],
    [choice("preferredPlaybook", "默认工作剧本", "自动模式按任务路由，明确点名的剧本优先。", "auto", ["auto", ...PSTACK_PLAYBOOKS.map(book => book.id)]),
      choice("githubBinding", "GitHub MCP 绑定", "选择 required 时，启动或恢复 pstack 工作流需要 GitHub MCP。", "on-demand", ["on-demand", "required"]),
      input("verificationCommands", "项目验证命令", "每行一条完整的可信项目命令，由运行时精确匹配。", "", true)]),
  ...PSTACK_PRINCIPLES,
  method("recall", "恢复工作背景", "从本工作区的记录与现状恢复上次进度。",
    "先确定时间窗、主题和当前工作区。在已授权的会话与共享记录中寻找原始任务、已采纳决定、失败尝试和未完成项，再通过当前代码与实际产物核实。给出时间线、证据和恢复点。", ["why-investigators"],
    [number("lookbackDays", "历史窗口（天）", "用户未指定日期时，从当前工作区回看。", 7)]),
  method("reflect", "任务复盘", "从工具、判断和不同意见三个角度核查当前过程。",
    "三个独立视角读取同一份任务记录，给出具体错误、证据、替代动作和适用范围；综合者核实分歧，先找能阻止重犯的结构约束，再定位已有技能的具体改动。涉及用户技能时按本次授权处理。", ["reflect-tooling", "reflect-judgment"],
    [number("substantiveEditLines", "较大技能修改的参考行数", "超过此规模的已批准修改使用完整的草拟、验证、迭代流程。", 10)]),
  method("setup-pstack", "模型与推理设置", "配置角色默认模型、推理预算、人数及隔离方式。",
    "通过原生子代理目录、启用模型、角色候选和权限核实可派发范围。在回执中读取实际供应方和底层模型；显式继承与使用宿主默认值是两种选择。独立模型数量不足或推理能力不支持时报告实际缺口。", [], [
      choice("budget", "通用推理预算", "未指定角色预算时使用；继承父模型保留其原生默认。small、medium、large、unlimited 分别对应 medium、high、xhigh、max。", "default", ["default", "small", "medium", "large", "unlimited"]),
      input("excludeModels", "排除模型", "输入以逗号或换行分隔的 provider/model，例如本机能列出但已停止服务的模型。", "", true),
    ]),
  method("show-me-your-work", "记录决定", "以可追溯的证据记录长任务中的关键选择。",
    "为开始、分叉、验证、回滚、阻断、完成分别追加记录。TSV 每行包含 UTC 时间、阶段、动作、原因、证据、结果。恢复时与真实输出对照；并行任务分开记录。授权范围内才提交审计日志。", [],
    [input("logPath", "决定日志路径", "相对于任务工作目录的 TSV 文件。", "decisions.tsv")]),
  method("swarm", "并行分工", "给独立切片分配工作，收齐每一项的结果。",
    "明确验收、切片边界、互不覆盖的写入范围。为每个子任务提供目标、输入、证据和停止条件，使用真实宿主批量派发。区分已完成、失败、超时、取消与未启动；核对实际产物并给出汇总表。", ["swarm-workers"], [
      choice("shape", "分工形态", "切片按不同范围执行，竞赛使用相同简报，混合同时采用两种方式。", "partition", ["partition", "race", "mixed"]),
      choice("raceRule", "竞赛选择规则", "在竞赛或混合形态派发前固定选择标准。", "best-of", ["first-pass", "rank-all", "best-of"]),
      number("missingEvidenceRetries", "缺证据时重派次数", "报告漏交指定版本或测量方法时重派，预算用尽后报告缺口。", 1, 0),
    ]),
  method("tdd", "先看失败的测试", "在有低成本复现时用行为断言固定缺陷。",
    "明确预期与实际行为；选择现有的最窄可执行入口，先看到断言因预期原因失败，再修改生产代码，复跑同一断言及邻近契约。昂贵或不稳定的路径记录原因并选择等价验证。"),
  method("teach", "循例讲解", "结合实现路径和设计动机讲清一个问题。",
    "选择与读者相关的真实例子，分别调查 how 与 why，先给具体动作和结果再引出概念，改变一个输入演示边界。保留源码指针与无法证明的动机。", ["how-explainer", "why-synthesizer"]),
  method("technical-writing", "技术写作", "按读者任务选择文档结构。",
    "一个正文只用一种 Diátaxis 模式。教程逐步建立能力，指南完成任务，参考资料支持查找，解释交代原因。统一术语、主动句和步骤，写明前置条件与可观察结果；用真实运行检查命令和链接。", ["judgment"],
    [choice("mode", "文档模式", "自动根据读者当前的任务选择。", "auto", ["auto", "tutorial", "how-to", "reference", "explanation"]),
      number("instructionWords", "操作步骤建议词数", "较长的英文操作句按一个动作一句拆分。", 20),
      number("sentenceWords", "正文句子建议词数", "较长英文句子按独立判断拆分。", 25)]),
  method("typescript-best-practices", "TypeScript 工程实践", "用显式契约表达有效输入、失败与合法状态。",
    "在外部边界解析未知值。用判别联合、穷尽检查、精确的可选语义与现有类型表示领域。避免掩盖错误的断言和重复的包装类型；检查所有调用者，并跑类型与行为验证。"),
  method("unslop", "精简表达", "去掉套话，保留读者做判断需要的事实。",
    "逐段核对内容与论据，删去泛泛评价、重复摘要、模板化开头和装饰。把抽象判断换成实际动作、数字和来源；保留作者原意与限制。读一遍整篇的节奏和用词。", ["judgment"]),
  method("why", "调查设计原因", "跨可用证据来源核实变化背后的动机。",
    "从当前文件、符号、行为和引入它的变更建立锚点，按启用且获准的来源分派调查。防御代码优先查事故与修复记录。每个来源给直接引用、日期、上下文或检索无结果；综合者交叉验证并标注直接记载、推断、相反证据和未知原因。", ["why-investigators", "why-synthesizer"], evidenceSources),
  { id: "thermo-nuclear-code-quality-review", kind: "review", label: "Thermos 深度质量评审", description: "检查结构退化、特例蔓延、巨型文件和可行的整体简化。", instructions: THERMOS_INSTRUCTIONS, parameters: [], roleIds: ["interrogate-reviewers"] },
];
