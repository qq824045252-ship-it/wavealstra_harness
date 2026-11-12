# Issue #27：实体窗口与分阶段延迟补充实测

本报告补充[既有逐条验收矩阵](bot-scheduling-27-followup-2026-11-12.md)，不替代此前成功/失败记录，不关闭 Issue。所有时间为 UTC，除非明确标为产品本地时区。

最新补批见§7：414bf2bf上七类真实任务的原始68/68通过，实际改向已补到；可见文件查看仍受限。§1–6保留此前b5批63/70及后续提醒更正，不重写历史结果。

## 1. 结论及固定版本

- **原始本批 FAIL：63/70，7 FAIL，进程自然 exit 1。** [原始断言](evidence/issue27/b5-instrumented-0129/raw-checks.json)、[失败明细](evidence/issue27/b5-instrumented-0129/failure-details.json)保留。63 个布尔真值不等于 63 项完整产品验收通过，下文列出弱断言/误导标签。
- 测试源码为 `b5c1429d77d2d2f192149c48a92990cca8f4926c` 的独立 git archive。3168 文件来源清单已冻结；1265 个运行源码文件指纹前后均为 `fa44173fa7b18d2aac9f6e8441f3123e56d08a7b295eb1402285fcf0e9adbde2`。产品没有改动。
- 使用真实 Omarchy/Hyprland 原生 Electron `pnpm dev`、新隔离 HOME，宿主已有 Magpie `http://127.0.0.1:3425/v1`，唯一真实模型 `opendesign/deepseek-v4.1-flash`。未改网关、用户实例、凭据或系统配置。
- 实际发送 **6 类不同语义任务 + 8 个忙时算术样本**：并行 A/B、直接回答、只读状态查询、CSV 分析委托、纯定时提醒、真实本地文件事件。第七类“运行中自然改向”因为测试脚本错误没有发送，不能算已覆盖。
- 新增有效证据：960/1200 原生窗口、A 的真实不可变成果在 B 等待时交付、两个持久会话及 Work 回原会话、真实 file 事件去重，以及 8 个忙时实质答案的 COMMIT/广播/接收/DOM/可见 rAF/后续 Paint 分阶段观测。
- 本批不能证明运行中改向、文件点击/外部查看器、Work 里程碑的精确 COMMIT→Paint、多个主窗口或 GitHub webhook。原矩阵 11、23–27 仍不能整体改为 PASS。

## 2. 实际时间和成本

| 阶段 | 实际证据 |
|---|---|
| 启动到自然退出 | 2026-11-12 01:29:19.976 → 01:35:48.100，6 分 28.124 秒 |
| 首个真实 HTTP | 01:30:10.719，HTTP 200/SSE |
| 最后模型 HTTP 完成 | 01:35:04.203 |
| 调用数 | 62：foreground 20、native main 30、child 9、completion review 2、watch review 1 |
| 唯一真实工具调用 | 45：42 completed、3 failed |
| 返回 usage | prompt 1,394,122；completion 25,249；total 1,419,371；cached prompt 1,108,224；reasoning 12,334。缓存/推理为提供方各字段，不另加到 total |
| 大 trace 离线分析 | 单次成功解析 4.068 秒，低优先级；不启动模型/GUI。首次 `/usr/bin/time` 不存在，exit127，分析器尚未执行；改用 shell time 后成功 |

三次工具失败没有隐藏：一次 `register_artifact` 指向尚不存在文件，一次 `bash` 返回非零，一次 `register_artifact` 超出绑定工作区。[调用摘要](evidence/issue27/b5-instrumented-0129/compact-result.json)包含原诊断。最终有可用成果不等于零失败/零重试成本。

此前两个零输入预检失败也保留在本机：第一次原生窗口身份查询未找到目标；后续确认产品更改 process.title 会使 `/proc/PID/environ` 里的 HOME 不再可用，不能归咎于已证实的窗口映射竞态。测试驱动改用受隔离 HOME 保护的 main-probe 启动记录，并复核 PID/startTicks/exe/cwd 和唯一 Hyprland PID/address。随后零输入 960/1200 预检 4/4 通过。预检均没有模型请求，不混入本批 62 次调用。

## 3. 7 个失败和弱 PASS 的准确含义

根因在冻结测试驱动 `scenario.cjs:39`：点击官方“归档并开始新对话”后，**尚无第一条持久消息的新会话返回空 ID**。驱动立即保存空字符串，且只断言“不同于旧 ID”，错误地将其标为两个持久会话。真实提交后产品正常建立新 ID，但驱动没有更新。

