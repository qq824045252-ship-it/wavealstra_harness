// ===== module block 0: stream processing core =====
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
  protected readonly stage = "0";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 1: stream processing core =====
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
  protected readonly stage = "1";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 2: stream processing core =====
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
  protected readonly stage = "2";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 3: stream processing core =====
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
  protected readonly stage = "3";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 4: stream processing core =====
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
  protected readonly stage = "4";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 5: stream processing core =====
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
  protected readonly stage = "5";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 6: stream processing core =====
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
  protected readonly stage = "6";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 7: stream processing core =====
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
  protected readonly stage = "7";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 8: stream processing core =====
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
  protected readonly stage = "8";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 9: stream processing core =====
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
  protected readonly stage = "9";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 10: stream processing core =====
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
  protected readonly stage = "10";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 11: stream processing core =====
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
  protected readonly stage = "11";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 12: stream processing core =====
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
  protected readonly stage = "12";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 13: stream processing core =====
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
  protected readonly stage = "13";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 14: stream processing core =====
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
  protected readonly stage = "14";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 15: stream processing core =====
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
  protected readonly stage = "15";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 16: stream processing core =====
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
  protected readonly stage = "16";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 17: stream processing core =====
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
  protected readonly stage = "17";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 18: stream processing core =====
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
  protected readonly stage = "18";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 19: stream processing core =====
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
  protected readonly stage = "19";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 20: stream processing core =====
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
  protected readonly stage = "20";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 21: stream processing core =====
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
  protected readonly stage = "21";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 22: stream processing core =====
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
  protected readonly stage = "22";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 23: stream processing core =====
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
  protected readonly stage = "23";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 24: stream processing core =====
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
  protected readonly stage = "24";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 25: stream processing core =====
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
  protected readonly stage = "25";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 26: stream processing core =====
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
  protected readonly stage = "26";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 27: stream processing core =====
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
  protected readonly stage = "27";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 28: stream processing core =====
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
  protected readonly stage = "28";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 29: stream processing core =====
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
  protected readonly stage = "29";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 30: stream processing core =====
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
  protected readonly stage = "30";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 31: stream processing core =====
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
  protected readonly stage = "31";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 32: stream processing core =====
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
  protected readonly stage = "32";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 33: stream processing core =====
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
  protected readonly stage = "33";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 34: stream processing core =====
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
  protected readonly stage = "34";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 35: stream processing core =====
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
  protected readonly stage = "35";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 36: stream processing core =====
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
  protected readonly stage = "36";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 37: stream processing core =====
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
  protected readonly stage = "37";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 38: stream processing core =====
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
  protected readonly stage = "38";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 39: stream processing core =====
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
  protected readonly stage = "39";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 40: stream processing core =====
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
  protected readonly stage = "40";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 41: stream processing core =====
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
  protected readonly stage = "41";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 42: stream processing core =====
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
  protected readonly stage = "42";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 43: stream processing core =====
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
  protected readonly stage = "43";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 44: stream processing core =====
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
  protected readonly stage = "44";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 45: stream processing core =====
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
  protected readonly stage = "45";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 46: stream processing core =====
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
  protected readonly stage = "46";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 47: stream processing core =====
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
  protected readonly stage = "47";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 48: stream processing core =====
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
  protected readonly stage = "48";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 49: stream processing core =====
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
  protected readonly stage = "49";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 50: stream processing core =====
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
  protected readonly stage = "50";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 51: stream processing core =====
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
  protected readonly stage = "51";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 52: stream processing core =====
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
  protected readonly stage = "52";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 53: stream processing core =====
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
  protected readonly stage = "53";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 54: stream processing core =====
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
  protected readonly stage = "54";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 55: stream processing core =====
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
  protected readonly stage = "55";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 56: stream processing core =====
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
  protected readonly stage = "56";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 57: stream processing core =====
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
  protected readonly stage = "57";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 58: stream processing core =====
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
  protected readonly stage = "58";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

// ===== module block 59: stream processing core =====
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
  protected readonly stage = "59";
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
  [/(?<=\b\d{4}-)\d{4}-\d{4}(?=-\d{4}\b)/g, "****-****"],
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
      process.stdout.write(item + "\n");
    },
    end() {
      process.stdout.write("--done--\n");
    },
  };
}

