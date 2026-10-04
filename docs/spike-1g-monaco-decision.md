# 1G — Monaco Spike 决策文档（V3.5 §53）

> 日期：2026-08-08 · monaco-editor 0.56.0 · Electron 37 · 决策状态：**冻结**
> **Wave 5A 落地：2026-08-08**（`src/renderer/src/lib/monacoLazy.ts`：仅编辑态 dynamic import；
> `?worker&inline` 内联 blob worker；1MB+ 编辑降级；`CodeView` 退出编辑 dispose editor+model）
> Spike：`scripts/monaco-spike.cjs`（主进程）+ `monaco-spike-page.html` + `monaco-spike-app.mjs`
> 运行：`node_modules/.bin/electron.cmd scripts/monaco-spike.cjs`

## 决策

```
静态代码 Artifact 预览 → Shiki（1F 已冻结）
进入编辑态            → 动态 import Monaco（lazy load，首屏零成本）
```

**边界**：`code-view` 默认 Shiki 渲染；用户点「编辑」才加载 Monaco。
Monaco 的 485ms cold import + 208ms worker 启动绝不允许进入首屏成本（§53 硬要求）。

## Benchmark（真实 BrowserWindow，自定义协议模拟生产资源加载，CSP 开启）

| 指标 | 结果 |
|---|---|
| cold ESM import（editor.api 全量） | **485–577 ms** |
| worker 创建+启动（本地 ESM worker） | **203–210 ms** |
| editor.create（首实例） | 43–58 ms |
| 100KB createModel+渲染 | 53–66 ms |
| 1MB | 59–63 ms |
| 5MB | 76–78 ms（**规模线性良好**） |
| 5 实例 create | 9–16 ms |
| dispose 全部（含 5MB 模型） | 503–515 ms |
| bundle（editor.api 全量，css 空 loader） | **4.97 MB** |

## CSP / Worker / 打包结论（实测）

1. **CSP `worker-src 'self'` 下本地 ESM worker 正常加载**（无 Refused 错误）。
   生产用 vite 的 `?worker&inline` 或独立 worker chunk 均可满足。
2. **Monaco ESM 含大量 `import './x.css'`**——浏览器原生模块不支持，必须经
   bundler（vite/esbuild `loader.css=empty`）。这是集成前提，不是障碍。
3. **内联 importmap 会被 `script-src 'self'` 拦截**（spike 实测）——生产不要依赖
   裸说明符 importmap 加载 monaco；入口用相对路径或由 bundler 解析。
4. **asar**：monaco 是纯静态资源（js/css/字体），vite 打包后无运行时文件解析
   问题；worker 由 bundler 输出。比 Shiki Oniguruma 的 wasm 更简单。
5. **file:// 无法承载模块依赖链**（跨文件 CORS 限制）——renderer 必须走
   自定义协议或打包后的单 chunk（生产 electron-vite 天然满足）。

## 大文件与内存

- 5MB 文本 78ms 渲染（一次性 model），**无需分片**；但持续编辑大文件
  建议 1MB+ 时提示「只读/超大文件」降级。
- dispose 513ms 主要是模型销毁成本；生产注意：关闭编辑态必须
  `editor.dispose()` + `model.dispose()`，否则内存不回收。
- renderer workingSet 未能从 spike 直接读取（Electron 37 metrics 无 Renderer 条目），
  以 bundle 4.97MB + dispose 行为作为成本边界依据。

## 淘汰方案

- **Monaco 常驻（首屏预载）**：淘汰。485ms+208ms 冷成本违背 §53「Monaco 运行时
  不得进入首屏成本」。
- **monaco-editor 全量 bundle 进主 chunk**：淘汰。4.97MB 增量过大；必须
  动态 import 分 chunk。

## 后续动作

- [x] 生产集成：`动态 import('monaco-editor/...')` 分 chunk + worker 懒创建
      （Wave 5A：`monaco-editor/editor/editor.api` + languages/definitions 子路径经
      exports map 动态 import；worker 用 vite `?worker&inline`；bundle 5.2MB 独立 chunk）
- [ ] 语言裁剪：按需注册 languages 可再降 bundle（当前 ts/js/json/py/shell/md 六语言注册，
      json 语言服务 jsonMode 2.4MB 为最大单项，后续可评估是否裁剪）
- [x] CodeView 编辑态入口 + dispose 生命周期测试（Wave 5A：wave5a-e2e 编辑挂载/退出卸载断言；
      golden code-edit 场景）

## 与 1F 的衔接

```
代码 Artifact 打开 → Shiki（JS RegExp，<100ms，无 worker）
点击「编辑」      → lazy Monaco（485ms 一次性成本，可接受）
```
