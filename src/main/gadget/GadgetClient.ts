import type { GadgetClient, GadgetJson, GadgetRuntimeInfo, GadgetStoredValue, GadgetValues } from "../../shared/gadget-backend";

/** Runs before the Gadget's own scripts. The token stays out of URLs and persistent browser storage. */
export function installGadgetClient(token: string): void {
  const origin = location.origin;
  async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${origin}/__mybuddy/${route}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      headers: { "x-mybuddy-gadget-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    const result = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(result.error?.message || `Gadget 请求失败 (${response.status})`), { code: result.error?.code || "REQUEST_FAILED" });
    }
    return result.value;
  }
  function values(bucket: "storage" | "config"): GadgetValues {
    const run = <T>(operation: string, args: unknown = {}) => request<T>(bucket, { operation, ...Object(args) });
    return Object.freeze({
      get: (key: string) => run<GadgetJson>("get", { key }),
      read: (key: string) => run<GadgetStoredValue>("read", { key }),
      set: (key: string, value: GadgetJson, expectedRevision?: string | null) => run<GadgetStoredValue>("set", { key, value, expectedRevision }),
      delete: (key: string, expectedRevision?: string | null) => run<void>("delete", { key, expectedRevision }),
      keys: () => run<string[]>("keys"),
    });
  }
  const client: GadgetClient = Object.freeze({
    call: (action: string, input: GadgetJson = null, options?: { signal?: AbortSignal }) => request<GadgetJson>(`actions/${encodeURIComponent(action)}`, { input }, options?.signal),
    storage: values("storage"),
    config: values("config"),
    info: () => request<GadgetRuntimeInfo>("runtime"),
  });
  Object.defineProperty(window, "gadget", { value: client, configurable: true });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = target?.getAttribute("href") || "";
    if (!/^file:/i.test(href)) return;
    event.preventDefault(); event.stopPropagation();
    window.open(`https://mybuddy-open.local/open-file?target=${encodeURIComponent(href)}`, "_blank");
  }, true);
}
