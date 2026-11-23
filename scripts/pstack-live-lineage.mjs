import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function readLiveCompletion(directory, meta) {
  let value;
  try { value = JSON.parse(readFileSync(join(directory, "evidence.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) return { evidenceError: "The terminal evidence is unreadable." };
    throw error;
  }
  const identity = ["route", "arm", "cwd", "root", "sourceHash", "request", "modelId", "start"];
  if (!value || !identity.every(key => typeof meta[key] === "string" && value[key] === meta[key]) ||
      value.attemptId !== meta.attemptId || !Array.isArray(value.records) || typeof value.end !== "string" ||
      !(Date.parse(value.end) >= Date.parse(meta.start))) {
    return { evidenceError: "The terminal evidence does not match this run." };
  }
  return { result: value };
}

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
