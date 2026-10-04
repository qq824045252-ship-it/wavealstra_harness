---
name: grid-generator
description: |
  为选中的 Frame 生成 0.1px 极细像素网格，用于对齐辅助。
  当用户想画网格、加参考线、检查像素对齐时使用。
  Triggers: "加网格", "生成网格", "对齐网格", "画个 grid",
  "show grid", "add grid", "像素对齐", "pixel grid".
metadata:
  version: "0.3.1"
  author: ardot-team
---

# Grid Generator

在选中的 Frame **同级**生成一个同位置、同尺寸的像素网格图层。网格
使用 0.1px 的极细 line 节点，不影响设计稿视觉密度。

## ⚠️ 硬约束（违反会导致功能完全错误，必须遵守）

本 skill 的核心价值在于"极细的 line 网格"。下面这些约束是**强制
的**，无论你之前训练时见过什么"画网格"的常规写法，本 skill 都必须
按以下规则执行：

| 维度 | ✅ 必须 | ❌ 禁止 |
|---|---|---|
| 节点类型 | `type: "line"` | `type: "rectangle"`、`type: "frame"` 当线用 |
| 线宽 | `strokeWeight: 0.1`（小数 0.1，不是 1） | `strokeWeight: 1`、或用矩形的 `width/height: 1` 模拟 |
| 颜色机制 | `strokes` + `strokeWeight` | `fills`（line 不接受 fills，会变成不可见） |
| 方向 | `rotation: 0` 横线 / `rotation: 90` 竖线 | 用 width vs height 比例模拟方向 |

**为什么不能用 rectangle**：rectangle 在很小的线宽（如 0.1px）下，
Ardot 渲染时会消除子像素，导致显示不出来；line 节点的 strokeWeight
是矢量描边，0.1 能正确显示为发丝级参考线。

**为什么不能用 fills**：line 节点的视觉表现完全由 strokes 控制，
fills 在 line 上无效。如果你在 line 上写 fills，结果是一根透明
不可见的线。

如果你"觉得用 rectangle 更直接 / 更熟悉"，请停止这个念头，按本
skill 的规则执行。完整写法见 Step 5。

## When to use

- 设计稿需要对齐到 4 / 8 / 16 像素的栅格
- 想快速校验布局间距是否符合规范
- 想给自己加个临时的视觉参考

## When NOT to use

- 想要列网格（columns）—— 本 skill 只做均匀像素网格
- 想要修改目标 Frame 本身 —— 本 skill 不会动目标 Frame
- 想要可导出的网格 —— 生成的 grid 是普通图层，导出时会显示

## Workflow

### Step 1 — 拿到目标 Frame

调用 `fetch_editor_state`（设置 `includeSchema: false`、
`includeGeneralEditInstructions: false`）。

判断当前选区：

- **有选区且全部都是 Frame**：**所有**选中的 Frame 都作为目标，逐个生成 grid（不要只处理第一个！）
- **有选区但混合了非 Frame 节点**：只处理其中是 Frame 的那些，并在最终报告里说明"忽略了 N 个非 Frame 节点"
- **有选区但全部不是 Frame**（比如选中了矩形、文字）：告诉用户
  "请选中至少一个 Frame，本 skill 只能为 Frame 生成网格" 然后停下
- **没有选区**：告诉用户 "请先选中一个或多个 Frame" 然后停下

⚠️ **重要**：如果选了 N 个 Frame，本 skill 要为每一个 Frame 都
生成一个独立的 grid 图层，**一个都不能漏**。Step 2 ~ Step 7 整个
流程要对每个 Frame 重复一遍（或者一次性收集完所有 gridSize 再批量
执行）。

对每个目标 Frame 记录：
- `id`（用于后续 batch_edit 的 parent 引用 / 同级插入定位）
- `name`（用于报告）
- `x` / `y` / `width` / `height`（用于网格尺寸计算）
- `parent.id`（用于把 grid 插到同一个父节点下）

### Step 2 — 让用户选网格密度

对每个目标 Frame，调用 `AskUserQuestion`，问网格大小：

- 选项：`4px`、`8px`（默认推荐）、`16px`、`24px`、`自定义`
- 单选
- 如果用户选了"自定义"：再问一次让用户输入数字。**必须在提问时
  显式告知用户合法范围**：
  - 计算 `maxGridSize = floor(min(frameWidth, frameHeight) / 2)`
  - 提示文案示例：
    "请输入网格大小（合法范围 1 ~ {maxGridSize}px，超出范围则
    无法画出任何网格线）。"
