import type { ModePresetDto } from "../mode-profile";

const tagRoutes: Record<string, string> = {
  "bugfix-test": "bug-fix",
  "feature-dev": "feature",
  refactor: "refactoring",
  "add-tests": "skill:principle-test-behavior-not-implementation",
  "code-review": "skill:interrogate",
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
  return !readOnlyCodingTag(id) || ["investigation", "skill:architect", "skill:interrogate"].includes(route);
}
