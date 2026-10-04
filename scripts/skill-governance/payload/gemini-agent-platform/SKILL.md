---
name: gemini-agent-platform
description: "Call Gemini Enterprise/Vertex AI/Google Agent Platform, or an explicitly requested Gemini-specific API/image model. Use only for explicit Google/Gemini API requests; generic images use native image_generate and explicit CheaperInference uses cheaper-inference-image."
---

# Gemini Enterprise / Vertex AI

## Intent / Boundary

通过明确指定的 Google/Gemini API 完成文本、多模态或图像请求。普通生图走 MyBuddy native image_generate；明确 CheaperInference 走 cheaper-inference-image，即使模型来自 Google 也不改变该路由。

## Workflow

1. 确认供应商、端点、模型、输入文件和输出目录；未指定的普通生图不触发本 Skill。
2. 运行 tools/gemini_ap.mjs；Node 直接构造 JSON、fetch 请求、解码图片，不启动 PowerShell。
3. 配置优先级为 CLI（模型/项目/区域）→ 进程环境 → Windows 用户环境 → config.env。只读取指定 Gemini 变量；不打印或提交密钥。
4. 输入图像必须存在；API 返回失败或没有期望图像时返回非零，不静默换模型/供应商。
5. 检查产物格式、尺寸、文件非空及内容是否符合请求；输出路径按实际 MIME 扩展名保存，多图加序号，已有文件不覆盖。

## Git Bash examples

```bash
SKILL_DIR="$HOME/.mybuddy/skills/gemini-agent-platform"
node "$SKILL_DIR/tools/gemini_ap.mjs" --prompt '用一句话解释强化学习'
node "$SKILL_DIR/tools/gemini_ap.mjs" --endpoint developer --prompt '图里有什么？' --image-path 'C:/data/input.png'
# 模型须来自当前配置或已核实的 Google 模型 ID
node "$SKILL_DIR/tools/gemini_ap.mjs" --model "$GEMINI_AP_MODEL" --prompt 'A blue microphone icon' --generate-image --out-image './icon.png'
```

环境变量：Agent Platform 用 GEMINI_AP_API_KEY、GEMINI_AP_PROJECT，区域 GEMINI_AP_LOCATION 默认 global，模型 GEMINI_AP_MODEL；Developer 用 GEMINI_API_KEY 和 GEMINI_DEV_MODEL。config.env 格式参照 config.env.example，不要把真实 key 写入文档。

## Parameters / Output Contract

--prompt 必填；--endpoint 为 agentplatform（默认）或 developer；--model/--project/--location 覆盖配置；--system-instruction、--temperature、--top-p、--top-k、--max-output-tokens 控制生成；--image-path 添加输入图。

--generate-image 声明 TEXT/IMAGE；--aspect-ratio 传给 API（允许值取决于模型，不能承诺任意尺寸都支持）；--out-image 控制文件路径；--resize N 可选用 uv/Pillow 将输出另存 NxN，原图保留。--raw 只输出原始 JSON，不保存图片。旧 --size 是未实现参数，现在明确拒绝，尺寸要求写 prompt 或使用 --resize。

交付文本或真实图片绝对路径、实际模型、usage 与验证范围。180 秒超时返回非零；认证/权限失败停止，核对配置与服务端错误，不把 401 简化成固定原因。429/5xx 不无限重试，避免重复计费。不得回显 key 或带 key 的 URL。旧 tools/gemini_ap.ps1 仅保留兼容；默认入口是 .mjs。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
