# Android 图片产物读取修复与验收（2026-09-30）

## 问题与修复边界

真实任务“一周锻炼计划”的 PNG 已登记在桌面 Artifact Domain，但 Remote 原来仅同步文字，本地 C 盘路径被 Markdown URL 过滤后没有有效图片地址。单纯修改斜杠、重新生图或修改 Tailscale 都不能补齐文件读取链路。

本次让 Remote 与桌面共用现有 Artifact Domain。历史响应增加 task-scoped 的 imageArtifacts 描述和回复产物关联；安卓支持已登记图片的路径别名、artifact_ref 实时事件、历史兜底展示，以及原图查看。没有修改原始会话文字，也没有重新生成图片。

## 数据与安全边界

- 图片内容接口：`GET /v1/tasks/:taskId/artifacts/:artifactId/image?v=:version`（同样支持 HEAD）。沿用设备 Bearer 鉴权；校验任务与产物归属、版本、实际根路径与符号链接/目录联接边界。
- 不接受任意 path/URL 参数，不提供开放文件代理，不取消 Markdown 默认链接安全过滤。Content-Type 来自文件签名；非图片、超过 16 MB、变化中的文件会拒绝。
- 安卓先通过带鉴权的请求取得 Blob，再显示本地对象 URL。设备令牌不进入图片 URL，也不写入图片缓存。缓存仅在内存内，按客户端会话、taskId、artifactId、version 区分，限制条目和字节数。
- 图像组件与 SVG 代码块均保持稳定组件身份，重复历史同步不会销毁重建已有图像。

## 实際部署

安卓：**1.1.6 / versionCode 8**，ADB 覆盖安装后由设备包管理器核验。保留原配对及应用数据。

电脑：更新实际提供 3352 服务的免安装版 `release-models-20260930043733706/win-unpacked`，完整构建对应的程序资源及依赖后部署并重启。原资源和可执行文件保留在 `out/remote-image-fix/portable-backup`。另一个旧安装目录没有更新；其未使用的本轮暂存目录已清理。

## 验收

| 范围 | 结果 |
|---|---|
| 图片读取与权限回归 | 23 项通过：真实文件读取、签名 MIME、托管图片、路径逃逸、跨任务、未认证/已撤销设备、版本与缓存等 |
| 统一渲染回归 | 23 项通过：原 15 项 SVG/滚动用例，另含 PNG 引用、无正文兜底、去重、缓存、失败重试和原图查看 |
| 消息同步回归 | 20 项通过 |
| Remote Access 原有用例、桌面/安卓类型检查 | 通过 |
| 构建与打包 | Remote build、Capacitor sync、Android assembleDebug、桌面 build、Windows 目录打包通过 |
| 真机图片验收 | 9 项通过；原任务中两处 Windows 路径引用均显示 1536 × 1024 图片，复用同一次鉴权下载 |
| 图片内容一致性 | 手机实际显示 Blob 为 2,030,692 字节，SHA-256 与电脑原 PNG 完全一致；CDP 未返回二进制 body 时不以空 body 代替真实图片哈希 |
| 真机刷新稳定性 | 图片位置保持不变，工具折叠，历史刷新不重新下载图片 |
| SSH 长对话复测 | 8 个 SVG 保持挂载；上滑、下滑、底部静置均为 0 像素漂移；底部 23 秒内观察到 3 次真实历史读取 |

验收使用原图片及原 SSH 会话，不向这些任务发送新提示词。临时 WebView 调试转发已清理，手机最后留在图片任务。

## 可复现入口与证据

```text
node scripts/run-remote-image-tests.cjs
node scripts/remote-renderer-regression-test.cjs
node scripts/run-remote-regression.cjs
pnpm run test:remote-access
pnpm run remote:typecheck
pnpm run typecheck
node scripts/remote-phone-image-acceptance.cjs
node scripts/remote-phone-scroll-regression.cjs
```

真机脚本要求已配对且 USB 调试连接的测试手机；图片脚本支持 `ADB_SERIAL`、`REMOTE_TEST_TASK_ID`、`REMOTE_TEST_IMAGE`。SSH 脚本只测当前已打开的 SSH 会话，不发送消息。

本次精简证据在 `artifacts/remote-images-20260930/`：`acceptance.json`、`phone-image-acceptance.json`、`ssh-scroll-acceptance.json`、`renderer-results.json`。APK 与桌面包哈希保存在 acceptance.json，临时构建日志在 out/remote-image-fix。

实现提交：`c163616d5f340b66e9ea93edc5f7a7ab31011bab`。
