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

## Magpie 与图片默认选择

复用 `models.json` 中的 `providers.magpie` 地址、网关 key 和 headers；Magpie 继续管理上游身份。不会取出其上游 OAuth，也不会复制本应用 Codex OAuth 到 API 连接。

Magpie 协议核验基于官方仓库 [`yetone/magpie@f8987ce6173abacf503fb97f9bb36f63225c1824`](https://github.com/yetone/magpie/tree/f8987ce6173abacf503fb97f9bb36f63225c1824)：

- [`internal/gateway/gateway.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/gateway.go)：`GET /v1/models?kind=image,video` 返回明确的媒体模型；`GET /v1` 宣告路由。聊天模型的图片输入能力不用于推断生图能力。
- [`draw.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/draw.go) 与 [`video.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/video.go)：图片生成/编辑、视频创建/进度/内容接口。
- [`transcribe.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/transcribe.go) 与 [`speech.go`](https://github.com/yetone/magpie/blob/f8987ce6173abacf503fb97f9bb36f63225c1824/internal/gateway/speech.go)：文件转写与语音合成。Magpie 没有 `kind=audio` 目录，音频模型需明确填写网关支持的 `provider/model`。

实际目录查询只发送 GET，不发送样本，也不试生成。缓存按网关地址和身份摘要隔离；同地址更换身份后不会沿用另一身份的目录。

新配置的图片绑定默认是“自动”。首次发现候选时，主模型提供方为 Magpie 则优先 Magpie，否则优先已登录 Codex；同一目录中的候选模型按 ID 稳定排序。确定后保存连接和模型，不因登录顺序、刷新、退出或请求失败换到另一家。显式关闭不被自动开启。已有 schema-v1 配置保留原选择，用户可主动改成自动。

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
pnpm -s test:media-capability-config
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
