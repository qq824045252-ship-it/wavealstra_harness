# 进阶：列网格 / 行网格的实现思路

本 skill v0.1 只做单位网格（uniform grid）。如果你想扩展成列
网格或行网格，可以参考下面的思路自己改造。

## 列网格（Columns）

常用于 Web / 移动端布局，按列数 + 间距 + 边距划分。

### 参数

- `columnCount`：列数（4 / 8 / 12 / 16 常见）
- `margin`：左右边距
- `gutter`：列之间的间距

### 列宽计算

```
columnWidth = (frameWidth - margin * 2 - gutter * (columnCount - 1)) / columnCount
```

如果算出来 columnWidth < 0，说明 Frame 太窄，参数不合理。

### 矩形位置

```
第 i 列的 x 坐标 = margin + (columnWidth + gutter) * i
```

### 颜色

跟单位网格不同，列网格通常用半透明蓝或半透明粉来跟单位网格区分。
建议 `rgba(0, 100, 255, 0.1)`。

## 行网格（Rows）

跟列网格对称，用于垂直节奏对齐。把上面公式里的 width 换成 height、
margin 换成上下边距即可。

## 同时生成多种网格

如果用户想要列网格 + 行网格叠加，可以在 grid Frame 里建两个子
Frame，分别叫 `columns` 和 `rows`，分别画。这样用户可以单独显示
/ 隐藏某一层。

## 关于性能

矩形数量没有上限规定，但 Ardot 画布在节点数 > 500 时可能开始卡。
设计时要做好节点数估算和软上限。
