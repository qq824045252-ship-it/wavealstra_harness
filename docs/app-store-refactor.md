# appStore 模块结构与维护约定

## 设计目标

`appStore.ts` 保留为公开入口，内部按状态所有权、跨域操作和运行期资源拆分。
应用仍只有一个供组件使用的 Zustand store，原有扁平字段与 action 调用方式保持不变。
拆分的目的，是让一个操作依赖什么、修改什么、持有什么资源能在对应模块中看清楚。

拆分前的公开契约来自提交 `c8de589e74464c67ba42e42c90f7d169ef205a45`：

- 35 个命名导出：26 个运行时值、9 个类型。
- 96 个状态字段、179 个 action，共 275 个初始顶层键。
- 这些键的单一归属见 [app-store-refactor-map.json](./app-store-refactor-map.json)。
- 原契约快照位于 [app-store-contract.json](../scripts/app-store-contract.json)，用于检查拆分是否遗漏或覆盖成员。

最终交付以 `dc5d2b6017233f3ad990cc29871c16ce7e314a11`（0.1.85）为父提交，
版本为 0.1.86。0.1.84 的代码变更识别、打开文件联动与空间终端优化，
以及 0.1.85 的精确行数计算、内容预热与避免重复累加更新全部保留；
原 `artifact_ref` 分支新增的 `change.path` 透传迁入 `runtime/agentProjection.ts`，
并由真实 store 的事务测试验证。公开 store 契约未因此改变。

组件继续使用现有入口，例如：

```ts
import { useAppStore, selectActiveTaskArtifacts } from "@/store/appStore";
```

保留这个入口也保留了已有 UI fixture 对 `@/store/appStore` 的 alias 替换能力。
内部模块通过参数取得 store context；组件无须知道 action 被分配到哪个文件。

## 十一个状态域

每个 `slices/<domain>.ts` 声明一个 `XState` 接口和一个 `createXState()` 默认值工厂。
`AppState` 是这 11 个接口与 `AppActions` 的交集，没有嵌套改名，也没有创建 11 个独立 store。

| 状态域 | 主要所有权 |
| --- | --- |
| `appUi` | 页面、主题、侧栏、设置和全局抽屉/弹层 |
| `tasks` | 任务列表、回收站、待提交的重新生成、筛选、固定任务、压缩状态 |
| `workspaces` | 空间列表、任务区折叠和空间树展开集合 |
| `projects` | 项目列表、当前项目、项目 tab 和导航请求 |
| `activeContext` | 当前任务/草稿、模型与权限显式标记、连接器、场景、分支信息、上下文用量 |
| `composer` | 输入草稿、插入内容、引用、选区、终端上下文和消息选择 |
| `artifacts` | Artifact Domain 投影、显示策略、渲染缓存、加载状态与错误 |
| `workbench` | 右栏、文件 tab、浏览器、布局、扩展入口和工作区计数 |
| `terminal` | 终端会话镜像、按 owner 管理的终端 tab |
| `appConfig` | 模型目录、默认模型、模型偏好、人设和全局功能配置 |
| `capabilities` | 已安装/市场技能、专家和连接器目录 |

“状态归属”不限制一个业务操作只能更新一个域。
例如切换任务同时影响 active context、composer 和 workbench，其状态提交仍由一个跨域操作完成。

## 操作装配与依赖方向

`createAppStore.ts` 明确装配 11 个状态工厂与 36 个 action group：
11 个 slice 内的局部操作组、21 个 `commands/` 组、4 个 `runtime/` 操作组。
订阅、缓冲、bootstrap 等运行期辅助模块不新增公开状态或 action。

