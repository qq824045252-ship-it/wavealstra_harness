/**
 * Native contract for the gadget state protocol, run against the real shipped binary.
 *
 * The TypeScript fault tests prove the transport and the runtime wiring; this one proves
 * the binary actually enforces the lease and revocation contract. It fails when the
 * binary is missing, so a green run cannot come from a Node fallback.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeAuditReader, locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import type { GadgetStateAction, GadgetStateAuthorization, GadgetStateReply } from "../src/main/gadget/GadgetState";

const root = process.cwd();
const executable = locateRuntimeAudit(root);
if (!executable || !existsSync(executable)) {
  throw new Error("缺少原生 worker：先运行 node scripts/prepare-runtime-audit.cjs（缺产物必须失败，不能当通过）");
}

const protocol = String(execFileSync(executable, ["--protocol-version"], { encoding: "utf8", windowsHide: true })).trim();
assert(/^\d+$/.test(protocol), `协议号必须是数字，实际 ${protocol}`);

const fixtures = join(root, "out", "tests");
mkdirSync(fixtures, { recursive: true });
const directory = mkdtempSync(join(fixtures, "runtime-audit-native-contract-"));
const data = join(directory, "gadget-data");
mkdirSync(data);
const canonical = realpathSync(data);
// The worker opens its database at startup, so the file must exist even for state-only work.
const database = join(directory, "app.db");
writeFileSync(database, "");
const reader = new RuntimeAuditReader(executable, database);
const generation = randomUUID();

// The worker returns its own canonical form; every later call must echo it verbatim.
let store = "";
const key = Array.from({ length: 1 }, () => 107);
const write = (value: number, authorization: GadgetStateAuthorization): Promise<GadgetStateReply> =>
  reader.accessGadgetState(data, store, "storage",
    { operation: "set", key, valueJson: JSON.stringify(value), writeId: randomUUID() } as GadgetStateAction & { writeId: string },
    authorization, () => false);
const read = (): Promise<GadgetStateReply> =>
  reader.accessGadgetState(data, store, "storage", { operation: "read", key } as GadgetStateAction & { writeId: string },
    { generation, invocationId: "reader", expiresAt: Date.now() + 30_000 }, () => false);
const live = (invocationId: string): GadgetStateAuthorization =>
  ({ generation, invocationId, expiresAt: Date.now() + 30_000 });

function stateFile(): string {
  return join(data, ".mybuddy-state.json");
}

function storedValue(): unknown {
  if (!existsSync(stateFile())) return undefined;
  const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as { storage?: Record<string, { value?: unknown }> };
  return parsed.storage?.k?.value;
}

async function main(): Promise<void> {
  try {
    const opened = await reader.openGadgetState(data);
    assert.equal(opened?.kind, "opened", `the worker must report the opened store: ${JSON.stringify(opened)}`);
    // Windows reports verbatim paths (`\\?\C:\...`); the directory itself is what matters.
    const normalise = (value: string) => value.replace(/^\\\\\?\\/, "").toLowerCase();
    assert.equal(normalise((opened as { canonicalPath: string }).canonicalPath), normalise(canonical));
    store = (opened as { canonicalPath: string }).canonicalPath;

    // 1. A live lease commits.
    const committed = await write(1, live("invocation-1"));
    assert.equal(committed.kind, "value", `a live lease must commit, got ${JSON.stringify(committed)}`);
    assert.deepEqual(storedValue(), 1);
    const replayed = await read();
    assert.equal(replayed.kind, "value");
    assert.deepEqual((replayed as { entry?: { value?: unknown } }).entry?.value, 1);
    console.log("PASS the real binary commits a write with a live lease");

    // 2. An expired lease is refused at the commit boundary and changes nothing.
    const expired = await write(2, { generation, invocationId: "invocation-2", expiresAt: Date.now() - 1_000 });
    assert.deepEqual(expired, { kind: "error", error: "STALE_WRITE" });
    assert.deepEqual(storedValue(), 1, "an expired write must not reach the file");
    console.log("PASS the real binary refuses a write whose lease expired");

    // 3. A revoked invocation is refused, a sibling invocation still commits.
    assert.equal(await reader.revokeGadgetInvocation(generation, "invocation-3"), true);
    const revoked = await write(3, live("invocation-3"));
    assert.deepEqual(revoked, { kind: "error", error: "STALE_WRITE" });
    assert.deepEqual(storedValue(), 1);
    assert.equal((await write(4, live("invocation-4"))).kind, "value");
    assert.deepEqual(storedValue(), 4);
    console.log("PASS revocation only retires the invocation it names");

    // 4. Revoking the generation also stops backend/background writes (no per-call lease).
    assert.equal(await reader.revokeGadgetGeneration(generation), true);
    const background = await write(5, { generation, invocationId: "runtime", expiresAt: 0 });
    assert.deepEqual(background, { kind: "error", error: "STALE_WRITE" });
    assert.deepEqual(storedValue(), 4);
    // Reads stay available for a generation whose writers were retired.
    assert.equal((await read()).kind, "value");
    console.log("PASS revoking a generation stops its background writes but not reads");

    // 5. Deletes are gated like writes, so an expired lease cannot remove anything.
    const deleteExpired = await reader.accessGadgetState(data, store, "storage",
      { operation: "delete", key, writeId: randomUUID() } as GadgetStateAction & { writeId: string },
      { generation, invocationId: "deleter", expiresAt: Date.now() - 1_000 }, () => false);
    assert.deepEqual(deleteExpired, { kind: "error", error: "STALE_WRITE" });
    assert.deepEqual(storedValue(), 4, "an expired delete must not remove the value");
    // A generation mismatch is a host-side decision (GadgetRuntime rejects it before the
    // worker sees it); the worker enforces the lease and the revocation set it was told about.
    const deleteLive = await reader.accessGadgetState(data, store, "storage",
      { operation: "delete", key, writeId: randomUUID() } as GadgetStateAction & { writeId: string },
      { generation: randomUUID(), invocationId: "deleter", expiresAt: Date.now() + 30_000 }, () => false);
    assert.deepEqual(deleteLive, { kind: "deleted" });
    assert.equal(storedValue(), undefined, "a live delete commits");
    console.log("PASS the real binary gates deletes with the same lease");
  } finally {
    await reader.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

void main();
