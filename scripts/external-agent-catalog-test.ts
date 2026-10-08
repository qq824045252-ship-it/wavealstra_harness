import assert from "node:assert/strict";
import { loadExternalAgentCatalog, updateExternalAgentCatalog, useExternalAgentCatalog } from "../src/renderer/src/lib/externalAgentCatalog";
import type { ExternalAgentDescriptorDto } from "../src/shared/external-agent";

const agent: ExternalAgentDescriptorDto = { id: "codex", name: "Codex", protocol: "acp", available: true, availability: "adapter", enabled: true, commandLabel: "fixture" };
let requests: Array<{ refresh: boolean; resolve: (items: ExternalAgentDescriptorDto[]) => void; reject: (error: Error) => void }> = [];
(globalThis as any).window = { api: { externalAgent: { listAgents: (refresh: boolean) => new Promise<ExternalAgentDescriptorDto[]>((resolve, reject) => { requests.push({ refresh, resolve, reject }); }) } } };

const first = loadExternalAgentCatalog();
const simultaneous = loadExternalAgentCatalog();
assert.equal(first, simultaneous, "settings and menu share the same pending request");
assert.equal(requests.length, 1);
requests[0].resolve([agent]);
await first;
assert.equal(useExternalAgentCatalog.getState().loading, false);
for (let i = 0; i < 5; i++) await loadExternalAgentCatalog();
assert.equal(requests.length, 1, "repeated menu mounts and settings navigation do not fetch again");

const refreshed = loadExternalAgentCatalog(true);
assert.equal(requests.length, 2);
assert.equal(requests[1].refresh, true);
assert.equal(useExternalAgentCatalog.getState().agents[0].name, "Codex", "existing rows remain visible during explicit refresh");
updateExternalAgentCatalog([{ ...agent, enabled: false }]);
requests[1].resolve([agent]);
await refreshed;
assert.equal(useExternalAgentCatalog.getState().agents[0].enabled, false, "late refresh cannot undo a settings mutation");
await loadExternalAgentCatalog();
assert.equal(requests.length, 2);

const oldRefresh = loadExternalAgentCatalog(true);
const newRefresh = loadExternalAgentCatalog(true);
requests[3].resolve([{ ...agent, name: "New" }]);
await newRefresh;
requests[2].resolve([{ ...agent, name: "Old" }]);
await oldRefresh;
assert.equal(useExternalAgentCatalog.getState().agents[0].name, "New", "late response cannot overwrite the latest explicit refresh");

const failedRefresh = loadExternalAgentCatalog(true);
requests[4].reject(new Error("fixture refresh failure"));
await assert.rejects(failedRefresh, /fixture refresh failure/);
assert.equal(useExternalAgentCatalog.getState().loading, false);
assert.equal(useExternalAgentCatalog.getState().agents[0].name, "New", "failed refresh preserves the warm catalog");

useExternalAgentCatalog.setState({ agents: [], loaded: false });
const failedFirst = loadExternalAgentCatalog();
requests[5].reject(new Error("fixture initial failure"));
await assert.rejects(failedFirst);
const retry = loadExternalAgentCatalog();
assert.equal(requests.length, 7, "failed initial request can be retried");
requests[6].resolve([]);
await retry;
await loadExternalAgentCatalog();
assert.equal(requests.length, 7, "a successfully empty catalog is cached");
console.log("PASS ACP catalog: shared pending request, warm navigation, refresh, settings races, failure retry, empty list");
