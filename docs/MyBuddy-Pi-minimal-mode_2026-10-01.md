# MyBuddy · 代码模式「最小模式」与隐藏 Code Mode 状态验收

记录时间（UTC）：2026-10-01T11:13:50.760Z

## 结果

1. Code Mode 的实际状态提示已从欢迎页和聊天页隐藏；后台仍保留只读诊断状态，不影响代码模式自动启用。
2. 代码开发新增 Tag：**最小模式**（id=`minimal`），在 coding Tag 列表中固定排第一。即使用户自定义 Tag 原先排在前面，读取时仍把 minimal 放到第一位。
3. 最小模式不定义 `promptAddon`、SkillPolicy、MCP Policy、模型/权限建议、专家或 runtime 要求，因此它不会增加任何 **Tag 场景提示词**。代码开发基础 Mode 的系统配置仍然存在；“无提示词”指这个 Tag 自身不额外注入提示。
4. coding 原默认仍为 **修 Bug（bugfix-test）**，本次只增加第一项，不擅自改变默认选择。

## 旧配置迁移

ModeProfileStore 原有的 seed 合并逻辑继续使用：已经存在的 coding policy.json 会自动补入 minimal，不覆盖用户自定义 Tag。`sanitizeModePresets` 额外保证 minimal 固定第一，其余 seed 顺序稳定，用户自定义项保留。

## 测试

- 完整回归：**41/41 套件通过**，且前后源码指纹一致。
- 新功能契约：8 项通过，覆盖第一顺序、无 prompt/policy、旧 policy 自动补齐、最小 Tag 不产生 modePreset 段、修 Bug 对照仍产生提示段。
- UI 隐藏契约：3 项通过。
- 既有 Mode Preset 测试：183 passed / 0 failed。
- Preset Editor：56 passed / 0 failed。
- typecheck、remote:typecheck、desktop build、remote build、免安装打包均通过。

### 实际新包 + 真实模型任务

真实模型：commandcode/deepseek/deepseek-v4.1-flash。两个任务都从真实欢迎页进入“代码开发”，通过页面 Tag 选择，使用 Pi 原生 Code Mode + fixture MCP 读取随机数据并写回结果。

| 任务 | 保存 Tag | 状态提示 | 运行时提示快照 | 结果 |
|---|---|---|---|---|
| minimal-no-prompt | minimal | 欢迎页/聊天页均不可见 | 无 modePreset 段、无“最小模式”提示 | 通过 |
| bugfix-prompt-control | bugfix-test | 欢迎页/聊天页均不可见 | 有 modePreset 段、有“修 Bug”提示 | 通过 |

最小模式任务实际调用 Code Mode 4 次；随机 nonce/求和结果由测试程序直接回读校验，不依赖模型自述。渲染器错误：0；隔离测试配置/凭据已清理。

## 免安装包

    C:\Users\servi\Documents\GitHub\wavealstra_harness\release-pi-minimal-mode-20261001110418533\win-unpacked\MyBuddy.exe

app.asar SHA-256：`ea506fdb621ceab22a39c64dfe72f433dfaa7143470593e85ebfe2109e1bc09f`

本次未替换正在运行的用户实例；以上包是实际验收包。

## Git

- `96aa546afd7eb791cba315a86cff8de561e68cf2` — fix(remote): hydrate external task mode metadata
- `be2f69c63d90236955af943374122370a20f9ff0` — feat(coding): add minimal no-prompt tag and hide Code Mode status

未 push。
