import type { BrowserDocumentContext } from "./BrowserDocumentContext";
import type { CollectionSnapshot, CollectionSource } from "./BrowserCollection";
import { withBrowserDom } from "./BrowserDom";

export interface CollectionDomTarget { selector: string; scopeSelector?: string; }
export interface CollectionDomAttribute extends CollectionDomTarget { attribute: string; }
export type CollectionDomTerminal =
  | { kind: "present"; target: CollectionDomTarget }
  | { kind: "disabled"; target: CollectionDomTarget }
  | { kind: "attribute"; target: CollectionDomAttribute; value: string }
  | { kind: "scroll-end"; target: CollectionDomTarget };
export type CollectionDomAdvance =
  | { kind: "next"; target: CollectionDomTarget }
  | { kind: "scroll"; target: CollectionDomTarget };
export interface CollectionDomHorizontal {
  viewport: CollectionDomTarget;
  columnIndexAttribute: string;
  expectedColumns?: CollectionDomAttribute;
  maxSteps: number;
}
export interface CollectionDomOptions {
  scopeSelector?: string;
  rowSelector: string;
  keyAttribute: string;
  cellSelector: string;
  rowIndexAttribute?: string;
  expectedRows?: CollectionDomAttribute;
  queryIdentity?: CollectionDomAttribute;
  terminal: CollectionDomTerminal;
  advance: CollectionDomAdvance;
  horizontal?: CollectionDomHorizontal;
}
export interface CollectionDomInput {
  /** Resolve the target again and send trusted native input; never synthesize DOM events. */
  click(target: CollectionDomTarget): Promise<void>;
  scroll(target: CollectionDomTarget, axis: "vertical" | "horizontal", direction: "forward" | "start"): Promise<void>;
}
export interface CollectionDomCoverage {
  horizontalComplete: boolean;
  horizontalSteps: number;
  reason?: "budget" | "no-progress" | "column-gap" | "changed";
}

interface DomRow { key: string; index?: number; cells: Array<{ index?: number; text: string }> }
interface DomSnapshot {
  rows: DomRow[];
  expectedRows?: number;
  queryIdentity?: string;
  terminal: boolean;
  horizontalEnd: boolean;
  horizontalPosition: number;
  expectedColumns?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseSnapshot(value: unknown): DomSnapshot {
  if (!isRecord(value) || !Array.isArray(value.rows) || typeof value.terminal !== "boolean"
    || typeof value.horizontalEnd !== "boolean" || typeof value.horizontalPosition !== "number") throw new Error("Invalid collection DOM observation");
  const rows: DomRow[] = value.rows.map((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.key !== "string" || !raw.key || !Array.isArray(raw.cells)
      || (raw.index !== undefined && (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0))) throw new Error("Invalid collection DOM row");
    const cells = raw.cells.map((cell: unknown) => {
      if (!isRecord(cell) || typeof cell.text !== "string"
        || (cell.index !== undefined && (!Number.isSafeInteger(cell.index) || (cell.index as number) < 0))) throw new Error("Invalid collection DOM cell");
      return { text: cell.text, ...(cell.index === undefined ? {} : { index: cell.index as number }) };
    });
    return { key: raw.key, cells, ...(raw.index === undefined ? {} : { index: raw.index as number }) };
  });
  for (const key of ["expectedRows", "expectedColumns"] as const) {
    const count = value[key];
    if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) throw new Error(`Invalid ${key}`);
  }
  if (value.queryIdentity !== undefined && typeof value.queryIdentity !== "string") throw new Error("Invalid collection query identity");
  return {
    rows, terminal: value.terminal, horizontalEnd: value.horizontalEnd, horizontalPosition: value.horizontalPosition,
    ...(value.expectedRows === undefined ? {} : { expectedRows: value.expectedRows as number }),
    ...(value.expectedColumns === undefined ? {} : { expectedColumns: value.expectedColumns as number }),
    ...(value.queryIdentity === undefined ? {} : { queryIdentity: value.queryIdentity as string }),
  };
}

