/**
 * Compile compatible headless test entries together with one esbuild service.
 * This only recognizes a deliberately small subset of package.json commands;
 * everything else still runs through pnpm with its original command semantics.
 * There is no persistent cache: every invocation compiles the current sources.
 */
import { build, formatMessages, stop } from "esbuild";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const SIMPLE_WORD = /^[-\w./:@=,+]+$/;
const scalarFlags = new Map([
  ["platform", "platform"], ["format", "format"], ["packages", "packages"],
  ["jsx", "jsx"], ["tsconfig", "tsconfig"],
]);
const mapFlags = new Map([["alias", "alias"], ["loader", "loader"], ["log-override", "logOverride"]]);

export function parseBundledTestCommand(command, root) {
  const parts = command.trim().split(/\s*&&\s*/);
  if (parts.length !== 2) return undefined;
  const compile = parts[0].trim().split(/\s+/);
  const execute = parts[1].trim().split(/\s+/);
  if (compile[0] !== "esbuild" || execute[0] !== "node" || execute[1] !== "scripts/test-guard.mjs") return undefined;
  if (![...compile, ...execute].every((word) => SIMPLE_WORD.test(word))) return undefined;
  const options = {};
  let entry, outfile;
  for (const argument of compile.slice(1)) {
    if (argument === "--bundle") { options.bundle = true; continue; }
    if (!argument.startsWith("--")) {
      if (entry) return undefined;
      entry = argument;
      continue;
    }
    const single = /^--([^:=]+)=(.+)$/.exec(argument);
    if (single) {
      if (single[1] === "outfile") { if (outfile) return undefined; outfile = single[2]; }
      else if (scalarFlags.has(single[1])) options[scalarFlags.get(single[1])] = single[2];
      else return undefined;
      continue;
    }
    const external = /^--external:(.+)$/.exec(argument);
    if (external) { (options.external ??= []).push(external[1]); continue; }
    const mapping = /^--([^:=]+):([^=]+)=(.+)$/.exec(argument);
    if (!mapping || !mapFlags.has(mapping[1])) return undefined;
    const key = mapFlags.get(mapping[1]);
    (options[key] ??= {})[mapping[2]] = mapping[3];
  }
  if (!entry || !outfile || !options.bundle || options.platform !== "node" || !["cjs", "esm"].includes(options.format)) return undefined;
  // File loaders emit extra assets with shared names; leave those commands to
  // their existing runner instead of combining their output namespaces.
  if (Object.values(options.loader ?? {}).some((loader) => loader === "file" || loader === "copy")) return undefined;
  const output = resolve(root, outfile);
  const withinTests = relative(resolve(root, "out/tests"), output);
  if (isAbsolute(withinTests) || withinTests === ".." || withinTests.startsWith(".." + sep)) return undefined;
  const extension = extname(output);
  if (![".js", ".cjs", ".mjs"].includes(extension)) return undefined;
  const guardArgs = execute.slice(2);
  if (guardArgs.length === 0 || resolve(root, guardArgs[0]) !== output) return undefined;
  return { entry: resolve(root, entry), output, options, guardArgs, extension };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

async function describeError(error) {
  if (error?.errors?.length) return (await formatMessages(error.errors, { kind: "error", color: false })).join("\n");
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * Map entries exist only for commands whose complete compile + guard contract
 * was recognized. A compilation error is a failed test, never a stale-output
 * execution. A failed batch is retried individually to attribute errors without
 * suppressing the healthy tests in the same batch.
 */
export async function prepareTestBundles(names, scripts, {
  root, batchSize = 8, timeoutMs = 300_000, buildImpl = build, stopImpl = stop,
} = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new Error("Invalid test bundle batch size");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid test bundle timeout");
  const plans = names.map((name) => ({ name, plan: parseBundledTestCommand(scripts[name], root) })).filter(({ plan }) => plan);
  const outputCounts = new Map();
  for (const { plan } of plans) outputCounts.set(plan.output, (outputCounts.get(plan.output) ?? 0) + 1);
  const groups = new Map();
  for (const item of plans) {
    // Two scripts owning one output may deliberately run with different flags.
    // Preserve their original compile/run order rather than prebuilding either.
    if (outputCounts.get(item.plan.output) !== 1) continue;
    const key = JSON.stringify(stable({ options: item.plan.options, directory: dirname(item.plan.output), extension: item.plan.extension }));
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const prepared = new Map();
  let batches = 0;
  async function compile(items) {
    const plan = items[0].plan;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        stopImpl();
        reject(new Error(`Test bundle compilation exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      batches += 1;
      const result = await Promise.race([
        buildImpl({
          ...plan.options, absWorkingDir: root,
          entryPoints: items.map(({ plan: entry }) => ({ in: entry.entry, out: basename(entry.output, entry.extension) })),
          outdir: dirname(plan.output), outExtension: { ".js": plan.extension },
          // Each test remains a standalone program; no shared execution state.
          splitting: false, logLevel: "silent",
        }),
        timeout,
      ]);
      const warnings = result.warnings?.length ? (await formatMessages(result.warnings, { kind: "warning", color: false })).join("\n") : "";
      for (const { name, plan: entry } of items) prepared.set(name, { guardArgs: entry.guardArgs, warnings });
    } catch (error) {
      clearTimeout(timer);
      if (items.length > 1) {
        for (const item of items) await compile([item]);
      } else prepared.set(items[0].name, { error: await describeError(error) });
    } finally { clearTimeout(timer); }
  }
  try {
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += batchSize) await compile(group.slice(offset, offset + batchSize));
    }
  } finally { stopImpl(); }
  return { prepared, batches };
}
