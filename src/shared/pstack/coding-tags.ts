import type { ModePresetDto } from "../mode-profile";
import { PSTACK_READ_ONLY_METHODS } from "./upstream";

const tagRoutes: Record<string, string> = {
  "bugfix-test": "bug-fix",
  refactor: "refactoring",
  // 兼容旧数据：feature-dev / add-tests 已退役（RETIRED_MODE_PRESET_IDS），旧任务/旧配置
  // 仍可能带这两个 id。add-tests 的原则剧本路由保留；feature-dev 的 feature 剧本
  // 与 web-html 显式 pstackRoute 重叠，条目已删（旧任务回落 minimal + preferredPlaybook）。
  "add-tests": "skill:principle-test-behavior-not-implementation",
  "code-review": "skill:thermo-nuclear-code-quality-review",
  "plan-design": "skill:architect",
  "readonly-explain": "investigation",
};

export type CodingTag = Pick<ModePresetDto, "id" | "pstackRoute">;
export function codingTagRoute(tag?: CodingTag | null): string | undefined {
  return tag?.pstackRoute || (tag && Object.hasOwn(tagRoutes, tag.id) ? tagRoutes[tag.id] : undefined);
}

export function readOnlyCodingTag(id?: string | null): boolean {
  return id === "code-review" || id === "plan-design" || id === "readonly-explain";
}

export function codingTagSupportsRoute(id: string | undefined, route: string): boolean {
  return !readOnlyCodingTag(id) || route === "investigation" || route === "skill:architect" || route === "skill:thermo-nuclear-code-quality-review"
    || PSTACK_READ_ONLY_METHODS.some(method => route === "skill:" + method);
}