/** Read one observed document. Selector strings are data, never executable page code. */
function observationScript(options: CollectionDomOptions): string {
  return withBrowserDom(`(() => {
    const config = ${JSON.stringify(options)};
    const exact = (target) => {
      const root = target.scopeSelector ? exact({ selector: target.scopeSelector }) : document;
      const matches = __mbDom.all(target.selector, root);
      if (matches.length !== 1) throw new Error('Collection target must match exactly one element: ' + target.selector);
      return matches[0];
    };
    const attribute = target => exact(target).getAttribute(target.attribute);
    const count = target => {
      if (!target) return undefined;
      const raw = attribute(target);
      if (raw === null || !/^(0|[1-9]\\d*)$/.test(raw)) throw new Error('Collection count is missing or invalid');
      return Number(raw);
    };
    const root = config.scopeSelector ? exact({ selector: config.scopeSelector }) : document;
    const rows = __mbDom.all(config.rowSelector, root).map(row => {
      const key = row.getAttribute(config.keyAttribute);
      if (!key) throw new Error('Collection row has no stable key');
      const indexRaw = config.rowIndexAttribute ? row.getAttribute(config.rowIndexAttribute) : null;
      if (indexRaw !== null && !/^(0|[1-9]\\d*)$/.test(indexRaw)) throw new Error('Collection row index is invalid');
      const cells = __mbDom.all(config.cellSelector, row).map(cell => {
        const raw = config.horizontal ? cell.getAttribute(config.horizontal.columnIndexAttribute) : null;
        if (config.horizontal && (raw === null || !/^(0|[1-9]\\d*)$/.test(raw))) throw new Error('Horizontal cell has no column index');
        return { ...(raw === null ? {} : { index: Number(raw) }), text: __mbDom.text(cell).trim() };
      });
      return { key, ...(indexRaw === null ? {} : { index: Number(indexRaw) }), cells };
    });
    const terminal = (() => {
      const rule = config.terminal;
      if (rule.kind === 'present') {
        const scope = rule.target.scopeSelector ? exact({ selector: rule.target.scopeSelector }) : document;
        return __mbDom.all(rule.target.selector, scope).length === 1;
      }
      if (rule.kind === 'disabled') { const el = exact(rule.target); return el.disabled === true || el.getAttribute('aria-disabled') === 'true'; }
      if (rule.kind === 'attribute') return attribute(rule.target) === rule.value;
      const el = exact(rule.target), expected = count(config.expectedRows); return el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && (rows.length >= expected || rows.some(row => row.index !== undefined && row.index + 1 >= expected));
    })();
    const horizontal = config.horizontal ? exact(config.horizontal.viewport) : null;
    return { rows, expectedRows: count(config.expectedRows), queryIdentity: config.queryIdentity ? attribute(config.queryIdentity) : location.href,
      terminal, horizontalEnd: !horizontal || horizontal.scrollLeft + horizontal.clientWidth >= horizontal.scrollWidth - 1,
      horizontalPosition: horizontal?.scrollLeft ?? 0, expectedColumns: count(config.horizontal?.expectedColumns) };
  })()`);
}

