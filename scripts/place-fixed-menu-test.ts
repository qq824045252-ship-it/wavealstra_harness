import assert from "node:assert/strict";
import { placeFixedMenu, placeFixedSideFlyout, placeStackOrSide, toLayoutRect } from "../src/renderer/src/lib/placeFixedMenu";

const viewport = { width: 280, height: 720 };

{
  // 中部：朝下，右对齐锚点
  const placed = placeFixedMenu({
    anchor: { top: 200, bottom: 224, left: 200, right: 224 },
    menuWidth: 200,
    menuHeight: 360,
    viewport,
    minWidth: 200,
    maxHeight: 420,
    align: "end",
  });
  assert.equal(placed.openUp, false);
  assert.equal(placed.top, 228);
  assert.equal(placed.left, 24);
  assert.ok(placed.maxHeight >= 360);
}

{
  // 贴底：下方不够整页菜单 → 翻到上方，且底边不越出窗口
  const placed = placeFixedMenu({
    anchor: { top: 640, bottom: 664, left: 200, right: 224 },
    menuWidth: 200,
    menuHeight: 380,
    viewport,
    minWidth: 200,
    maxHeight: 420,
    align: "end",
  });
  assert.equal(placed.openUp, true);
  assert.ok(placed.top >= 8, `top ${placed.top} should stay in viewport`);
  assert.ok(
    placed.top + Math.min(380, placed.maxHeight) <= viewport.height - 8,
    `menu bottom overflows: top=${placed.top} maxH=${placed.maxHeight}`,
  );
  assert.ok(placed.maxHeight >= 360, `maxHeight ${placed.maxHeight} should fit the menu above`);
}

{
  // 窗口极矮：仍夹在视口内，允许内部滚动
  const short = { width: 280, height: 200 };
  const placed = placeFixedMenu({
    anchor: { top: 160, bottom: 184, left: 200, right: 224 },
    menuWidth: 200,
    menuHeight: 380,
    viewport: short,
    minWidth: 200,
    maxHeight: 420,
    align: "end",
  });
  assert.ok(placed.top >= 8);
  assert.ok(placed.top + placed.maxHeight <= short.height - 8 + 0.5);
}

{
  // 左侧不够时不要出屏
  const placed = placeFixedMenu({
    anchor: { top: 200, bottom: 224, left: 4, right: 28 },
    menuWidth: 200,
    menuHeight: 120,
    viewport: { width: 180, height: 720 },
    minWidth: 200,
    align: "end",
  });
  assert.equal(placed.left, 8);
}

{
  // 列表贴右：flyout 必须完整落在 avoid 左侧，不能盖住模型行
  const popup = { top: 200, bottom: 520, left: 560, right: 840 };
  const row = { top: 460, bottom: 496, left: 568, right: 832 };
  const placed = placeFixedSideFlyout({
    row,
    avoid: popup,
    flyoutWidth: 200,
    flyoutHeight: 160,
    viewport: { width: 1100, height: 800 },
  });
  assert.ok(placed.left + 200 <= popup.left, `flyout overlaps popup: left=${placed.left}`);
  assert.ok(placed.left >= 8, `flyout off-screen left: ${placed.left}`);
  assert.equal(placed.top, row.top);
}

{
  // 左侧不够、右侧够：放到列表右侧
  const popup = { top: 200, bottom: 400, left: 16, right: 200 };
  const row = { top: 240, bottom: 276, left: 20, right: 196 };
  const placed = placeFixedSideFlyout({
    row,
    avoid: popup,
    flyoutWidth: 200,
    flyoutHeight: 120,
    viewport: { width: 480, height: 720 },
  });
  assert.ok(placed.left >= popup.right, `expected right of popup, left=${placed.left}`);
}

{
  // 左右都不够：改放到列表上方，仍不与 avoid 相交
  const popup = { top: 300, bottom: 620, left: 40, right: 420 };
  const row = { top: 560, bottom: 596, left: 48, right: 412 };
  const placed = placeFixedSideFlyout({
    row,
    avoid: popup,
    flyoutWidth: 200,
    flyoutHeight: 140,
    viewport: { width: 460, height: 720 },
  });
  const overlaps =
    placed.left < popup.right &&
    placed.left + 200 > popup.left &&
    placed.top < popup.bottom &&
    placed.top + 140 > popup.top;
  assert.equal(overlaps, false, `narrow viewport still overlaps: ${JSON.stringify(placed)}`);
  assert.ok(placed.top + 140 <= popup.top + 0.5, `should sit above popup, top=${placed.top}`);
}

{
  // alignOffset：侧向放置时让内部「思考强度」行与模型行顶对齐
  const popup = { top: 200, bottom: 520, left: 560, right: 840 };
  const row = { top: 460, bottom: 496, left: 568, right: 832 };
  const placed = placeFixedSideFlyout({
    row,
    avoid: popup,
    flyoutWidth: 200,
    flyoutHeight: 80,
    alignOffset: 36,
    viewport: { width: 1100, height: 800 },
  });
  assert.equal(placed.top, row.top - 36);
  assert.ok(placed.left + 200 <= popup.left, `flyout overlaps popup: left=${placed.left}`);
}

{
  const preview = { top: 360, left: 200, width: 220, height: 80 };
  const below = placeStackOrSide({
    preview,
    menuWidth: 200,
    menuHeight: 56,
    viewport: { width: 1100, height: 800 },
  });
  assert.equal(below.top, 446);
  assert.equal(below.left, 200);
  assert.ok(below.top >= preview.top + preview.height);
}

{
  // 下方不够：改到预览卡左侧，不重叠，且不超出视口
  const preview = { top: 640, left: 280, width: 220, height: 80 };
  const side = placeStackOrSide({
    preview,
    menuWidth: 200,
    menuHeight: 160,
    viewport: { width: 900, height: 720 },
  });
  assert.equal(side.left, 280 - 6 - 200);
  assert.ok(side.left + 200 <= preview.left);
  assert.ok(side.top >= 8);
  assert.ok(side.top + 160 <= 720 - 8);
}

{
  // CSS zoom：视觉矩形必须先换算成布局坐标，flyout 顶边才与模型行对齐
  const zoom = 1.05;
  const rowVisual = { top: 210, bottom: 247.8, left: 588, right: 882 };
  const popupVisual = { top: 160, bottom: 520, left: 580, right: 874 };
  const row = toLayoutRect(rowVisual, zoom);
  const popup = toLayoutRect(popupVisual, zoom);
  assert.equal(row.top, 200);
  assert.equal(popup.left, 580 / zoom);
  const placed = placeFixedSideFlyout({
    row,
    avoid: popup,
    flyoutWidth: 220,
    flyoutHeight: 80,
    viewport: { width: 1100 / zoom, height: 800 / zoom },
  });
  assert.equal(placed.top, row.top);
  assert.equal(placed.left, popup.left - 6 - 220);
  assert.ok(placed.left + 220 <= popup.left);
}

{
  const same = toLayoutRect({ top: 10, bottom: 20, left: 30, right: 40 }, 1);
  assert.equal(same.top, 10);
  assert.equal(same.left, 30);
}

console.log("place-fixed-menu-test: ok");
