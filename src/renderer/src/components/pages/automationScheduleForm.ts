import { normalizeSingleExpertId } from "../../../../shared/expert-id";
import type { CronJobDto, PermissionMode, WelcomeMode } from "../../../../shared/agent-ipc";
import type { AutomationTemplate } from "@/mock/data";

type FreqMode = "period" | "every" | "once" | "cron";
export type PeriodUnit = "day" | "week" | "month";
export type EveryUnit = "s" | "m" | "h" | "d";

export interface FormState {
  id?: string;
  reminder?: CronJobDto["reminder"];
  name: string;
  prompt: string;
  spaceId: string | null;
  connectorIds: string[];
  skillIds: string[];
  expertId: string | null;
  modelId: string | null;
  permissionMode: PermissionMode;
  /** 任务类型：办公 / 代码 / 设计 */
  welcomeMode: WelcomeMode;
  freqMode: FreqMode;
  cronExpr: string;
  periodUnit: PeriodUnit;
  periodTime: string;
  periodDow: number;
  everyN: number;
  everyUnit: EveryUnit;
  onceAt: string;
  originalOnce?: { value: string; expression: string };
  dateStart: string;
  dateEnd: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function nowTimeHHMM(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function toLocalDatetimeValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dateInputToStartMs(date: string): number | undefined {
  if (!date.trim()) return undefined;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

export function dateInputToEndMs(date: string): number | undefined {
  if (!date.trim()) return undefined;
  const d = new Date(`${date}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

function msToDateInput(ms?: number): string {
  if (ms == null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function emptyForm(defaultModelId?: string | null): FormState {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return {
    name: "",
    prompt: "",
    spaceId: null,
    connectorIds: [],
    skillIds: [],
    expertId: null,
    modelId: defaultModelId ?? null,
    permissionMode: "auto",
    welcomeMode: "working",
    freqMode: "period",
    cronExpr: "",
    periodUnit: "day",
    periodTime: nowTimeHHMM(),
    periodDow: 1,
    everyN: 1,
    everyUnit: "d",
    onceAt: toLocalDatetimeValue(tomorrow),
    dateStart: "",
    dateEnd: "",
  };
}

function parseHHMM(time: string): { h: number; m: number } {
  const [hs, ms] = time.split(":");
  const h = Math.min(23, Math.max(0, Number(hs) || 0));
  const m = Math.min(59, Math.max(0, Number(ms) || 0));
  return { h, m };
}

export function formToSchedule(form: FormState): {
  scheduleType: CronJobDto["scheduleType"];
  scheduleExpr: string;
} {
  if (form.freqMode === "cron") return { scheduleType: "cron", scheduleExpr: form.cronExpr };
  if (form.freqMode === "every") {
    const n = Math.max(1, form.everyN || 1);
    return { scheduleType: "every", scheduleExpr: `${n}${form.everyUnit}` };
  }
  if (form.freqMode === "once") {
    if (form.originalOnce?.value === form.onceAt) return { scheduleType: "at", scheduleExpr: form.originalOnce.expression };
    const d = new Date(form.onceAt);
    return {
      scheduleType: "at",
      scheduleExpr: Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(),
    };
  }
  const { h, m } = parseHHMM(form.periodTime);
  if (form.periodUnit === "week") {
    const dow = Math.min(6, Math.max(0, form.periodDow));
    return { scheduleType: "cron", scheduleExpr: `0 ${m} ${h} * * ${dow}` };
  }
  if (form.periodUnit === "month") {
    return { scheduleType: "cron", scheduleExpr: `0 ${m} ${h} 1 * *` };
  }
  return { scheduleType: "cron", scheduleExpr: `0 ${m} ${h} * * *` };
}

export function jobToForm(job: CronJobDto, defaultModelId?: string | null): FormState {
  const base = emptyForm(defaultModelId);
  base.id = job.id;
  base.reminder = job.reminder;
  base.name = job.name;
  base.prompt = job.prompt;
  base.spaceId = job.spaceId ?? null;
  base.connectorIds = job.connectorIds ?? [];
  base.skillIds = job.skillIds ?? [];
  base.expertId = normalizeSingleExpertId(job.expertId) ?? null;
  base.modelId = job.modelId ?? defaultModelId ?? null;
  base.permissionMode = job.permissionMode ?? "auto";
  base.welcomeMode =
    job.welcomeMode === "coding" || job.welcomeMode === "general" || job.welcomeMode === "working"
      ? job.welcomeMode
      : "working";
  base.dateStart = msToDateInput(job.effectiveFrom);
  base.dateEnd = msToDateInput(job.effectiveTo);

  if (job.scheduleType === "every") {
    base.freqMode = "every";
    const m = /^(\d+)([smhd])$/i.exec(job.scheduleExpr.trim());
    if (m) {
      base.everyN = Number(m[1]) || 1;
      base.everyUnit = m[2].toLowerCase() as EveryUnit;
    }
  } else if (job.scheduleType === "at") {
    base.freqMode = "once";
    const d = new Date(job.scheduleExpr);
    if (!Number.isNaN(d.getTime())) {
      base.onceAt = toLocalDatetimeValue(d);
      base.originalOnce = { value: base.onceAt, expression: job.scheduleExpr };
    }
  } else {
    base.freqMode = "period";
    const parts = job.scheduleExpr.trim().split(/\s+/);
    if (parts.length === 5) parts.unshift("0");
    if (parts.length >= 3) {
      const minute = Number(parts[1]);
      const hour = Number(parts[2]);
      if (!Number.isNaN(hour) && !Number.isNaN(minute)) {
        base.periodTime = `${pad2(hour)}:${pad2(minute)}`;
      }
      const dow = parts[5];
      const dom = parts[3];
      if (dow && dow !== "*") {
        base.periodUnit = "week";
        const first = dow.split(",")[0]?.split("-")[0];
        const n = Number(first);
        if (!Number.isNaN(n)) base.periodDow = n;
      } else if (dom && dom !== "*") {
        base.periodUnit = "month";
      } else {
        base.periodUnit = "day";
      }
    }
  }
  if (job.scheduleType === "cron" && formToSchedule(base).scheduleExpr !== (job.scheduleExpr.trim().split(/\s+/).length === 5 ? `0 ${job.scheduleExpr.trim()}` : job.scheduleExpr.trim())) {
    base.freqMode = "cron"; base.cronExpr = job.scheduleExpr;
  }
  return base;
}

export function templateToForm(t: AutomationTemplate, defaultModelId?: string | null): FormState {
  const form = emptyForm(defaultModelId);
  form.name = t.title;
  form.prompt = t.prompt;
  form.welcomeMode = t.welcomeMode ?? "working";
  if (t.scheduleType === "every") {
    form.freqMode = "every";
    form.everyN = t.everyN ?? 1;
    form.everyUnit = (t.everyUnit as EveryUnit) ?? "d";
  } else if (t.scheduleType === "at") {
    form.freqMode = "once";
    const d = new Date(t.scheduleExpr);
    if (!Number.isNaN(d.getTime())) form.onceAt = toLocalDatetimeValue(d);
  } else {
    form.freqMode = "period";
    form.periodUnit = t.periodUnit ?? "day";
    form.periodTime = t.periodTime ?? "09:00";
  }
  return form;
}

export const DOW_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** WorkBuddy 风格可读调度文案 */
export function formatScheduleLabel(job: CronJobDto): string {
  if (job.scheduleType === "every") {
    const m = /^(\d+)([smhd])$/i.exec(job.scheduleExpr.trim());
    if (m) {
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      const unit = u === "s" ? "秒" : u === "m" ? "分钟" : u === "h" ? "小时" : "天";
      return `每 ${n} ${unit}`;
    }
    return `每 ${job.scheduleExpr}`;
  }
  if (job.scheduleType === "at") {
    const d = new Date(job.scheduleExpr);
    if (Number.isNaN(d.getTime())) return "单次";
    return `单次 ${d.toLocaleString()}`;
  }
  const parts = job.scheduleExpr.trim().split(/\s+/);
  if (parts.length === 5) parts.unshift("0");
  if (parts.length === 6 && parts[0] === "0" && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2]) && parts[4] === "*") {
    const minute = pad2(Number(parts[1]) || 0);
    const hour = pad2(Number(parts[2]) || 0);
    const dow = parts[5];
    const dom = parts[3];
    if (dow && dow !== "*") {
      const first = Number(dow.split(",")[0]?.split("-")[0]);
      const label = Number.isNaN(first) ? "每周" : DOW_LABELS[first] ?? "每周";
      return `${label} ${hour}:${minute}`;
    }
    if (dom && dom !== "*") return `每月${dom}日 ${hour}:${minute}`;
    return `每天 ${hour}:${minute}`;
  }
  return job.scheduleExpr;
}

export function formatNextRunLabel(nextRunAt: number | undefined, now: number): string {
  if (nextRunAt == null) return "";
  const diff = nextRunAt - now;
  if (diff <= 0) return "即将执行";
  const mins = Math.max(1, Math.round(diff / 60_000));
  if (mins < 60) return `${mins}分钟后执行`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}小时后执行`;
  const days = Math.round(hours / 24);
  return `${days}天后执行`;
}
