import { step } from "./stages";
import { practiceStages } from "./practice-stages";
import { promptStages } from "./prompt-stages";
import { advancedStages } from "./advanced-stages";
import type { PstackStage } from "./types";

/** Method-level phases are callable without choosing an enclosing development playbook. */
export const methodStages: Record<string, PstackStage[]> = {
  ...practiceStages,
  ...promptStages,
  ...advancedStages,
  architect: [
    step("ground", "追踪受影响的系统", "沿真实调用找当前状态、所有者、调用者及约束。改变所有权还需调查历史缘由；不要固定开启一轮多代理调查。", ["why"]),
    step("sketch", "比较两种结构", "自己画出两种实际不同的结构，给调用示例、类型、状态所有权和失败路径。大型或有争议的设计才调用 arena；不因跨过一个函数就固定派发多模型。", ["arena", "principle-exhaust-the-design-space"]),
    step("synthesize", "选定最小清晰契约", "选择每份状态一个所有者、每件事一个支持入口、调用者需要知道最少的方案。重复绕行说明边界需要重画。交付选定结构、放弃方案及验收；本机 checkpoint 开启或用户明确要求时才等待确认。", ["principle-redesign-from-first-principles"]),
  ],
  arena: [
    step("frame", "确定任务和评分尺度", "写清产物、共享起点、隔离输出位置。用 advance 的 criteria 冻结 rubricCount 条裁判私有的评分项，或用 artifact 提供该量表的 JSON。用相同测量条件，先声明接受何种失败与退赛。"),
    step("run", "并行产生候选", "同一份简报交给每位候选，产物和取舍分别写到自己的输出位置。核对真实模型和是否成功产出；退赛显式记录。", ["principle-separate-before-serializing-shared-state"], "arena-runners"),
    step("judge", "匿名交叉评审", "在候选产物全部完成后，使用不暴露模型的路径标签和评分尺度发给独立裁判。核对身份；逐项评分并建议基底。", [], "arena-cross-judge"),
    step("pick", "选出基底", "主审完整读每个产物，对比各项得分和独立裁判意见；分歧追到依据与标尺，打平比较接口和维护者负担。"),
    step("graft", "合成候选优点", "逐个候选记录值得移入的具体部分、来源和拒绝理由，保持整套方案使用相同模型。过度分歧时重定共同契约。"),
    step("verify", "按同一标准验证", "实测合成后的产物，失败时回到评判标准或遗漏的合并项。交付产物及基底、合入部分、退赛和证据记录。", ["principle-prove-it-works"]),
  ],
  swarm: [
    step("frame", "确定分工或竞赛", "声明完成条件、产物、形态（切片、竞赛或混合），竞争时预定首个通过、全体排序或择优。按总任务数分工，独立写入单独划区。"),
    step("dispatch", "以独立简报并行分派", "每份简报写明目标、切片或赛道、验证和回报。审查固定精确版本，测量固定样本数、单位与顺序，结果交回 PASS、ISSUES、BLOCKED 与证据。", [], "swarm-workers"),
    step("drain", "核实全部实际回执", "逐项核对版本、方法与产物。缺必需字段按重派次数重试，仍缺失记缺口。分工须覆盖所有指定切片，竞赛按预定规则判定。"),
    step("report", "合成一个报告", "给每项状态、可证明的问题、退赛或缺口及赛制。失败和未启动项不可计为通过。"),
  ],
  interrogate: [
    step("scope", "固定目标差异", "按用户指定的分支、提交、文件或工作区固定原始差异，纳入属于本次的未跟踪文件。"),
    step("intent", "写出本次意图", "从任务、上下文与调用者归纳必须达到的行为与不变量，用它限定审查。"),
    step("panel", "在隔离工作区尝试破坏修改", "每位评审者实际运行真实代码的失败测试、复现脚本或探针。按委派契约提交覆盖、试验及发现，绑定本次真实原生命令回执；发现须有失败断言和实际输出。只新增隔离复现，不修改被审查源码；不提交猜测、风格意见或依赖未来改动的风险。零发现允许，但仍须记录实际试验和覆盖范围。", [], "interrogate-reviewers"),
    step("synthesize", "收齐可重跑的发现", "逐项读取真实运行证据，合并共同根因。主代理按宿主分配的 finding id 对每条候选发现调用 pstack_workflow verify 重跑相同命令；没有实际命令、输出或无法在当前版本复现的线索不进入结论。"),
    step("judge", "交付经复跑证实的缺陷", "只保留主代理复跑后仍失败且违反原意图的发现，列准确命令、实际输出和预期输出；说明实际模型和未覆盖范围。可以没有已验证发现。本方法只报告，不应用修复；后续修复由获得授权的任务承担。"),
  ],
  reflect: [
    step("transcript", "读取本次完整记录", "由当前代理自己读取任务目标、实际执行、纠正和结果，不固定启动复盘子代理。"),
    step("synthesis", "保留会改变后续工作的教训", "只保留仍然成立、能改变下一次代理行为的发现。每项给本次原始证据，并定位本次使用过的已有技能；临时故障、一次性数值和泛泛建议不写成长期规则。"),
    step("approval", "核对既有编辑授权", "给出具体技能改动和理由。已有本次编辑授权就按范围执行；尚未授权的个人技能修改先让用户批准。不因复盘自动提交、推送或编辑插件缓存。"),
    step("report", "回读已授权修改", "通过原生技能创作或修订入口保存获准的改动，回读与验证后说明哪些已应用，哪些只有建议。"),
  ],
  how: [
    step("scope", "确定要解释的行为", "固定问题、范围和用户关心的入口，给一位只读调查者简短完整的目标。"),
    step("explain", "沿真实调用调查", "由一位只读调查者跟踪入口、状态变化、失败路径与消费者，交回文件、符号和实际依据。复杂问题可按 explorationAngles 检查多个角度，但不固定扇出多轮代理。", [], "how-explainer"),
    step("present", "直接回答并附源码依据", "用用户能跟随的输入解释实现，保留决定结论的边界与未知；按需要组织正文，不强制固定标题。"),
  ],
  why: [
    step("target", "界定历史决定", "定位要解释的行为或数字；当前代码说明机制，不能单独证明作者当初的意图。"),
    step("history", "从引入和后续变更取证", "在已启用且获准的来源内，优先读取最初引入及每次相关修改的提交、PR 讨论。只有记录不足时才查其他可用来源，不固定逐个扫描连接器或启动调查团。"),
    step("present", "区分记录、推断与未知", "引用作者实际写过的依据，自己的推断明确标记；冲突证据和记录无法回答的问题直接说明。简洁回答，不套固定报告结构。"),
  ],
};
