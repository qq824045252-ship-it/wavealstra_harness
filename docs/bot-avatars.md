> Integration status (2026-11-13): integrated on main baseline d6fc2d8b. Direct Omarchy checks passed: typecheck, test:bot-avatar-ui (React/DOM fixture), classification audit, and integrity of 93 entries / 186 assets. Native desktop file selection, packaged application behavior and full regression were not run. Independent security re-review was blocked and is NOT claimed to have passed. Historical producer results below are not independent integration acceptance. Publication does not remove these limitations.

# Bot 头像支持与素材交接

本次独立云端副本基于 `6072ad6aa49e76586004af34ab21ba28e25f358d`。不提交、不推送、不操作 Vivion 或其他活跃原仓。Work 详情与编排仍按本地版本协调；本功能只在共享文件添加下面列出的窄接线。

## 当前素材事实

- 产品目录：`src/renderer/src/assets/bot-avatars/`。
- 产品清单：`src/shared/bot-avatar-manifest.json`；当前 **93** 条，186 个 PNG/GIF 文件，共 **28,657,002 bytes（约 27.3 MiB）**。
- 这 93 只来自当前线程通过 Library 正式物化的三批交接 ZIP。逐个核对 ZIP SHA-256、资源 SHA-256/字节数、路径和真实文件类型，完整解码八帧并确认八帧不同、无限循环、256×256、poster 可解码。`docs/bot-avatar-materials.json` 记录逐只来源、哈希、源初审状态和限制。
- 未接入编号 **051、056、061、081、082、092**。交接说明这些项目被生成服务拒绝；没有重试或从其他目录补入。当前数量不是 99。
- 资源是原创生成关键帧合成的概念循环图，有轻微形变的可能；不是真实三维实时渲染。来源方完成了 27/34px 明暗背景与帧审查；消费方没有重新人工逐帧审查全部 93 只。
- 两个明确自制的工程测试小兽已从产品清单移除，保留在 `fixtures/bot-avatars/`。JPEG/WebP/宽图变体也仅用于测试，不算正式角色。

三批交接的 ZIP（原始归档和 Library 元数据保存在独立的 `../bot-avatar-incoming/`，没有打进产品）：

| 分组 | 数量 | ZIP SHA-256 |
| --- | ---: | --- |
| 学习/研究/创意 001–033 | 33 | `ccc15aa2a329f40dd5def085d04ff15de74ac6cfa039c455c740555e2bdd571d` |
| 工作 034–066，排除三项 | 30 | `d6996f288a2e38c719a816497d05eed46dadc5579040a7d12ac9f77454817174` |
| 生活 067–099，排除三项 | 30 | `55d9d5f871e593ac1a5bbacb87e1653eb21aa8e5e2eb368bc865def530317a0d` |

## 清单契约

```json
{
  "version": 1,
  "entries": [{
    "id": "builtin:companion-001",
    "label": "学习搭子",
    "provenance": "original-approved",
    "copyright": "保留素材原有原创、生成来源及许可声明，不虚构开放许可或第三方授权。",
    "approval": "handoff:原始Library标识@已核验ZIP哈希",
    "poster": {"file": "companion-001.png", "sha256": "实际64位sha256", "bytes": 12345},
    "animation": {"file": "companion-001.gif", "sha256": "实际64位sha256", "bytes": 23456}
  }]
}
```

示例哈希和大小是格式说明，不能直接用作素材。`id` 一旦采用应保持稳定，名称与文件可以更新。最大 99 条；只允许本目录文件基名，不接受 URL、斜杠或外部文件路径。PNG poster 必填，动图可选。产品只读取显式清单；目录里未列入的图片会让资源检查失败，不自动猜测或搜索临时目录。

资源预算由 `pnpm -s test:bot-avatar-assets` 验证：最大 256×256；poster 静态 PNG ≤128 KiB；GIF ≤1 MiB、2–48 帧、200ms–10s、无限循环且与 poster 尺寸一致；整个清单 ≤32 MiB。逐文件核对 SHA-256 和字节数。未来增加素材先按上述契约完成来源/版权与人工视觉验收，再更新清单、来源台账和资源检查。不得把“已生成”自动视为“已通过审查”。

