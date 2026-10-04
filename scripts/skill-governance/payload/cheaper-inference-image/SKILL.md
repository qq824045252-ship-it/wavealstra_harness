---
name: cheaper-inference-image
description: "Generate images through CheaperInference only when the user explicitly selects that provider, a model through that provider, or provider-specific cost/speed/quality comparison. Generic image generation uses MyBuddy native image_generate; explicit Vertex AI uses gemini-agent-platform."
---

# Cheaper Inference 生图

## 快速开始

设置当前 Git Bash 会话的 API key（不回显；持久配置由用户管理）：

```bash
read -rsp "CheaperInference API key: " CHEAPER_INFERENCE_API_KEY
export CHEAPER_INFERENCE_API_KEY
```

### 路径说明

**重要**：脚本位于本技能目录下，需要使用绝对路径或解析技能目录。推荐使用以下方式获取技能目录路径：

```bash
SKILL_DIR="$HOME/.mybuddy/skills/cheaper-inference-image"
```

生成单张图（默认模型 grok-imagine）：

```bash
SKILL_DIR="$HOME/.mybuddy/skills/cheaper-inference-image"
uv run --no-project python "$SKILL_DIR/scripts/generate_image.py" --model grok-imagine --prompt "a red apple on a wooden table, photorealistic"
```

脚本会保存为 `./<model>_<timestamp>.jpg/.png`（相对于当前工作目录），并打印耗时与文件路径。指定输出路径与数量：

```bash
SKILL_DIR="$HOME/.mybuddy/skills/cheaper-inference-image"
uv run --no-project python "$SKILL_DIR/scripts/generate_image.py" --model nano-banana --prompt "..." --out C:/Users/servi/Downloads/img.png --n 2
```

## 模型选择（实测数据，2026-08）

| 模型 | Provider | 速度 | 输出 | 结论 |
|---|---|---|---|---|
| grok-imagine | xAI | ~7-8s，稳定 | JPEG base64（~300KB） | **默认推荐**，快、稳、小 |
| nano-banana | Google | ~11-22s，波动 | PNG（1.5MB+，data URI） | 质量更好，但慢且传输大 |
| gpt-image-2 | OpenAI | 30-45s+，经常 502 | JPEG base64 | 不推荐，上游经常超时（`upstream_error`） |

- 响应既有 `b64_json` 也有 `url`（data URI 或 http），脚本都已兼容。
- base64 使传输体积膨胀约 33%，1.5MB PNG 光传输+解码就占数秒。
- 生图按张计费（约 $0.014-0.09/张），测试时先确认 prompt。

## 错误处理

- `401/403`：key 无效，检查 `CHEAPER_INFERENCE_API_KEY`。
- `502 upstream_error` / 超时：gpt-image-2 常见，换 grok-imagine 或重试。
- 脚本对 5xx 与网络错误自动重试 2 次（间隔 2s），仍失败退出码 2。
- 想先验证 key 而不花钱：`curl.exe -H "Authorization: Bearer $CHEAPER_INFERENCE_API_KEY" https://api.cheaperinference.com/v1/models`

## 相关背景

- Base URL：`https://api.cheaperinference.com/v1`（OpenAI 兼容）。
- 模型清单含 62 个模型，可用 `GET /v1/models` 拉取（`grok-imagine`、`nano-banana`、`gpt-image-2` 为图像模型，type=image）。
- Dim 的「多模态 → 图像生成」设置界面只显示已注册 provider 暴露的模型（如 CheaperInference/gpt-image-2），无法切换 grok-imagine / nano-banana —— 这是 provider 注册限制；本 skill 直接用 API 绕开该界面。

## Routing Boundary

仅明确指定 CheaperInference 或经该服务调用模型/测速/比价时触发。普通画图走 native image_generate；明确 Gemini Enterprise/Vertex AI 走 gemini-agent-platform。模型名相同不意味着供应商相同。

## Workflow / Output Contract

确认指定供应商、模型、输入与输出目录 → 从环境读取密钥 → 用现有 generate_image.py 执行 → 检查退出码、文件非空、实际格式/尺寸与请求是否一致 → 返回绝对文件路径、耗时和实际模型。模型与费用表仅为历史样本，当前可用性读取服务模型列表；不可静默换供应商或模型。认证失败停止；有限重试后仍失败保留错误，不宣称生成成功。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
