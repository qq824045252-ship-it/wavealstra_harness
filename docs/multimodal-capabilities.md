# 语音、识别与媒体服务

设置中的五项能力共用服务连接、密钥管理和能力绑定。工具仍由 Pi 1.3.0 调用，不新增代理执行循环。

## 支持的接入方式

| 能力 | 服务与接口 | 结果 |
| --- | --- | --- |
| 语音转文字 | 本机 Whisper；已有 HTTP ASR；OpenAI 形状 `/audio/transcriptions`；Magpie 音频路由 | 正文与服务实际返回的可选语言、分段 |
| 图片文字识别 | 已有 JSON OCR；OpenAI 形状视觉 `/chat/completions`；Mistral `/ocr` | 文字；旧 JSON OCR 可保留真实位置框，视觉和 Mistral 适配器不伪造文字框 |
| 文字转语音 | OpenAI 形状或 Magpie `/audio/speech` | 实际 MP3、WAV 或 Ogg/Opus 音频文件 |
| 图片生成 | 本应用 Codex OAuth；OpenAI 形状或 Magpie `/images/generations`、`/images/edits` | 下载并登记的图片产物，保留真实格式 |
| 视频生成 | OpenAI 形状或 Magpie `/videos`、`/videos/{id}`、`/videos/{id}/content` | 可恢复的远端任务与下载后登记的视频产物 |

“OpenAI 兼容 API”指对应能力的请求协议。只支持聊天接口的网关不因此具备音频或媒体生成能力。普通 API 连接不推测模型名称，模型与音色由使用者填写，服务端负责最终验证权限和参数。TTS 当前消费文件音频，不把 SSE 或厂商 JSON 当音频保存，也不覆盖 Realtime 协议。

一个 API 连接可被多项能力复用。API 地址是根地址，通常以 `/v1` 结尾；旧识别服务继续使用其完整请求地址。密钥只保存在主进程系统凭据库：留空保留，替换或移除是明确动作。设置保存使用版本校验；凭据更新或文件写入失败会恢复已更改的密钥，恢复失败会明确报告。

## 内置 Provider 预设（不限于 OpenRouter）

同一套能力选择器提供多个已映射协议的 Provider，额外保留自定义 OpenAI 兼容网关；本机 NPU/Whisper 只有检测到对应运行时才显示为可用服务，不作为所有设备的前提。

| Provider 预设 | 语音转文字 | OCR | 文字转语音 | 图片生成 | 视频生成 |
| --- | --- | --- | --- | --- | --- |
| OpenRouter（公共入口） | ✓ | 视觉 OCR | ✓ | ✓ | ✓ |
| OpenAI 原生 API | ✓ | 视觉 OCR | ✓ | ✓ | —（旧视频接口已停用） |
| Groq | ✓ | 视觉 OCR | ✓（Orpheus / WAV） | — | — |
| Google Gemini OpenAI 兼容接口 | — | 视觉 OCR | — | — | — |
| Mistral 专用 OCR | — | ✓ | — | — | — |
| Magpie（已有连接） | 依网关目录 | — | 依网关目录 | ✓ | ✓ |
| Codex（已有登录） | — | — | — | ✓ | — |
| 本机 Whisper | ✓（需已安装） | — | — | — | — |
| 自定义兼容 API | 依服务实现 | 依服务实现 | 依服务实现 | 依服务实现 | 依服务实现 |

✓ 表示代码已接到对应协议入口，不代表当前模型、账户余额或权限一定可用。未知或未实现的能力不能仅凭厂商名展示为已就绪。普通用户通过五项能力中的“添加服务商”选预设，也可自建兼容接口连接。**每个 Provider 连接只需要一个 API Key**；五项能力分别用 `mediaBindings[capability].connectionId` 指向同一连接，各自保存不同的 `model`。从这个连接读密钥时只使用主进程 Keyring 内的 `credentialRef`，renderer 从不接收原始密钥。