- 如果用户输入超出范围（小于 1 或大于 maxGridSize）：
  - **不要默默拒绝再问**，要明确告知 "{用户输入} 超出合法范围
    1 ~ {maxGridSize}px，请重新输入"
  - 然后再次询问
- 如果用户输入恰好等于 maxGridSize 或更接近边界值（比如 1200×800
  画布、用户输入 400）：**直接接受**，不要因为"线太少"而拒绝。
  400 在 1 ~ 400 范围内是合法的（因为 800/2 = 400），应正常进入
  Step 3。

把用户为每个 Frame 选择的网格大小记为 `gridSize`。

#### 合法范围的算例

- frame = 1200 × 800：maxGridSize = min(1200, 800) / 2 = 400 →
  允许输入 1 ~ 400
- frame = 373 × 173：maxGridSize = min(373, 173) / 2 = 86 →
  允许输入 1 ~ 86
- 任何超出此范围的输入都要明确报错并允许重输

### Step 3 — 算出网格线的坐标

**原则**：第一根线从 `gridSize` 开始（不是从 0 开始），之后每隔
`gridSize` 一根，只要坐标还在 Frame 范围内就继续画。

不要"留白"、不要"考虑边距"、不要"觉得太靠边就跳过"。

#### 横线（y 坐标列表）

```
y = gridSize, 2*gridSize, 3*gridSize, ...
所有满足 0 < y <= frameHeight 的位置都要画
```

#### 竖线（x 坐标列表）

```
x = gridSize, 2*gridSize, 3*gridSize, ...
所有满足 0 < x <= frameWidth 的位置都要画
```

#### 边界处理

- 如果某根线的位置正好等于 frameHeight / frameWidth（比如 frame
  高 160、gridSize 16，第 10 根 y=160），**这根线要画**。
- 不要因为"太靠边"就跳过任何一根线。

#### 算例（必读）

**例 1**：frame = 100 × 100，gridSize = 4

横线 y 坐标：`4, 8, 12, 16, ..., 96, 100`
→ 25 根横线（4 到 100 步长 4）

竖线 x 坐标：`4, 8, 12, ..., 96, 100`
→ 25 根竖线

**例 2**：frame = 373 × 173，gridSize = 24

横线 y 坐标：
- 24, 48, 72, 96, 120, 144, 168 都 ≤ 173 ✓
- 192 > 173 ✗ 停止

→ 7 根横线

竖线 x 坐标：
- 24, 48, ..., 360 都 ≤ 373 ✓
- 384 > 373 ✗ 停止

→ 15 根竖线

**例 3**（大间距）：frame = 1200 × 800，gridSize = 400

横线 y 坐标：400, 800 都 ≤ 800 ✓ → **2 根横线**（不要漏掉 y=800
那根！它恰好等于 frameHeight，必须画）

竖线 x 坐标：400, 800, 1200 都 ≤ 1200 ✓ → **3 根竖线**（同理
不要漏掉 x=1200 那根）

总共 5 根线，正常进入下一步——**不要因为"线少"就拒绝**。

#### 自验证公式（必做）

算完 y 列表和 x 列表后，必须用下面的公式核对一遍，**对不上就重算**：

```
预期横线数 = floor(frameHeight / gridSize)
预期竖线数 = floor(frameWidth / gridSize)
```

- 例 1：100 × 100 / 4 → 横线 floor(100/4)=25，竖线 floor(100/4)=25 ✓
- 例 2：373 × 173 / 24 → 横线 floor(173/24)=7，竖线 floor(373/24)=15 ✓
- 例 3：1200 × 800 / 400 → 横线 floor(800/400)=2，竖线 floor(1200/400)=3 ✓

⚠️ **如果你算出的 y/x 列表长度跟公式不一致，说明算错了**：
- 大概率是漏掉了"恰好等于 frameWidth/Height"那一根
- 或者多算了一根超过 frame 范围的
- 必须**回去重新枚举一遍** y/x 坐标，直到列表长度等于公式预期

#### 软上限检查

```
totalLines = horizontalLineCount + verticalLineCount
```

如果 `totalLines > 200`：
- 用 `AskUserQuestion` 提示用户："网格会生成 N 根线，可能影响画布
  性能，是否继续？"
- 用户选"取消" → 停止
- 用户选"继续" → 进入 Step 3.5

