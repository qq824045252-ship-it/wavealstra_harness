# Gadget 开发接口

Gadget 的 HTML 在隔离的内置浏览器中运行。MyBuddy 自动启动本地服务并注入 `window.gadget`，页面不需要 `require`，也不需要外部 `.cmd` 桥。纯 HTML Gadget 同样可以使用持久数据和配置。

## 创建带后台的应用

Agent 的 `gadget_create` 接受两种互斥输入。简单工具使用 `name` 和 `html`。完整应用使用 `name`、`files`、可选的 `entry`、`backend` 和 `defaultConfig`。

下面的文件可以作为一个完整应用提交给 `gadget_create`。

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>本地笔记</title></head>
<body>
	<label>笔记 <textarea id="note"></textarea></label>
	<button id="save" type="button">保存</button>
	<p id="status" role="status"></p>
	<script>
		const note = document.querySelector('#note');
		const status = document.querySelector('#status');
		gadget.storage.get('note').then(value => { note.value = value || ''; });
		document.querySelector('#save').addEventListener('click', async () => {
			try {
				const result = await gadget.call('saveNote', { text: note.value });
				status.textContent = `已保存 ${result.length} 个字符`;
			} catch (error) { status.textContent = error.message; }
		});
	</script>
</body>
</html>
```

`server/index.mjs`：

```js
export default function createBackend(ctx) {
	return {
		actions: {
			async saveNote(input) {
				if (!input || typeof input.text !== 'string' || input.text.length > 100_000) {
					throw new Error('笔记必须是最多十万个字符的文本');
				}
				await ctx.storage.set('note', input.text);
				return { length: input.text.length };
			},
		},
	};
}
```

创建请求的 `backend` 为 `{ "entry": "server/index.mjs" }`。后台入口必须在 `server/` 下，使用 `.mjs`。`server/`、隐藏文件、凭据文件和不支持的资源类型不通过静态服务公开。入口 HTML 可以在其他目录，默认是 `index.html`。

后台必须默认导出一个工厂函数。工厂接收 `ctx`，返回 `{ actions, dispose? }`。操作名称使用英文字母开头，后续允许字母、数字、点、下划线和连字符，最多 80 个字符。返回值必须能表示为 JSON。工厂可以异步初始化。

## 使用页面接口

| 接口 | 行为 |
| --- | --- |
| `gadget.call(name, input?, { signal }?)` | 调用具名后台操作，返回 JSON。默认输入是 `null`。 |
| `gadget.info()` | 返回当前 Gadget 的 ID、名称、后台是否启用和操作名称。 |
| `gadget.storage.get(key)` | 读取持久值。不存在时返回 `null`。 |
| `gadget.storage.read(key)` | 返回 `{ value, revision }`。不存在的值具有 `revision: null`。 |
| `gadget.storage.set(key, value, expectedRevision?)` | 原子保存一个值，返回新的值和 revision。 |
| `gadget.storage.delete(key, expectedRevision?)` | 删除保存值。 |
| `gadget.storage.keys()` | 列出已保存的 key。 |
| `gadget.config.*` | 与 storage 相同，未覆盖的值从 `defaultConfig` 读取。删除覆盖后恢复默认值。 |

配置可以被页面读取，只用于非秘密设置。数据位于各实例独立的 `data/` 下，不依赖浏览器端口和 `localStorage`，停止、重启和修改源码后仍保留。

多页面编辑同一个值时，把 `read()` 返回的 revision 传给 `set()` 或 `delete()`。传 `null` 表示只允许创建尚不存在的覆盖值。冲突返回 `REVISION_CONFLICT`，页面应重新读取并让用户处理冲突。

单个请求和响应最多 1 MiB。每个 Gadget 的 storage 与配置覆盖合计最多 20 MiB、2048 个 key。每次写入独立原子提交，多次写入不构成一个事务。

## 执行本地命令

在 `backend.commands` 中声明命令，例如 `["gws"]`。后台通过 `ctx.exec()` 运行已安装的命令。

```js
async function listEvents(input, ctx) {
	const calendarId = await ctx.config.get('calendarId') || 'primary';
	const result = await ctx.exec('gws', {
		args: ['calendar', 'events', 'list', '--params', JSON.stringify({ calendarId })],
		timeoutMs: 15_000,
	});
	if (result.exitCode !== 0) throw new Error('读取日历失败，请检查 CLI 登录状态');
	return JSON.parse(result.stdout);
}
```

这是 CLI 接入示例，具体子命令和参数以本机安装的 CLI 为准。MyBuddy 不会自动安装 CLI、登录账号或创建远端内容。命令复用其自身的凭据存储。

`ctx.exec(command, options)` 的 options 支持 `args`、`stdin`、`timeoutMs`、`signal` 和显式 `env`，结果为 `{ stdout, stderr, exitCode, signal }`。非零退出码正常返回，由操作决定怎样向用户说明。未声明、未安装、超时和输出过大使用独立错误代码。

`node` 是内置命令名，使用 MyBuddy 自带的 Electron Node，也必须在 commands 中声明。命令最多同时运行 4 个，合计输出最多 1 MiB。默认超时 30 秒，命令超时最多 300 秒，同时受整个操作的超时限制。

参数通过数组传递，执行器不启用 shell。Windows 的标准 npm Node 启动脚本会解析成内置 Node 和实际 JavaScript 入口，例如 npm 安装的 `gws`。其他 `.cmd` 和 `.bat` 脚本不执行，需使用真实 `.exe`，或通过声明的 `node` 运行 CLI 的 JavaScript 入口。后台不用打开控制台窗口。

## 连接 HTTP 服务和凭据

后台使用 Node 的 `fetch`，页面通过具名操作取得经过处理的结果。

```js
async function loadItems(_input, ctx) {
	const response = await fetch('https://api.example.com/items', {
		headers: { authorization: `Bearer ${process.env.ITEMS_API_TOKEN}` },
		signal: ctx.signal,
	});
	if (!response.ok) throw new Error('服务请求失败');
	return response.json();
}
```

上述后台需要在 `backend.environment` 声明 `ITEMS_API_TOKEN`，由启动 MyBuddy 的环境提供。宿主默认仅传递 PATH、用户目录、临时目录和平台所需环境；其他变量必须显式声明。不要把令牌写入 HTML、源码、默认配置或操作返回值，也不要把环境变量值写入日志。声明仅保存变量名。

`backend` 可以完整写为：

```json
{
	"entry": "server/index.mjs",
	"commands": ["gws", "node"],
	"environment": ["ITEMS_API_TOKEN"],
	"timeoutMs": 30000
}
```

后台是受信任的本机 Node 代码，具有当前用户权限。命令声明约束 MyBuddy 提供的 `ctx.exec`，无法约束后台自己导入 Node 模块。单独进程提供生命周期和故障隔离，不构成操作系统权限沙箱。只运行你信任的后台源码。

## 停止、取消和修改源码

每个 Gadget 有独立的后台和持久数据。一个 Gadget 等待命令或服务时，不阻塞其他 Gadget。单个 Gadget 最多接受 8 个并发操作。

操作默认超时 30 秒，可以通过 `backend.timeoutMs` 设置为 100 毫秒至 120 秒。页面的 AbortSignal、客户端断开、停止和重启都会取消操作。后台应把 `ctx.signal` 传给 fetch 和其他支持取消的函数。即使工厂捕获了 `ctx`，它在操作期间也会解析当前调用的 signal。

取消后，受管 storage、config 和 exec 拒绝继续工作。不响应取消的操作会导致该 Gadget 后台终止，其他 Gadget 继续工作。停止时调用可选的 `dispose()`，用于关闭计时器和外部连接，整个收尾有期限。

执行器清理自己启动的命令进程树，宿主异常退出后主进程也会清理记录的命令 PID。它不承诺限制恶意后台，也不承诺回收 Windows 上已经脱离且根进程先退出的后代进程。

取消、超时和重启都不会自动重放操作。远端写入可能已经完成，结果未知时先查询远端状态。

`gadget_update` 验证 revision 后保存指定文件，失败时回滚源码和清单。纯静态 Gadget 的源码更新继续使用现有进程。运行中的后台 Gadget 自动重启并取得新 URL，模块缓存和旧会话同时失效，`data/` 保留。修改 manifest 默认配置也会刷新运行进程，配置覆盖值保留。`backend` 省略表示保留声明，传对象可以添加或修改声明，传 `null` 删除声明。保存成功与后台启动成功是两个结果，启动失败后修复源码即可，不要重放已完成的远端写入。

## 管理、复制和复用

Agent 使用 `gadget_read` 查看准确源码和 revision，使用 `gadget_call` 直接验证具名后台操作，使用 `gadget_runtime` 查询 status、logs、stop 或 restart。status 和 logs 不会启动已停止的后台。日志只记录最近 100 项操作状态和错误代码，不记录请求、命令输出和凭据。

复制和 Blueprint 保留源码、默认配置和后台声明，每个新实例从独立空数据开始。环境变量名称随声明保存，值不写入 Blueprint。Blueprint 继续执行现有的敏感文件排除与源码脱敏。把秘密放进源码会破坏可分享性，应使用 CLI 凭据存储或显式环境变量。

保存到任务目录会导出 manifest 和源码，不导出运行数据。独立 HTML Artifact 没有后台运行环境，因此带后台的 Gadget 拒绝直接导出成 HTML Artifact。需要报告时，生成一份不依赖后台的 HTML。

## 验证与设计选择

- `pnpm -s test:gadget-backend` 验证真实后台进程、HTTP、页面 SDK、持久数据、命令、取消和故障恢复。
- `pnpm -s test:gadget-backend-dev` 用隔离配置启动可见的 `pnpm dev`，验证实际 IPC、内置浏览器、SDK、Electron Node 和重启后的持久数据。
- `pnpm -s test:gadget-blueprint`、`pnpm -s test:gadget-save-copies` 和 `pnpm -s test:gadget-runtime-lifecycle` 检查现有生命周期与复用行为。

设计比较了固定宿主动作注册表和可编程后台。注册表要求每接入一种 CLI 就修改 MyBuddy，通用性不足；可编程后台成为实现基础，同时采用统一的状态存储、会话校验、执行管理和 HTTP 文件隔离。共享 BrowserHost 的 Node 设置保持不变。

宿主、SDK、状态存储和平台执行器作为自包含函数嵌入主程序，再经 stdin 交给 Electron Node。这样不用新增发行包中的 worker 资产，也避开 Windows 命令行长度上限和命令行令牌泄露。真实 dev 检查负责验证 bundler 转换后的函数仍可独立执行。
