/**
 * 1F — Code fixtures 生成器（V3.5 §28 / Wave 5A）
 *
 * 生成 Shiki spike 需要的真实尺度代码样本：
 *   code-python.py   ~200 行（类/装饰器/类型注解/推导式/f-string）
 *   code-json.json   ~300 KB（嵌套配置+数据）
 *   code-medium.ts   1.5k 行（语法多样性模板循环）
 *   code-large.ts    10k 行（同一生成器放大）
 *   code-js.js       Wave 5A：JS 语言（ESM/async/解构/模板串）
 *   code-shell.sh    Wave 5A：Shell 语言（函数/管道/变量/循环/heredoc）
 *   code-longline.ts Wave 5A：超长行（12 行 × ~600 字符，横向滚动基准）
 *
 * 运行：node scripts/gen-code-fixtures.mjs
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic");
mkdirSync(OUT, { recursive: true });

// ---------- Python ----------
function genPython(blocks = 12) {
  const parts = [];
  for (let i = 0; i < blocks; i++) {
    parts.push(`# Block ${i}: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

`);
  }
  return parts.join("");
}

// ---------- JSON ----------
function genJson() {
  const items = [];
  for (let i = 0; i < 400; i++) {
    items.push(`{
    "id": "pkg-${i}",
    "name": "package-number-${i}",
    "version": "1.${i % 20}.${i % 7}",
    "enabled": ${i % 3 !== 0},
    "priority": ${i % 5},
    "settings": {
      "timeout_ms": ${1000 + i * 37},
      "retries": ${i % 4},
      "tags": ["bench", "fixture", "shiki-${i % 9}"],
      "url": "https://example.com/api/v${i % 3}/items/${i}",
      "limits": { "min": ${i}, "max": ${i + 100}, "step": 0.${i % 10} },
      "nested": { "level": ${i % 6}, "path": ["a", "b", "c", "n${i % 4}"] }
    },
    "metadata": {
      "created": "2026-08-0${i % 9}T12:00:0${i % 10}Z",
      "labels": { "env": "test", "owner": "bench-${i % 11}", "tier": "t${i % 3}" },
      "checksum": "${[...Array(32)].map((_, k) => "0123456789abcdef"[(i * 7 + k * 13 + 3) % 16]).join("")}"
    }
  }`);
  }
  return `[\n  ${items.join(",\n  ")}\n]\n`;
}

// ---------- TypeScript ----------
function genTs(blocks) {
  const parts = [];
  for (let b = 0; b < blocks; b++) {
    parts.push(`// ===== module block ${b}: stream processing core =====
import { EventEmitter } from "node:events";
import { Readable, Transform, Writable } from "node:stream";

export type Severity = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  severity: Severity;
  source: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface Sink<T> {
  write(item: T): void;
  end(): void;
}

export abstract class Pipeline<TIn, TOut> extends EventEmitter {
  protected readonly stage = "${b}";
  private _count = 0;

  constructor(protected readonly sink: Sink<TOut>) {
    super();
  }

  abstract transform(input: TIn): TOut | Promise<TOut>;

  async process(items: Iterable<TIn> | AsyncIterable<TIn>): Promise<number> {
    for await (const item of items) {
      const out = await this.transform(item);
      this.sink.write(out);
      this._count += 1;
      if (this._count % 1000 === 0) {
        this.emit("progress", { stage: this.stage, count: this._count });
      }
    }
    this.sink.end();
    return this._count;
  }

  get count(): number {
    return this._count;
  }
}

export class ThrottledTransform<T> extends Transform {
  private last = 0;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number = 10,
  ) {
    super({ objectMode: true, highWaterMark: 256 });
  }

  _transform(chunk: T, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed < 1000 / this.ratePerSec && this.burst > 0) {
      setTimeout(() => this.push(chunk) && cb(), 1000 / this.ratePerSec - elapsed);
    } else {
      this.last = now;
      this.push(chunk);
      cb();
    }
  }
}

export function severityRank(s: Severity): number {
  const rank: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  return rank[s] ?? 0;
}

export async function* windowed<T>(
  source: AsyncIterable<T>,
  size: number,
  step = size,
): AsyncGenerator<T[]> {
  let window: T[] = [];
  for await (const item of source) {
    window.push(item);
    if (window.length >= size) {
      yield window;
      window = window.slice(step);
    }
  }
  if (window.length > 0) yield window;
}

export class StatsCollector implements Sink<LogEntry> {
  private counts = new Map<Severity, number>();

  write(entry: LogEntry): void {
    this.counts.set(entry.severity, (this.counts.get(entry.severity) ?? 0) + 1);
  }

  end(): void {
    /* flush to storage */
  }

  summary(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export function redact(input: AnyRecord, keys: string[]): AnyRecord {
  const out: AnyRecord = { ...input };
  for (const key of keys) {
    if (key in out) out[key] = "[REDACTED]";
  }
  return out;
}

export const DEFAULT_RULES: ReadonlyArray<[RegExp, string]> = [
  [/(api[_-]?key|token|secret|password)/gi, "$1=***"],
  [/(?<=\\b\\d{4}-)\\d{4}-\\d{4}(?=-\\d{4}\\b)/g, "****-****"],
];

export function maskText(text: string): string {
  let out = text;
  for (const [re, rep] of DEFAULT_RULES) out = out.replace(re, rep);
  return out;
}

export interface StreamSpec {
  mode: "object" | "buffer";
  highWaterMark: number;
  finalize?: () => void;
}

export const BUFFER_SIZES = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024] as const;

