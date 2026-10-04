# Markdown 功能覆盖样本

> 静态 fixture（Wave 5A）：覆盖 GFM 全要素 + 链接/图片策略 + 锚点。与
> `markdown-long.md`（长文档性能）互补：本文件验证**渲染质量**，前者验证**性能**。

## 1. 表格

| 语言 | 静态查看 | 编辑模式 | 备注 |
| --- | --- | --- | --- |
| TypeScript | Shiki | Monaco | 主语言 |
| JavaScript | Shiki | Monaco | 同 ts 语法族 |
| Python | Shiki | Monaco | 缩进敏感 |
| Shell | Shiki | Monaco | 脚本语言 |
| JSON | Shiki | Monaco | 数据交换 |

## 2. 任务列表

- [x] 已完成：Markdown 解析管线保留（unified/remark AST）
- [x] 已完成：Shiki 静态高亮集成
- [ ] 待办：Monaco 编辑态 lazy-load
- [ ] 待办：大文件降级策略

## 3. 嵌套列表与引用

1. 第一层有序项
   - 嵌套无序项 A
   - 嵌套无序项 B
     1. 深层有序 1
     2. 深层有序 2
2. 第二层有序项
   - [ ] 嵌套任务项

> 设计原则：*“以 fixture 基准为准，不以历史实现为准。”*
>
> - 引用内列表
> - 引用内代码 `inline code`

## 4. 锚点与目录

### 4.1 子标题锚点

长文档需要锚点、目录与滚动位置恢复三者联动（[回到顶部](#markdown-功能覆盖样本)）。

### 4.2 锚点往返

从[第 1 节](#1-表格)跳转，再从[第 3 节](#3-嵌套列表与引用)跳回。

## 5. 脚注

GFM 脚注在此验证[^fn-1]，多行脚注与引用[^fn-2]。

[^fn-1]: 脚注一：正文引用后集中定义，渲染到文档末尾。
[^fn-2]: 脚注二：跨引用——同一脚注可被多处引用，只渲染一次。

## 6. 链接与图片策略

- 外链：<https://example.com/docs> 与 [示例站](https://example.com)
- 文件类链接：[code-ts.ts](./code-ts.ts)（产物跳转）
- 锚点链接：[表格节](#1-表格)
- 图片 data URI：![1px 红点](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)
- 图片外链：![远程图片](https://example.com/logo.png)
- 图片相对路径：![本地图片](./assets/diagram.png)

## 7. 代码块与行内代码

```ts
// 行内代码：`const ok = true;`
export function sum(a: number, b: number): number {
  return a + b; // 尾注释
}
```

```shell
echo "hello from shell"
ls -la | grep fixture
```

```json
{ "name": "fixture", "values": [1, 2, 3], "nested": { "ok": true } }
```

无语言代码块：

```
plain text block
```

## 8. 分隔与强调

**加粗**、*斜体*、~~删除线~~、`行内代码`、[^fn-2] 再次引用。

---

结束。
