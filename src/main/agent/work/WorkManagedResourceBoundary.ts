import { randomUUID } from "node:crypto";
import { currentDurableInvocation } from "../durable/DurableExecutionContext";
import { setManagedResourceBoundary, type ManagedResourceAction } from "../../platform/managed-resources";
import { onHeldInputReleased } from "../../platform/computer-use/heldInput";
import { WorkResourceGate, resourceOwnerKey, type ResourceLease, type WorkResource, type WorkResourceOwner } from "./WorkResourceGate";

/** Protect service calls that did not enter through native tool hooks, using the same host gate. */
let unsubscribeCleanup: (() => void) | undefined;
export function installWorkManagedResourceBoundary(gate: WorkResourceGate, resolveOwner: (taskId?: string) => WorkResourceOwner): void {
  const held = new Map<string, { lease: ResourceLease; controls: Set<string> }>();
  unsubscribeCleanup?.();
  unsubscribeCleanup = onHeldInputReleased((taskId, receipt) => {
    gate.settleInputCleanup(taskId, receipt);
    for (const [key, state] of held) if (!taskId || state.lease.owner.taskId === taskId) held.delete(key);
  });
  setManagedResourceBoundary(async <T>(input: ManagedResourceAction, run: () => Promise<T>): Promise<T> => {
    const invocation = currentDurableInvocation();
    const owner = resolveOwner(input.taskId ?? invocation?.execution.taskId);
    if (invocation) {
      if (input.taskId && input.taskId !== invocation.execution.taskId) throw new Error("受管资源 taskId 与真实调用身份不一致");
      const actual = String(invocation.native.conversationId);
      if (owner.bindingId) owner.childId = actual !== owner.conversationId ? actual : undefined;
      else owner.conversationId = actual;
    }
    const resources: WorkResource[] = [{ kind: "desktop", scope: "physical-input", key: "host-session", mode: input.readonly ? "read" : "write" }];
    if (input.kind === "browser") resources.push({ kind: "browser", scope: "browser-session", key: "host-profile", mode: input.readonly ? "read" : "write" });
    const key = resourceOwnerKey(owner);
    const nativeLease = invocation ? gate.live().find(lease => resourceOwnerKey(lease.owner) === key
      && lease.actionId.includes(`:${invocation.native.taskId}:`)
      && resources.every(resource => lease.resources.some(actual => actual.kind === resource.kind && actual.key === resource.key && (actual.mode === "write" || resource.mode === "read")))) : undefined;
    const cachedHeld = held.get(key);
    if (cachedHeld && gate.leaseState(cachedHeld.lease) === "released") held.delete(key);
    const heldState = held.get(key);
    const heldLease = heldState?.lease;
    const reusable = nativeLease ?? heldLease;
    const admission = reusable ? { ok: true as const, lease: reusable }
      : gate.acquire({ actionId: `managed:${randomUUID()}`, owner, resources, leaseMs: 60_000 });
    if (!admission.ok) throw new Error(admission.reason);
    const lease = admission.lease;
    const cleanup = /^(key_up|mouse_up|mouse_up_client)$/.test(input.action);
    const denied = cleanup && reusable ? gate.validateSettlement(lease) : gate.validate(lease); if (denied) throw new Error(denied);
    const control = `${input.action.startsWith("key_") ? "key" : "mouse"}:${input.inputKey ?? "unknown"}`;
    try {
      const result = await run();
      if (!nativeLease) {
        if (/^(key_down|mouse_down|mouse_down_client)$/.test(input.action)) {
          const state = heldState ?? { lease, controls: new Set<string>() };
          state.controls.add(control); held.set(key, state); gate.markInputHeld(lease, [...state.controls]);
        } else {
          if (cleanup) heldState?.controls.delete(control);
          if (!heldState?.controls.size) { held.delete(key); if (!cleanup || gate.leaseState(lease) !== "quarantined") gate.release(lease, "confirmed"); }
          else gate.markInputHeld(lease, [...heldState.controls]);
        }
      }
      return result;
    } catch (error) {
      if (!nativeLease) gate.release(lease, "unknown", error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}
