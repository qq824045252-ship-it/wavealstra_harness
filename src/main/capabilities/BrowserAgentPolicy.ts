/** Shared agent guidance; app-owned external-open controls route separately. */
export const browserAgentPolicy = "网页和本地 HTML（含 file://、localhost）的打开、读取、交互与验收一律使用侧栏 browser_exec；MyBuddy 自身界面用 ui_exec。内置浏览器不可用或失败时报告具体原因，不得改用外部浏览器、computer_exec 或 shell 启动命令绕过。外部浏览器仅允许用户亲自点击“在系统浏览器打开”；Agent 不得代点该入口。";
