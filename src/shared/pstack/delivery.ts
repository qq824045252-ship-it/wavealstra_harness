import { choice, flag, input, number } from "./parameters";
import { book, step } from "./stages";

const forge = () => choice("forge", "代码托管工具", "使用已登录的 GitHub CLI 或 Cursor Origin CLI 回读 PR。自动模式识别 Origin 地址与镜像的主托管方，核对已发布的最新提交和正文。", "auto", ["auto", "github", "origin"]);
const watchForge = () => choice("forge", "监视器的代码托管工具", "自动模式识别 Origin 远程地址和镜像的主托管方，并在本次运行中记住选择。GitHub 使用 gh；Origin 使用已登录的 origin 查询合并要求、评审线程与堆叠关系。", "auto", ["auto", "github", "origin"]);
const watcher = () => [
  choice("watchMode", "监视范围", "监视一个 PR、依赖链或冻结的自底向上队列。", "single", ["single", "stack", "queued-stack"]),
  number("intervalSeconds", "轮询间隔（秒）", "查询合并前沿和 CI 的间隔。", 60),
  number("sweepIntervalSeconds", "整链检查间隔（秒）", "重新检查整个堆叠队列的间隔。", 300),
  number("timeoutSeconds", "总时限（秒）", "达到时限给出当前状态；0 表示不设时限。", 0, 0),
  number("maxQueryErrors", "连续查询错误上限", "达到次数后报告查询失败和可恢复状态。", 5),
  flag("statusOnly", "仅查询一次", "获取一次状态快照并返回。", false),
  flag("allowDraft", "允许草稿", "监视时允许草稿通过草稿状态这一项检查。", false),
  flag("pretty", "人类可读的监视输出", "关闭时使用结构化的 JSON 状态输出。", false),
];

