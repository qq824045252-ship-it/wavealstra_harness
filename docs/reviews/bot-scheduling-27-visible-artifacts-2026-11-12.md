# #27：保存版本可见读取与 file 条件补测

## 范围与固定源码

本轮继续 #27 的两个真实缺口，不关闭 Issue，不覆盖以往失败。

- 实测本地源码提交：`372a8a134dc16d76ce6213cde24e597bff28c62b`，基于 `1af669a2751544b989d7a8cde74c137b06d5e9b8`。若发布前吸收后续 main 导致提交 ID 改变，以[冻结产品 patch](evidence/issue27/visible-372a8a13-0355/tested-product.patch)及源文件指纹区分实测版本与集成版本，不能声称后续全 main 同样已实测。
- 独立 archive：`/home/vivion/iq27-tmp/s27-8chmust_`；独立 HOME：`/home/vivion/iq27-tmp/i27-QajIPb`。3251 源文件、驱动清单前后无变化；1267 个运行文件指纹为 `5398ee4e6f8cd9ec71a4b36cce6350a4575343457db9b618c017115a740c5b74`。
- 模型只用 `opendesign/deepseek-v4.1-flash`。真实 Electron/Hyprland，960 逻辑像素实体窗口，实际 CDP 输入。没有修改用户实例、用户默认应用关联或系统配置。

## 最小修复

1. **已登记文本可直接看见。** 成果按钮在原卡中预览精确保存版本；文本、JSON、CSV 等不再把 `shell.openPath` 空错误当成“用户已看到”。复用既有读取 IPC 的可选有界分支，最多读取 256 KiB 加1个探测字节，严格 UTF-8，明确截断，纯文本渲染，不执行 HTML。缺失快照显示真实错误并可重试，不回退原始可变文件。不支持格式仍明确提示，并提供独立系统应用打开；系统调用成功也只说明已请求，不能确认窗口。
2. **明确的登记前失败不误记未知写。** 只有初次源路径 `realpath` 的 ENOENT 在任何快照写入/登记之前转换成 `isError`。提示说明绑定目录和实际解析路径，要求先核对已有文件，不诱导重跑生成脚本。后续存储、提交、递归完整性检查和中断仍保留原异常/unknown 机制。没有把所有失败一律判无副作用。

旧批的 `inputs/event-result.json` 相对已经绑定的 `inputs` 目录，形成重复前缀。其初次 ENOENT 确认没有本次写入。旧账不追改。旧 file partial 的另一原因是执行器用 `bash cat` 读来源，不属于现有明确只读回执投影，因此结果回合缺少 ready 证明；原脚本不输出 ready 本身不是缺陷。

## 专项及独立审查

- UI：16 项及新增重试专项通过，覆盖版本切换、双击、关闭后迟到响应、空文本、合法 data: 文本、脚本转义、截断、缺失快照与系统错误。
- 有界 reader：UTF-8 边界、非法编码/NUL、目录、缺失/越界及旧两参数调用兼容通过。
- artifact registration 与真实 Durable tool-policy：错误路径 `failed/consumed`、纠正路径 `passed/consumed`、存储失败 `inconclusive/unknown`；原有部分写失败/timeout/restart 反例通过。
- 一次统一 typecheck 通过，独立只读窄审未发现确定阻断，diff-check 通过。
- 首次测试临时目录遇 errno -122 配额错误，改用本隔离 clone 自有临时目录后通过，未清理他人文件。
- 3 处旧 GUI 受控 fixture 已同步新接口，但未运行，不能算 GUI 门禁通过。没有重复全量回归、build 或打包。

## 六类真实批：保留 31/33 和两项差异

时间为 2026-11-12 **03:55:34.158–04:03:14.037 UTC**，7分39.879秒。六类分别为直接回答、只读状态查询、纯提醒、文本成品、CSV分析、真实本地 file 事件。原始结果 **31/33，2 FAIL，exit1**，见[原始断言](evidence/issue27/visible-372a8a13-0355/raw-checks.json)。不把补证覆盖为“整批通过”。