export function pickBufferSize(bytes: number): (typeof BUFFER_SIZES)[number] {
  for (const size of BUFFER_SIZES) if (bytes <= size) return size;
  return BUFFER_SIZES[BUFFER_SIZES.length - 1];
}

enum Phase {
  Init = "init",
  Running = "running",
  Draining = "draining",
  Closed = "closed",
}

export class Lifecycle {
  private phase: Phase = Phase.Init;

  get isRunning(): boolean {
    return this.phase === Phase.Running;
  }

  start(): void {
    if (this.phase !== Phase.Init) throw new Error("already started");
    this.phase = Phase.Running;
  }

  drain(): void {
    if (this.phase !== Phase.Running) throw new Error("not running");
    this.phase = Phase.Draining;
  }

  close(): void {
    this.phase = Phase.Closed;
  }
}

export function createSinkStdout(): Sink<string> {
  return {
    write(item) {
      process.stdout.write(item + "\\n");
    },
    end() {
      process.stdout.write("--done--\\n");
    },
  };
}

`);
  }
  return parts.join("");
}

// ---------- JavaScript ----------
function genJs(blocks = 10) {
  const parts = [];
  for (let i = 0; i < blocks; i++) {
    parts.push(`// ===== module block ${i}: async queue worker =====
import { EventEmitter } from "node:events";

const QUEUE_LIMIT = 1000;

export class AsyncQueue extends EventEmitter {
  #items = [];
  #running = 0;

  constructor(public concurrency = 4) {
    super();
    if (concurrency < 1) throw new RangeError("concurrency must be >= 1");
  }

  get size() {
    return this.#items.length;
  }

  push(task) {
    this.#items.push(task);
    this.#drain();
    return this;
  }

  async #drain() {
    while (this.#running < this.concurrency && this.#items.length > 0) {
      const task = this.#items.shift();
      this.#running += 1;
      this.emit("start", { id: task.id });
      try {
        const result = await task.run();
        this.emit("done", { id: task.id, result });
      } catch (error) {
        this.emit("error", { id: task.id, error });
      } finally {
        this.#running -= 1;
        this.#drain();
      }
    }
    if (this.#running === 0 && this.#items.length === 0) {
      this.emit("idle");
    }
  }
}

export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const sample = { name: "queue-${i}", tags: ["a", "b"], nested: { depth: 2, ok: true } };
const label = \`queue #${i} @ \${Date.now()}\`;

export default async function main() {
  const q = new AsyncQueue(2);
  q.on("done", (e) => console.log(label, e));
  for (let n = 0; n < 10; n++) q.push({ id: n, run: () => Promise.resolve(n * 2) });
  await new Promise((resolve) => q.once("idle", resolve));
  return sample;
}

`);
  }
  return parts.join("");
}