- `:54` 调用 `history("")` 被 schema 正常拒绝，尚未走到 `:57` 的改向提交。
- 三项 B-AMENDED 字节/交付/写调用断言失败，因为根本没有提交要求 B-AMENDED 的用户消息。实际 B-ORIGINAL 符合原 r1 指令。不能把此结果说成改向产品失败，也不能说改向通过。
- “final amended execution” 后段再次在空 ID 查询失败，未运行该处会话归属断言。
- 文本/JSON 两个 openFile 在查询历史时就失败，**按钮未点击，open IPC/shell 探针记录为零**。外部文件打开未测，不以“没有报错”作为成功。

此外，原始 PASS 标签 `amended execution succeeds`、`A bytes unchanged after amendment`、`A ... once across revisions` 只能证明原 r1 成功、A 原字节保留、A 写一次。没有产生 r2，不能据标签扩张成跨修订 PASS。[判定修正](evidence/issue27/b5-instrumented-0129/assessment.json)不改变原始布尔结果。

新会话真实存在由**另外的只读持久事实审计**证明：

- 原会话 `bot-conversation-158b6bfd-c687-4437-867c-fe94c46c95ec`。
- 新会话 `bot-conversation-c957b31d-7ca3-46dc-bff8-ac2b62403aad`。
- A/B Work 的四条 feedback 全在原会话；CSV 两条、file event 一条各在新会话。提醒同样只回其来源新会话。
- SQLite 使用 immutable readonly，审计前后 DB SHA256 相同，未伪造/补写业务。审计只补实际已发生的归属事实，不把未发送的改向/未点击的文件动作补成 PASS。

[归属与不可变文件审计](evidence/issue27/b5-instrumented-0129/routing-artifact-audit.json)记录完整 ID、登记 digest、实际 bytes hash、来源绑定和本次模型/工具账目。测试驱动 v4 已在独立临时目录静态纠正：仅在第一条消息持久化后取得非空 ID，再逐条确认其余新会话消息 ID 一致；本报告不宣称 v4 已实跑。

## 4. 原生窗口、部分成果和原会话

本轮四次 native window 观测均对应同一受控 PID/address，Hyprland size 与 DOM inner/outerWidth 同时为请求的 960 或 1200 逻辑像素，无水平溢出。不是仅 CDP viewport 模拟；截图在桌面缩放下的像素宽度不冒充逻辑窗宽。

- [960 窗口 A 部分成果](evidence/issue27/b5-instrumented-0129/first-A-960.png)：A `a-ready.txt` 登记快照真实存在，7 bytes，内容 A-READY，digest 相符；B 仍受验收 gate 等待。脚本展开并滚动到文件卡，所以这是**人工揭示后的可见性**，不是自动首屏时延。
- [1200 新会话](evidence/issue27/b5-instrumented-0129/second-conversation-1200.png)、[960 结果](evidence/issue27/b5-instrumented-0129/results-960.png)、[1200 结果](evidence/issue27/b5-instrumented-0129/results-1200.png)是实际窗口截图，后两次文件打开步骤没有执行。
- 官方 workspaceNavigation → 精确来源请求 → 前台详情实际做了“原→新→原”三次，DOM 只包含对应请求的 user/answer ID，不混其他请求。此处证明来源请求视图隔离，不等同于显示该 Work 所有后台历史或跨 Bot/团队/渠道全范围隔离。
- CSV 真实读取原文件，登记不可变 analysis.txt，计算结果包含总额 118、最高 Coffee/50，源 CSV 未改。
- file source 真正经过 fs.watch→持久 inbox→工作区处理器→登记 JSON，LOCAL-V2/value29 得58；两次写相同字节未增加 inbox、执行或输出。该输入明确是本地模拟数据，不是真实 GitHub 事件。

## 5. 分阶段延迟：仅八个忙时实质答案

[逐样本与统计](evidence/issue27/b5-instrumented-0129/busy-phase-metrics.json)选择每个忙时算术请求第一次含完整数字答案的 DOM 版本，随后 100ms 内存在整个消息位于可视区的 rAF。8 个请求各一条样本，不混回执、计划文字、同消息后续修订、Work/提醒、人工滚动或返回旧会话。

分位数为 nearest-rank `ceil(n*p)`；N=8 的 P95 实际为最大观测值，不能代表总体 P95 或 SLA。

