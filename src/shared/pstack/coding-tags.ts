import type { ModePresetDto } from "../mode-profile";
import { PSTACK_READ_ONLY_METHODS } from "./upstream";

export type CodingTag = Pick<ModePresetDto, "id" | "pstackRoute">;
export function codingTagRoute(tag?: CodingTag | null): string | undefined {
  return tag?.pstackRoute || undefined;
}

/** Legacy runs freeze their original Tag. New tasks resolve retired IDs to minimal before reaching runtime. */
export function readOnlyCodingTag(id?: string | null): boolean {
  return id === "code-review" || id === "plan-design" || id === "readonly-explain";
}

export function codingTagSupportsRoute(id: string | undefined, route: string): boolean {
  return !readOnlyCodingTag(id) || route === "investigation" || route === "skill:architect" || route === "skill:thermo-nuclear-code-quality-review"
    || PSTACK_READ_ONLY_METHODS.some(method => route === "skill:" + method);
}