- OpenRouter 使用固定的 `https://openrouter.ai/api/v1`，图片 `POST /images`，参考图放 `input_references`，视频异步 `POST /videos` → `GET /videos/{id}` → `GET /videos/{id}/content`，转写 `POST /audio/transcriptions`，语音合成 `POST /audio/speech`，视觉 OCR `POST /chat/completions`。
- OpenRouter 图片、视频、语音合成、语音转写、视觉 OCR 的模型列表分别来自 `/images/models`、`/videos/models`、`/models?output_modalities=speech`、`/models?output_modalities=transcription`、`/models?input_modalities=image&output_modalities=text`。目录只读取模型标识、名称和音色列表，失败时保留原引用，不把任何聊天模型的图片输入能力当作生图能力。
- 视频创建、进度查询与结果下载独立于当前界面选择。账本保留原连接 ID、API 地址、协议、模型及工具调用 ID；密钥轮换后按原服务继续查询。超时、取消或提交结果不明时，不跨 Provider 自动重试付费生成。
- OpenRouter 语音合成模型的 `voice` 与 `model` 绑定，切换模型清除旧音色。当前音频输出适配支持 MP3、WAV、Ogg/Opus；只提供 PCM 的模型尚不在可完整输出范围内，不能把“目录出现”解读为“已实测通过”。Groq 的 Orpheus 预设默认 WAV，并遵守其长度/音色限制。
- OpenAI、Groq、Gemini 的这些预设只展示当前已实现且有官方接口依据的能力，不会因为一个服务宣称 OpenAI 兼容就把不支持的功能伪装成可用。开发者仍可添加自定义连接，由服务端返回来验证具体兼容性。

