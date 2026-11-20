# DeepSeek API 接入

MyBuddy 的 DeepSeek 接入包含独立工具 API 和模型原生能力两部分。独立工具可以供其他厂商的聊天模型调用；模型原生能力使用模型设置中的 DeepSeek 身份。设置入口与 OpenRouter 等服务商统一，参见[统一 API 服务设置](./api-service-settings.md)。

## 设置独立工具

1. 打开「设置 → 工具能力 → API 服务」，在统一的「服务商」下拉框选择 DeepSeek，点击「添加 API 服务」，填写 API Key。OpenRouter 等服务商使用同一入口，没有独立的 DeepSeek 添加按钮或页面。
2. 为「语音转文字」「图片文字识别」「文字转语音」选择该服务。DeepSeek 的这些接口不需要模型名。文字转语音默认使用「实时播放（WebSocket）」，也可选择「生成后播放（HTTP WAV）」。
3. 展开「联网搜索」，将供应商选为 DeepSeek；在「搜索 / 网页服务连接」引用已有 API 连接。需要使用原生网页读取时，将「网页读取服务」选为 DeepSeek。
4. 保存后在新会话中使用工具。配置检查不发送测试文件，不代表已完成实际推理。

只有一个 DeepSeek 连接时，搜索可自动引用它；有多个时须明确选择。连接和密钥由现有能力配置与凭据管理保存，搜索配置只保存连接 ID。更换或清除密钥会影响所有引用该连接的工具。搜索依赖新连接时，设置页先保存连接与密钥，再保存搜索引用；失败的草稿保留以便重试。

| 功能 | 工具 | 行为 |
| --- | --- | --- |
| 网页搜索 | `web_search` | 调用 `/v1/tools/search`；支持原问题、站点和时间过滤，保留来源及站点信息 |
| 网页读取 | `fetch_content` | 调用 `/v1/tools/fetch`，把返回 Markdown 存入现有原文检索流程 |
| 文档 OCR | `ocr_file` | 调用 `/v1/tools/ocr`；图片、PDF、DOC/DOCX、PPT/PPTX；保留页次、识别方式和不完整页标记 |
| 语音识别 | `speech_to_text` | 调用 `/v1/tools/asr`；PCM16 WAV / Ogg Opus；保留转写文字与音频时长 |
| 语音合成 | `text_to_speech` | 通过 WebSocket 边合成边播放，或通过 HTTP 生成 WAV；Stella / Tide 音色，两种方式都保存音频文件 |

### 搜索与网页读取

- `web_search` 可以使用单源、按顺序失败回退或多源并行等现有搜索模式，主聊天模型不必是 DeepSeek。
- 查询按 Unicode 字符计数，连同站点、日期运算符最多 128 个字符。原生适配器接受 1–50 条；统一搜索聚合器仍沿用每家最多 20 条的现有结果保留策略。
- 返回的 `snippet`、供应商 `summary` 和页面 `content` 分别保留。供应商摘要不作为网页原文，也不作为独立核验结果。
- DeepSeek Fetch 是可选择的页面读取服务。已打开的同页浏览器正文优先；raw 响应、GitHub 仓库、PDF、图片、视频等保留原有专用处理路径。
- 工具执行读取当前连接配置。明确选择的连接失效时返回配置错误；身份错误、缺失 Key 和用户取消不会被当成配额失败来切换供应商。

### OCR 与语音

- `ocr_file` 接受 `file_path`，原有 `image_path` 继续可用；同时传入不同路径会报错。
- OCR 有 `text_recognition` 和 `rich_layout_recognition` 两种模式。结果按页返回；`finish_reason: length` 标记为不完整，不能当成完整文档。正文中的归一化版面坐标保持原样，不转换成图片像素坐标或桌面点击坐标。
- OCR 输入最多 100 MiB、服务端最多 1,000 页。新建 DeepSeek 连接默认等待 180 秒。客户端停止等待后，已被服务端接收的识别仍可能完成并计费。
- ASR 输入最多 8 MiB、120 秒，验证实际 WAV / Opus 容器。双声道音频只识别左声道。自动识别语言，不发送 `model`、语言或提示词字段。
- TTS 使用 `stella` 或 `tide`，单次最多 10,000 个计费字符，汉字计两个。应用保存 WAV；不提供服务端不支持的语速、MP3 或 Ogg 选项。切换到 DeepSeek 会清除其他服务留下的音色和语速。
- WebSocket 请求使用 `wss://api.deepseek.com/v1/tools/tts`，发送 Unicode 边界完整的文本块及 `finish_text`，接收 24 kHz、16 位、单声道 PCM。主进程通过认证头连接；密钥、音频帧不进入聊天记录或模型上下文。
- 只有服务端返回 `finish / success` 且 WAV 保存成功，才完成语音调用。断开连接、超时、服务端错误、取消及不完整 PCM 不作为成功；已开始音频的请求不会自动改用 HTTP 重发。
- HTTP 继续验证 WAV 容器与样本完整性。未知长度的 HTTP WAV 在正常 EOF 时无法独立证明服务端已合成全部预期文字；需要明确的完成信号时选择 WebSocket。

### 对话中的结果与播放

普通任务和 Bot 对话复用同一组结果卡片：