`totalLines <= 200` 的话直接进入 Step 3.5。

### Step 3.5 — 必须先报告再画（防止漏画）

在进入 Step 4 创建任何节点之前，你必须先用一段话向用户报告：

```
即将生成网格：
- 目标 Frame：[name]，尺寸 [width] × [height]
- 网格大小：[gridSize]px
- 横线 [horizontalLineCount] 根，y 坐标列表：[4, 8, 12, ...]
- 竖线 [verticalLineCount] 根，x 坐标列表：[4, 8, 12, ...]
- 总根数：[totalLines] 根，分 [batchCount] 批提交
```

**用户不需要确认**，你报告完直接进入 Step 4。这一步的目的是让用户
能在画完之后核对："列表里报告的根数 = 画布上实际看到的根数"。

如果你跳过这一步直接开始画，用户没法验证你画的对不对。所以这一步
是强制的。

### Step 4 — 创建 grid Frame 容器

用 `batch_edit` 创建一个新 Frame，参数：

- `parent`：目标 Frame 的 `parent.id`（同级插入）
- `name`：`grid`
- `x` / `y`：跟目标 Frame 完全一致
- `width` / `height`：跟目标 Frame 完全一致
- `fills`：`[]`（不填充）
- `clipsContent`：true（网格超出边界时被裁掉）

记录新创建的 grid Frame 的 `id` 为 `gridFrameId`。

### Step 5 — 在 grid Frame 里用 line 节点画网格线

**⚠️ 再次提醒（重要）**：

> 网格线**只能**用 `type: "line"` + `strokeWeight: 0.1`。
>
> 在你的训练语料里，"画网格"最常见的实现是用细矩形（rectangle
> with width/height=1）。在本 skill 中，这种实现是**错误的**，
> 渲染会出问题。请严格按本 Step 给出的代码模板执行，不要"凭经验"
> 改成 rectangle。

**注意：本步可能涉及大量节点，必须分批提交。每次 batch_edit 提交
≤ 25 个 op（Ardot 上限），保守起见建议 ≤ 20 个，提交后用
`batch_read` 验证。**

#### 5.1 line 节点的写法

Ardot 的 `line` 节点：
- **height 恒为 0**（不要传 height，传了也会被忽略）
- **width = 线的长度**
- **rotation 决定方向**：`0` = 水平向右，`90` = 垂直向下
- **(x, y) = line 的起点**（不是中心）
- 颜色用 `strokes`，**线宽用 `strokeWeight`**（fills 对 line 无效）

每根线的样式（线宽 0.1px、半透明红）：

```javascript
strokes: [{
  type: "SOLID",
  color: { r: 1, g: 0, b: 0 },
  opacity: 0.5,
  visible: true,
  blendMode: "NORMAL"
}],
strokeWeight: 0.1
```

#### 5.2 横线写法

每一根横线（y 来自 Step 3 的横线列表）：

```javascript
hLine=I(gridFrameId, {
  type: "line",
  name: "h-line@y" + y,
  x: 0,
  y: <y>,
  width: <frameWidth>,
  rotation: 0,
  strokeWeight: 0.1,
  strokes: [{ type: "SOLID", color: {r: 1, g: 0, b: 0}, opacity: 0.5, visible: true, blendMode: "NORMAL" }]
})
```

#### 5.3 竖线写法

每一根竖线（x 来自 Step 3 的竖线列表）：

```javascript
vLine=I(gridFrameId, {
  type: "line",
  name: "v-line@x" + x,
  x: <x>,
  y: 0,
  width: <frameHeight>,
  rotation: 90,
  strokeWeight: 0.1,
  strokes: [{ type: "SOLID", color: {r: 1, g: 0, b: 0}, opacity: 0.5, visible: true, blendMode: "NORMAL" }]
})
```

**重要**：竖线的 `width` 字段填的是 **frameHeight**（line 沿 +y
方向延伸 frameHeight 长度），不是 frameWidth。这是 line 节点的特性：
width 永远代表"线的长度"，方向靠 rotation 控制。

#### 5.4 分批提交

把所有线分组，每组 ≤ 20 根，逐批用 `batch_edit` 提交，parent 设为
`gridFrameId`。

每批提交完成后：
- 调用 `batch_read` 读 `gridFrameId` 的子节点数量
- 跟"已提交的累计根数"对比
- 数量不对 → 进入"失败处理"（5.5）

不要再次"检查坐标是否在范围内"——Step 3 已经保证了。直接画 Step 3
给出的所有坐标。

