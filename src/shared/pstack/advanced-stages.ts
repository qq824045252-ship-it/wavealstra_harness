import { step } from "./stages";
import type { PstackSkill, PstackStage } from "./types";

const artifact = "所有输入和产物使用当前任务工作区内的相对路径；把生成文件集中在 .artifacts 下，不把报告混入产品源码。通过 pstack_workflow advance 的 artifact 提交 JSON 清单，宿主验收真实文件及执行回执；缺依赖时 block 并写明依赖，不用文字声称成功。";
const formalReceipt = "清单 version=1、kind=formal-verification，含 skillPath（项目本地 SKILL.md）、syncCommit（实际 40 位 Git commit）、tool、toolVersion、command、properties、bounds、assumptions、sources:[{path,digest,symbols}]、verificationFiles、cleanCheckTaskId、mutation:{checkTaskId,sourcePath,description,failureEvidence}。digest 为当前文件 SHA256；task ID 引用本次工作流 verify 的真实 toolTaskId。破坏变体与恢复后的通过须执行同一命令，负例失败文本含 failureEvidence；不能把依赖、语法或启动失败当反例。生成清单后不要改变已验证源码或检查脚本。";

export const advancedStages: Record<string, PstackStage[]> = {
  "ketchup-video": [
    step("scope", "恢复用户离开后的工作", "以本次调用之前最近一条用户消息为时间窗起点，核实期间实际工作、当前状态和待判断事项。只读回顾；生成媒体使用任务产物目录。", ["ketchup"]),
    step("story", "用真实证据编排画面", "最多 10 页，每页一个观点，用实际截图、改动、数据或图解说明。不要编造数字或界面；全片统一画面和标签，字幕单独置于底部且不遮内容。每页约 10 词字幕，屏幕上的新增文字每 3 词至少停留 1 秒。"),
    step("render", "生成可播放的字幕视频", "使用已有文件、终端或媒体工具输出横屏、无音轨、字幕烧录的 MP4，页间适量移动。预先探测 ffmpeg 和 ffprobe；缺少时明确依赖。保留每页最终合成 PNG（包括字幕）和 subtitle、onScreenText、startSeconds、endSeconds。"),
    step("inspect", "核实实际视频帧和阅读时间", "创建 version=1、kind=ketchup-video 的 JSON，含 video 和 slides:[{image,subtitle,onScreenText,startSeconds,endSeconds}]，所有路径相对工作区。先调用 pstack_video_inspect(artifact)，它实际探测 MP4 并将解码帧与每页 PNG 匹配、测量停留时间，返回逐页 PNG。逐张用 read 图片检查可读性、遮挡和画面证据；必要时修正并重渲染。技术解码通过不代表视觉检查通过。"),
    step("deliver", "交付实物与待决事项", artifact + "清单增加 inspectionTaskId（pstack_video_inspect 回执的 taskId）和 visualReview:[{frame,readTaskId,note}]，每页引用实际 read 图片工具回执。开头一句说明进展，然后 MP4、一行剩余工作、完整待决事项（推荐、依据、风险）。只报告确实渲染并检查过的影片；失败时一句说明失败和待决事项。"),
  ],
  "create-formal-verification-skill": [
    step("property", "从源码选择重要承诺", "阅读真实实现及调用方，选择普通测试难覆盖且后果重要的性质。将每个状态、操作和原子步骤映射到具体源码；列明并发、输入范围、环境和未覆盖部分。"),
    step("tool", "采用最小可运行的验证工具", "并发和交错优先考虑 TLA+，纯函数约束可用 SMT 或语言验证器；证明助手只用于确实需要的证明。语言不受支持时明确限制，以生成输入执行真实代码，不能手写一个永远通过的替身。固定工具版本，提供一条可复现命令，先运行当前检查。"),
    step("prove", "证明检查能发现真实破坏", "在任务范围内暂时删除真实源码的一项保护或改变步骤顺序，用 pstack_workflow verify 跑原命令并保留原生失败回执。检查失败来自目标性质；恢复源码后通过同一 verify 命令取得成功回执。当前产品已有反例时报告真实缺陷和边界，未经任务授权不修产品、不削弱性质；无法取得必要验收则 block。"),
    step("author", "保存可执行项目技能", "创建项目本地 SKILL.md 和检查文件，写明触发条件、运行入口、依赖、性质到源码的映射、边界、假设、未覆盖项、同步 commit，以及如何重跑真实负例和恢复。TLA+ 技能通过 MyBuddy 的 statechart 方法和 pstack_statechart 工具执行，不依赖 Cursor 插件路径。按生成的技能从头实测。"),
    step("handoff", "验收检查与后续维护", artifact + formalReceipt + "交付性质、工具选择理由、实际结果、运行命令与边界，提供 maintain-formal-verification-skill 维护入口。"),
  ],
  "maintain-formal-verification-skill": [
    step("inventory", "定位现有形式验证", "按功能寻找本项目已有验证技能和检查文件，回读性质、源码覆盖、边界、假设、命令和同步 commit。未登记同步 commit 时以最近一次验证修改的 commit 为基线并明确说明；先用 verify 执行旧检查，保留 baselineCheckTaskId。"),
    step("drift", "检查覆盖代码的全部变化", "查看同步 commit 之后所有覆盖代码的改动，包括移动/改名、新写入者和调用方式。分类为无影响、模型漂移、有证据的承诺变更或可能产品缺陷；不要只检查原文件名。"),
    step("reconcile", "从实现更新模型", "修正模型和源码映射后重跑。逐步回放失败轨迹：真实实现不可能发生的步骤是模型错误；实现能发生的轨迹是产品缺陷，给出引入 commit 和损害。不能削弱性质、缩小边界或降低检查力度来换绿灯；变更承诺须说明依据。"),
    step("prove", "重新验证失败与恢复", "对更新后的检查执行真实代码破坏变体，使用 verify 保存失败回执；恢复后以同一命令取得 clean pass。检查实际工具错误和性质反例的区别。验证资料的编辑与产品修复分开；没有验证的部分不推进 sync commit。"),
    step("handoff", "逐项交付同步结果", artifact + formalReceipt + "清单另含 previousSyncCommit、changeSummary、status（in sync 或 updated）、baselineCheckTaskId（更新之前运行旧检查的真实 toolTaskId）。真实 bug 或 blocked 单独报告且不得用通过清单掩盖，未解决阻断用 block。列出更新、确认无变化、发现问题和尚未核实的范围。"),
  ],
  statechart: [
    step("model", "建立与实现一致的状态模型", "复用现有 .tla/.cfg 或从源码构建模型，列出有限状态范围、假设、原子操作及用户关心的不变量。Next 是操作的析取；正常终态应有停留步，避免将正常结束误报为死锁。所有源码映射有出处。"),
    step("view", "选择忠实的图形视图", "需要可读名称时编写纯 view 模块导出 state(vars)，可选 step(action,from,to)、group、colors、title。state 返回文字、层级数组或并行区域对象；不要删掉会影响规则或可达性的步骤。"),
    step("run", "执行原生 TLC 编译器", "调用 pstack_statechart(spec,config,view?,out,shell)，out 为新的任务产物目录；额外本地模型或视图依赖全部列入 inputs，以便绑定其实际版本。随应用固定的官方编译器使用支持直接执行 TypeScript 的 Node，以及 Java/TLC；缺少时给出真实依赖错误。可复用 TLA2TOOLS/JAVA，或由官方 mise 流程安装锁定版本，仍遵守原生命令权限。0 为规则通过、1 为发现反例、2 为执行失败；反例不冒充执行失败。"),
    step("interpret", "核对报告和图的含义", "回读实际 report.md、tlc.out 和 chart.mmd（若输出）。图通常最多 500 状态，超额只画反例路径，后续检查最多 100000 状态；明确未检查规则、截断、视图隐藏步骤及约束。模型描述源码时，沿真实代码回放反例。用 MyBuddy Mermaid 展示已生成的图，不能手画一张冒称 TLC 已验证。"),
    step("handoff", "交付运行绑定的状态图", artifact + "清单 version=1、kind=statechart、executionTaskId（pstack_statechart 的 taskId）、scope、assumptions、interpretation。产物必须与同一执行回执及输入 SHA256 一致。没有 chart.mmd 时按报告解释状态预算或覆盖原因；保留报告和原始输出，不伪造图。"),
  ],
};