## 保存、读取与安全边界

`BotAvatarService` 在当前 SQLite 中使用独立的 `bot_avatar_choices`、`bot_avatar_uploads`、`bot_avatar_animations`、`bot_avatar_preferences` 表。Bot 选择带独立 revision，并校验当前用户与过期保存。没有头像记录的当前格式 Bot 默认为原图标；未知或已移除的内置 ID 也回退。没有改变数据库 schema 版本或旧库清理契约，没有修改 Bot 的模型/授权、消息、记忆、Work 配置及已冻结事项。

只有应用主窗口自身的顶层文档可调用头像 IPC。检查 sender、mainFrame、窗口身份和应用 URL；原生选图与异步解码返回后再次检查。renderer 的导入请求没有 path/URL/原始字节字段，也没有新增通用文件读取或图像协议。私有读取只接受当前用户名下的内容 ID 和明确的 poster/animation variant。

用户上传 PNG/JPEG/GIF/静态 WebP：源文件 ≤2 MiB、普通文件、2048×2048/约4M像素以内；检查扩展名与文件魔数一致，拒绝 SVG、APNG、动态 WebP、符号链接、目录、超限或变化中的文件。GIF 动画另限 256×256、48 帧、10 秒、1 MiB；去除注释、应用/纯文本扩展，保留图像和图形控制块，重建无限循环信息。静态首帧通过既有 Photon Rust/WASM 在专用 Worker 内解码、按 EXIF 转正、缩小并重新编码 PNG。主进程和 Worker 在加载解码器前校验容器；头像专用 WASM 线性内存实际限制为 128 MiB，V8 堆限制另算，不当作 WASM 内存约束。最多一个解码 Worker，5 秒超时，结束即销毁；不使用浏览器窗口、模型、网络或新图形框架。

上传内容仅写入 `~/.mybuddy/bot-avatars/<user-hash>/`，目录 0700、文件 0600（Windows 按既有用户目录权限边界，尚未实机验证 ACL）。最多 32 个本地头像，内容寻址；GIF 同时保存私有 PNG poster 和清理后的 GIF。没有把源路径、图片或副本放入聊天附件、模型上下文、资料库、远程服务或网关。删除本地头像会清空使用它的个人 Bot 选择并恢复默认。显式重新添加可以修复损坏的应用自有普通缓存文件，拒绝跟随替换后的链接。

## 动画与界面

统一组件用于 Bot 列表、个人对话标题、消息作者、协作摘要、双方协作详情和收件记录，按 Bot ID 读取同一选择；原有名称文本与无障碍名称保留。

列表、消息、选择器及协作记录固定用 PNG。只有当前个人 Bot 标题允许动画，并要求持久化总开关开启、系统没有 reduced-motion、document 可见、IntersectionObserver 确认可见。不可见时实际替换为 poster，而不是仅用 CSS 隐藏 GIF。没有每行 Canvas/WebGL。私有 GIF 仅在标题需要播放时读入，缓存最多四个；重复头像共享读取。GIF 失败降级 poster，poster 失败保留有名称的图标。图片尺寸固定，静态图 lazy/async 解码。

## 已做验证与实际边界

以下专项已通过（最终结果参见本次交接报告；不等同于全量 532 项 headless 门禁）：

