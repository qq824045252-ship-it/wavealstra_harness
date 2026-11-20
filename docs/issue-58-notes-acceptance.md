# #58 笔记工作台对照与验收

基准为 EdgeEver v2.30.0 的普通笔记工作流。MyBuddy 主窗口左侧提供「笔记」入口，项目和工作空间仍从各自的「资料」进入同一套工作台。网页剪藏结果也在主窗口打开。普通笔记使用现有资料存储和 Tiptap。

对照来源见[三栏和专注编辑](https://github.com/tianma-if/edgeever/blob/v2.30.0/docs/best-practices.md)、[编辑工具栏](https://github.com/tianma-if/edgeever/blob/v2.30.0/apps/web/src/components/EditorToolbar.tsx)、[列表](https://github.com/tianma-if/edgeever/blob/v2.30.0/apps/web/src/components/MemoListPane.tsx)、[版本历史](https://github.com/tianma-if/edgeever/blob/v2.30.0/apps/web/src/components/dialogs/RevisionHistoryDialog.tsx)和[网页剪藏](https://github.com/tianma-if/edgeever/blob/v2.30.0/apps/extension/README.md)。

| 上游普通笔记能力 | MyBuddy 入口 | 实现与验收证据 |
| --- | --- | --- |
| 三栏、调宽、折叠、专注、主题、密度、菜单与快捷键 | 主窗口「笔记」及资料工作台 | Windows Electron 已验证三栏和明暗主题，截取明暗两张截图。上游同样例桌面对照、栏宽拖动、专注和快捷键组合待逐项验收。 |
| 独立于账号、模型和任务的本地流程 | 主窗口「笔记」 | 空模型配置和空任务、工作空间的隔离 profile 已完成新建、编辑、搜索和导出。打开前后主窗口目标 ID 相同。 |
| 文件夹、标签、收藏、置顶、拖动、批量整理、合并、恢复 | 左栏、中栏和回收站 | Windows Electron 已验证回收站恢复同一条目。服务测试验证层级、标签和置顶。批量整理和拖动待独立桌面验收。 |
| 富文本与 Markdown、公式、表格、代码、Mermaid 和资源 | 编辑区 | Windows Electron 已验证中文、样式、链接、任务列表、表格、公式、代码语言与缩进保真。Mermaid 代码保留，渲染和剪贴板图片操作待逐项验收。 |
| 自动保存、失败重试、历史比较和恢复 | 编辑状态、版本历史 | 桌面已验证自动保存、历史比较、恢复和正常重启。React 行为测试覆盖保存失败后草稿恢复，以及保存回复晚于继续输入。 |
| 网页选区和文章剪藏 | 内置浏览器「剪藏到笔记」 | Windows Electron 的实际 BrowserHost 及资料 IPC 通过选区、文章、结构、来源、图片、目标文件夹、标签和修改后搜索检查。 |
| 提取失败、外链图片异常和重复来源 | 内置浏览器剪藏 | 空选区返回错误，404 图片显示明确状态，重复剪藏生成不同 ID，已编辑正文保留。超长文章单独验收待执行。 |
| 本地离线查看 | 正文和资料附件 | 关闭剪藏源 HTTP 服务并退出重开后，正文和受管图片正常读取。整机断网及 Office/PDF 附件预览逐格式验收待执行。 |
| 中文搜索与更新一致 | 笔记搜索、已有资料搜索/读取 | 桌面两字中文短词搜索通过。服务测试覆盖旧索引补齐、280 KiB 以上正文尾部、改词后的索引和回收站隔离。启动补索引也验证了空笔记会被跳过，后续文档仍可索引。 |
| 兼容已存项目、工作空间、条目、附件、版本和引用 | Library 增量升级 | 旧结构夹具移除新增列后重启两次，保持原文件、ID、版本元数据、固定引用、空间绑定和任务引用。 |
| 范围、继承与只读 | 项目、工作空间和现有资料工具 | 归属、项目隔离、直接读取、父级继承和撤销引用的现有测试通过。新主窗口工作台里的只读界面逐项验收待执行。 |
| Markdown 导入、Markdown / HTML / PDF 导出及本地备份 | 文件菜单、笔记导出 | Windows Electron 实际生成文件，验证 HTML 内嵌图片、PDF 字符和 Markdown 配套附件再导入。备份恢复保留原 ID、附件和历史。文件选择使用隔离测试适配，系统对话框逐项交互待验收。 |
| 本地文件夹导入 | 左栏「文件夹」旁的「导入」及「文件 → 导入文件夹」 | Windows Electron 验证两个入口、目录选择请求、取消和导入后展示。资料库测试验证子目录、空目录、Markdown 链接、原文件保留和失败回滚。 |

## 数据约定

- Markdown 正文沿用现有受管文件。富文本和源码模式共用正文。旧笔记中的原始 HTML 和部分扩展语法可在源码模式保留并编辑。
- 合并生成新笔记，输入笔记原有链接继续解析。回收站保留资料 ID、文件和引用关系，恢复后这些引用可以重新使用。
- 备份恢复补回缺失条目；已有条目报告为已保留。新版本正文保存独立快照。旧版本记录可以保留和定位，可恢复正文以哈希校验通过的实际副本为准。

## 执行记录

- 主窗口、剪藏和实际导出结果位于 out/diagnostics/issue-58，包含 mybuddy-notes-light.png、mybuddy-notes-dark.png、desktop-smoke.json、desktop-clip.json、desktop-export.json 和 exports 目录。
- 类型检查、IPC 清单、资料库领域和事务、资料工具范围、编辑器生命周期、项目资料与工作空间资料相关检查已执行。
- 上游 Windows 发行文件通过 SHA-256 校验。解包后使用隔离 profile 启动了两次，进程均在可交互前退出，未取得同样例的上游截图。