| 观测边界 | P50 | P95 |
|---|---:|---:|
| renderer 输入事件 → 完整答案 DOM，单 renderer performance.now | 4.380 秒 | 15.089 秒 |
| 输入事件 → 首实质 host 文本事件（旧统计口径） | 4.347 秒 | 15.089 秒 |
| SQLite COMMIT API 返回 → main broadcast 前 | 0.743 ms | 0.821 ms |
| COMMIT 返回 → renderer receive | 1.33–2.09 ms | 53.06–53.82 ms |
| COMMIT 返回 → DOM 匹配 | 35.78–36.54 ms | 68.94–69.70 ms |
| COMMIT 返回 → 完整消息可见区 rAF | 36.69–37.45 ms | 70.26–71.02 ms |
| COMMIT 返回 → 同 renderer 随后的 Paint 开始 | 37.65–38.41 ms | 70.82–71.58 ms |

以上边界不互换：

1. COMMIT 是真实 better-sqlite3 API 返回，不是磁盘 fsync，也不是 Durable 子库第一笔事实入库。
2. DOM 使用消息 ID/版本和规范化文本匹配；rAF 检查消息矩形。它们不是物理显示确认。
3. Paint/DrawFrame 是实际 Chromium trace 事件，但此处 Paint 的节点为 `#document`/整视口，只能称**同 renderer 第一次后续绘制**。不能证明该 Paint 包含目标消息每个像素，更不能称物理屏幕 scanout 时刻。
4. 输入计时来自 renderer 的真实 input 事件记录，不是操作系统按键时间戳。
5. 本批 onMessageChanged 观察流没有 Work feedback，其精确 COMMIT→DOM/Paint **没有测到**。到期提醒实际上捕获一条完整链，见下方更正；不能把两者混称未测。既有 host/截图时间不得填入 Work 链。

原始 trace 共767,627事件，1,740 Paint、2,496 DrawFrame，traceComplete dataLossOccurred=false。16/16时钟校准匹配，单调时钟偏移交集有效，区间宽0.760187ms。总108个 DOM 版本中62个后来有可见rAF；其余或延迟很久才可见的版本没有混入八样本性能组。[全链摘要](evidence/issue27/b5-instrumented-0129/phase-summary.json)和[校准记录](evidence/issue27/b5-instrumented-0129/trace-calibration.json)可核对。

插桩确有开销：main 元数据/入队计量398.908ms，renderer observer累计9581.5ms/17,854次；未计 main 批量落盘和Chrome tracing全部成本，未做减法修饰。因此这是**插桩下实测**，不是无插桩性能基线，也不据此宣称某次性能优化收益。

### 5.1 提醒样本筛选更正（保留原始数据）

`d83532da` 初稿错误称到期提醒没有进入观察流。复核确切持久消息ID发现，后处理只筛选 `work-feedback`/`cron` 前缀，遗漏 `bot-message-reminder-…`。原始 `phase-summary.json`/renderer记录早已完整包含此提醒，**没有改造原始数据，也没有影响上表八个算术样本**。

[该条提醒的精确来源与阶段](evidence/issue27/b5-instrumented-0129/reminder-phase-correction.json)：COMMIT返回→广播0.431ms；→renderer接收0.747–1.508ms；→DOM212.560–213.321ms；→可见rAF223.850–224.611ms；→随后renderer Paint开始214.355–215.116ms。这是一条观测，不据此报总体P50/P95；Paint早于后一次rAF标记也不证明目标像素的实际显示时刻。

原始 compact/派生 busy-phase JSON 保留初稿，里面“reminder缺失”的过宽限制由本节明确更正。Work反馈的缺口仍存在，不能因这条提醒改为全部后台成果已测。后续关联使用实际持久ID，不再猜前缀。

## 6. 再现、保留和后续验收

冻结驱动及探针见 [test-drivers](evidence/issue27/b5-instrumented-0129/test-drivers/README.md)，含实际执行的 v3 脚本和散列。原始 report SHA256 `bbacac703984911bc56d58ac9828ef65d4ec10de8baa3963d5dfd0d9099624a5`。约212MB trace/SSE/完整报告留在隔离测试目录，没有向仓库复制整套 profile/凭据。

本机原始证据：`/home/vivion/iq27-tmp/s27-EMW04H/out/diagnostics/bot-scheduling/batch-2026-11-12T01-29-20-008Z-1599454/`。发布文件的 hash 在 [publication-manifest](evidence/issue27/b5-instrumented-0129/publication-manifest.json)。原始 [evidence-manifest](evidence/issue27/b5-instrumented-0129/evidence-manifest.json)生成在后续离线phase分析之前，两个manifest用途不同。