| 模块 | 职责 |
| --- | --- |
| `appStore.ts` | 显式重导出原公开 API，避免把内部模块整体暴露出去 |
| `app/store.ts` | 创建唯一的应用实例，提供内部单例连接点 |
| `app/hooks.ts`、`app/compat.ts` | React hooks 和原有全局 helper 的兼容适配 |
| `app/createAppStore.ts` | 创建状态、操作、运行期资源和 selector 实例，支持测试隔离 |
| `app/context.ts` | 提供 `get`、`set`、延迟解析的 `getApi()` 和实例运行期资源 |
| `app/actions.ts`、`app/types.ts` | action 签名、公开类型以及状态交集 |
| `app/commands/` | 任务、项目、空间、发送、重试、文件和布局等业务操作 |
| `app/runtime/` | 事件订阅、delta 排程、bootstrap、投影、历史与内容加载 |
| `app/messages/`、`app/transitions/` | 消息映射/reducer，以及跨域状态转换计算 |
| `app/selectors.ts` | 派生视图与每个 store 实例各自拥有的 memoization |
| `app/persistence/` 等辅助目录 | 有明确职责的偏好存储、空间处理、格式化和面板策略 |

允许的依赖方向是：公开入口连接单例/适配器；单例调用 factory；factory 装配域模块；
域模块通过 context、类型和纯函数协作。底层模块不能反向导入 `appStore.ts`、
`store.ts`、`hooks.ts` 或 `compat.ts`，也不能自行创建另一个应用单例。
`import type` 用于类型关系，运行期依赖环由架构图门禁检查。

`getApi()` 延迟取得 preload bridge，保留测试或 preload 在 store 创建后才可用的行为。
需要隔离实例时，测试调用 `createAppStore({ getApi })`；生产组件始终使用公开入口中的实例。

## 必须保留的行为边界

### 原子状态转换

- `taskActivation.ts` 在一次状态提交中切换任务及其模型、权限、连接器、草稿和相关 UI。
  历史按请求的 taskId 回填；当前页面专属信息在异步返回时检查当前任务，避免覆盖新页面。
- `messageRevision.ts` 保留重新生成的两阶段语义：点击先登记 pending 并保留旧回复；
  `assistant_start` 到达后，再原子替换消息并清除 pending。失败不制造空白回复。
- `taskLifecycle.ts` 删除当前任务时，任务列表和右栏/引用等清理同批发布；
  删除非当前任务不能关闭正在使用的面板。
- 跨域操作不要改成连续调用多个 setter。每次 Zustand `set()` 都可能被订阅者看到，
  拆文件不应把原本完整的一次转换变成几个中间状态。

### 事件、队列与缓存的所有者

- `initRuntime` 的一次启动拥有自己的订阅和排程。重复启动先清理前一实例；
  旧 cleanup 和迟到回调不能解除新实例的订阅或覆盖新 bootstrap 的状态。
- Pi 与 ACP 的文本/思考增量共用有序缓冲。只有相邻且 type、taskId、messageId、final
  条件一致的 delta 可以合并；工具/结束等结构事件之前必须先 flush。
- RAF 与 40ms fallback 共同保证后台窗口可推进，二者不能重复提交同一批增量。
- 空间移动与任务移动共用所属 store 的串行队列；并发去重集合、删除 tombstone、
  历史 hydration 去重、内容 hydration 单飞资源均归该 store 实例所有。
- 删除 tombstone 在乐观移除前登记，用于阻止迟到 Agent patch 重新创建已删任务。
- sidebar/artifact selector 缓存归实例所有；仅消息正文变化时，sidebar 摘要应保持稳定引用。
  不把队列、timer、unsubscribe 或缓存控制对象加入可观察的 `AppState`。

### 异步重试停止原请求所属任务

`runControl.ts` 提供内部 `abortTask(context, taskId)`，公开 `abortActiveTask()` 仍在调用时取当前任务。
创建分支收到 `TASK_BUSY`、删除用户消息遇到 busy 后重试时，使用请求开始时捕获的 taskId。
这样用户在等待 IPC 期间切换任务，不会因为旧请求重试而停止新页面中的任务。
这两处目标捕获是本次明确的行为修正，由事务测试验证。

## 添加字段或 action

1. 为新字段选择一个状态域，在该域的接口和默认值工厂中同时声明；不要在另一个域再次初始化。
   可选字段也应明确决定初始值，避免依赖对象 spread 的覆盖顺序。
