import assert from "node:assert/strict";
import {
  clampThinkingLevel,
  defaultOnThinkingLevel,
  resolveThinkingLevels,
} from "../src/shared/thinking-levels";

console.log("== resolveThinkingLevels ==");
{
  assert.deepEqual(resolveThinkingLevels({}), [], "无 reasoning、无 map → 空");
  assert.deepEqual(
    resolveThinkingLevels({ reasoning: false }),
    [],
    "reasoning=false 无 map → 空",
  );
  assert.deepEqual(
    resolveThinkingLevels({ reasoning: true }),
    [],
    "推理模型无显式 map → 不发明通用档位",
  );
  assert.deepEqual(
    resolveThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { minimal: null, high: "high", max: "max" },
    }),
    ["high", "max"],
    "只返回显式非 null 档位",
  );
  assert.deepEqual(
    resolveThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { high: "high", balanced: "balanced" },
    }),
    ["high", "balanced"],
    "自定义 key 追加，但不补未声明标准档",
  );
  assert.deepEqual(
    resolveThinkingLevels({
      reasoning: false,
      thinkingLevelMap: { off: "off", high: "high" },
    }),
    ["off", "high"],
    "非推理但 models.json 显式写了 map → 只用声明 key",
  );
  assert.deepEqual(
    resolveThinkingLevels({
      reasoning: true,
      compat: { reasoningEffortMap: { low: "low", high: "high" } },
    }),
    ["low", "high"],
    "无 thinkingLevelMap 时回退 reasoningEffortMap",
  );
}

console.log("== clampThinkingLevel ==");
{
  assert.equal(clampThinkingLevel("high", ["off", "low", "medium", "high"]), "high", "保持");
  assert.equal(
    clampThinkingLevel("xhigh", ["off", "minimal", "low", "medium", "high"]),
    "high",
    "xhigh 就近落到 high，而不是第一档 off",
  );
  assert.equal(clampThinkingLevel("off", []), "off", "无档位 → off");
  assert.equal(clampThinkingLevel("", ["off", "high"]), "off", "空值优先 off");
  assert.equal(
    clampThinkingLevel("max", ["low", "medium", "high"]),
    "high",
    "更高档不支持时向下夹",
  );
}

console.log("== defaultOnThinkingLevel ==");
{
  assert.equal(defaultOnThinkingLevel(["off", "low", "medium", "high"]), "medium", "默认 medium");
  assert.equal(
    defaultOnThinkingLevel(["off", "low", "medium", "high"], "high"),
    "high",
    "保留已选非 off",
  );
  assert.equal(defaultOnThinkingLevel(["off", "high", "max"]), "high", "无 medium 用第一档非 off");
  assert.equal(defaultOnThinkingLevel(["off"]), "off", "只有 off → off");
  assert.equal(defaultOnThinkingLevel([]), "off", "无档位 → off");
  assert.equal(
    defaultOnThinkingLevel(["off", "low", "high"], "xhigh"),
    "high",
    "更高档不支持时落到最近非 off",
  );
}

console.log("thinking-levels-test: ok");