官方协议： [OpenRouter Images](https://openrouter.ai/blog/tutorials/image-generation/)、[OpenRouter Videos](https://openrouter.ai/blog/tutorials/video-generation-api/)、[OpenRouter ASR](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/)、[OpenRouter TTS](https://openrouter.ai/blog/tutorials/text-to-speech/)、[Groq TTS](https://console.groq.com/docs/text-to-speech)。

## Magpie 与图片默认选择

复用 `models.json` 中的 `providers.magpie` 地址、网关 key 和 headers；Magpie 继续管理上游身份。不会取出其上游 OAuth，也不会复制本应用 Codex OAuth 到 API 连接。

Magpie 协议核验基于官方仓库 [`yetone/magpie@f8987ce6173abacf503fb97f9bb36f63225c1824`](https://github.com/yetone/magpie/tree/f8987ce6173abacf503fb97f9bb36f63225c1824)：

- [`internal/gateway/gateway.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/gateway.go)：`GET /v1/models?kind=image,video` 返回明确的媒体模型；`GET /v1` 宣告路由。聊天模型的图片输入能力不用于推断生图能力。
- [`draw.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/draw.go) 与 [`video.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/video.go)：图片生成/编辑、视频创建/进度/内容接口。
- [`transcribe.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/transcribe.go) 与 [`speech.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/speech.go)：文件转写与语音合成。Magpie 没有 `kind=audio` 目录，音频模型需明确填写网关支持的 `provider/model`。

实际目录查询只发送 GET，不发送样本，也不试生成。缓存按网关地址和身份摘要隔离；同地址更换身份后不会沿用另一身份的目录。

新配置的图片绑定默认是“自动”。首次发现候选时，主模型提供方为 Magpie 则优先 Magpie，否则优先已登录 Codex；同一目录中的候选模型按 ID 稳定排序。确定后保存连接和模型，不因登录顺序、刷新、退出或请求失败换到另一家。显式关闭不被自动开启。已有 schema-v1 配置保留原选择，用户可主动改成自动。

## 百度智能云 OCR（新增原生 Provider）

现在可在 **OCR → 服务 → 添加服务商 → 百度智能云 OCR** 中直接选择，四种模式为：
- `general_basic`：通用识别，仅返回文字；
- `general`：通用识别，包含真实位置框；
- `accurate_basic`：高精度识别，仅返回文字；
- `accurate`：高精度识别，包含真实位置框。

百度 OCR 使用固定官方 HTTPS 地址 `https://aip.baidubce.com`，不是 OpenAI 兼容接口。用户填写 **API Key** 和 **Secret Key**，密钥分别保存在主进程系统凭据库，通过两个独立 `credentialRefs` 引用；原有单密钥连接的 `credentialRef` 保持不变。配置仍是 schema v1，`mediaBindings.ocr.model` 保存识别模式 ID，`connectionId` 保存连接身份。不会把 Key 或 Token 放进配置、renderer、生成结果或日志。

主进程使用 `POST /oauth/2.0/token` 换取 Access Token，只在内存缓存并提前刷新；识别调用向 `POST /rest/2.0/ocr/v1/{mode}` 提交 `application/x-www-form-urlencoded` 的 Base64 图片。当前支持任务目录内的 PNG/JPEG 文件，并执行编码大小、响应大小、超时、取消与图片文件边界检查；Token 明确失效时仅刷新并重试一次，额度错误不自动重试。标准/高精度含位置模式会把真实 `words_result[].location` 转换成现有 `OcrResult.boxes`，未返回坐标时不伪造。

首次使用不依赖本机 NPU；仍可在本机、Mistral、OpenRouter、旧 HTTP OCR 和百度间自由选择。保存时一次更新两项密钥及其引用，失败执行回滚；配置检查不会上传文件。**旧 `local-only` 策略不因选择百度自动放宽**，切换 Provider 不会静默上传。需在百度云后台开通相应识别接口及额度。

官方接口参考：[百度 OCR 调用方式](https://ai.baidu.com/ai-doc/OCR/Ck3h7y2ia)、[百度 OCR 错误码](https://ai.baidu.com/ai-doc/OCR/dk3h7y5vr)、[含位置高精度识别](https://ai.baidu.com/ai-doc/OCR/tk3h7y2aq)。

## 配置兼容与隐私

`capabilities.json` 保持 schema v1，新增可选 `connections` 和 `mediaBindings`。现有 `services`、`serviceId`、provider、凭据引用以及禁用偏好保留。已注册的自定义 provider 继续可用；未注册的原选择仍可见，不再提供填写任意 Adapter ID 的普通表单。

连接地址为 loopback 只说明第一跳在本机，不保证服务后续离线。ASR/OCR 正文会进入当前对话。旧服务的 `local-only` 限制继续阻止上传和进入代理历史；切换服务不会自动放宽能力绑定的限制。新绑定只有明确选择允许对话处理后才解除自身限制。

状态“已配置，未试用”与实际成功使用分开。配置检查不冒充模型、额度或结果已验证。默认配置、打开页面、展开详情、刷新目录都不产生媒体生成请求。

## 视频任务恢复

`video-generation-jobs.json` 在提交前原子保存意图，收到响应后保存远端 ID、原连接地址和协议、模型、所属任务和工具调用。账本不保存密钥、完整 prompt 或参考图。

1. 已接单的任务超时、停止等待或下载失败时，返回本地 `job_id`。
2. 在原任务中调用 `video_generate({ "job_id": "video-…" })`，只恢复原服务查询/下载，不再提交生成。即使当前服务选择已改变或清空，恢复仍按账本选路。
3. 恢复需要原连接仍存在且地址和协议一致；凭据可以正常轮换。跨任务恢复、携带新的生成参数、关闭能力都会被拒绝。
4. 停止本地等待不等于取消远端任务。服务已收到请求但响应丢失时记录 `submission-unknown`，不会假称已取得远端 ID，也不会自动重试付费提交。
5. 产物落盘失败仍提供恢复编号；回滚不完整时保留残留路径与 Artifact ID，先处理残留再恢复，避免重复产物。

设置页的视频详情可只读查看最近任务编号和状态。不会因为打开设置而自动恢复、下载或生成。

## 验证命令

```sh
pnpm -s test:baidu-ocr
pnpm -s test:media-capability-config
pnpm -s test:media-provider-presets
pnpm -s test:openrouter-capabilities
pnpm -s test:magpie-capabilities
pnpm -s test:unified-media-adapters
pnpm -s test:media-capability-services
pnpm -s test:media-capability-extension
pnpm -s test:media-capabilities-dom
pnpm -s typecheck
pnpm -s build
pnpm -s test:all
```

实际 Electron 组件门禁：`pnpm -s test:media-capabilities-ui`。使用隔离 profile、生产全局 CSS 和真实组件，检查五项统一表单、保存/刷新竞态、凭据与旧配置、窄屏和主题布局；截图写入 `out/tests/media-capabilities-screenshots`。它归类为 GUI，并在 Windows CI 的独立步骤执行，不混进无头套件。完整应用流程仍由 `test:local-capabilities-electron` 及原有 Windows GUI/打包验收覆盖。
