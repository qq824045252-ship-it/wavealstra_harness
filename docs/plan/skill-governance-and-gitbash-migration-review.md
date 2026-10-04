# Skill 治理与 Git Bash 迁移：审查和实施结果

2026-09-09。目标根：`C:/Users/servi/.mybuddy/skills`。已应用 69 个文件，部署后 SHA-256 全部匹配。没有新增 Skill Runtime；Origin broker/client 原字节保持不变。

## Review 结论

- 执行方向可行，但 Skill 根不属于 Git 仓库。代码库保存逐文件变更包、基线哈希、部署脚本和验证证据；真实用户目录已部署，原文件字节备份在 `C:/Users/servi/.mybuddy/skill-governance-backups/`。
- FastCopy sync 是源到目标的单向镜像，会删除目标多余文件，原“双向同步”表述错误。Node wrapper 避免 MSYS 参数转换，同时保留源目录尾分隔符的语义。[官方帮助](https://fastcopy.jp/help/fastcopy_eng.htm)。
- Gemini 旧 --size 实际无效，现在明确报错；文档不再承诺 API 支持任意规格。CLI / 环境 / Windows 用户环境 / config.env 配置优先级、双端点、MIME、多图、resize 与错误退出均有覆盖；不回显密钥。
- 会议转写项目实际位于 Documents/GitHub，产物实际为 cwd 下音频名+时间戳；旧路径与输出规则已改。首次 NPU 编译本次为 170 秒，短暂健康超时不能当成服务不存在再启动。
- Origin 首次从 Graph1 调 import 虽返回 ok，却没有工作表数据。通过同一 broker 的 ScriptFile 建立工作表后导入、统计通过；入口新增结果核对和有限恢复边界。窗口激活存在时序差异是 Origin 官方记录的机制，[运行脚本说明](https://docs.originlab.com/labtalk/guide/running-scripts/)。本轮没有修改 broker 架构或算法。
- ardot-design-generator 是 CodeBuddy 插件包残留：manifest 声明 3 个子 Skill，但 skills/ 实际为空；MyBuddy 只认直接 SKILL.md，当前不能作为正式 Skill 加载。

## 验证范围

- 24/24 正式 Skill：YAML/identity、既有 metadata、资源链接、eval 最低 4 正+4 负、关键双向互斥、Bash 示例语法检查通过。MyBuddy 原生 SkillPackageValidator 24/24 valid，readSkillEvalCases 实际读到 202 条。
- 202/202 语义 Judge 通过（Gemini 2.5 Flash，使用仓库原有 SKILL_TRIGGER_EVAL_PROMPT，隐藏 expected 标签）。最终 SKILL.md 哈希与评测输入一致。**语义评测不等于运行时实际选中 Skill 的调用记录。**
- 入口总字符数 220,055 → 150,675，下降 31.5%。全部小于 12k；8 个仍超过 8k，保留工程/安全门禁或必要工作流，作为已审阅预算 warning。
- FastCopy：真实 Git Bash + 本机 fcp，中文/空格/单引号路径、字节内容、过滤、sync 目标多余文件、测试目录删除、错误码通过。
- MATLAB：本机 R2025b，--code mean=3、--script、故意失败 exit=1、临时脚本清理通过。
- Gemini：真实文本 CLI 返回 GOVERNANCE_OK；真实 gemini-3-pro-image 输出 PNG（1408×768，173309 bytes），Node 解码并经 uv/Pillow另存32×32通过；6组测试覆盖配置、端点、图片/JSON、无效输入和退出码，以及部署幂等、并发漂移与路径边界。
- Origin：既有 broker PID 3760 / protocol 2；status、import、stats、labtalk -ScriptFile通过。N=4、mean=5、SD=2.581988897471611、min=2、max=8；脚本变量=42；原活动页 Graph1 已恢复，未创建第二个 broker。
- 真实 NPU 转写：6.7秒合成测试音频，约3秒完成，正文“这是一条语音转写测试今天完成了技能迁移和验证。”；本任务启动的 ASR 服务已经按其 PID 确认后正常关闭。
- NPU OCR：1页短文本正确得到 TEST 42；宽文本样本部分识别，保留质量限制，不能只凭 exit=0 断言准确。
- Office：创建 Word、添加段落、save、读回 Governance 42、close通过；Git Bash 默认参数及显式 MSYS 排除路径均实测。PPTD 最小 fixture 本地 WASM 导出成功。ProjectLibre 实际 XML、周报实际 JSON、学术公式/cite/数字 mask→restore→verify、Archify showcase fixture validate通过。
- EasyEDA daemon health通过，但 windows=[]，未进行板级变更/DRC。KiCad 与 epro2kicad做CLI入口检查，未运行板转换。Ansys仅文档治理/评测，没有启动求解。PPT未做视觉版式审查；此次改的是路由/入口文档，未改导出器。

## 逐项交付

¹ warn 仅指入口仍为8–12k，不是包损坏或评测失败。done指本次治理与相应范围验证完成，不代表所有领域业务E2E都重跑。

| Skill | Yao Gate | Eval | Context | Shell | Near-neighbor | 状态 |
|---|---|---:|---|---|---|---|
| academic-translation | warn¹ | 8 | 20.0k → 10.9k | Git Bash | 见 Boundary | done |
| ansys-simulation | warn¹ | 8 | 12.2k → 9.1k | Git Bash | 见 Boundary | done；未运行求解 |
| archify | warn¹ | 8 | 16.4k → 10.3k | Git Bash | 见 Boundary | done |
| cheaper-inference-image | pass | 9 | 2.3k → 2.7k | Git Bash | Gemini / native image | done |
| code-view | pass | 8 | 3.7k → 3.7k | Git Bash | 见 Boundary | done |
| dim-feature-add | pass | 8 | 5.6k → 5.8k | 方法/工具路由 | 见 Boundary | done |
| dimagent-debug | warn¹ | 8 | 8.9k → 9.0k | 方法/工具路由 | root-cause-debugging | done |
| easyeda-agent | warn¹ | 8 | 18.8k → 11.8k | Git Bash | KiCad / epro | done；无连接器窗口 |
| epro2kicad | pass | 8 | 6.6k → 6.9k | Git Bash | KiCad 编辑 | done；CLI 检查 |
| fastcopy-copy | pass | 8 | 4.5k → 2.8k | Git Bash | 见 Boundary | done |
| gemini-agent-platform | pass | 8 | 7.2k → 2.2k | Git Bash | Cheaper / native image | done |
| kicad-design | warn¹ | 8 | 12.5k → 10.9k | Git Bash | EasyEDA / epro | done；CLI 检查 |
| loop-agent | pass | 8 | 6.9k → 7.1k | 方法/工具路由 | 见 Boundary | done |
| matlab-r2025b | pass | 10 | 1.9k → 2.1k | Git Bash | Origin | done |
| meeting-transcribe | pass | 8 | 2.1k → 2.5k | Git Bash | OCR / 已有文本 | done |
| npu-ocr | pass | 8 | 3.9k → 4.1k | Git Bash | ASR / 原生文本 | done；宽文本限制 |
| officecli | pass | 8 | 25.9k → 6.3k | Git Bash | open-kimi-ppt | done |
| open-kimi-ppt | pass | 8 | 21.7k → 6.7k | Git Bash | officecli | done |
| origin-analysis | warn¹ | 10 | 13.5k → 9.9k | 显式 PowerShell | MATLAB | done |
| projectlibre-gen | pass | 8 | 5.0k → 5.3k | Git Bash | 普通待办 | done |
| root-cause-debugging | warn¹ | 13 | 11.9k → 11.3k | 方法/工具路由 | dimagent-debug | done |
| shared-memory | pass | 8 | 3.2k → 3.4k | 方法/工具路由 | 见 Boundary | done |
| wechat-public | pass | 8 | 2.6k → 2.9k | 方法/工具路由 | 见 Boundary | done |
| weekly-report-fill | pass | 8 | 2.7k → 3.1k | Git Bash | 普通文字摘要 | done |
| weekly-summary | no-skill | — | 0.2k → 0.2k | Git Bash | 见 Boundary | 候选清理，未删除 |
| ardot-design-generator | orphan candidate | — | 无入口 | 不适用 | Ardot 插件包 | 未删除 |

## PowerShell retained

| 项目 | 保留原因 | 默认入口 |
|---|---|---|
| origin-analysis | Windows COM / .NET Named Pipe / ACL；禁止重写 broker | 显式 PowerShell backend |
| easyeda daemon launcher | 已有 Windows 后台启动器兼容；普通 easyeda CLI 已是 Git Bash | 仅启动器显式 PowerShell |
| officecli install.ps1 | Windows 安装阶段；运行时无依赖 | Git Bash 调 officecli |
| FastCopy / MATLAB / Gemini 旧 .ps1 | 兼容现有调用方，未删除；不再是 Skill 默认路径 | Node .mjs |
| loop-agent 的 verify-stack.ps1 示例 | 用户项目自有验证命令示例，非 Skill 核心运行依赖 | 按项目命令 |

## Cleanup candidates

| 目录 | 证据与判断 | 建议 |
|---|---|---|
| weekly-summary | 177字符，只有一句意图和Usage；普通文字摘要无稳定独立流程，判定no-skill。周报系统JSON契约由weekly-report-fill承担 | 保留原目录，候选移除；不扩大weekly-report-fill触发范围 |
| ardot-design-generator | CodeBuddy plugin.json v1.0.1声明3个子Skill，skills/为空；相关DB四张表查询0条，settings/capabilities/hidden-skills无引用；src/shared/professional-tools.ts仍有兼容名称 | 安装残留候选；若仍需原插件，从原来源修复完整包，不能臆造顶层入口；本轮未删除 |

## 部署和回退

- 审查包：`scripts/skill-governance/payload/`；清单：`manifest.json`。不包含config.env或凭据。
- `node scripts/skill-governance/deploy.mjs`：只校验当前状态。`--apply`：先校验基线、逐文件写入并读回；并发改动会拒绝覆盖。已部署文件不重复写。
- 每次部署在上述skill-governance-backups目录生成rollback.json，保存被修改文件原始字节；首次备份为2026-09-09T08-03-02-985Z。后续校正另外保存变更前字节；按时间逆序回退，且先核对当前文件没有后续用户修改。
- 技能发现/加载时读取新文件；已经注入旧文档的现有对话上下文不会被重写。本次目标是MyBuddy用户Skill目录。
- 仓库中并行出现的ComputerAutomationService、ComputerUseOverlayService、ComputerUseRunCoordinator、index.ts及model-runtime-init-probe.ts改动不属于本任务，没有纳入提交。

## 证据文件

- [包验证](../../scripts/skill-governance/validation.json) / [MyBuddy原生验证](../../scripts/skill-governance/mybuddy-validator.json)
- [语义评测](../../scripts/skill-governance/semantic-eval.json)
- [FastCopy/MATLAB真实冒烟](../../scripts/skill-governance/native-smoke.json) / [Origin](../../scripts/skill-governance/origin-smoke.json)
- [媒体验证](../../scripts/skill-governance/media-smoke.json) / [领域工作流](../../scripts/skill-governance/workflow-smoke.json) / [CLI入口](../../scripts/skill-governance/cli-smoke.json)
