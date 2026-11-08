/**
 * Issue #17 A1 startup marks.
 *
 * Enabled only when `MYBUDDY_PERF_ISSUE17=1`; every call is a no-op otherwise so production
 * startup is unchanged. Main-process marks are recorded here. `rendererLoaded` is only "the page
 * loaded" — the renderer reports `bootstrapApplied` and `taskListInteractive` over `perf:mark`,
 * so a visible shell is never mistaken for an interactive window.
 */
type MarkName =
  | "appReady"
  | "windowCreated"
  | "rendererLoaded"
  | "bootstrapApplied"
  | "taskListInteractive"
  | "restoreDelivered"
  | "cronReady"
  | "gatewayRestored"
  | "memoryGatewayReady"
  | "remoteAccessReady";

const REQUIRED: MarkName[] = [
  "appReady",
  "windowCreated",
  "rendererLoaded",
  "bootstrapApplied",
  "taskListInteractive",
  "restoreDelivered",
  "cronReady",
  "memoryGatewayReady",
  "remoteAccessReady",
];

const ENABLED = process.env.MYBUDDY_PERF_ISSUE17 === "1";
const TIMEOUT_MS = 30_000;

const marks: Partial<Record<MarkName, number>> = {};
let reported = false;
let onReported: (() => void) | undefined;
let extraProvider: (() => Record<string, unknown>) | undefined;

export function startupMarkEnabled(): boolean {
  return ENABLED;
}

export function startupMark(name: string): void {
  if (!ENABLED || reported) return;
  const mark = name as MarkName;
  if (marks[mark] === undefined) marks[mark] = process.uptime() * 1000;
  if (REQUIRED.every((item) => marks[item] !== undefined)) reportStartup(true);
}

export function onStartupReport(handler: () => void): void {
  onReported = handler;
}

/** Emit once; `complete=false` is reported on timeout with whatever marks arrived. */
export function reportStartup(complete: boolean): void {
  if (!ENABLED || reported) return;
  reported = true;
  const extra = extraProvider?.() ?? {};
  const payload = { complete, missing: REQUIRED.filter((item) => marks[item] === undefined), marks, ...extra };
  process.stdout.write(`MYBUDDY_PERF_ISSUE17:${JSON.stringify(payload)}\n`, () => onReported?.());
}

export function armStartupReport(extra: () => Record<string, unknown> = () => ({})): void {
  if (!ENABLED) return;
  extraProvider = extra;
  setTimeout(() => reportStartup(false), TIMEOUT_MS).unref();
}