后续安全可做项：修正驱动后另起新隔离profile，仍至少6类真实任务，补运行中改向与文件点击，检查准确IPC/打开结果，不复用已结束Work制造“改向成功”。若需要后台成果精确延迟，先补测试专用观察真实 invalidation/历史渲染路径，不能用前台change流假代替。任何新增真实批单列来源/结果，不覆盖本批FAIL。

当前没有产品改动、没有全量回归、没有build/pack，也没有修改CI。最后完整headless仍以旧报告的 `1c4966bd` 为准，不因本报告提交而改写。多个主窗口、窄于960实体窗、真实GitHub webhook和跨渠道/常驻能力边界保持原样。Issue #27继续open。

## 7. 修正驱动后的七类真实补批（414bf2bf）

### 7.1 实际范围与原始结果

2026-11-12 02:38:08.126–02:45:07.449 UTC，**6分59.323秒**。从当时最新main `414bf2bfef86b67b36121192bbfe838512db5302` 建独立archive，新HOME/XDG目录，真实Electron/Hyprland和同一V4.1 Flash。本批期间#21另推main，没有热改或换掉冻结源码。

原始驱动结果为 **68/68，0 FAIL，exit0**，见[原始断言](evidence/issue27/v4-414bf2bf-0238/raw-checks.json)与[完整范围摘要](evidence/issue27/v4-414bf2bf-0238/acceptance-summary.json)。**只代表这些断言，不是#27全过；尤其不等于外部查看器成功显示。** 原先63/70原样保留，不被这批替换。

实际七类：并行A/B、直接回答、只读查询、CSV分析委托、纯提醒、本地file事件、运行中自然改向。另带2个忙时算术功能问句，不重跑此前8样本的性能分位数。#21仅在02:39:36–02:39:48重叠12秒focused/typecheck CPU，无其他GUI/模型批；不将本批用作干净性能基线。

驱动修正仅在测试副本：第一条新消息持久化后取得非空会话ID；等待第二Work实际创建后再改向；文件按钮使用CDP真实鼠标事件，逐条关联精确snapshot路径的IPC和shell结果。产品源码未改。3210文件清单前后校验零差异，1266个运行文件指纹均为 `c2db687b4815a67c640be2ce4df0476fbd76a44bcddec8834f59efbdace46d5a`。

### 7.2 改向及归属缺口已实际补到

- A先完成并登记真实7字节 `A-READY` 快照，B仍等受控gate；[960实体窗截图](evidence/issue27/v4-414bf2bf-0238/first-A-960.png)仍是展开/滚动后的可见证据。
- 在新会话发送改向，目标明确为原Work `work-8395e382-018d-420e-8376-f1e06202c22f`，实际同Work从r1升r2，没有另建替代Work。r1绑定stopped/aborted，r2 completed，Work closed/succeeded。
- r2真实复核并保留A，B复用原 `B-ORIGINAL`，gate后最终为9字节 `B-AMENDED`，登记新版不可变快照并回原会话。真实transport中A write一次、B-ORIGINAL一次、B-AMENDED一次。这个计数是write工具调用证据，不冒充穷尽所有等价文件写法的证明。
- 第二个独立CSV Work保持r1并closed/succeeded；源CSV未变，真实交付结果118/Coffee50。
- 只读SQLite复核原A/B Work六条feedback均属原会话；CSV两条、file一条各属新会话，提醒只回新会话。数据库immutable读前后hash一致。原→新→原来源请求视图仍逐ID匹配。
- r1停止只表示真实停止回执，不证明任意旧外部副作用都不存在；未把旧风险或失败记录删除。

来源、绑定、字节与账目见[独立持久事实审计](evidence/issue27/v4-414bf2bf-0238/independent-audit.json)。

### 7.3 文件点击已真实执行，可见查看仍有明确限制

两次点击均从已交付的准确immutable snapshot按钮发出，记录 `open-ipc-enter → shell-open-enter → shell-open-resolved → open-ipc-resolved`，操作ID和路径一致，打开前后快照hash相同。这里补到了上批未执行的真实按钮/IPC/OS调用。

但**空错误返回不能证明用户看到了文件**：

