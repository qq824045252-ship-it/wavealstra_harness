<!-- __SANITIZED__ 来源: C:\Users\user\.mybuddy\sessions\--C--Users-user-Desktop-mybuddy--\2026-08-07T04-01-40-451Z_019fda62-4263-7b25-a5e0-a438598f36ac.jsonl | block:  | 长度: 2357 -->
# Ardot MCP 工具参考（19 个）

> 来源：Ardot 本地 MCP（127.0.0.1:50501）实际 `tools/list` 返回 + 官方文档 https://docs.ardot.tencent.com/ardot-mcp.html
> 执行任何 **batch_edit** 前必须通读本文档的 batch_edit 规则。

## 查询类

| 工具 | 用途 |
|---|---|
| `fetch_editor_state` | 当前编辑器状态：活跃画布、用户选区、打开的文件。建议 `includeSchema: false`、`includeGeneralEditInstructions: false`（除非需要 schema） |
| `fetch_file_info` | 当前活跃文件信息：文件名、链接、文件 ID、当前用户访问权限（编辑前确认写权限） |
| `batch_read` | 批量检索节点：按 `name`/`type` 正则搜索或按节点 ID 精确查找；可控制层级深度、详细程度，按需返回指定属性 |
| `capture_screenshot` | 节点/画布区域截图（验证布局与视觉效果），支持批量，单次建议 ≤10 个 |
| `capture_layout` | 设计文件布局结构树；`problemsOnly: true` 时只返回存在重叠/裁剪等布局问题的节点 |

## 设计系统

| 工具 | 用途 |
|---|---|
| `fetch_variables` | 读取设计变量（Design Token）：颜色、间距、字号等，可用于生成 CSS 全局样式 |
| `apply_variables` | 创建/更新变量集合；支持 COLOR/FLOAT/BOOLEAN/STRING 四种类型，多模式（Light/Dark），默认合并 |
| `fetch_component_lib` | 获取本地组件库的组件与集合（batch_edit 创建实例前先发现可复用组件） |
| `fetch_guidelines` | 主题设计规范，7 个主题：`table` / `landing-page` / `web-app` / `mobile-app` / `slides` / `code` / `tailwind` |
| `search_style_guide` | 跨风格/配色/字体/布局搜索风格指南候选项 |
| `build_style_guide` | 基于 search_style_guide 选择构建完整设计系统，输出含颜色/字体/间距/效果的 Markdown 规范 |

## 编辑操作

| 工具 | 用途 |
|---|---|
| `batch_edit` | 批量设计操作，见下方专门规则 |
| `locate_available_space` | 按方向（上/右/下/左）与尺寸查找画布空白区，可指定起始参考节点和最小间距 |
| `create_new_page` | 在当前 .ardot 文件新增空白页面（CANVAS），可指定名称、插入位置、是否切换焦点 |

## 资源与导出

| 工具 | 用途 |
|---|---|
| `scan_exportable_resources` | 扫描节点树返回可导出资源（image/svg），导出前确定范围与格式 |
| `export_nodes` | 导出节点为 PNG/JPEG/WEBP/SVG/PDF；PDF 模式可合并多个 Frame |
| `upload_images` | 批量上传本地图片并作为图像填充应用到节点（PNG/JPEG/WEBP，≤20 项） |
| `register_assets` | 注册本地资产供画布使用 |

## 辅助工具

| 工具 | 用途 |
|---|---|
| `get_available_fonts` | 当前环境可用字体列表及样式；创建文本节点后验证 `fontName`（family + style）可用 |

## batch_edit 规则（必读）

1. **单次 ≤25 个操作**；大批量按逻辑分区拆多次（结构 → 内容 → 样式 → 验证）
2. 支持 6 种操作：`Insert`(I)、`Copy`(C)、`Update`(U)、`Move`(M)、`Delete`(D)、`Image`(图片生成/获取)
3. **每个 Insert/Copy 必须有绑定名**（binding name），供后续操作引用为父节点；绑定名只在同一次调用内有效，不要跨调用复用
4. **不要对刚复制节点的子节点用 Update**：复制会重建子节点并分配新 ID
5. 操作按顺序执行；任一操作失败则整批回滚
6. 节点数据遵循 .ardot schema：新节点的 `id` 由系统自动生成，不要在节点数据里写 `id`
7. 插入 SVG 用 `type: "frame"` + `svg` 属性（SVG 会被解析为带矢量子节点的 FrameNode）
8. 引用远程团队库组件/样式/变量时用 `libraryKey`（`ref` 为源节点 id，`$lib:<libraryKey>:<set>:<var>` 语法）
9. 每次 batch_edit 后返回潜在问题列表，下次调用时修复
10. 每个创建的节点必须赋有意义的 `name`