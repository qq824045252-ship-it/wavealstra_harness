# magpie agent plugin: MyBuddy

让 magpie 把它的模型接进 MyBuddy（本仓库的桌面应用）：MyBuddy 出现在 magpie
的 Agents 页，接入后 magpie 的模型写进 `~/.mybuddy/models.json`，在 MyBuddy
自己的模型选择器里选。

magpie 自带「第三方 agent」插件机制，因此这里不需要编译 magpie 源码，也不
需要改 magpie 仓库。

## 安装

在本目录里（magpie 记的是绝对路径）：

```sh
cd integrations/magpie-agent-mybuddy
magpie plugin add "$PWD"
```

或者只装单个模块文件：

```sh
magpie plugin add "$PWD/mybuddy.agent.js"
```

装好后 `magpie ls` 会多一行 `MyBuddy`（所在文件夹 `~/.mybuddy` 存在即视为已安装）。
在 magpie 的 Agents 页把 MyBuddy 的 provider 设为 magpie，等价于：

```sh
magpie mybuddy provider magpie
```

断开（把 `models.json` 里 magpie 写的块还原）：

```sh
magpie mybuddy provider default
```

## 它写了什么

`~/.mybuddy/models.json` 的 `providers.magpie`：

- `baseUrl` / `apiKey`：magpie 网关地址与 `magpie-mybuddy` 网关密钥；
- `headers.User-Agent = MyBuddy`：MyBuddy 的 Pi 运行时会把该 header 带在请求上，
  magpie 的用量/会话因此把它记成 `mybuddy`，而不是 `pi`；
- `compat.sendSessionAffinityHeaders`：让网关记录会话；
- `models`：每个网关模型一条 Pi 模型定义（`id`、`name`、思考等级
  `thinkingLevelMap`、图片输入、上下文窗口、输出上限、价格；原生 Responses
  模型标 `openai-responses`，其余走 Chat 由网关翻译）。

MyBuddy 没有 `model` 配置键——模型在应用自己的窗口里选，所以这是 magpie 的
connect-only agent：Agents 页只有一个 `provider` 字段（magpie 或空）。
magpie 第一次写入前会把用户原来的键存进它的 stash，断开时还原。

## 卸载

先断开再移除插件：

```sh
magpie mybuddy provider default
magpie plugin rm /home/vivion/github/wavealstra_harness/integrations/magpie-agent-mybuddy
```

本地路径安装时，`magpie plugin list` 显示的就是安装时那个绝对路径，按它移除即可。
