# 长文档性能基准样本（fixture）

> 由 `scripts/gen-markdown-long.mjs` 生成，共 40 章。
> 用途：V3.5 §84 long-document performance —— 首帧渲染、滚动、语法高亮、表格布局。

## 目录

- [第 1 章：章节 1](#第-1-章章节-1)
- [第 2 章：章节 2](#第-2-章章节-2)
- [第 3 章：章节 3](#第-3-章章节-3)
- [第 4 章：章节 4](#第-4-章章节-4)
- [第 5 章：章节 5](#第-5-章章节-5)
- [第 6 章：章节 6](#第-6-章章节-6)
- [第 7 章：章节 7](#第-7-章章节-7)
- [第 8 章：章节 8](#第-8-章章节-8)
- [第 9 章：章节 9](#第-9-章章节-9)
- [第 10 章：章节 10](#第-10-章章节-10)
- [第 11 章：章节 11](#第-11-章章节-11)
- [第 12 章：章节 12](#第-12-章章节-12)
- [第 13 章：章节 13](#第-13-章章节-13)
- [第 14 章：章节 14](#第-14-章章节-14)
- [第 15 章：章节 15](#第-15-章章节-15)
- [第 16 章：章节 16](#第-16-章章节-16)
- [第 17 章：章节 17](#第-17-章章节-17)
- [第 18 章：章节 18](#第-18-章章节-18)
- [第 19 章：章节 19](#第-19-章章节-19)
- [第 20 章：章节 20](#第-20-章章节-20)
- [第 21 章：章节 21](#第-21-章章节-21)
- [第 22 章：章节 22](#第-22-章章节-22)
- [第 23 章：章节 23](#第-23-章章节-23)
- [第 24 章：章节 24](#第-24-章章节-24)
- [第 25 章：章节 25](#第-25-章章节-25)
- [第 26 章：章节 26](#第-26-章章节-26)
- [第 27 章：章节 27](#第-27-章章节-27)
- [第 28 章：章节 28](#第-28-章章节-28)
- [第 29 章：章节 29](#第-29-章章节-29)
- [第 30 章：章节 30](#第-30-章章节-30)
- [第 31 章：章节 31](#第-31-章章节-31)
- [第 32 章：章节 32](#第-32-章章节-32)
- [第 33 章：章节 33](#第-33-章章节-33)
- [第 34 章：章节 34](#第-34-章章节-34)
- [第 35 章：章节 35](#第-35-章章节-35)
- [第 36 章：章节 36](#第-36-章章节-36)
- [第 37 章：章节 37](#第-37-章章节-37)
- [第 38 章：章节 38](#第-38-章章节-38)
- [第 39 章：章节 39](#第-39-章章节-39)
- [第 40 章：章节 40](#第-40-章章节-40)

## 文档结构说明

本样本刻意混排 **GFM 全要素**：ATX/Setext 标题、无序/有序/任务列表、表格、
fenced code、行内代码、引用、数学块、脚注、链接与图片引用，保证渲染器全路径覆盖。

**关键词密度**：markdown / 渲染 / 性能 / 基准 / 表格 / 代码块 / 引用 / 脚注 / 锚点 / 数学。


## 第 1 章：章节 1

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 1.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 1 章已完成项）
- [ ] 任务二（第 1 章待办项）
- [ ] 任务三（第 1 章待办项）

### 1.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-1-0 | 0.0 ms | 1.0 ms | 接近 ⚠️ |
| item-1-1 | 7.3 ms | 7.9 ms | 达标 ✅ |
| item-1-2 | 14.6 ms | 14.8 ms | 接近 ⚠️ |
| item-1-3 | 21.9 ms | 21.7 ms | 达标 ✅ |
| item-1-4 | 29.2 ms | 28.6 ms | 接近 ⚠️ |
| item-1-5 | 36.5 ms | 35.5 ms | 达标 ✅ |
| item-1-6 | 43.8 ms | 42.4 ms | 接近 ⚠️ |
| item-1-7 | 51.1 ms | 49.3 ms | 达标 ✅ |

### 1.3 代码块

```ts
// 1：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 1.4 引用与公式

> 设计原则 1：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 1.5 脚注与链接

本段引用脚注[^note-1]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-1]: 第 1 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 2 章：章节 2

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 2.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 2 章已完成项）
- [ ] 任务二（第 2 章待办项）
- [ ] 任务三（第 2 章待办项）

### 2.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-2-0 | 0.0 ms | 2.0 ms | 接近 ⚠️ |
| item-2-1 | 7.3 ms | 8.9 ms | 达标 ✅ |
| item-2-2 | 14.6 ms | 15.8 ms | 接近 ⚠️ |
| item-2-3 | 21.9 ms | 22.7 ms | 达标 ✅ |
| item-2-4 | 29.2 ms | 29.6 ms | 接近 ⚠️ |
| item-2-5 | 36.5 ms | 36.5 ms | 达标 ✅ |
| item-2-6 | 43.8 ms | 43.4 ms | 接近 ⚠️ |
| item-2-7 | 51.1 ms | 50.3 ms | 达标 ✅ |

### 2.3 代码块

```ts
// 2：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 2.4 引用与公式

> 设计原则 2：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 2.5 脚注与链接

本段引用脚注[^note-2]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-2]: 第 2 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 3 章：章节 3

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 3.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 3 章已完成项）
- [ ] 任务二（第 3 章待办项）
- [ ] 任务三（第 3 章待办项）

### 3.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-3-0 | 0.0 ms | 3.0 ms | 接近 ⚠️ |
| item-3-1 | 7.3 ms | 9.9 ms | 达标 ✅ |
| item-3-2 | 14.6 ms | 16.8 ms | 接近 ⚠️ |
| item-3-3 | 21.9 ms | 23.7 ms | 达标 ✅ |
| item-3-4 | 29.2 ms | 30.6 ms | 接近 ⚠️ |
| item-3-5 | 36.5 ms | 37.5 ms | 达标 ✅ |
| item-3-6 | 43.8 ms | 44.4 ms | 接近 ⚠️ |
| item-3-7 | 51.1 ms | 51.3 ms | 达标 ✅ |

### 3.3 代码块

```ts
// 3：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 3.4 引用与公式

> 设计原则 3：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 3.5 脚注与链接

本段引用脚注[^note-3]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-3]: 第 3 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 4 章：章节 4

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 4.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 4 章已完成项）
- [ ] 任务二（第 4 章待办项）
- [ ] 任务三（第 4 章待办项）

### 4.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-4-0 | 0.0 ms | 4.0 ms | 接近 ⚠️ |
| item-4-1 | 7.3 ms | 10.9 ms | 达标 ✅ |
| item-4-2 | 14.6 ms | 17.8 ms | 接近 ⚠️ |
| item-4-3 | 21.9 ms | 24.7 ms | 达标 ✅ |
| item-4-4 | 29.2 ms | 31.6 ms | 接近 ⚠️ |
| item-4-5 | 36.5 ms | 38.5 ms | 达标 ✅ |
| item-4-6 | 43.8 ms | 45.4 ms | 接近 ⚠️ |
| item-4-7 | 51.1 ms | 52.3 ms | 达标 ✅ |

### 4.3 代码块

```ts
// 4：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 4.4 引用与公式

> 设计原则 4：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 4.5 脚注与链接

本段引用脚注[^note-4]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-4]: 第 4 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 5 章：章节 5

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 5.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 5 章已完成项）
- [ ] 任务二（第 5 章待办项）
- [ ] 任务三（第 5 章待办项）

### 5.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-5-0 | 0.0 ms | 5.0 ms | 接近 ⚠️ |
| item-5-1 | 7.3 ms | 11.9 ms | 达标 ✅ |
| item-5-2 | 14.6 ms | 18.8 ms | 接近 ⚠️ |
| item-5-3 | 21.9 ms | 25.7 ms | 达标 ✅ |
| item-5-4 | 29.2 ms | 32.6 ms | 接近 ⚠️ |
| item-5-5 | 36.5 ms | 39.5 ms | 达标 ✅ |
| item-5-6 | 43.8 ms | 46.4 ms | 接近 ⚠️ |
| item-5-7 | 51.1 ms | 53.3 ms | 达标 ✅ |

### 5.3 代码块

```ts
// 5：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 5.4 引用与公式

> 设计原则 5：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 5.5 脚注与链接

本段引用脚注[^note-5]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-5]: 第 5 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 6 章：章节 6

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 6.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 6 章已完成项）
- [ ] 任务二（第 6 章待办项）
- [ ] 任务三（第 6 章待办项）

### 6.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-6-0 | 0.0 ms | 6.0 ms | 接近 ⚠️ |
| item-6-1 | 7.3 ms | 12.9 ms | 达标 ✅ |
| item-6-2 | 14.6 ms | 19.8 ms | 接近 ⚠️ |
| item-6-3 | 21.9 ms | 26.7 ms | 达标 ✅ |
| item-6-4 | 29.2 ms | 33.6 ms | 接近 ⚠️ |
| item-6-5 | 36.5 ms | 40.5 ms | 达标 ✅ |
| item-6-6 | 43.8 ms | 47.4 ms | 接近 ⚠️ |
| item-6-7 | 51.1 ms | 54.3 ms | 达标 ✅ |

### 6.3 代码块

```ts
// 6：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 6.4 引用与公式

> 设计原则 6：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 6.5 脚注与链接

本段引用脚注[^note-6]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-6]: 第 6 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 7 章：章节 7

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 7.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 7 章已完成项）
- [ ] 任务二（第 7 章待办项）
- [ ] 任务三（第 7 章待办项）

### 7.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-7-0 | 0.0 ms | 7.0 ms | 接近 ⚠️ |
| item-7-1 | 7.3 ms | 13.9 ms | 达标 ✅ |
| item-7-2 | 14.6 ms | 20.8 ms | 接近 ⚠️ |
| item-7-3 | 21.9 ms | 27.7 ms | 达标 ✅ |
| item-7-4 | 29.2 ms | 34.6 ms | 接近 ⚠️ |
| item-7-5 | 36.5 ms | 41.5 ms | 达标 ✅ |
| item-7-6 | 43.8 ms | 48.4 ms | 接近 ⚠️ |
| item-7-7 | 51.1 ms | 55.3 ms | 达标 ✅ |

### 7.3 代码块

```ts
// 7：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 7.4 引用与公式

> 设计原则 7：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 7.5 脚注与链接

本段引用脚注[^note-7]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-7]: 第 7 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 8 章：章节 8

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 8.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 8 章已完成项）
- [ ] 任务二（第 8 章待办项）
- [ ] 任务三（第 8 章待办项）

### 8.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-8-0 | 0.0 ms | 8.0 ms | 接近 ⚠️ |
| item-8-1 | 7.3 ms | 14.9 ms | 达标 ✅ |
| item-8-2 | 14.6 ms | 21.8 ms | 接近 ⚠️ |
| item-8-3 | 21.9 ms | 28.7 ms | 达标 ✅ |
| item-8-4 | 29.2 ms | 35.6 ms | 接近 ⚠️ |
| item-8-5 | 36.5 ms | 42.5 ms | 达标 ✅ |
| item-8-6 | 43.8 ms | 49.4 ms | 接近 ⚠️ |
| item-8-7 | 51.1 ms | 56.3 ms | 达标 ✅ |

### 8.3 代码块

```ts
// 8：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 8.4 引用与公式

> 设计原则 8：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 8.5 脚注与链接

本段引用脚注[^note-8]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-8]: 第 8 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 9 章：章节 9

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 9.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 9 章已完成项）
- [ ] 任务二（第 9 章待办项）
- [ ] 任务三（第 9 章待办项）

### 9.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-9-0 | 0.0 ms | 9.0 ms | 接近 ⚠️ |
| item-9-1 | 7.3 ms | 15.9 ms | 达标 ✅ |
| item-9-2 | 14.6 ms | 22.8 ms | 接近 ⚠️ |
| item-9-3 | 21.9 ms | 29.7 ms | 达标 ✅ |
| item-9-4 | 29.2 ms | 36.6 ms | 接近 ⚠️ |
| item-9-5 | 36.5 ms | 43.5 ms | 达标 ✅ |
| item-9-6 | 43.8 ms | 50.4 ms | 接近 ⚠️ |
| item-9-7 | 51.1 ms | 57.3 ms | 达标 ✅ |

### 9.3 代码块

```ts
// 9：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 9.4 引用与公式

> 设计原则 9：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 9.5 脚注与链接

本段引用脚注[^note-9]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-9]: 第 9 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 10 章：章节 10

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 10.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 10 章已完成项）
- [ ] 任务二（第 10 章待办项）
- [ ] 任务三（第 10 章待办项）

### 10.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-10-0 | 0.0 ms | 10.0 ms | 接近 ⚠️ |
| item-10-1 | 7.3 ms | 16.9 ms | 达标 ✅ |
| item-10-2 | 14.6 ms | 23.8 ms | 接近 ⚠️ |
| item-10-3 | 21.9 ms | 30.7 ms | 达标 ✅ |
| item-10-4 | 29.2 ms | 37.6 ms | 接近 ⚠️ |
| item-10-5 | 36.5 ms | 44.5 ms | 达标 ✅ |
| item-10-6 | 43.8 ms | 51.4 ms | 接近 ⚠️ |
| item-10-7 | 51.1 ms | 58.3 ms | 达标 ✅ |

### 10.3 代码块

```ts
// 10：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 10.4 引用与公式

> 设计原则 10：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 10.5 脚注与链接

本段引用脚注[^note-10]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-10]: 第 10 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 11 章：章节 11

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 11.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 11 章已完成项）
- [ ] 任务二（第 11 章待办项）
- [ ] 任务三（第 11 章待办项）

### 11.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-11-0 | 0.0 ms | 11.0 ms | 接近 ⚠️ |
| item-11-1 | 7.3 ms | 17.9 ms | 达标 ✅ |
| item-11-2 | 14.6 ms | 24.8 ms | 接近 ⚠️ |
| item-11-3 | 21.9 ms | 31.7 ms | 达标 ✅ |
| item-11-4 | 29.2 ms | 38.6 ms | 接近 ⚠️ |
| item-11-5 | 36.5 ms | 45.5 ms | 达标 ✅ |
| item-11-6 | 43.8 ms | 52.4 ms | 接近 ⚠️ |
| item-11-7 | 51.1 ms | 59.3 ms | 达标 ✅ |

### 11.3 代码块

```ts
// 11：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 11.4 引用与公式

> 设计原则 11：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 11.5 脚注与链接

本段引用脚注[^note-11]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-11]: 第 11 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 12 章：章节 12

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 12.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 12 章已完成项）
- [ ] 任务二（第 12 章待办项）
- [ ] 任务三（第 12 章待办项）

### 12.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-12-0 | 0.0 ms | 12.0 ms | 接近 ⚠️ |
| item-12-1 | 7.3 ms | 18.9 ms | 达标 ✅ |
| item-12-2 | 14.6 ms | 25.8 ms | 接近 ⚠️ |
| item-12-3 | 21.9 ms | 32.7 ms | 达标 ✅ |
| item-12-4 | 29.2 ms | 39.6 ms | 接近 ⚠️ |
| item-12-5 | 36.5 ms | 46.5 ms | 达标 ✅ |
| item-12-6 | 43.8 ms | 53.4 ms | 接近 ⚠️ |
| item-12-7 | 51.1 ms | 60.3 ms | 达标 ✅ |

### 12.3 代码块

```ts
// 12：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 12.4 引用与公式

> 设计原则 12：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 12.5 脚注与链接

本段引用脚注[^note-12]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-12]: 第 12 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 13 章：章节 13

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 13.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 13 章已完成项）
- [ ] 任务二（第 13 章待办项）
- [ ] 任务三（第 13 章待办项）

### 13.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-13-0 | 0.0 ms | 13.0 ms | 接近 ⚠️ |
| item-13-1 | 7.3 ms | 19.9 ms | 达标 ✅ |
| item-13-2 | 14.6 ms | 26.8 ms | 接近 ⚠️ |
| item-13-3 | 21.9 ms | 33.7 ms | 达标 ✅ |
| item-13-4 | 29.2 ms | 40.6 ms | 接近 ⚠️ |
| item-13-5 | 36.5 ms | 47.5 ms | 达标 ✅ |
| item-13-6 | 43.8 ms | 54.4 ms | 接近 ⚠️ |
| item-13-7 | 51.1 ms | 61.3 ms | 达标 ✅ |

### 13.3 代码块

```ts
// 13：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 13.4 引用与公式

> 设计原则 13：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 13.5 脚注与链接

本段引用脚注[^note-13]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-13]: 第 13 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 14 章：章节 14

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 14.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 14 章已完成项）
- [ ] 任务二（第 14 章待办项）
- [ ] 任务三（第 14 章待办项）

### 14.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-14-0 | 0.0 ms | 14.0 ms | 接近 ⚠️ |
| item-14-1 | 7.3 ms | 20.9 ms | 达标 ✅ |
| item-14-2 | 14.6 ms | 27.8 ms | 接近 ⚠️ |
| item-14-3 | 21.9 ms | 34.7 ms | 达标 ✅ |
| item-14-4 | 29.2 ms | 41.6 ms | 接近 ⚠️ |
| item-14-5 | 36.5 ms | 48.5 ms | 达标 ✅ |
| item-14-6 | 43.8 ms | 55.4 ms | 接近 ⚠️ |
| item-14-7 | 51.1 ms | 62.3 ms | 达标 ✅ |

### 14.3 代码块

```ts
// 14：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 14.4 引用与公式

> 设计原则 14：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 14.5 脚注与链接

本段引用脚注[^note-14]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-14]: 第 14 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 15 章：章节 15

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 15.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 15 章已完成项）
- [ ] 任务二（第 15 章待办项）
- [ ] 任务三（第 15 章待办项）

### 15.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-15-0 | 0.0 ms | 15.0 ms | 接近 ⚠️ |
| item-15-1 | 7.3 ms | 21.9 ms | 达标 ✅ |
| item-15-2 | 14.6 ms | 28.8 ms | 接近 ⚠️ |
| item-15-3 | 21.9 ms | 35.7 ms | 达标 ✅ |
| item-15-4 | 29.2 ms | 42.6 ms | 接近 ⚠️ |
| item-15-5 | 36.5 ms | 49.5 ms | 达标 ✅ |
| item-15-6 | 43.8 ms | 56.4 ms | 接近 ⚠️ |
| item-15-7 | 51.1 ms | 63.3 ms | 达标 ✅ |

### 15.3 代码块

```ts
// 15：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 15.4 引用与公式

> 设计原则 15：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 15.5 脚注与链接

本段引用脚注[^note-15]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-15]: 第 15 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 16 章：章节 16

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 16.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 16 章已完成项）
- [ ] 任务二（第 16 章待办项）
- [ ] 任务三（第 16 章待办项）

### 16.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-16-0 | 0.0 ms | 16.0 ms | 接近 ⚠️ |
| item-16-1 | 7.3 ms | 22.9 ms | 达标 ✅ |
| item-16-2 | 14.6 ms | 29.8 ms | 接近 ⚠️ |
| item-16-3 | 21.9 ms | 36.7 ms | 达标 ✅ |
| item-16-4 | 29.2 ms | 43.6 ms | 接近 ⚠️ |
| item-16-5 | 36.5 ms | 50.5 ms | 达标 ✅ |
| item-16-6 | 43.8 ms | 57.4 ms | 接近 ⚠️ |
| item-16-7 | 51.1 ms | 64.3 ms | 达标 ✅ |

### 16.3 代码块

```ts
// 16：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 16.4 引用与公式

> 设计原则 16：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 16.5 脚注与链接

本段引用脚注[^note-16]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-16]: 第 16 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 17 章：章节 17

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 17.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 17 章已完成项）
- [ ] 任务二（第 17 章待办项）
- [ ] 任务三（第 17 章待办项）

### 17.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-17-0 | 0.0 ms | 17.0 ms | 接近 ⚠️ |
| item-17-1 | 7.3 ms | 23.9 ms | 达标 ✅ |
| item-17-2 | 14.6 ms | 30.8 ms | 接近 ⚠️ |
| item-17-3 | 21.9 ms | 37.7 ms | 达标 ✅ |
| item-17-4 | 29.2 ms | 44.6 ms | 接近 ⚠️ |
| item-17-5 | 36.5 ms | 51.5 ms | 达标 ✅ |
| item-17-6 | 43.8 ms | 58.4 ms | 接近 ⚠️ |
| item-17-7 | 51.1 ms | 65.3 ms | 达标 ✅ |

### 17.3 代码块

```ts
// 17：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 17.4 引用与公式

> 设计原则 17：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 17.5 脚注与链接

本段引用脚注[^note-17]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-17]: 第 17 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 18 章：章节 18

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 18.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 18 章已完成项）
- [ ] 任务二（第 18 章待办项）
- [ ] 任务三（第 18 章待办项）

### 18.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-18-0 | 0.0 ms | 18.0 ms | 接近 ⚠️ |
| item-18-1 | 7.3 ms | 24.9 ms | 达标 ✅ |
| item-18-2 | 14.6 ms | 31.8 ms | 接近 ⚠️ |
| item-18-3 | 21.9 ms | 38.7 ms | 达标 ✅ |
| item-18-4 | 29.2 ms | 45.6 ms | 接近 ⚠️ |
| item-18-5 | 36.5 ms | 52.5 ms | 达标 ✅ |
| item-18-6 | 43.8 ms | 59.4 ms | 接近 ⚠️ |
| item-18-7 | 51.1 ms | 66.3 ms | 达标 ✅ |

### 18.3 代码块

```ts
// 18：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 18.4 引用与公式

> 设计原则 18：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 18.5 脚注与链接

本段引用脚注[^note-18]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-18]: 第 18 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 19 章：章节 19

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 19.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 19 章已完成项）
- [ ] 任务二（第 19 章待办项）
- [ ] 任务三（第 19 章待办项）

### 19.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-19-0 | 0.0 ms | 19.0 ms | 接近 ⚠️ |
| item-19-1 | 7.3 ms | 25.9 ms | 达标 ✅ |
| item-19-2 | 14.6 ms | 32.8 ms | 接近 ⚠️ |
| item-19-3 | 21.9 ms | 39.7 ms | 达标 ✅ |
| item-19-4 | 29.2 ms | 46.6 ms | 接近 ⚠️ |
| item-19-5 | 36.5 ms | 53.5 ms | 达标 ✅ |
| item-19-6 | 43.8 ms | 60.4 ms | 接近 ⚠️ |
| item-19-7 | 51.1 ms | 67.3 ms | 达标 ✅ |

### 19.3 代码块

```ts
// 19：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 19.4 引用与公式

> 设计原则 19：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 19.5 脚注与链接

本段引用脚注[^note-19]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-19]: 第 19 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 20 章：章节 20

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 20.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 20 章已完成项）
- [ ] 任务二（第 20 章待办项）
- [ ] 任务三（第 20 章待办项）

### 20.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-20-0 | 0.0 ms | 20.0 ms | 接近 ⚠️ |
| item-20-1 | 7.3 ms | 26.9 ms | 达标 ✅ |
| item-20-2 | 14.6 ms | 33.8 ms | 接近 ⚠️ |
| item-20-3 | 21.9 ms | 40.7 ms | 达标 ✅ |
| item-20-4 | 29.2 ms | 47.6 ms | 接近 ⚠️ |
| item-20-5 | 36.5 ms | 54.5 ms | 达标 ✅ |
| item-20-6 | 43.8 ms | 61.4 ms | 接近 ⚠️ |
| item-20-7 | 51.1 ms | 68.3 ms | 达标 ✅ |

### 20.3 代码块

```ts
// 20：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 20.4 引用与公式

> 设计原则 20：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 20.5 脚注与链接

本段引用脚注[^note-20]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-20]: 第 20 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 21 章：章节 21

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 21.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 21 章已完成项）
- [ ] 任务二（第 21 章待办项）
- [ ] 任务三（第 21 章待办项）

### 21.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-21-0 | 0.0 ms | 21.0 ms | 接近 ⚠️ |
| item-21-1 | 7.3 ms | 27.9 ms | 达标 ✅ |
| item-21-2 | 14.6 ms | 34.8 ms | 接近 ⚠️ |
| item-21-3 | 21.9 ms | 41.7 ms | 达标 ✅ |
| item-21-4 | 29.2 ms | 48.6 ms | 接近 ⚠️ |
| item-21-5 | 36.5 ms | 55.5 ms | 达标 ✅ |
| item-21-6 | 43.8 ms | 62.4 ms | 接近 ⚠️ |
| item-21-7 | 51.1 ms | 69.3 ms | 达标 ✅ |

### 21.3 代码块

```ts
// 21：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 21.4 引用与公式

> 设计原则 21：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 21.5 脚注与链接

本段引用脚注[^note-21]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-21]: 第 21 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 22 章：章节 22

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 22.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 22 章已完成项）
- [ ] 任务二（第 22 章待办项）
- [ ] 任务三（第 22 章待办项）

### 22.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-22-0 | 0.0 ms | 22.0 ms | 接近 ⚠️ |
| item-22-1 | 7.3 ms | 28.9 ms | 达标 ✅ |
| item-22-2 | 14.6 ms | 35.8 ms | 接近 ⚠️ |
| item-22-3 | 21.9 ms | 42.7 ms | 达标 ✅ |
| item-22-4 | 29.2 ms | 49.6 ms | 接近 ⚠️ |
| item-22-5 | 36.5 ms | 56.5 ms | 达标 ✅ |
| item-22-6 | 43.8 ms | 63.4 ms | 接近 ⚠️ |
| item-22-7 | 51.1 ms | 70.3 ms | 达标 ✅ |

### 22.3 代码块

```ts
// 22：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 22.4 引用与公式

> 设计原则 22：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 22.5 脚注与链接

本段引用脚注[^note-22]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-22]: 第 22 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 23 章：章节 23

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 23.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 23 章已完成项）
- [ ] 任务二（第 23 章待办项）
- [ ] 任务三（第 23 章待办项）

### 23.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-23-0 | 0.0 ms | 23.0 ms | 接近 ⚠️ |
| item-23-1 | 7.3 ms | 29.9 ms | 达标 ✅ |
| item-23-2 | 14.6 ms | 36.8 ms | 接近 ⚠️ |
| item-23-3 | 21.9 ms | 43.7 ms | 达标 ✅ |
| item-23-4 | 29.2 ms | 50.6 ms | 接近 ⚠️ |
| item-23-5 | 36.5 ms | 57.5 ms | 达标 ✅ |
| item-23-6 | 43.8 ms | 64.4 ms | 接近 ⚠️ |
| item-23-7 | 51.1 ms | 71.3 ms | 达标 ✅ |

### 23.3 代码块

```ts
// 23：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 23.4 引用与公式

> 设计原则 23：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 23.5 脚注与链接

本段引用脚注[^note-23]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-23]: 第 23 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 24 章：章节 24

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 24.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 24 章已完成项）
- [ ] 任务二（第 24 章待办项）
- [ ] 任务三（第 24 章待办项）

### 24.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-24-0 | 0.0 ms | 24.0 ms | 接近 ⚠️ |
| item-24-1 | 7.3 ms | 30.9 ms | 达标 ✅ |
| item-24-2 | 14.6 ms | 37.8 ms | 接近 ⚠️ |
| item-24-3 | 21.9 ms | 44.7 ms | 达标 ✅ |
| item-24-4 | 29.2 ms | 51.6 ms | 接近 ⚠️ |
| item-24-5 | 36.5 ms | 58.5 ms | 达标 ✅ |
| item-24-6 | 43.8 ms | 65.4 ms | 接近 ⚠️ |
| item-24-7 | 51.1 ms | 72.3 ms | 达标 ✅ |

### 24.3 代码块

```ts
// 24：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 24.4 引用与公式

> 设计原则 24：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 24.5 脚注与链接

本段引用脚注[^note-24]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-24]: 第 24 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 25 章：章节 25

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 25.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 25 章已完成项）
- [ ] 任务二（第 25 章待办项）
- [ ] 任务三（第 25 章待办项）

### 25.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-25-0 | 0.0 ms | 25.0 ms | 接近 ⚠️ |
| item-25-1 | 7.3 ms | 31.9 ms | 达标 ✅ |
| item-25-2 | 14.6 ms | 38.8 ms | 接近 ⚠️ |
| item-25-3 | 21.9 ms | 45.7 ms | 达标 ✅ |
| item-25-4 | 29.2 ms | 52.6 ms | 接近 ⚠️ |
| item-25-5 | 36.5 ms | 59.5 ms | 达标 ✅ |
| item-25-6 | 43.8 ms | 66.4 ms | 接近 ⚠️ |
| item-25-7 | 51.1 ms | 73.3 ms | 达标 ✅ |

### 25.3 代码块

```ts
// 25：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 25.4 引用与公式

> 设计原则 25：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 25.5 脚注与链接

本段引用脚注[^note-25]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-25]: 第 25 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 26 章：章节 26

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 26.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 26 章已完成项）
- [ ] 任务二（第 26 章待办项）
- [ ] 任务三（第 26 章待办项）

### 26.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-26-0 | 0.0 ms | 26.0 ms | 接近 ⚠️ |
| item-26-1 | 7.3 ms | 32.9 ms | 达标 ✅ |
| item-26-2 | 14.6 ms | 39.8 ms | 接近 ⚠️ |
| item-26-3 | 21.9 ms | 46.7 ms | 达标 ✅ |
| item-26-4 | 29.2 ms | 53.6 ms | 接近 ⚠️ |
| item-26-5 | 36.5 ms | 60.5 ms | 达标 ✅ |
| item-26-6 | 43.8 ms | 67.4 ms | 接近 ⚠️ |
| item-26-7 | 51.1 ms | 74.3 ms | 达标 ✅ |

### 26.3 代码块

```ts
// 26：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 26.4 引用与公式

> 设计原则 26：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 26.5 脚注与链接

本段引用脚注[^note-26]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-26]: 第 26 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 27 章：章节 27

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 27.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 27 章已完成项）
- [ ] 任务二（第 27 章待办项）
- [ ] 任务三（第 27 章待办项）

### 27.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-27-0 | 0.0 ms | 27.0 ms | 接近 ⚠️ |
| item-27-1 | 7.3 ms | 33.9 ms | 达标 ✅ |
| item-27-2 | 14.6 ms | 40.8 ms | 接近 ⚠️ |
| item-27-3 | 21.9 ms | 47.7 ms | 达标 ✅ |
| item-27-4 | 29.2 ms | 54.6 ms | 接近 ⚠️ |
| item-27-5 | 36.5 ms | 61.5 ms | 达标 ✅ |
| item-27-6 | 43.8 ms | 68.4 ms | 接近 ⚠️ |
| item-27-7 | 51.1 ms | 75.3 ms | 达标 ✅ |

### 27.3 代码块

```ts
// 27：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 27.4 引用与公式

> 设计原则 27：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 27.5 脚注与链接

本段引用脚注[^note-27]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-27]: 第 27 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 28 章：章节 28

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 28.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 28 章已完成项）
- [ ] 任务二（第 28 章待办项）
- [ ] 任务三（第 28 章待办项）

### 28.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-28-0 | 0.0 ms | 28.0 ms | 接近 ⚠️ |
| item-28-1 | 7.3 ms | 34.9 ms | 达标 ✅ |
| item-28-2 | 14.6 ms | 41.8 ms | 接近 ⚠️ |
| item-28-3 | 21.9 ms | 48.7 ms | 达标 ✅ |
| item-28-4 | 29.2 ms | 55.6 ms | 接近 ⚠️ |
| item-28-5 | 36.5 ms | 62.5 ms | 达标 ✅ |
| item-28-6 | 43.8 ms | 69.4 ms | 接近 ⚠️ |
| item-28-7 | 51.1 ms | 76.3 ms | 达标 ✅ |

### 28.3 代码块

```ts
// 28：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 28.4 引用与公式

> 设计原则 28：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 28.5 脚注与链接

本段引用脚注[^note-28]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-28]: 第 28 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 29 章：章节 29

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 29.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 29 章已完成项）
- [ ] 任务二（第 29 章待办项）
- [ ] 任务三（第 29 章待办项）

### 29.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-29-0 | 0.0 ms | 29.0 ms | 接近 ⚠️ |
| item-29-1 | 7.3 ms | 35.9 ms | 达标 ✅ |
| item-29-2 | 14.6 ms | 42.8 ms | 接近 ⚠️ |
| item-29-3 | 21.9 ms | 49.7 ms | 达标 ✅ |
| item-29-4 | 29.2 ms | 56.6 ms | 接近 ⚠️ |
| item-29-5 | 36.5 ms | 63.5 ms | 达标 ✅ |
| item-29-6 | 43.8 ms | 70.4 ms | 接近 ⚠️ |
| item-29-7 | 51.1 ms | 77.3 ms | 达标 ✅ |

### 29.3 代码块

```ts
// 29：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 29.4 引用与公式

> 设计原则 29：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 29.5 脚注与链接

本段引用脚注[^note-29]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-29]: 第 29 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 30 章：章节 30

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 30.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 30 章已完成项）
- [ ] 任务二（第 30 章待办项）
- [ ] 任务三（第 30 章待办项）

### 30.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-30-0 | 0.0 ms | 30.0 ms | 接近 ⚠️ |
| item-30-1 | 7.3 ms | 36.9 ms | 达标 ✅ |
| item-30-2 | 14.6 ms | 43.8 ms | 接近 ⚠️ |
| item-30-3 | 21.9 ms | 50.7 ms | 达标 ✅ |
| item-30-4 | 29.2 ms | 57.6 ms | 接近 ⚠️ |
| item-30-5 | 36.5 ms | 64.5 ms | 达标 ✅ |
| item-30-6 | 43.8 ms | 71.4 ms | 接近 ⚠️ |
| item-30-7 | 51.1 ms | 78.3 ms | 达标 ✅ |

### 30.3 代码块

```ts
// 30：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 30.4 引用与公式

> 设计原则 30：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 30.5 脚注与链接

本段引用脚注[^note-30]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-30]: 第 30 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 31 章：章节 31

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 31.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 31 章已完成项）
- [ ] 任务二（第 31 章待办项）
- [ ] 任务三（第 31 章待办项）

### 31.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-31-0 | 0.0 ms | 31.0 ms | 接近 ⚠️ |
| item-31-1 | 7.3 ms | 37.9 ms | 达标 ✅ |
| item-31-2 | 14.6 ms | 44.8 ms | 接近 ⚠️ |
| item-31-3 | 21.9 ms | 51.7 ms | 达标 ✅ |
| item-31-4 | 29.2 ms | 58.6 ms | 接近 ⚠️ |
| item-31-5 | 36.5 ms | 65.5 ms | 达标 ✅ |
| item-31-6 | 43.8 ms | 72.4 ms | 接近 ⚠️ |
| item-31-7 | 51.1 ms | 79.3 ms | 达标 ✅ |

### 31.3 代码块

```ts
// 31：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 31.4 引用与公式

> 设计原则 31：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 31.5 脚注与链接

本段引用脚注[^note-31]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-31]: 第 31 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 32 章：章节 32

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 32.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 32 章已完成项）
- [ ] 任务二（第 32 章待办项）
- [ ] 任务三（第 32 章待办项）

### 32.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-32-0 | 0.0 ms | 32.0 ms | 接近 ⚠️ |
| item-32-1 | 7.3 ms | 38.9 ms | 达标 ✅ |
| item-32-2 | 14.6 ms | 45.8 ms | 接近 ⚠️ |
| item-32-3 | 21.9 ms | 52.7 ms | 达标 ✅ |
| item-32-4 | 29.2 ms | 59.6 ms | 接近 ⚠️ |
| item-32-5 | 36.5 ms | 66.5 ms | 达标 ✅ |
| item-32-6 | 43.8 ms | 73.4 ms | 接近 ⚠️ |
| item-32-7 | 51.1 ms | 80.3 ms | 达标 ✅ |

### 32.3 代码块

```ts
// 32：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 32.4 引用与公式

> 设计原则 32：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 32.5 脚注与链接

本段引用脚注[^note-32]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-32]: 第 32 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 33 章：章节 33

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 33.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 33 章已完成项）
- [ ] 任务二（第 33 章待办项）
- [ ] 任务三（第 33 章待办项）

### 33.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-33-0 | 0.0 ms | 33.0 ms | 接近 ⚠️ |
| item-33-1 | 7.3 ms | 39.9 ms | 达标 ✅ |
| item-33-2 | 14.6 ms | 46.8 ms | 接近 ⚠️ |
| item-33-3 | 21.9 ms | 53.7 ms | 达标 ✅ |
| item-33-4 | 29.2 ms | 60.6 ms | 接近 ⚠️ |
| item-33-5 | 36.5 ms | 67.5 ms | 达标 ✅ |
| item-33-6 | 43.8 ms | 74.4 ms | 接近 ⚠️ |
| item-33-7 | 51.1 ms | 81.3 ms | 达标 ✅ |

### 33.3 代码块

```ts
// 33：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 33.4 引用与公式

> 设计原则 33：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 33.5 脚注与链接

本段引用脚注[^note-33]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-33]: 第 33 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 34 章：章节 34

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 34.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 34 章已完成项）
- [ ] 任务二（第 34 章待办项）
- [ ] 任务三（第 34 章待办项）

### 34.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-34-0 | 0.0 ms | 34.0 ms | 接近 ⚠️ |
| item-34-1 | 7.3 ms | 40.9 ms | 达标 ✅ |
| item-34-2 | 14.6 ms | 47.8 ms | 接近 ⚠️ |
| item-34-3 | 21.9 ms | 54.7 ms | 达标 ✅ |
| item-34-4 | 29.2 ms | 61.6 ms | 接近 ⚠️ |
| item-34-5 | 36.5 ms | 68.5 ms | 达标 ✅ |
| item-34-6 | 43.8 ms | 75.4 ms | 接近 ⚠️ |
| item-34-7 | 51.1 ms | 82.3 ms | 达标 ✅ |

### 34.3 代码块

```ts
// 34：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 34.4 引用与公式

> 设计原则 34：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 34.5 脚注与链接

本段引用脚注[^note-34]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-34]: 第 34 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 35 章：章节 35

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 35.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 35 章已完成项）
- [ ] 任务二（第 35 章待办项）
- [ ] 任务三（第 35 章待办项）

### 35.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-35-0 | 0.0 ms | 35.0 ms | 接近 ⚠️ |
| item-35-1 | 7.3 ms | 41.9 ms | 达标 ✅ |
| item-35-2 | 14.6 ms | 48.8 ms | 接近 ⚠️ |
| item-35-3 | 21.9 ms | 55.7 ms | 达标 ✅ |
| item-35-4 | 29.2 ms | 62.6 ms | 接近 ⚠️ |
| item-35-5 | 36.5 ms | 69.5 ms | 达标 ✅ |
| item-35-6 | 43.8 ms | 76.4 ms | 接近 ⚠️ |
| item-35-7 | 51.1 ms | 83.3 ms | 达标 ✅ |

### 35.3 代码块

```ts
// 35：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 35.4 引用与公式

> 设计原则 35：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 35.5 脚注与链接

本段引用脚注[^note-35]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-35]: 第 35 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 36 章：章节 36

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 36.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 36 章已完成项）
- [ ] 任务二（第 36 章待办项）
- [ ] 任务三（第 36 章待办项）

### 36.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-36-0 | 0.0 ms | 36.0 ms | 接近 ⚠️ |
| item-36-1 | 7.3 ms | 42.9 ms | 达标 ✅ |
| item-36-2 | 14.6 ms | 49.8 ms | 接近 ⚠️ |
| item-36-3 | 21.9 ms | 56.7 ms | 达标 ✅ |
| item-36-4 | 29.2 ms | 63.6 ms | 接近 ⚠️ |
| item-36-5 | 36.5 ms | 70.5 ms | 达标 ✅ |
| item-36-6 | 43.8 ms | 77.4 ms | 接近 ⚠️ |
| item-36-7 | 51.1 ms | 84.3 ms | 达标 ✅ |

### 36.3 代码块

```ts
// 36：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 36.4 引用与公式

> 设计原则 36：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 36.5 脚注与链接

本段引用脚注[^note-36]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-36]: 第 36 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 37 章：章节 37

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 37.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 37 章已完成项）
- [ ] 任务二（第 37 章待办项）
- [ ] 任务三（第 37 章待办项）

### 37.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-37-0 | 0.0 ms | 37.0 ms | 接近 ⚠️ |
| item-37-1 | 7.3 ms | 43.9 ms | 达标 ✅ |
| item-37-2 | 14.6 ms | 50.8 ms | 接近 ⚠️ |
| item-37-3 | 21.9 ms | 57.7 ms | 达标 ✅ |
| item-37-4 | 29.2 ms | 64.6 ms | 接近 ⚠️ |
| item-37-5 | 36.5 ms | 71.5 ms | 达标 ✅ |
| item-37-6 | 43.8 ms | 78.4 ms | 接近 ⚠️ |
| item-37-7 | 51.1 ms | 85.3 ms | 达标 ✅ |

### 37.3 代码块

```ts
// 37：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 37.4 引用与公式

> 设计原则 37：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 37.5 脚注与链接

本段引用脚注[^note-37]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-37]: 第 37 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 38 章：章节 38

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 38.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 38 章已完成项）
- [ ] 任务二（第 38 章待办项）
- [ ] 任务三（第 38 章待办项）

### 38.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-38-0 | 0.0 ms | 38.0 ms | 接近 ⚠️ |
| item-38-1 | 7.3 ms | 44.9 ms | 达标 ✅ |
| item-38-2 | 14.6 ms | 51.8 ms | 接近 ⚠️ |
| item-38-3 | 21.9 ms | 58.7 ms | 达标 ✅ |
| item-38-4 | 29.2 ms | 65.6 ms | 接近 ⚠️ |
| item-38-5 | 36.5 ms | 72.5 ms | 达标 ✅ |
| item-38-6 | 43.8 ms | 79.4 ms | 接近 ⚠️ |
| item-38-7 | 51.1 ms | 86.3 ms | 达标 ✅ |

### 38.3 代码块

```ts
// 38：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 38.4 引用与公式

> 设计原则 38：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 38.5 脚注与链接

本段引用脚注[^note-38]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-38]: 第 38 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 39 章：章节 39

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 39.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 39 章已完成项）
- [ ] 任务二（第 39 章待办项）
- [ ] 任务三（第 39 章待办项）

### 39.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-39-0 | 0.0 ms | 39.0 ms | 接近 ⚠️ |
| item-39-1 | 7.3 ms | 45.9 ms | 达标 ✅ |
| item-39-2 | 14.6 ms | 52.8 ms | 接近 ⚠️ |
| item-39-3 | 21.9 ms | 59.7 ms | 达标 ✅ |
| item-39-4 | 29.2 ms | 66.6 ms | 接近 ⚠️ |
| item-39-5 | 36.5 ms | 73.5 ms | 达标 ✅ |
| item-39-6 | 43.8 ms | 80.4 ms | 接近 ⚠️ |
| item-39-7 | 51.1 ms | 87.3 ms | 达标 ✅ |

### 39.3 代码块

```ts
// 39：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 39.4 引用与公式

> 设计原则 39：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 39.5 脚注与链接

本段引用脚注[^note-39]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-39]: 第 39 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


## 第 40 章：章节 40

本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。

### 40.1 列表与任务清单

- 分块渲染：按标题切块，懒渲染视口外章节
- 语法高亮：仅高亮视口内代码块
- 表格：固定表头 + 行虚拟化
- [x] 任务一（第 40 章已完成项）
- [ ] 任务二（第 40 章待办项）
- [ ] 任务三（第 40 章待办项）

### 40.2 表格（8 行）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| item-40-0 | 0.0 ms | 40.0 ms | 接近 ⚠️ |
| item-40-1 | 7.3 ms | 46.9 ms | 达标 ✅ |
| item-40-2 | 14.6 ms | 53.8 ms | 接近 ⚠️ |
| item-40-3 | 21.9 ms | 60.7 ms | 达标 ✅ |
| item-40-4 | 29.2 ms | 67.6 ms | 接近 ⚠️ |
| item-40-5 | 36.5 ms | 74.5 ms | 达标 ✅ |
| item-40-6 | 43.8 ms | 81.4 ms | 接近 ⚠️ |
| item-40-7 | 51.1 ms | 88.3 ms | 达标 ✅ |

### 40.3 代码块

```ts
// 40：类型化事件总线示例（每章同构，语法多样性模板）
type EventMap = Record<string, unknown[]>;
interface Emitter<E extends EventMap> {
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;
  emit<K extends keyof E>(event: K, ...args: E[K]): void;
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;
}
class Bus<E extends EventMap> implements Emitter<E> {
  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();
  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as (...args: never[]) => void);
    this.handlers.set(event, set);
    return () => set.delete(fn as (...args: never[]) => void);
  }
  emit<K extends keyof E>(event: K, ...args: E[K]): void {
    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));
  }
  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const off = this.on(event, (...args) => { off(); fn(...args); });
  }
}
```

### 40.4 引用与公式

> 设计原则 40：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5

行内公式 $E = mc^2$ 与块级公式：

$$
\int_{0}^{\infty} f(x)\,dx = \lim_{n \to \infty} \sum_{k=1}^{n} f(x_k)\,\Delta x
$$

### 40.5 脚注与链接

本段引用脚注[^note-40]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。

[^note-40]: 第 40 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。


---

> 结束。fixture 生成确定性：同版本生成器输出逐字节一致。
