import type { PstackSkill } from "./types";

function principle(id: string, label: string, instructions: string): PstackSkill {
  return { id: "principle-" + id, kind: "principle", label, description: instructions.split("。")[0] + "。", instructions, roleIds: [], parameters: [] };
}

export const PSTACK_PRINCIPLES: PstackSkill[] = [
  principle("attack-the-premise", "检验共同前提", "两个修复押在同一假设上却仍失败时，按实际承担负载的对象分别计数。找出谁在分配角色，改变分配并重测。"),
  principle("boundary-discipline", "明确边界", "明确边界的所有者、允许输入、输出和失败语义。在进入边界时完成校验，只让有效状态进入内部。"),
  principle("build-the-lever", "建立验证工具", "对难以复核的手工工作制作最小可重跑的测量或验证方法，先证明它能识别一次已知失败。"),
  principle("encode-lessons-in-structure", "从结构上避免重犯", "遇到同类错误，找出让错误成为可能的数据表示、调用顺序或共享状态。修改结构，并用旧失败检验修复。"),
  principle("exhaust-the-design-space", "比较设计方案", "比较有实质差异的方案，为每种写出最有力的支持和反对依据。对影响取舍的未知数做实验。"),
  principle("experience-first", "从用户体验验收", "从用户实际打开、点击、等待或读取结果的地方验收，尤其关注失败和重开场景。"),
  principle("explain-the-number", "解释数字", "为阈值、优化目标、容量和预算说明单位、数据来源、分布及适用条件。换负载后重新核实。"),
  principle("fix-root-causes", "修复根因", "从现象追到产生错误状态的第一个责任点。用对照实验验证因果关系；修复后重放原始复现。"),
  principle("foundational-thinking", "从基础约束出发", "列出需求成立所依赖的事实、资源和约束，区分已证实的前提与当前实现带来的偶然限制。"),
  principle("guard-the-context-window", "控制上下文", "从大日志或长轨迹提取能回答当前问题的片段，保留原始证据位置。移交时给出精确输入和结论。"),
  principle("laziness-protocol", "先消除多余劳动", "先找能删除工作量的设计和现有可复用能力。选择能够满足真实验收条件的最直接实现。"),
  principle("make-operations-idempotent", "让操作可重试", "先定义目标终态。分别从初次进入、中途失败、重启、重复投递和并发进入验证都能收敛。"),
  principle("migrate-callers-then-delete-legacy-apis", "迁移调用者再删除旧接口", "列全调用者，逐个迁到目标接口，从真实入口验证；确认没有遗漏后再清理旧内部接口。"),
  principle("minimize-reader-load", "降低阅读成本", "沿一个典型调用数清需要同时记住的状态和跳转。把紧密相关的决策与数据放回同一责任边界。"),
  principle("model-the-domain", "用类型描述领域", "先命名对象、有效状态及合法转换。遇到相互矛盾的布尔组合时，检查能否改用有约束的数据类型。"),
  principle("never-block-on-the-human", "自主推进可逆工作", "可逆且已授权的实现选择先按证据推进。仅对确实需要用户决定的范围、权限和不可逆操作提出具体问题。"),
  principle("outcome-oriented-execution", "按结果推进", "用最终用户结果划分阶段。每一阶段写出可以当场执行的验收，不把临时过渡当成完成。"),
  principle("prove-it-works", "用实际结果证明", "重走声明已修好的实际入口，读取输出、保存状态或用户可见结果。记录输入和观察，把未执行的部分列清。"),
  principle("redesign-from-first-principles", "从需求重建设计", "新约束让原设计越来越复杂时，从目标和不变量重建一个简单候选，与现有设计比较迁移成本。"),
  principle("separate-before-serializing-shared-state", "先拆分共享状态", "先按任务、资源或文件划分所有权。对剩下确实共享的不变量，明确串行边界，并验证取消和重试。"),
  principle("sequence-verifiable-units", "分步验证", "按能独立证明的行为拆步。每步获得证据后再继续；中途停止也能清楚指出最后已验证的状态。"),
  principle("subtract-before-you-add", "先做减法", "检查能否先消除重复路径、可推导状态或失效选项。删除后重跑原行为，再决定是否需要新抽象。"),
  principle("test-behavior-not-implementation", "验证外部行为", "用调用者可见的输入、动作和结果断言。实现换一种正确写法时测试仍应通过。"),
  principle("type-system-discipline", "用类型表达约束", "在系统边界解析外部值，让类型表达有效状态。检查宽断言、可选字段与类型转换是否掩盖错误。"),
];