两项失败：

- 文本实际保存为要求的两行，末尾另有换行；驱动严格字节相等断言失败，因此该路径后的预览故障测试未执行。保留实际文件与失败，不为变绿改文件或原结果。
- 提醒已正常到期，但新驱动错误要求正文包含 job 标题。实际正文是提醒内容而非标题，产生约4分钟的无用等待后超时。后续应按 scheduler sourceId/dedupeKey 对账，不能继续用正文猜关联。

首次模型请求 03:56:29.026，最后响应 03:58:46.801；上述等待时间不计为模型推理。37 次调用全部有 usage：prompt 788,131、completion 9,500、total 797,631、cached prompt 598,144、reasoning 3,494；金额未知。见[原始 usage](evidence/issue27/visible-372a8a13-0355/raw-usage-audit.json)。本批为功能验收，不宣称性能分位数改善。

## 真实文件/事件结果与零模型补证

- CSV Work 实际 closed/succeeded，结果118、Coffee；真实卡片按钮经主进程读取该不可变快照，页面显示与保存文本完全一致，hash 未变，页面无横向溢出。
- file 事件由实际 fs.watch 触发，LOCAL-V2/value29 → doubled58，脚本只执行一次，同字节重复写不增加执行。输出仍不包含 ready，未为迎合复核改写输出格式。
- 本轮执行器实际使用原生 read 读取来源及结果；复核上下文含3条已核实读取。真实现有结果模型判定 `outcome=completed`、`notificationAssessment=met`，引用准确来源 read 和已登记成品。8条动作准入均 consumed，无 unknown；Watch review delivered，持续 Work 仍 active 等待下次真实变化。
- JSON 按钮实际在同一实体窗中显示保存版本，与源快照字节一致。[JSON截图](evidence/issue27/visible-372a8a13-0355/preview-event-result-json.png)。这是本地合成事件，**不是 GitHub webhook**。
- 在同一已核实测试窗口另做**零模型补证5/5**：显示实际文本快照；仅暂时移开本批快照验证 ENOENT，不回退原文件；恢复完全相同字节后点击重试，真实 IPC 重新显示；提醒按准确 sourceId/dedupeKey 关联到原会话，runCount=1且到期已投递；前后模型调用均37。原严格文本差异仍保留。
- [补证记录](evidence/issue27/visible-372a8a13-0355/zero-model-ui-supplement.json)、[可见文本](evidence/issue27/visible-372a8a13-0355/supplement-text-visible.png)、[真实错误](evidence/issue27/visible-372a8a13-0355/supplement-missing-error.png)。全部自有测试进程结束，快照恢复验证通过，资源已交下一个任务。

## 仍未宣称通过

本轮补到了受支持文本/JSON的可见读取和带原生来源证据的 file 条件完成。它不代表任意格式的系统查看器、任意 shell 输出的自动证据提取、实体多主窗口、GitHub webhook、完整 Work 里程碑 commit→paint 指标或所有平台均通过。此前63/70、后续68/68但file partial和本轮31/33均保持原样，不能合并成一个不存在的全绿批次。#27 继续开放，旧矩阵的部分覆盖项不整体改绿。

[本批完整证据摘要](evidence/issue27/visible-372a8a13-0355/acceptance-summary.json)和[校验清单](evidence/issue27/visible-372a8a13-0355/manifest.json)。原始报告 SHA256：`eb67829e0a80ca41b9f69e6306cc05254446214ccaaff3bc08fccb9c0e7e5557`；原始请求/响应仅保留本地，未发布凭据或用户实际数据。

## 发布集成记录

发布前保留用户及另一任务的 main `4356ddf4f49c3c2db1e246d21f3c5029550cccd7`，本轮集成修复提交为 `7ddd8cc4f7633e4003196d66476a25f59fbc8ae9`。15个修复/专项文件与实测372a8a13逐文件比较无差异；在先吸收e35fafd6时完成短集成typecheck、artifact registration和UI16项专项，后续#28提交无本轮文件冲突。没有把后续全main写成六类实测版本，没有重跑全量。