#### 5.5 失败处理

如果某一批提交失败 / 验证不通过：
- 用 `batch_edit` 执行 `D(gridFrameId)` 把整个 grid Frame 删掉
- 告诉用户"生成网格时出错（具体错误信息），已清理"
- 不要 retry

### Step 6 — 锁定 grid Frame

所有线提交完毕，验证通过后：

用 `batch_edit` 更新 grid Frame：

```
U(gridFrameId, { locked: true })
```

锁定的目的：避免用户操作目标 Frame 时误选到网格。用户要删除时，
在图层面板找到 grid，右键解锁后删除即可。

⚠️ **多 Frame 情况下必须每个都锁定**：如果 Step 1 处理了 N 个
Frame、对应生成了 N 个 grid Frame，那么这一步要把**所有** N 个
gridFrameId 都执行一遍锁定操作（可以放在同一个 batch_edit 里一次
提交），**一个都不能漏**。漏锁会导致用户在选目标 Frame 时仍然误
选到那个没锁的 grid。

### Step 7 — 报告

最终告诉用户：

```
已为 N 个 Frame 生成 grid 图层：

1. [目标 Frame 1 名]
   - 网格大小：[gridSize]px
   - 共 [horizontalLineCount] 根横线 + [verticalLineCount] 根竖线
   - 已锁定 ✓

2. [目标 Frame 2 名]
   - ...

线宽统一为 0.1px（半透明红）。
删除时请在图层面板取消锁定后 Delete 对应的 grid 层。
```

如果只处理了 1 个 Frame，报告可以简化为：

```
已在 [目标 Frame 名] 旁边生成 grid 图层
- 网格大小：[gridSize]px
- 线宽：0.1px（半透明红）
- 共 [horizontalLineCount] 根横线 + [verticalLineCount] 根竖线
- 图层已锁定，删除时请在图层面板取消锁定后 Delete grid 层
```

## Out of scope

- 不做列网格（columns） / 行网格（rows）—— 想要的话见
  `references/advanced-grids.md`
- 不做"删除网格"功能 —— grid 是普通同级图层，用 Ardot 原生
  Delete 即可
- 不修改目标 Frame 本身
- 不做跨多个 Frame 批量加网格
- 不做颜色 / 线宽定制（如果需要，生成后手动改 grid 层属性）

## Reference materials

- `references/advanced-grids.md` — 介绍列网格、行网格的实现思路，
  本 skill 不实现，但用户想自己扩展时可以参考。**Workflow 不会
  主动读这个文件**，仅作为拓展资料。

## Notes

### 关于 line 节点（必读）

Ardot 的 `line` 节点跟 rectangle 有几个关键差异，写错容易出怪事：

| 属性 | line 的行为 |
|---|---|
| `width` | 线的"长度"，跟方向无关 |
| `height` | 恒为 0，传了也会被忽略 |
| `rotation` | 决定方向，`0` = 水平向右，`90` = 垂直向下 |
| `(x, y)` | 线的起点，不是中心 |
| 颜色 | 用 `strokes` + `strokeWeight`，**不能用 fills** |
| `strokeWeight` | 可以是小数，0.1 是本 skill 的目标值 |

### 关于线宽 0.1px

0.1px 的线在常规缩放下接近"发丝级"，叠在设计稿上几乎不会干扰视觉，
又能在放大时清楚地看到栅格。这是相对 1px 实线最大的改进。

### 关于性能

line 节点比 rectangle 渲染开销略低，但节点数仍然要控制。本 skill
在 Step 3 做了 200 根线的软上限和确认环节，如果用户坚持生成大网格，
画布卡顿是预期内的。

### 关于颜色

网格颜色固定为半透明红 `rgba(255,0,0,0.5)` + 0.1px 线宽，是设计圈
较通用的"参考线"风格，跟绝大多数设计稿主色不容易冲突。如需换色，
可以生成完后手动选中 grid Frame 内任意 line 改 strokes。

### 关于 batch_edit 分批

Step 5 必须分批提交并验证。Ardot 单次 batch_edit 上限是 25 op，
本 skill 保守用 20。原因：即使 batch_edit 单次失败会回滚整个 block，
**跨 batch 之间**的"半成品"风险仍然存在——比如第 3 批失败，前 2 批
已经画进画布了。详见 Ardot Skill 开发指南 2.3 节"batch_edit 弱事务"
小节。
