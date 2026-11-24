import { number } from "./parameters";
import { book, step } from "./stages";

const auditParameters = () => [
  number("auditMinutes", "巡检周期（分钟）", "派发期间按此周期回读子会话的实际工作记录。若用户授权后台巡检，按工作流状态中的 auditSchedule 建立本任务的计划，在 audit 时传入 scheduleId 核对。", 60),
  number("firstReportMinutes", "首次工作记录目标（分钟）", "负责人在此期限内应留下文件写入或工作报告。宿主到期检查子会话，记录首次证据和超期状态。", 15),
];

export const coordinationBooks = [
  book("autonomous-run", "自主迭代", "持续运行到可核查的终点，每轮保留证据。", [
    step("predicate", "固定退出判据", "开始前用可执行的检查写下完成条件、任务范围及允许的副作用。"),
    step("wake", "确定唤醒方式", "需要后台或重启后持续时，核对 automation_exec、创建有边界的定时唤醒并读取真实回执。只跟踪一次事件时优先事件观察器。"),
    step("iterate", "推进一个最小单元", "按证据选择最小修改，重跑原判据。保留有效结果，放弃被实验证伪的单元。", ["principle-sequence-verifiable-units"]),
    step("recover", "处理途中失败", "区分产品、验证工具和环境失败；在用户范围内修复阻断，旁支工作单列。"),
    step("checkpoint", "记录本轮变化", "逐轮写下尝试、证据、判据是否靠近及下一假设；核实持久化后的记录。", ["show-me-your-work"]),
    step("finish", "按判据停止", "原目标达成则交付；平台或权限确实阻断时给可验证的原因。停滞先调整假设，绝不放宽退出条件。"),
  ]),
  book("autopilot-full", "独立变更全程托管", "独立变更并行推进，各自验证并在授权内逐个交付。", [
    step("authority", "标出用户保留的事项", "记录本次执行、外部写入及合并的授权；用户只要求说明计划时等待。列出必须由用户确认的项目。"),
    step("owners", "每项分给独立负责人", "给每个负责人一份完整简报、目标、文件所有权与实际验证。负责人从首份证据到交付维护决定与子任务记录。", ["swarm", "show-me-your-work"], "swarm-workers"),
    step("parallel", "并行独立变更", "独立分支或不重叠的写入面可同时推进，有重叠时按实际共享状态串行。", ["principle-separate-before-serializing-shared-state"]),
    step("verify", "按当前补丁独立验证", "每轮记录代码完成时的 head SHA，独立评审意图、真实功能和维护性。补丁发生实质变化时重新取得验证结论。", ["swarm", "interrogate"], "interrogate-reviewers"),
    step("land", "交付已验证的负责人结果", "核实基线、当前 head、门禁和证据，再按本轮授权交付。处理完的负责人交接到下一单元。"),
    step("audit", "协调者巡检全部任务", "按巡检周期核实真实产物、运行状态、负责人和外部等待。对超期且没有副作用进展的单元按证据恢复；基准上调须单独核实和授权。"),
    step("stop", "响应停止并对账", "停止令立即送达所有负责人，停止新增写入，收齐终态与恢复位置。"),
  ], auditParameters()),
  book("autopilot-stack", "托管堆叠变更", "构建可按依赖顺序审阅的变更链，交给操作者决定合并。", [
    step("owners", "分配各层负责人", "每人负责一个修改，从首个有效产物、审查到就绪持续写工作记录；隔离并行写入。", ["swarm", "show-me-your-work"], "swarm-workers"),
    step("audit", "建立真实巡检", "在授权的后台设施上安排周期巡检并回读收据。每次以提交、检查、任务台账或产物的变化判断健康状态。"),
    step("authority", "保留操作者关口", "执行必须取得授权；停止时让所有负责人立即进入零写入状态，保留进度。"),
    step("verify", "在每个版本独立验证", "收集每项 HEAD 与就绪报告，以实际 patch 和 verifier 回执认定本次验证是否有效。", ["interrogate"], "interrogate-reviewers"),
    step("append", "把已验证项加入链", "按依赖从底向上排成一条线性变更链，所有就绪判定附当前补丁证据。"),
    step("topology", "集中修改链结构", "仅协调者改变父子拓扑。写分支前核实远端 tip、目标父节点与权限，负责人只处理自己的代码。", ["principle-separate-before-serializing-shared-state"]),
    step("drift", "核对漂移", "从底到顶比较更新后的基线、head、patch-id 与 CI。补丁或上下文变化影响结论时重新验证。"),
    step("handoff", "交付可审阅的链", "给出链头链尾、每个父子关系、证据与未纳入事项。合并留给获得授权的操作者。"),
  ], auditParameters()),
  book("orchestrate", "大规模任务协调", "MyBuddy 原生扩展：协调多条任务线、持久收据、集成和验收。", [
    step("frame", "量化完成条件", "列出单元数、切分、时间预算和最终产物，单人可完成时优先缩减编排层。"),
    step("state", "建立可恢复的状态", "把授权、任务简报、依赖、负责人、待处理收据、门禁和集成前沿记录到工作台账，核实已有状态后再启动。", ["show-me-your-work"]),
    step("pilot", "试跑一个完整单元", "用一个小单元验证派发、产出、独立核验、收据、集成前沿与终态，再据此修改简报和单位大小。"),
    step("scale", "维护有上限的执行窗口", "从原生子代理设置取得容量。独立单元滚动补位，有必要时才引入分线协调者；同一资源保持单一写入者。", ["swarm"], "swarm-workers"),
    step("drain", "消费并核实收据", "逐一验证返回的任务、版本与所有权。资源耗尽时缩小任务；网络中断重试原简报；工具故障可试可用的不同模型；未知故障限次重试。达到重试上限时明确放弃并重新规划。重复通知按同一结果收敛。", ["principle-make-operations-idempotent"]),
    step("integrate", "持续集成已核实的结果", "从第一项有效产物开始按依赖集成，记录当前基线、补丁、验证与冲突所有者，执行外部动作前核实授权。"),
    step("close", "盘点全部单元", "处理最后的回执，每个已派发单元均有终态。重读真实产物与最终计数、验证各版本对应的证明，报告未交付和仍需决定的项目。"),
  ], [number("retryLimit", "每单元重试上限", "故障按原因处理，预算用尽时将单元记录为失败并重新规划。", 2, 0),
    number("unknownFailureRetries", "未知故障重试次数", "原因不明的故障先限次原样重试，仍失败则重新诊断。", 1, 0)]),
];
