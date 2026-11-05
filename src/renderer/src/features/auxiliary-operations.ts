export interface AuxiliaryOperation {
  requestId: string;
  complete(): void;
}

/** Keep the submission identity until the UI has received its result or explicitly cancels it. */
export async function beginAuxiliaryOperation(kind: string, input: unknown): Promise<AuxiliaryOperation> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
  const key = `mybuddy:auxiliary-operation:${kind}:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  const existing = localStorage.getItem(key);
  const requestId = existing || crypto.randomUUID();
  if (!existing) localStorage.setItem(key, requestId);
  return {
    requestId,
    complete: () => { if (localStorage.getItem(key) === requestId) localStorage.removeItem(key); },
  };
}
