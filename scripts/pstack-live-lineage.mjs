import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function originalCaseStart(meta) {
  let current = meta;
  const visited = new Set();
  while (current.previousRun) {
    const directory = resolve(current.previousRun);
    assert(!visited.has(directory), "Cycle in diagnostic resume lineage");
    visited.add(directory);
    current = JSON.parse(readFileSync(join(directory, "run.json"), "utf8"));
    assert(current.root === meta.root && current.route === meta.route && current.arm === meta.arm);
  }
  return Date.parse(current.start);
}