- `pnpm -s typecheck`：web、main 与 scripts 三层无新增错误；`node scripts/test-all.mjs --audit` 分类自检通过。
- `test:bot-avatar-assets`：当前 93 条、186 文件、28,657,002 bytes；类型、闭合路径、哈希、尺寸、循环与预算。
- `test:bot-avatar-containers`：真实 Photon 红灯复现（738 bytes，实际 4096×4096，旧预检误报 128×128），44 个 PNG/GIF/WebP 畸形容器在主进程及 Worker 解码前被拒绝，正常最大尺寸/渐进 JPEG、动画 poster 与实际 WASM memory.grow 上限。见 `docs/bot-avatar-security-review.md`。
- `test:bot-avatar-decoder`：真实生成的 Photon/WASM Worker；自制 PNG/JPEG/WebP/GIF，准确首帧、缩小、并发拒绝、损坏文件和 Worker 退出。
- `test:bot-avatars`：真实临时 SQLite 和私有文件；无头像旧行、两个 Bot 独立选择、版本冲突、PNG/GIF 关闭重开、异用户隔离、路径/魔数/体积/尺寸/链接拒绝、GIF 元数据清理、过期窗口与选图后权限复核、取消、配额、删除与损坏修复。
- `test:bot-avatar-ui`：真实 React 事件/生命周期（LinkeDOM）；保存/切换/失败、添加/删除/再添加、GIF→poster→图标回退、可访问名称、reduced-motion/visibility/observer 信号、99 行静态列表、共享读取、缓存上限、监听器清理。
- 既有 `test:bot-workspace`、`test:bot-create`、`test:bot-create-ui`（30 项 React 创建交互）、`test:bot-settings`、`test:bot-display-groups` 已通过。

云端实际 Chromium 独立预览已人工检查：浅/深色、1180/500 CSS px 无横向溢出、选择与 Bot 切换、总动画开关、重载恢复、列表/消息身份一致；93 款清单已显示；99 行列表动画数为 0、Canvas 数为 0。这个预览使用明确标注的本地接口替身，不能代表真实 Electron IPC/原生选图器。真实文件读取、WASM 解码、SQLite 关闭重开由上面的独立专项验证。截图通过工具检查；浏览器运行环境对共享目录只读，截图写入 `avatars-wide-dark.png` 失败，未声称有持久截图文件。

尚未验证：完整 Electron `pnpm dev` 与原生选图器联调、Windows/macOS/Linux 桌面全部行为、真实系统 reduced-motion 与窗口最小化（信号行为已测试）、完整产品构建/asar 中 Worker 与 WASM、发行包、全量 headless/GUI/NETWORK 套件。没有运行 build/pack/dist。独立可选 `test:bot-avatar-browser` 使用 Playwright 和本地 HTTP + 真 SQLite/Worker，留给具备浏览器运行条件的环境；云端代码容器没有可用 Unix socket/桌面，自动浏览器启动未完成，不记为通过。浏览器所在环境另用仅绑定 127.0.0.1 的静态预览服务完成人工检查。

## 与本地并行修改协调

以下共享文件只需窄合入，不应覆盖本地整份文件：

- `AgentService.ts`：头像服务 import、字段与初始化三处，不触及 Work 服务逻辑。
- `src/main/index.ts`：头像 IPC、原生 picker 和 decoder 接线；`src/preload/index.ts` 与 `src/shared/bot-work-ipc.ts`：一个类型化头像方法。
- `BotWorkspacePage.tsx`：头像组件/设置 import，标题和消息图标替换，身份设置里挂载选择器；保留本地的 Work 详情与导航/编排差异。
- `BotDisplayGroups.tsx`、`BotCallThread.tsx`、`BotCollaborationView.tsx`：以 Bot ID 替换身份位置的通用图标。
- `electron.vite.config.ts`：增加头像 Worker 资产发射；`package.json`：新测试脚本和 Worker 的 asarUnpack 项；`scripts/test-all.mjs`：5 个 headless、1 个 NETWORK 分类。

`global.css`、`BotWorkspacePage.css`、Work 详情和编排文件没有修改。其余头像源码、局部 CSS、资源、来源台账和测试均为新增。集成时保留既有 `image-resize-worker.js` 与 `photon_rs_bg.wasm` 资产。本功能复用现有 Photon 依赖的代码，但单独发射 `bot-avatar-photon.wasm`：只限制其 wasm32 memory section 的 maximum 为 128 MiB，不修改共享 Pi WASM。头像 Worker 与这份 WASM 都须列入 asarUnpack。构建器在 WASM 布局或加载器不符合预期时失败，不退回无限内存的共享文件。首次授权完整构建后需执行原有 ARTIFACT/打包 payload 门禁，并在原生 `pnpm dev` 中验收 picker 与动画开关。
