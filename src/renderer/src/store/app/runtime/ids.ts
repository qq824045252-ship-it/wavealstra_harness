import type { AppContext } from "../context";

export const uid = (storeContext: AppContext): string =>
  `local-${Date.now()}-${storeContext.runtime.idCounter++}`;
