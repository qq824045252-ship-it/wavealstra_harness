# DeepSeek API 接入

MyBuddy 的 DeepSeek 接入包含独立工具 API 和模型原生能力两部分。独立工具可以供其他厂商的聊天模型调用；模型原生能力使用模型设置中的 DeepSeek 身份。

## 设置独立工具

1. 打开「设置 → 工具能力」，在「API 服务」点击「添加 DeepSeek」，填写 API Key。也可以从「联网搜索 → DeepSeek 服务」直接添加。
2. 为「语音转文字」「图片文字识别」「文字转语音」选择该服务。DeepSeek 的这些接口不需要模型名。
3. 展开「联网搜索」，将供应商选为 DeepSeek；需要使用原生网页读取时，将「网页读取服务」选为 DeepSeek。
4. 保存后在新会话中使用工具。配置检查不发送测试文件，不代表已完成实际推理。

只有一个 DeepSeek 连接时，搜索可自动引用它；有多个时须明确选择。连接和密钥由现有能力配置与凭据管理保存，搜索配置只保存连接 ID。更换或清除密钥会影响所有引用该连接的工具。搜索依赖新连接时，设置页先保存连接与密钥，再保存搜索引用；失败的草稿保留以便重试。

| 功能 | 工具 | 行为 |
| --- | --- | --- |
| 网页搜索 | `web_search` | 调用 `/v1/tools/search`；支持原问题、站点和时间过滤，保留来源及站点信息 |
| 网页读取 | `fetch_content` | 调用 `/v1/tools/fetch`，把返回 Markdown 存入现有原文检索流程 |
| 文档 OCR | `ocr` | 调用 `/v1/tools/ocr`；图片、PDF、DOC/DOCX、PPT/PPTX；保留页次、识别方式和不完整页标记 |
| 语音识别 | `speech_to_text` | 调用 `/v1/tools/asr`；PCM16 WAV / Ogg Opus；保留转写文字与音频时长 |
| 语音合成 | `text_to_speech` | 调用 `/v1/tools/tts`；Stella / Tide 音色，生成可播放的 WAV 附件 |

### 搜索与网页读取

- `web_search` 可以使用单源、按顺序失败回退或多源并行等现有搜索模式，主聊天模型不必是 DeepSeek。
- 查询按 Unicode 字符计数，连同站点、日期运算符最多 128 个字符。原生适配器接受 1–50 条；统一搜索聚合器仍沿用每家最多 20 条的现有结果保留策略。
- 返回的 `snippet`、供应商 `summary` 和页面 `content` 分别保留。供应商摘要不作为网页原文，也不作为独立核验结果。
- DeepSeek Fetch 是可选择的页面读取服务。已打开的同页浏览器正文优先；raw 响应、GitHub 仓库、PDF、图片、视频等保留原有专用处理路径。
- 工具执行读取当前连接配置。明确选择的连接失效时返回配置错误；身份错误、缺失 Key 和用户取消不会被当成配额失败来切换供应商。

### OCR 与语音

- `ocr` 接受 `file_path`，原有 `image_path` 继续可用；同时传入不同路径会报错。
- OCR 有 `text_recognition` 和 `rich_layout_recognition` 两种模式。结果按页返回；`finish_reason: length` 标记为不完整，不能当成完整文档。正文中的归一化版面坐标保持原样，不转换成图片像素坐标或桌面点击坐标。
- OCR 输入最多 100 MiB、服务端最多 1,000 页。新建 DeepSeek 连接默认等待 180 秒。客户端停止等待后，已被服务端接收的识别仍可能完成并计费。
- ASR 输入最多 8 MiB、120 秒，验证实际 WAV / Opus 容器。双声道音频只识别左声道。自动识别语言，不发送 `model`、语言或提示词字段。
- TTS 使用 `stella` 或 `tide`，单次最多 10,000 个计费字符，汉字计两个。当前实现输出 WAV；不提供语速、MP3、Ogg 或 WebSocket 实时播放选项。切换到 DeepSeek 会清除其他服务留下的音色和语速。
- 传输失败、取消、明确的 WAV 截断及不完整 PCM 样本不会生成成功音频。未知长度的流式 WAV 在正常 EOF 时无法独立证明服务端已合成全部预期文字。

