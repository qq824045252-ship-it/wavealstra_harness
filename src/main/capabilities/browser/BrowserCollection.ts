import { randomUUID } from "node:crypto";
import type { AutomationScope } from "../AutomationScope";

export interface CollectionRow { key: string; cells: string[]; index?: number; }
export interface CollectionSnapshot { rows: CollectionRow[]; expectedRows?: number; queryIdentity?: string; terminal?: boolean; }
export interface CollectionSource { snapshot(): Promise<CollectionSnapshot>; advance(): Promise<void>; }
export interface CollectionIdentity { owner: string; tab: string; document: string; query: string; }
export interface CollectionBudget { maxSteps: number; maxRows: number; }
export type CollectionPartialReason = "budget" | "no-progress" | "conflict" | "changed" | "no-terminal" | "count-mismatch" | "index-gap";
export interface CollectedRow extends CollectionRow { sourceStep: number; }
export interface CollectionResult { rows: CollectedRow[]; steps: number; expectedRows?: number; status: "complete" | "partial"; reason?: CollectionPartialReason; cursor?: string; }
interface State {
  identity: CollectionIdentity; rows: Map<string, CollectedRow>; indices: Map<number, string>;
  querySeen: boolean; queryIdentity?: string; expectedRows?: number; steps: number;
  advanceBeforeSnapshot: boolean; busy: boolean; touched: number;
}

function validIdentity(id: CollectionIdentity): boolean { return !!id.owner && !!id.tab && !!id.document && !!id.query; }
function equalIdentity(a: CollectionIdentity, b: CollectionIdentity): boolean { return a.owner === b.owner && a.tab === b.tab && a.document === b.document && a.query === b.query; }
function validateSnapshot(snapshot: CollectionSnapshot): void {
  if (!snapshot || !Array.isArray(snapshot.rows) || snapshot.rows.length > 10_000 || (snapshot.expectedRows !== undefined && (!Number.isSafeInteger(snapshot.expectedRows) || snapshot.expectedRows < 0 || snapshot.expectedRows > 1_000_000)) || (snapshot.queryIdentity !== undefined && (typeof snapshot.queryIdentity !== "string" || snapshot.queryIdentity.length > 2_000)) || (snapshot.terminal !== undefined && typeof snapshot.terminal !== "boolean")) throw new Error("Invalid collection snapshot");
  for (const row of snapshot.rows) if (!row || typeof row.key !== "string" || !row.key || row.key.length > 2_000 || !Array.isArray(row.cells) || row.cells.length > 200 || row.cells.some(cell => typeof cell !== "string" || cell.length > 100_000) || (row.index !== undefined && (!Number.isSafeInteger(row.index) || row.index < 0 || row.index > 1_000_000))) throw new Error("Invalid collection row");
}

/** Opaque in-memory continuations: callers must never allow a tool caller to supply identity. */
export class BrowserCollection {
  private readonly states = new Map<string, State>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  constructor(capacity = 64, ttlMs = 15 * 60_000) { this.capacity = capacity; this.ttlMs = ttlMs; }

  async collect(args: { identity: CollectionIdentity; source: CollectionSource; scope: AutomationScope; budget: CollectionBudget; cursor?: string }): Promise<CollectionResult> {
    const { identity, source, scope, budget } = args;
    if (!validIdentity(identity) || !Number.isInteger(budget.maxSteps) || budget.maxSteps < 1 || budget.maxSteps > 100 || !Number.isInteger(budget.maxRows) || budget.maxRows < 1 || budget.maxRows > 10_000) throw new Error("Invalid collection request");
    this.expire();
    let cursor = args.cursor;
    let state = cursor ? this.states.get(cursor) : undefined;
    if (cursor && (!state || !equalIdentity(state.identity, identity))) throw new Error("Collection cursor is stale or belongs to another page");
    if (!state) {
      if (this.states.size >= this.capacity) throw new Error("Too many active collections");
      cursor = randomUUID();
      state = { identity: { ...identity }, rows: new Map(), indices: new Map(), querySeen: false, steps: 0, advanceBeforeSnapshot: false, busy: false, touched: Date.now() };
      this.states.set(cursor, state);
    }
    if (!cursor) throw new Error("Missing collection cursor");
    if (state.busy) throw new Error("Collection cursor already in use");
    if (state.rows.size > budget.maxRows) throw new Error("Collection row budget is below existing rows");
    state.busy = true;
    const current = state;
    const finish = (status: "complete" | "partial", reason?: CollectionPartialReason, resumable = false): CollectionResult => {
      current.touched = Date.now();
      if (!resumable) this.states.delete(cursor);
      return { rows: [...current.rows.values()].map(row => ({ ...row, cells: [...row.cells] })), steps: current.steps, ...(current.expectedRows !== undefined ? { expectedRows: current.expectedRows } : {}), status, ...(reason ? { reason } : {}), ...(resumable ? { cursor } : {}) };
    };
    try {
      for (let step = 0; step < budget.maxSteps; step++) {
        scope.check();
        if (current.advanceBeforeSnapshot) { scope.dispatch(); await scope.run(() => source.advance()); current.advanceBeforeSnapshot = false; }
        const snapshot = await scope.run(() => source.snapshot());
        validateSnapshot(snapshot);
        if (current.querySeen && current.queryIdentity !== snapshot.queryIdentity) return finish("partial", "changed");
        current.querySeen = true; current.queryIdentity = snapshot.queryIdentity;
        if (snapshot.expectedRows !== undefined && current.expectedRows !== undefined && snapshot.expectedRows !== current.expectedRows) return finish("partial", "changed");
        if (snapshot.expectedRows !== undefined) current.expectedRows = snapshot.expectedRows;
        current.steps++;
        let added = 0;
        for (const row of snapshot.rows) {
          const prior = current.rows.get(row.key);
          if (prior) {
            if (JSON.stringify(prior.cells) !== JSON.stringify(row.cells) || prior.index !== row.index) return finish("partial", "conflict");
            continue;
          }
          if (row.index !== undefined && current.indices.has(row.index)) return finish("partial", "conflict");
          if (current.rows.size >= budget.maxRows) return finish("partial", "budget", true);
          current.rows.set(row.key, { ...row, cells: [...row.cells], sourceStep: current.steps });
          if (row.index !== undefined) current.indices.set(row.index, row.key);
          added++;
        }
        if (current.expectedRows !== undefined && current.rows.size > current.expectedRows) return finish("partial", "count-mismatch");
        if (snapshot.terminal === true) {
          if (current.expectedRows !== undefined && current.rows.size !== current.expectedRows) return finish("partial", "count-mismatch");
          if (current.indices.size && (current.indices.size !== current.rows.size || [...current.indices.keys()].some(index => index >= current.rows.size))) return finish("partial", "index-gap");
          return finish("complete");
        }
        current.advanceBeforeSnapshot = true;
        if (added === 0) return finish("partial", snapshot.terminal === undefined ? "no-terminal" : "no-progress", true);
      }
      return finish("partial", "budget", true);
    } catch (error) {
      // A failed/cancelled advance may already have taken effect; never implicitly replay it.
      this.states.delete(cursor);
      throw error;
    } finally { current.busy = false; }
  }
  discard(cursor: string, identity: CollectionIdentity): void {
    const state = this.states.get(cursor);
    if (!state || !equalIdentity(state.identity, identity) || state.busy) throw new Error("Collection cursor is stale, busy, or belongs to another page");
    this.states.delete(cursor);
  }
  private expire(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [cursor, state] of this.states) if (!state.busy && state.touched < cutoff) this.states.delete(cursor);
  }
}


