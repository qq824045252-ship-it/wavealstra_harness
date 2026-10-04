# Markdown Rich Fixture

> V3.5 §28 synthetic fixture：复杂 Markdown 渲染质量基线。

## 标题层级

### 三级标题

#### 四级标题

## 表格

| 特性 | 状态 | 备注 |
| --- | --- | --- |
| GFM 表格 | ✅ | remark-gfm |
| 数学公式 | ✅ | remark-math |
| 任务列表 | ✅ | GFM |

## 代码块

```ts
interface ArtifactDescriptor {
  id: string;
  taskId: string;
  version: number;
  capabilities: ArtifactCapabilities;
}

const artifacts: ArtifactDescriptor[] = await service.listByTask(taskId);
```

## 引用与列表

> 引用块：Artifact 最终只有一个持久真相源。
> V3.5 §2：ArtifactRepository = 唯一持久真相。

1. 有序列表项一
2. 有序列表项二
   - 嵌套无序项
   - 再嵌套
3. 有序列表项三

- [ ] 未完成任务
- [x] 已完成任务

## 行内样式

**加粗**、*斜体*、`行内代码`、~~删除线~~、[链接](https://example.com)、<kbd>Ctrl</kbd>+<kbd>C</kbd>

## 数学

行内公式 $E = mc^2$，块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$

## 分隔与图片

---

![占位图](https://placehold.co/200x60?text=fixture)

末尾段落，验证长文档滚动与锚点定位。
