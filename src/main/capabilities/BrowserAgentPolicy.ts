/** Shared agent guidance; app-owned external-open controls route separately. */
export const browserAgentPolicy = [
  "网页和本地 HTML（含 file://、localhost）的打开、读取、交互与验收一律使用任务 Space 的 browser_exec；侧栏关闭时照常使用。MyBuddy 自身界面用 ui_exec。内置浏览器不可用或失败时报告具体原因，不得改用外部浏览器、computer_exec 或 shell 启动命令绕过。外部浏览器仅允许用户亲自点击“在系统浏览器打开”；Agent 不得代点该入口。",
  "先访问任务目标页并复用已有登录。优先读取本任务已打开的目标标签，同站继续导航可传其 tabId 保留标签会话。首次使用已登录的站点，用 login 核验账户专属内容并登记自动续期，再继续原任务。普通公开网页直接使用。被登录挡住时用 login，自己点击普通登录入口或唯一的已有账号，跟随登录弹窗。只有需要用户输入密码、扫码或填验证码才呈现页面让用户操作，凭据只在网页输入。登录核验通过后立即接着做原任务。",
].join("");
