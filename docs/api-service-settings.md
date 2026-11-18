# 统一 API 服务设置

## 使用

「设置 → 工具能力」先显示统一的 **API 服务** 区。选择服务商（DeepSeek、OpenRouter、OpenAI、Groq、Mistral、百度、FLUX、百炼等，或自定义兼容 API），然后点击同一个「添加 API 服务」按钮。选择下拉项本身不会创建连接，也不会改动已有连接。

连接的名称、协议、地址、认证和密钥沿用同一个编辑器。一个连接可以被多项工具引用，不重复复制 Key。连接详情显示已接入接口和当前使用它的能力；接口已接入不等于账户权限、模型和实际调用都已验证。

语音、OCR、图片、视频继续按能力选择服务和必要的模型。无模型名的工具不显示虚假的模型输入框；专属音色、识别方式和播放方式来自适配器声明。OpenRouter 的模型目录刷新和自定义模型入口保持不变。

「联网搜索」在同一张供应商表内配置和选择：已配置或已选的供应商默认显示，其余从「添加供应商」展开。DeepSeek 在同行复用共享连接和 Key；Tavily、Serper、TinyFish、Brave 沿用各自的独立 Key。自动模式仍可配置供应商，网页读取与请求限制放在高级设置。明确绑定失效时保留选择并提示，不静默换 Key；多个相同协议连接需要明确选择。

配置、已保存的启用状态和当前会话上次实际搜索分开显示。实际搜索来自工具回执，不从勾选或凭据推测；不跨会话读取历史，也不发起额外的 API 请求。

模型编辑器统一使用 **模型原生能力** 区域。只为已实现的原生适配器显示选项；仍按实际模型、协议、地址判定支持。OpenRouter 支持多种模型，不意味着它自动提供 DeepSeek 独立工具或托管工具的协议。

## 实现边界

- `src/shared/api-service-settings.ts`：连接创建默认值、已接入接口、媒体控件和共享网页连接映射。复用 `MEDIA_PROVIDER_PRESETS`，不建立另一份凭据库。
- `ApiServicePicker`：跨工具共享连接创建入口；`SearchSettings`：联网搜索策略和供应商行；`WebServiceSettings`：同行共享连接选择与独立网页读取设置。
- `src/shared/model-native-settings.ts` 与 `NativeCapabilityFields`：由适配器声明的通用模型表单，保留原始 `compat` 字段及其他配置。
- `CapabilitiesTab` 不再包含 DeepSeek 专属 UI 分支。运行时的 DeepSeek/OpenRouter 适配器保持各自协议，不能以统一 UI 为由互相发送不兼容的参数。
- 不更改已保存的连接 ID、凭据引用、模型登录或数据库格式；搜索的现有适配器字段只由统一映射读写。工具连接凭据与模型登录凭据没有在本次重构中强行合并。
- 依赖连接的搜索保存等待连接与凭据保存成功；其他配置仍可独立保存，失败草稿保留。不会增加执行审批或修改 Bot 调度。

## 回归入口

```sh
pnpm -s typecheck
pnpm -s test:deepseek-model-settings-ui
pnpm -s test:media-capabilities-dom
pnpm -s test:deepseek-connection
pnpm -s test:deepseek-search
pnpm -s test:deepseek-media-provider
pnpm -s test:openrouter-capabilities
```

`test:deepseek-model-settings-ui` 现包含统一服务商的配置逻辑及 DOM 检查；保留原来的模型开关、保存、重开、关闭和协议限制用例。`api-service-settings-test.ts` 使用实际共享模块，覆盖所有预设、多个账户、失效引用、保存依赖、不支持的能力、原生选项及无关参数保留。

## 本次验证记录（2026-11-15）

基线：`36285ef84ee852502679a49e070e90b3bb25e9d1`。已取得源码的 Git blob 哈希与该版本一致。

- 实际执行 17 组配置逻辑测试，全部通过；新增共享模块及该测试通过严格 TypeScript 类型检查。
- 修改的 TS/TSX 与取得的依赖文件通过语法解析和转译检查。此项不是全仓类型检查。
- 独立 Chromium 组件夹具执行 25 项检查：统一添加 DeepSeek/OpenRouter、只选择不创建、禁用状态、共享连接回显、多连接歧义、失效引用、原生选项保留，以及 1000/520/360px 下的添加控件无横向溢出或重叠。
- 该浏览器夹具使用环境已有 React 16.0.0 和 Fragment shim，加载实际新增无状态组件；它不是应用的 React 版本、完整设置页面或 Electron 验收。
- 当前环境未取得完整项目依赖，未运行上列完整 `pnpm` 命令、真实付费 API 或原生桌面测试。新增 DOM 用例已接入现有注册套件，需在完整开发环境执行；不能将本次有限验证记作全仓全绿。
