import type { Space } from "../../../types";
import type { AppContext } from "../context";

export async function applySpacePath(
  storeContext: AppContext,
  space: Space,
  folderPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const { get, set } = storeContext;
  const result = await storeContext.getApi()?.db?.upsertSpace({
    id: space.id,
    name: space.name,
    path: folderPath,
  });
  if (result && !result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}