2. 在 `AppActions` 声明 action 签名，把实现放入对应局部操作组或业务 command。
   仅需要一个域的简单操作放 slice；需要组合任务、输入、面板或 IPC 的操作放 command。
3. 新操作组在 factory 中显式装配。跨域操作通过 context 计算完整补丁，保留必要的一次提交。
4. 新运行期资源放入实例 runtime，初始化、使用和清理采用同一个所有者；异步返回保留目标身份检查。
5. 同步维护归属映射。公开契约有意变化时，说明变化并更新契约快照，不能为遗漏字段或类型错误修改基线。
6. 添加能够观察实际状态、IPC 参数或事件顺序的测试。必须保留的源码规则使用
   `read-app-store-source.ts` 读取真实责任模块；禁止规则扫描整个实现目录，不能只检查 facade。

## 验收命令与通过标准

下表是验收入口，不表示这些命令已经在每个平台执行完毕。

| 入口 | 验证内容 |
| --- | --- |
| `pnpm -s test:app-store-structure` | 35 个导出的名称/种类、11 个域、原字段/action、可选标记、装配唯一性和依赖方向 |
| `pnpm -s test:app-store-runtime` | delta 边界、事件顺序、fallback、订阅清理、重复初始化与实例隔离 |
| `pnpm -s test:app-store-transactions` | 原子提交、迟到回写、tombstone、selector/hydration/移动队列隔离，以及重试停止目标 |
| `pnpm -s test:message-lifecycle`、`pnpm -s test:regenerate-lifecycle` | 消息分段、结束/错误状态和重新生成两阶段契约 |
| `pnpm -s test:streaming-send`、`pnpm -s test:acp-desktop-hydration` | 发送模式/队列路由，以及 ACP 历史补齐 |
| `pnpm -s test:task-switch`、`pnpm -s test:task-delete-panel`、`pnpm -s test:terminal` | 任务切换、删除收口与终端既有契约 |
| `pnpm -s test:architecture`、`pnpm -s test:architecture-graph` | 业务集成、导入分层、运行期依赖环和文件规模棘轮 |
| `pnpm -s typecheck`、`pnpm -s build`、`pnpm -s test:all` | Web/Node/脚本类型检查、构建和默认 headless 完整套件 |

通过标准是公开契约无意外变化、成员无遗漏/重复、无新增类型错误和测试失败、无新增运行期依赖环。
文件尺寸基线随拆分收紧；既有失败基线只能清理已修复项，不能添加条目掩盖回归。
`test:core-performance*` 按现有规则串行执行，避免并行负载干扰测量。
桌面验收先构建，再在真实桌面环境运行 `pnpm -s test:all:gui`；
Windows 打包与安装包 payload 验证按仓库 `AGENTS.md` 执行，并单独记录实际运行结果。

## 0.1.86 本次验收记录（2026-11-04）

在接入 0.1.84 和 0.1.85 更新后的完整代码上执行：

| 检查 | 实际结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过；Web/Node 无错误，scripts 棘轮新增 0。仍有 176 条既有 scripts 错误，本次没有扩大基线，并移除一条已修复的夹具错误 |
| `pnpm -s build` | 主进程、preload、renderer 生产构建通过 |
| `pnpm -s test:all -- --jobs=2` | 260 个 headless 测试命令通过，失败 0、已知失败 0；包含串行性能门禁 |
| `pnpm -s test:terminal` | host、bridge、store、Herdr launcher 四组通过 |
| 新 store 专项 | 结构契约通过；runtime 10 组、事务 8 组通过；`artifact_ref.change.path` 保留已验证 |
| 桌面与安装包 | 当前环境没有真实桌面会话；未执行 GUI 套件、Windows 打包/安装、快捷方式或 packaged payload 验收 |

完整套件还暴露了 0.1.83 已存在的三处过时测试：工作台中文菜单、Gadget 中文保存按钮、
概览多终端汇总策略。本次只同步相应测试，并增加终端 owner 隔离与 sessionId 去重覆盖，
没有为这些测试改回生产行为，也没有增加已知失败条目。
