import { Type } from "typebox";

/** Codemode receives the same host result as native calls, without parsing prose. */
export const browserStructuredOutputSchema = Type.Object({
  isError: Type.Boolean(),
  action: Type.Optional(Type.String()), tabId: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()), title: Type.Optional(Type.String()), text: Type.Optional(Type.String()),
  nextCursor: Type.Optional(Type.String()), textTruncated: Type.Optional(Type.Boolean()),
  elements: Type.Optional(Type.Array(Type.Object({ selector: Type.String(), tag: Type.String(), label: Type.String() }, { additionalProperties: true }))),
  outcome: Type.Optional(Type.Object({ dispatch: Type.Union([Type.Literal("not_started"), Type.Literal("dispatched")]), effect: Type.Union([Type.Literal("none"), Type.Literal("unknown"), Type.Literal("confirmed")]) })),
  code: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const browserToolDescription = "使用 MyBuddy 内置 Electron 浏览器，每个任务保留独立标签、共享登录 session，popup 也留在内置浏览器。status 列出本任务 tabs；tabId 固定本任务页面，不传时用本任务最近操作的标签。navigate 支持 http(s) 或本机 file://，不支持网络共享；返回已有标签会保留页面，reload:true 强制刷新，本机源码变更会自动刷新。Gadget 可传 gadgetId 按身份恢复当前端口。常用读取直接 navigate({url,after:{mode:'text'}})，不要为已知的打开和读取多等一个模型回合。read 默认交互观察，mode:text 只读正文；selector 缩小区域，nextCursor 续读同一快照，CURSOR_STALE 时重新只读。find/inspect/wait_for 支持 role/name/text/selector；click/fill/press 使用已观察的节点引用，局部复验会拒绝替换、歧义、禁用和遮挡，目标外变化不要求整页重读。timeout_ms 是整次调用总预算；navigate/click/fill/press/wait_for 的 after 可按 selector/role/name/state 等条件再观察，观察失败保留动作成功。Codemode 返回结构化结果：const r=await tools.browser_exec({action:'navigate',url,after:{mode:'text'}});text(r)。已知多步可顺序 await 并保留 completed；每步检查 isError，失败或效果 unknown 立即返回，后续步骤不执行，不重放提交。新页面或未知目标先观察。截图自动视觉路由；不执行任意 JavaScript，跨应用操作用 computer_exec。";