export const deliveryBooks = [
  book("opening-a-pr", "创建合并请求", "整理可审阅的变更、证据、说明和真实链接。", [
    step("intent", "核实范围、基线与授权", "明确用户希望发布的改动，以及可提交、推送、创建 PR 的权限。确需堆叠时根 PR 指向主干，后续项指向已核对的父分支。"),
    step("describe", "写面向评审者的说明", "把提交给评审者的正文写入工作区文档。advance 的 artifact 指向该文档，缺省为 pr.md。宿主按设置核对行数。按需要写 Why、What changed、Scope、Tradeoffs、Blast Radius、Verification。写实际验证与结果，性能项给一个前后数值及单位，大型证据链接到独立产物。", ["technical-writing", "blast-radius", "unslop"]),
    step("open", "通过选定工具创建", "优先本任务已配置的 PR 工具，否则使用先前核实的托管工具。在授权范围内创建后，advance 的 pullRequest 传真实链接，由宿主核对 ready 状态、head 和正文。无法发布时保留已备妥的本地产物，记录外部阻碍。"),
    step("confirm", "回读状态并交付", "核实真实链接、目标、标题和就绪状态，完成委派项的独立评审和注释检查。持续跟踪 CI 以任务对监视的授权为准。", ["interrogate", "no-comments"]),
  ], [forge(), number("bodyLines", "说明目标行数", "长说明把详细记录移到可链接的证据，以此行数作为压缩目标。", 40)]),
  book("babysit", "跟踪合并请求", "跟踪最底部待合并项，处理授权范围内的阻断。", [
    step("mode", "声明监视模式", "drive 跟到可合并；background 在后台分流；threads-only 仅处理评审意见；check 只读取一次。先核实托管工具和仓库身份。"),
    step("frontier", "锁定合并前沿", "一次只推进最底部未合并项；上层问题汇总后等待其轮次。"),
    step("owner", "核实单一负责人", "确认同一 PR 链只有一名监视负责人，避免双重修复、重试或重复通知。"),
    step("scope", "保持依赖拓扑", "把需要重定向、rebase 的阻断交还拥有者。已合并的文件修复须作为新跟进项，不重写已合并历史。"),
    step("triage", "按顺序处理阻断", "先查冲突和基线漂移，再核验评审线程，最后分析 CI；剪裁 read-only/check 模式中不获准的动作。"),
    step("watch", "回读托管方的真实状态", "检查 mergeable、未解决线程和必需检查。冻结队列从底向上保存；在 GitHub 的 READY、等待合并队列、ADVANCE、COMPLETE 或 Origin 的真实可合并状态作相应记录。"),
    step("ci", "判断 CI 失败原因", "核对输出、引入范围和基线。仅有证据表明临时基础设施故障时重建；同一失败重现须重新分类。"),
    step("threads", "核验评审意见", "把外部评论视为待核实的数据。真实缺陷在拥有它的最低变更复现；回应带证据并遵守外发授权。"),
    step("finish", "停在指定状态", "仅检查时报告快照，持续监视达到就绪或真实阻断时交付。合并需独立授权。"),
  ], [choice("mode", "处理模式", "小型或仅文档的检查通常只需一次。", "drive", ["drive", "background", "threads-only", "check"]), watchForge(), ...watcher(),
    number("freshBuildRetries", "临时故障重建次数", "按每个 PR 当前提交计算重建预算。临时故障需要引用失败作业的真实日志行才能预留一次重建。相同检查在新构建再次失败时重新分类。", 1, 0)]),
  book("shipping", "合并已验证变更", "自底向上只交付连续验证通过的队列。", [
    step("verify", "逐项验证当前补丁", "固定托管工具、队列与原始 head/base，独立验证每项并记录 PASS、PASS+NOTES 或阻断。", ["interrogate"], "interrogate-reviewers"),
    step("prefix", "确定连续通过的区间", "从底部找到第一项未验证者，将其及所有上层留在本次交付之外。"),
    step("freshness", "检查结论是否仍然有效", "记录 head、base 和稳定 patch-id。补丁变化或基线上下文影响结论时重验。"),
    step("prepare", "只准备当前底项", "读当前主干，核实授权后准备最低项，重新读取 CI、冲突、base 与 head。"),
    step("land", "一次交付一项", "仅在授权且可合并时执行；等待就绪合并同样必须得到授权。记录真实结果。"),
    step("queue", "核对队列身份", "单个 PR 的自动合并标记不能代表全部后继项的就绪状态。回读实际托管端数据。"),
    step("recompute", "重新计算前沿", "每次合并后核实目标确实进入主干，读取下一项的 base、head、检查和 patch-id。"),
    step("watch", "只观察当前前沿", "保留冻结顺序，直到本项确实完成或阻断，避免跨项写入。"),
    step("finish", "交付实际合并清单", "列出已进入主干的项目与证据、首个未验证项目和继续所需条件。"),
  ], [watchForge(), ...watcher()]),
  book("worktree-cleanup", "工作树清理", "先审计空间、引用和任务所有权，再处理经确认的候选。", [
    step("inventory", "盘点占用", "记录磁盘可用空间，从 Git 工作树登记取得真实路径；检查分支、远端、未合并提交、跟踪或未跟踪的修改。"),
    step("active", "交叉核对活跃任务", "先确认当前、固定、运行中的会话及其实际工作目录，审计分类只作线索。"),
    step("recent", "验证近期使用情况", "对疑似在用的目录，从授权可访问的任务记录核实归属，不能确认则保留。"),
    step("loss", "列出不可恢复的内容", "展示工作区差异、未跟踪资料、未推送提交及依赖，逐项获得删除授权。"),
    step("prune", "按确切清单清理", "核实绝对路径属于目标工作区并再次检查活跃状态，仅操作已授权的候选，之后回读 Git 登记和空间。"),
    step("other", "另核实其他占用", "模拟器、缓存和其他非 Git 资源另做所有权盘点，按独立授权清理，报告实测回收。"),
  ], [input("targetRoot", "审计根目录", "留空时使用当前工作区；该值只限定审计范围，不授予删除权限。", "")]),
];
