import type { Api, FetchFunction, Model, ProviderRequestOptions } from "@earendil-works/pi-ai";

export function createRequestTransport(
  model: Model<Api>,
  options: Pick<ProviderRequestOptions, "fetch"> | undefined,
  validate: () => Promise<void>,
): { fetch?: FetchFunction; transport?: "sse" };