- **语音合成**：开始实时试听、暂停、继续和停止试听；可单独取消语音生成。停止试听不会取消仍需保存的音频。音频保存后可使用常规播放器重播、拖动进度或下载。
- **文件识别**：按页折叠、页码、识别方式、完整性提示和复制文本。被截断的页面明确标记为未完整返回。
- **音频转写**：显示转写文字、时长、语言、可用分段时间，以及 DeepSeek 双声道输入采用左声道的说明。
- **联网搜索与原生托管操作**：显示实际进度和来源卡片；供应商摘要与网页原文分别标示，原生引用保留对应的回答摘录。

实时声音由用户在对应卡片点击播放后开始；切换页面或隐藏窗口会停止或暂停播放。播放器按请求、消息、工具调用和流 ID 隔离。已播放 PCM 及时释放；暂停过久或尚未播放导致缓冲达到上限时，显示实时试听不可用，合成继续进行，完成后仍可播放完整 WAV。原始 PCM 不持久保存。

Bot 前台可直接使用已启用的 OCR、转写和 TTS，无需先建立后台任务。文件输入限于当前工作目录和宿主保存、在当前对话中引用的附件副本，所有适配器使用同一边界。跟进先前附件时复用该对话的冻结来源，不把其他 Bot 的私人历史附件自动加入范围。

工具卡片、文件关联和当前请求的状态会持久保存；重开对话可恢复最终结果。取消或异常终止后不会保留运行中的转圈状态。普通任务通过 Code Mode 发起的嵌套调用也保存结构化结果，不能只剩参数预览或一行成功文字。

## 设置模型原生能力

在「设置 → 模型」中编辑官方 DeepSeek 的 `deepseek-flash`。支持以下协议与根地址组合：

| 协议 | API 根地址 |
| --- | --- |
| Chat Completions | `https://api.deepseek.com` 或 `https://api.deepseek.com/v1` |
| Responses | `https://api.deepseek.com` 或 `https://api.deepseek.com/v1` |
| Anthropic Messages | `https://api.deepseek.com/anthropic` |

统一的「模型原生能力」区域按适配器声明提供：

- 允许模型使用服务端联网搜索。
- 允许模型使用服务端网页读取。
- Bot 对话附件处理：应用默认处理、原生文件接口文档正文、原生文件接口文档正文和插图。

这些开关默认关闭。它们使用模型的 API Key，与「工具能力」中独立工具的共享连接分别管理。原生扩展只在上述官方模型和协议组合生效；其他模型或网关继续使用原来的普通对话路径。统一表单不会把 DeepSeek 的专属协议能力自动赋予 OpenRouter 或其他服务商。

### 原生联网与多轮对话

Pi 1.5 继续负责流解析、普通函数调用、推理与取消。原生适配器通过现有 hooks 添加 `deepseek_web_search` / `deepseek_read_url`，保存服务端操作、引用及网页签名。

服务端开始搜索或读取时，界面即更新执行记录，无需等待正文出现。服务端操作不作为本地函数再次执行。网页签名在同模型、同服务及同凭据身份的后续请求中原样回传；Responses 的原始输出项和 Messages 的原始内容块完整保留，包括普通函数调用关联。界面只接收派生的进度、来源链接及回答摘录；加密签名留在内部对话数据中。

当前模型目录复用项目已固定的 Pi 版本。视觉输入能力由该目录决定，不用模型名称猜测图片生成能力。

### Files 附件

启用 Files 后，受支持的 Bot 附件先上传至 `/files`，得到解析成功的 `file_id` 后再发起聊天请求：

- PDF、Word、PowerPoint，以及需文档解析的 BMP/TIFF 使用所选的正文或正文加插图解析模式。
- 支持的图片、纯文本、表格、电子书使用 `user_data`。
- 仅处理应用已保存的用户附件；提示词里出现的任意路径不会触发上传。
- 沿用应用现有附件大小限制。文件内容摘要用于确认保存副本未变化。
- 上传时设置服务端副本保留 24 小时。上传回执保存在宿主附件旁，仅含不透明文件 ID、过期时间及身份摘要；不保存 API Key 或原文。应用重启后可继续复用尚未过期的 ID。
- 复用按服务、凭据、文件内容及解析模式隔离，每次先确认附件副本的实际字节未变化；即将过期的 ID 不再引用。同一文件的并发上传合并，取消一个等待者不会中断其他仍在等待的请求。
- 对话展示准备、上传解析、已复用、已就绪或错误状态。上传中断时明确提示服务端可能仍在处理，不立即盲目重传。服务端结果已到达但本地回执无法保存时会提示下次重启可能需要重新上传。

三种协议分别使用各自的文件引用格式；Messages 自动附加 Files 所需的 beta 头。本功能处理对话附件的生命周期，不提供独立的云端文件列表或删除管理器。

独立 OCR 返回识别结果，不创建 Files 文件；Files 的解析结果用于模型输入，两条路径分别使用各自接口。

## 验证入口

以下套件使用隔离存储、真实应用调用链和确定性 HTTP / SSE / WebSocket 夹具，不需要真实 DeepSeek Key：

```sh
pnpm -s typecheck
pnpm -s test:deepseek-connection
pnpm -s test:deepseek-search
pnpm -s test:deepseek-media-provider
pnpm -s test:deepseek-media-integration
pnpm -s test:deepseek-tts-stream
pnpm -s test:deepseek-native
pnpm -s test:deepseek-model-settings-ui
pnpm -s test:capability-conversation
pnpm -s test:speech-stream-player
pnpm -s test:capability-result-dom
pnpm -s test:web-artifact-runtime
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