// ---------- Shell ----------
function genShell() {
  const parts = [];
  for (let i = 0; i < 10; i++) {
    parts.push(`#!/usr/bin/env bash
# ===== stage ${i}: log pipeline =====
set -euo pipefail

LOG_DIR="/var/log/app"
ARCHIVE_DIR="/var/log/archive"
RETENTION_DAYS=14

log_info() {
  local msg="$1"
  echo "[INFO] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg"
}

log_error() {
  local msg="$1"
  echo "[ERROR] $(date -u +%Y-%m-%dT%H:%M:%SZ) $msg" >&2
}

rotate() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    log_error "missing: $file"
    return 1
  fi
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  gzip -c "$file" > "\${ARCHIVE_DIR}/\${file##*/}.\${stamp}.gz" && rm -f "$file"
  log_info "rotated $file"
}

find "$LOG_DIR" -type f -name "*.log" -mtime "+\${RETENTION_DAYS}" | while read -r f; do
  rotate "$f"
done

for i in {1..5}; do
  printf "stage-%d done\\n" "$i"
done

cat <<EOF
pipeline ${i} finished at $(date)
EOF

`);
  }
  return parts.join("");
}

// ---------- 超长行（横向滚动基准） ----------
function genLongLines() {
  const row = (n) =>
    `const ROW_${n} = [${Array.from({ length: 40 }, (_, k) => `"key${k}:${n}"`).join(", ")}]; // 超长行 ${n}：模拟 minified / 长数据行，宽度约 600+ 字符`;
  const parts = [];
  parts.push(`// 超长行 fixture（Wave 5A）：横向滚动 / 行宽基准。每行 ~600 字符。`);
  parts.push(`type Row = string[];`);
  for (let i = 0; i < 10; i++) parts.push(row(i));
  parts.push(`export const ALL_ROWS: Row[] = [ROW_0, ROW_1, ROW_2, ROW_3, ROW_4, ROW_5, ROW_6, ROW_7, ROW_8, ROW_9];`);
  parts.push(`export function flatten(rows: Row[]): string { return rows.flat().join(","); }`);
  parts.push("");
  return parts.join("\n");
}

const tsLarge = genTs(60); // ~10k 行
const tsMedium = genTs(9); // ~1.5k 行

writeFileSync(join(OUT, "code-python.py"), genPython(12), "utf-8");
writeFileSync(join(OUT, "code-json.json"), genJson(), "utf-8");
writeFileSync(join(OUT, "code-medium.ts"), tsMedium, "utf-8");
writeFileSync(join(OUT, "code-large.ts"), tsLarge, "utf-8");
writeFileSync(join(OUT, "code-js.js"), genJs(10), "utf-8");
writeFileSync(join(OUT, "code-shell.sh"), genShell(), "utf-8");
writeFileSync(join(OUT, "code-longline.ts"), genLongLines(), "utf-8");

const line = (p) => readFileSync(p, "utf-8").split("\n").length;
const maxw = (p) =>
  readFileSync(p, "utf-8")
    .split("\n")
    .reduce((m, l) => Math.max(m, l.length), 0);
console.log("生成完成:");
console.log(`  code-python.py     ${line(join(OUT, "code-python.py"))} 行`);
console.log(`  code-json.json     ${line(join(OUT, "code-json.json"))} 行`);
console.log(`  code-medium.ts     ${line(join(OUT, "code-medium.ts"))} 行`);
console.log(`  code-large.ts      ${line(join(OUT, "code-large.ts"))} 行`);
console.log(`  code-js.js         ${line(join(OUT, "code-js.js"))} 行`);
console.log(`  code-shell.sh      ${line(join(OUT, "code-shell.sh"))} 行`);
console.log(`  code-longline.ts   ${line(join(OUT, "code-longline.ts"))} 行 / 最宽 ${maxw(join(OUT, "code-longline.ts"))} 字符`);
