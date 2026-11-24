import { input, number } from "./parameters";
import { PSTACK_PLAN_DEFAULTS, PSTACK_PLAN_GUIDE } from "./plan";
import { book, delivery, step } from "./stages";

export const investigationBooks = [
  book("investigation", "只读调查", "从实际调用、产物和版本记录回答一个明确问题。", [
    step("trace", "调查实现与动机", "保持任务工作区只读，直接沿一条实际输入追到消费者。动机类问题另查变更和设计证据，不固定再套一层 how。", ["why"], "how-explorer"),
    step("scope", "确认只读范围", "记录只读调查的范围、可访问的资料和无法观察的部分。"),
    step("explain", "综合发现", "以原始证据直接回答问题，解释调用链、文件与限制。选择类问题给候选取舍和建议，推断明确标注。", [], "how-explainer"),
    step("edit", "精简交付", "核对文件与符号，将最能回答问题的证据写在前面。若 Thermos 已触发，用 pstack_delegate 的 answerDraft 提交完整答稿。按审查意见修改答稿后可重新提交，宿主会交付通过的原文。", ["unslop"]),
  ]),
  book("runtime-forensics", "运行时取证", "从现场信号定位具体责任代码。", [
    step("capture", "采集现场", "在对应进程和入口获取 CPU profile、堆快照或渲染 trace，记录触发输入、时间和环境。"),
    step("reduce", "提取关键信号", "将大型产物缩减到热点函数、保留链、异常唤醒或停滞线程，保留原始位置。", ["principle-guard-the-context-window"]),
    step("experiment", "证伪机制", "使用获准的局部运行时观测或一次对照输入，验证信号与症状之间的因果关系。"),
    step("source", "对应到源码", "利用符号和调用者找到分配、调度或绘制责任点，指出证据不足的跳转。"),
    step("report", "交付现场诊断", "给出观察、机制、源码位置与复现实验。只读范围内将修复留给后续已授权任务。"),
  ]),
  book("trace-forensics", "离线轨迹取证", "分析已有 trace、堆快照或采样文件。", [
    step("format", "确认输入格式", "核实采样环境、时间与格式，选择匹配解析工具；大产物在可控范围中处理。", ["principle-guard-the-context-window"]),
    step("index", "转为可查询数据", "按帧、采样、节点或边形成查询表，保留原始符号和时间维度。"),
    step("narrow", "定位异常路径", "从耗时排序追调用树，内存泄漏沿对象到 GC 根，卡死则找阻塞线程与等待对象。"),
    step("attribute", "映射责任点", "用符号表定位文件、函数和行号。无法映射时明确缺失的符号或 build 信息。"),
    step("compare", "核对配对样本", "若有前后采样，比较同一负载与栈；单一样本将因果推断标注为假设。"),
    step("report", "交付可重查的发现", "列原始产物、查询、源码位置和最大未决问题；修复或优化另走相应流程。"),
  ]),
  book("session-pickup", "接续任务", "从上次实物与决策记录找到可信的恢复点。", [
    step("locate", "找到上次工作记录", "锁定当前项目与会话，读取合法可得的记录、任务状态和验收证据。", ["recall"]),
    step("reconstruct", "重建执行状态", "核实当前分支、工作区、已落地的差异、旧任务清单和负责人。"),
    step("remaining", "对照完成与待办", "区分已经验证、尚未验证和已失效的结论，指出下一项可执行操作。"),
    step("route", "决定如何接续", "选择继续实现、交付已成熟的建议、纠正旧判断或复盘失败，并路由到适配剧本。"),
    step("confirm", "核实继承的主张", "对最后关键结论查看原始实物或收据，避免复做有证据且仍有效的工作。", ["principle-prove-it-works"]),
  ]),
  book("multi-phase-plan", "多阶段计划", "把较大的工程写成有验证证据和接手条件的计划。", [
    step("size", "确定是否需要计划", "一两个文件且方案明确时直接给出判断。复杂计划说明目标、规模和不变量。"),
    step("prototype", "解决技术未知", "针对可实验的问题做原型，保留证据位置与结果。只有产品取舍交给用户。"),
    step("explore", "分头调查", "每位调查者提供文件位置、真实接口、依赖、风险和可以核实的最小实验。", ["swarm"], "swarm-workers"),
    step("outline", "填写计划骨架", PSTACK_PLAN_GUIDE),
    step("write", "按执行者组织", "正文采用操作指南，解释和参考资料进附录。逐项写清执行者、输入、输出和交接条件。", ["technical-writing", "unslop"]),
    step("validate", "检查计划完整性", "验证所有必需章节、工作项与附录存在，找空占位符、未解依赖和没有验证路径的动作。记录实际检查结果。"),
    step("handoff", "交付计划", "报告计划位置、验证结果和需要用户决定的事项。仅在获得实施授权时进入对应执行剧本。"),
  ], [input("planPath", "计划文档位置", "相对于当前任务工作区，留空时由任务选择适当的文档位置。", ""),
    number("liveLanes", "每项变更的现场验收场景数", "每个场景要提供独立证据位置与明确的通过条件。", PSTACK_PLAN_DEFAULTS.liveLanes),
    number("introLines", "引言最多行数", "正文标题到阅读说明之间的非空行数。", PSTACK_PLAN_DEFAULTS.introLines, 0)]),
  book("authoring-a-skill", "编写或修改技能", "用原生创作入口复用、创建、验证用户技能。", [
    step("assess", "评估现有技能", "调用 skill_authoring_assess 检查复用；确需创建时才用 skill_authoring_create，并保留其默认停用语义。"),
    step("validate", "核对技能结构", "确认名称、描述、引用文件、跨技能指针和预期发现范围，验证正常的发现与调用入口。"),
    step("exercise", "执行代表性用例", "有客观结果时分别运行正常与已知错误用例；主观写作以真实样例说明评价边界。"), delivery(),
  ]),
  book("pause-safely", "安全暂停", "停止新工作、保全已做的修改并留下可恢复状态。", [
    step("stop", "停在安全边界", "停止新派发，完成或回退当前最小原子操作，取消相关子任务并核实回执。"),
    step("preserve", "保持工作区可恢复", "保留其他任务的变更；暂停本身不授权推送、发布或创建 PR。"),
    step("snapshot", "保全未完成工作", "核实修改与现有持久状态。仅在仓库规则及用户授权允许时创建 WIP 提交，若状态不完整须明确标记。"),
    step("resume", "写恢复记录", "保存目标、进度、已验证行为、当前状态、关键文件、风险与下一步。已有决定日志时在恢复说明里引用其位置。暂停时不新开审计任务。报告恢复入口。"),
  ]),
];
