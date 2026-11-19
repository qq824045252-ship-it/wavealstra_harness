import type { PstackParameter } from "./types";

export function choice(id: string, label: string, description: string, defaultValue: string, options: string[]): PstackParameter {
  return { id, label, description, type: "select", defaultValue, options };
}

export function number(id: string, label: string, description: string, defaultValue: number, min = 1, max = Number.MAX_SAFE_INTEGER): PstackParameter {
  return { id, label, description, type: "number", defaultValue, min, max };
}

export function flag(id: string, label: string, description: string, defaultValue: boolean): PstackParameter {
  return { id, label, description, type: "boolean", defaultValue };
}

export function rubricScaleParameters() {
  return [
    number("ratingMinimum","评分下限","每项评分使用的最低整数。创建本次量表时可指定其他分制。",1,Number.MIN_SAFE_INTEGER),
    number("ratingMaximum","评分上限","每项评分使用的最高整数，必须高于下限。裁判按同一分制审阅所有产物。",5,Number.MIN_SAFE_INTEGER),
  ];
}

export function input(id: string, label: string, description: string, defaultValue: string, multiline = false): PstackParameter {
  return { id, label, description, type: "text", defaultValue, multiline };
}
