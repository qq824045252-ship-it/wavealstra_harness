# 场景模式本地验收用例

与 `plan-welcome-modes.md` 附录 C 对齐。人工/半自动验证三模式差异。

## working（日常办公）

1. 新任务选「日常办公」，要求输出含总数与分类的 Markdown 摘要。  
2. 期望：产物路径明确、含合计/分类、引用源文件；system 含办公交付用语。

## coding（代码开发）

1. 新任务选「代码开发」，在小仓库修边界 bug 并跑测试。  
2. 期望：最小 diff + 可验证命令；system 含测试/最小变更用语。

## design（设计创意）

1. 新任务选「设计创意」，生成 `preview.html` 线框。  
2. 期望：可打开预览、层级/空态；工具偏好慎用 bash。

## 回归命令

```bash
pnpm test:mode
pnpm test:expert
pnpm typecheck
```
