import { z } from "zod";

const relativeBackendEntry = z.string().max(240).refine((value) =>
  /^server\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.mjs$/.test(value)
  && !value.split("/").some((part) => part === "." || part === ".."),
"Gadget backend entry 必须是 server/ 下的 .mjs 文件");

const backendOptions = {
  environment: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).max(32).default([]),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
};

const nodeBackend = z.strictObject({
  entry: relativeBackendEntry,
  commands: z.array(z.string().min(1).max(1024).refine((value) => !/[\x00-\x1f]/.test(value))).max(32).default([]),
  ...backendOptions,
});
const processBackend = z.strictObject({
  kind: z.literal("process"),
  command: z.string().trim().min(1).max(1024).refine((value) =>
    !/[\x00-\x1f]/.test(value) && (/^[\w.-]+$/.test(value) && value !== "." && value !== ".." || /^(?:\/|[a-z]:[\\/])/i.test(value)),
  "Gadget process command 必须是 PATH 中的程序名或可执行文件绝对路径"),
  args: z.array(z.string().max(4096).refine((value) => !value.includes("\0"))).max(64).default([]),
  cwd: z.string().max(240).refine((value) => value === "." ||
    value.split("/").every((part) => part && !part.startsWith(".") && !/[\\:\x00-\x1f]/.test(part)),
  "Gadget process cwd 必须是源码内的相对目录").default("."),
  ...backendOptions,
});

export const gadgetBackendSchema = z.union([nodeBackend, processBackend]);

export type GadgetBackendDeclaration = z.infer<typeof gadgetBackendSchema>;
export type GadgetBackendInput = z.input<typeof gadgetBackendSchema>;
export type GadgetJson = null | boolean | number | string | GadgetJson[] | { [key: string]: GadgetJson };
export interface GadgetStoredValue { value: GadgetJson; revision: string | null }
export interface GadgetValues {
  get(key: string): Promise<GadgetJson>;
  read(key: string): Promise<GadgetStoredValue>;
  set(key: string, value: GadgetJson, expectedRevision?: string | null): Promise<GadgetStoredValue>;
  delete(key: string, expectedRevision?: string | null): Promise<void>;
  keys(): Promise<string[]>;
}
export interface GadgetRuntimeInfo {
  gadgetId: string;
  name: string;
  backend: boolean;
  actions: string[];
}
export interface GadgetClient {
  call(action: string, input?: GadgetJson, options?: { signal?: AbortSignal }): Promise<GadgetJson>;
  readonly storage: GadgetValues;
  readonly config: GadgetValues;
  info(): Promise<GadgetRuntimeInfo>;
}
export interface GadgetBackendContext {
  readonly gadgetId: string;
  readonly dataPath: string;
  readonly sourcePath: string;
  readonly signal: AbortSignal;
  readonly storage: GadgetValues;
  readonly config: GadgetValues;
  exec(command: string, options?: {
    args?: string[];
    stdin?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null }>;
}
export interface GadgetBackend {
  actions: Record<string, (input: GadgetJson, context: GadgetBackendContext) => GadgetJson | Promise<GadgetJson>>;
  dispose?(): void | Promise<void>;
}
export type GadgetBackendFactory = (context: GadgetBackendContext) => GadgetBackend | Promise<GadgetBackend>;