| 文件 | 实际观察 | 验收结论 |
|---|---|---|
| analysis.txt | shell.openPath返回空错误；实际启动xdg-open→nvim，无新可见窗口。nvim ttyNr=0，标准流指向测试dev.log | 调用/路径通过；可见查看未验证，不能称自动打开成功 |
| event-result.json | shell.openPath同样返回空错误；stderr为`No applications found for mimetype: application/json`，无新可见窗口，UI未显示错误 | 调用/路径通过；本隔离profile未提供可见JSON查看器，不能称成功查看 |

[逐次打开证据和判定](evidence/issue27/v4-414bf2bf-0238/open-file-assessment.json)及摘要保留确切shell返回。原68项中“OS accepted …”只断言此API返回，报告不扩张它。

此profile未继承用户HOME/XDG里的应用关联；不能直接推断用户日常profile的表现。补充只读定位显示系统text/plain默认为nvim.desktop（Terminal=true），本机xdg-open generic路径直接执行desktop Exec，其文档明确终端程序复用调用者TTY；与此次后台无TTY的现象一致。没有改系统/用户默认关联、安装应用、手工另开查看器伪装自动打开，也没有修改产品以掩盖结果。

额外拉起的nvim PID1756612和xdg-open PID1756500均只指向本次测试快照。核对argv/cwd/startTicks后仅向nvim发SIGTERM，launcher随后退出。未动用户编辑器或用户文件；最终自有Electron、runner、provider及上述进程全部消失。

### 7.4 file事件与成本不因总分通过而抹平

实际fs.watch触发LOCAL-V2，处理器只执行一次，value29→doubled58，登记98字节JSON；同字节重复写未增加执行/事件/输出。native绑定completed，持续Work保持active等待后续来源。

**但该轮结果复核是partial**：一次错误路径登记留下当前lineage的unknown动作；已登记结果JSON未包含ready字段，通知条件核对也记unknown。用户可见正文明确披露风险和不能重放，交付现有文件，不将本轮描述成全部效果已确认。此处只通过执行/数据/去重断言，不充当完整无风险S2验收。

调用及失败账目：

- 64次真实HTTP，唯一模型仍为`opendesign/deepseek-v4.1-flash`。可唯一关联：foreground21、native main23、child16、completion review2、watch review1；另1次未能按usage+时刻唯一归因，保留unknown，不猜分类。
- 63/64调用有可汇总usage：prompt1,566,206、completion23,940、total1,590,146、cached prompt1,248,256、reasoning8,995。另一调用usage缺失，不当零token；金额未知。
- 53个唯一诊断工具调用：48 completed、5 failed。失败为改向取消原subagent/bash各1、错误路径register_artifact两次、缺当前版本守卫work_amend一次。后续合法恢复成功不抹去这些成本。
- 首个HTTP02:39:09.065、最后HTTP完成02:44:21.604。相较运行总时长，启动/收尾时间单列，不全算模型推理。

### 7.5 状态与再现边界

冻结v4驱动在[evidence目录](evidence/issue27/v4-414bf2bf-0238/publication-manifest.json)，完整原始report SHA256为 `26a7399dc2b3e80c1512606ea3e608f6feb60f8c8d3db7e47106b568cd5b470a`。本机原始目录：`/home/vivion/iq27-tmp/s27-d0k1hd7g/out/diagnostics/bot-scheduling/batch-2026-11-12T02-38-08-183Z-1742727/`。

保留815,031事件的约217MB原始trace，dataLossOccurred=false；未为了功能补测再次重解析或重新宣称性能提升。GUI/模型窗口已交给下一任务。没有全量回归或build/pack；没有产品编辑、CI设置变更或关闭Issue。

当前缺口准确收窄为：可见外部查看器/打开错误呈现、Work里程碑完整commit→渲染观测，以及原矩阵仍注明的全场景/平台/多窗口/外部渠道边界。运行中改向和两个持久会话的此次实际链已有证据，不再说“这次未发送”。后续如要处理Linux文件打开，需区分产品打开适配、默认应用可用性与隔离profile配置，不以改关联后的夹具假代替现有环境结果。

## 8. 后续受支持文本可见预览修复

后续实现内置保存版本文本预览及登记前确定失败分类，并在冻结372a8a13上完成六类Flash实批。原始31/33，两项差异保留；同实例零模型补证5/5。文本/JSON真实IPC可见、丢失快照错误与恢复重试、file本轮completed+通知met有证据，但不宣称全部平台/格式或#27通过。详见[后续专项报告](bot-scheduling-27-visible-artifacts-2026-11-12.md)。本节不追改§7所记录的旧版表现。