## 设置模型原生能力

在「设置 → 模型」中编辑官方 DeepSeek 的 `deepseek-flash`，使用 Chat Completions 协议和 `https://api.deepseek.com`（也接受 `/v1` 根地址）。「DeepSeek 原生能力」提供：

- 允许模型使用 DeepSeek 联网搜索。
- 允许模型使用 DeepSeek 网页读取。
- Bot 对话附件处理：应用默认处理、DeepSeek Files 文档正文、DeepSeek Files 文档正文和插图。

这些开关默认关闭。它们使用模型的 API Key，与「工具能力」中独立工具的共享连接分别管理。原生扩展只在上述官方模型和协议组合生效；其他协议或网关继续使用原来的普通对话路径。

### 原生联网与多轮对话

Pi 1.5 继续负责流解析、普通函数调用、推理与取消。原生适配器通过现有 hooks 添加 `deepseek_web_search` / `deepseek_read_url`，保存服务端操作、引用及网页签名。

服务端操作只作为执行记录展示，不作为本地函数再次执行。网页签名在同模型、同服务及同凭据身份的后续请求中原样回传，避免对话看似成功却丢失先前读过的网页。界面显示来源链接；加密签名留在内部对话数据中。

当前模型目录复用项目已固定的 Pi 版本。视觉输入能力由该目录决定，不用模型名称猜测图片生成能力。

### Files 附件

启用 Files 后，受支持的 Bot 附件先上传至 `/files`，得到解析成功的 `file_id` 后再发起聊天请求：

- PDF、Word、PowerPoint 使用所选的正文或正文加插图解析模式。
- 支持的图片、纯文本、表格、电子书使用 `user_data`。
- 仅处理应用已保存的用户附件；提示词里出现的任意路径不会触发上传。
- 沿用应用现有附件大小限制。文件内容摘要用于确认保存副本未变化。
- 上传时设置服务端副本保留 24 小时。进程内按服务、凭据、文件内容与解析模式复用有效 `file_id`；重启后可从保存副本重新上传，可能再次产生解析费用。

独立 OCR 返回识别结果，不创建 Files 文件；Files 的解析结果用于模型输入，两条路径分别使用各自接口。

## 验证入口

以下套件使用隔离存储、真实应用调用链和确定性 HTTP / SSE 夹具，不需要真实 DeepSeek Key：

```sh
pnpm -s typecheck
pnpm -s test:deepseek-connection
pnpm -s test:deepseek-search
pnpm -s test:deepseek-media-provider
pnpm -s test:deepseek-media-integration
pnpm -s test:deepseek-native
pnpm -s test:deepseek-model-settings-ui
pnpm -s test:media-capabilities-dom
pnpm -s test:all:audit
```

真实 Electron 窗口交互另运行 `pnpm -s test:media-capabilities-ui`，需可用图形会话。DOM 或协议夹具通过不代表已进行真实付费 API 调用或桌面发行包验收。

## 官方协议依据

- [应用 API 总览](https://api-docs.deepseek.com/guides/build_a_chatbot/)
- [Search & Fetch](https://api-docs.deepseek.com/guides/search/)
- [OCR](https://api-docs.deepseek.com/guides/ocr/)
- [Speech to Text](https://api-docs.deepseek.com/guides/asr/)
- [Text to Speech](https://api-docs.deepseek.com/guides/tts/)
- [Web Tools](https://api-docs.deepseek.com/guides/web_tools/)
- [Files API](https://api-docs.deepseek.com/guides/files_api/)
- [File Parsing](https://api-docs.deepseek.com/guides/document_parsing/)
- [Vision](https://api-docs.deepseek.com/guides/vision/)