const method = (id: string, label: string, description: string, instructions: string): PstackSkill => ({
  id, label, kind: "method", description, instructions, parameters: [], roleIds: [], stages: advancedStages[id],
});

export const advancedSkills: PstackSkill[] = [
  method("ketchup-video", "视频进度回顾", "以实际工作证据生成并逐页核实带字幕的静音视频。", "遵循 ketchup 的时间窗与只读回顾；唯一新增写入为任务媒体产物。技术检查、真实图片回读与交付文件缺一不可。"),
  method("create-formal-verification-skill", "创建形式验证技能", "从真实源码建立可执行的形式检查，用破坏变体证明检查有效。", "将性质和模型对应到源码，以工具原始输出证明执行和反例，固定边界与版本，保存项目本地技能；结论仅覆盖明确的范围。"),
  method("maintain-formal-verification-skill", "维护形式验证技能", "核查同步 commit 后的实现漂移、反例和验证覆盖。", "先跑旧检查，再从源码更新模型；保留性质，不把未知或产品 bug 标记为验证通过。只有真实重跑和负例证明之后才推进同步点。"),
  method("statechart", "执行并绘制状态图", "调用随应用提供的官方 TLC 编译器，生成报告、Mermaid 图及反例。", "通过 pstack_statechart 执行锁定版本编译器，使用现有原生 shell 权限与任务生命周期；完成门禁核实执行回执、输入和输出的实际摘要。"),
];
