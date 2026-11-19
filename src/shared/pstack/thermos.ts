export const THERMOS_REVIEWER_ROLES = ["interrogate-reviewers", "judgment"];

export const THERMOS_CRITERIA = [
  { id: "structural-regression", label: "结构退化", description: "从实际调用者走通正常、失败和恢复路径，定位新增的状态、耦合和隐含所有权。" },
  { id: "simplification", label: "整体简化", description: "提出保持行为且能消除整类分支、概念或间接层的可行结构；比较迁移成本与可验证的收益。" },
  { id: "branch-growth", label: "分支与特例", description: "查找散落在无关流程的条件、互斥布尔标记、重复模式判断；将决策移到拥有它的类型或模块。" },
  { id: "type-boundaries", label: "类型边界", description: "追踪可空值、宽断言、转换和静默回退，检查能否在入口校验并用类型表达合法状态。" },
  { id: "canonical-layer", label: "职责与复用", description: "检查跨层泄漏、绕过既有契约和重复工具；指出有明确所有者的实现位置。" },
  { id: "file-growth", label: "文件规模", description: "比较基线与当前文件行数，跨过配置阈值时给出按职责拆分的方案，或记录保留原结构的具体理由。" },
  { id: "directness", label: "抽象与可读性", description: "检查只转发的包装、隐藏控制流的通用机制和拆文件后的间接层；比较读者理解一条真实路径的成本。" },
  { id: "atomicity", label: "编排与原子性", description: "检查独立工作是否无故串行，相关更新能否留下半完成状态；从重试、取消和并发验证所有权。" },
];

export const THERMOS_INSTRUCTIONS = "固定本次意图、基线、工作区差异（含未跟踪的任务文件）与必须保留的行为。先走真实入口检查结构，再对启用的评审项逐一找证据。每项发现给出文件位置、触发条件、读者或行为成本、可行修复与复验。按结构退化、可大幅简化、分支、边界、文件膨胀、模块与可读性排序。出现有证据的重大问题且无充分理由时判需修改。无阻断时给出通过及实际验证，缺关键证据时报告证据不足。只读评审止于结论，已授权修复时复验原发现。";