/** Keep horizontal stitching local so BrowserCollection sees stable complete row values. */
export function createBrowserCollectionDomSource(args: {
  context: Pick<BrowserDocumentContext, "evaluate" | "validate">;
  options: CollectionDomOptions;
  input: CollectionDomInput;
}): CollectionSource & { readonly coverage: CollectionDomCoverage } {
  const { context, options, input } = args;
  if (!options.rowSelector || !options.keyAttribute || !options.cellSelector || !options.terminal || !options.advance
    || (options.horizontal && (!options.horizontal.columnIndexAttribute || !Number.isInteger(options.horizontal.maxSteps)
      || options.horizontal.maxSteps < 1 || options.horizontal.maxSteps > 100))) throw new Error("Invalid collection DOM options");
  if (options.terminal.kind === "scroll-end" && !options.expectedRows) throw new Error("scroll-end requires expectedRows; viewport bottom alone cannot prove an infinite collection is complete");
  const script = observationScript(options);
  let coverage: CollectionDomCoverage = { horizontalComplete: !options.horizontal, horizontalSteps: 0 };
  const observe = async (): Promise<DomSnapshot> => {
    context.validate();
    const value = parseSnapshot(await context.evaluate(script));
    context.validate();
    return value;
  };
  return {
    get coverage() { return coverage; },
    async snapshot(): Promise<CollectionSnapshot> {
      if (options.horizontal) {
        context.validate();
        await input.scroll(options.horizontal.viewport, "horizontal", "start");
        context.validate();
      }
      const initial = await observe();
      if (!options.horizontal) {
        return { rows: initial.rows.map(row => ({ key: row.key, cells: row.cells.map(cell => cell.text), ...(row.index === undefined ? {} : { index: row.index }) })),
          expectedRows: initial.expectedRows, queryIdentity: initial.queryIdentity, terminal: initial.terminal };
      }
      const rows = new Map<string, { index?: number; cells: Map<number, string> }>();
      let current = initial;
      for (let step = 0; step < options.horizontal.maxSteps; step++) {
        if (current.queryIdentity !== initial.queryIdentity || current.expectedRows !== initial.expectedRows
          || current.expectedColumns !== initial.expectedColumns) {
          coverage = { horizontalComplete: false, horizontalSteps: step + 1, reason: "changed" };
          return { rows: [], queryIdentity: current.queryIdentity, terminal: false };
        }
        for (const row of current.rows) {
          let saved = rows.get(row.key);
          if (!saved) { saved = { index: row.index, cells: new Map() }; rows.set(row.key, saved); }
          if (saved.index !== row.index) throw new Error("Collection row index changed during horizontal scan");
          for (const cell of row.cells) {
            if (cell.index === undefined) throw new Error("Horizontal cell index missing");
            const previous = saved.cells.get(cell.index);
            if (previous !== undefined && previous !== cell.text) throw new Error("Collection cell changed during horizontal scan");
            saved.cells.set(cell.index, cell.text);
          }
        }
        if (current.horizontalEnd) {
          const complete = [...rows.values()].every(row => {
            const indices = [...row.cells.keys()].sort((a, b) => a - b);
            return indices.length === (current.expectedColumns ?? indices.length) && indices.every((index, i) => index === i);
          });
          coverage = { horizontalComplete: complete, horizontalSteps: step + 1, ...(complete ? {} : { reason: "column-gap" }) };
          if (!complete) return { rows: [], queryIdentity: current.queryIdentity, terminal: false };
          return { rows: [...rows].map(([key, row]) => ({ key, cells: [...row.cells].sort(([a], [b]) => a - b).map(([, text]) => text), ...(row.index === undefined ? {} : { index: row.index }) })),
            expectedRows: current.expectedRows, queryIdentity: current.queryIdentity, terminal: current.terminal };
        }
        context.validate();
        await input.scroll(options.horizontal.viewport, "horizontal", "forward");
        const next = await observe();
        if (next.horizontalPosition <= current.horizontalPosition) {
          coverage = { horizontalComplete: false, horizontalSteps: step + 1, reason: "no-progress" };
          return { rows: [], queryIdentity: next.queryIdentity, terminal: false };
        }
        current = next;
      }
      coverage = { horizontalComplete: false, horizontalSteps: options.horizontal.maxSteps, reason: "budget" };
      return { rows: [], queryIdentity: current.queryIdentity, terminal: false };
    },
    async advance(): Promise<void> {
      context.validate();
      if (options.advance.kind === "next") await input.click(options.advance.target);
      else await input.scroll(options.advance.target, "vertical", "forward");
      context.validate();
    },
  };
}
