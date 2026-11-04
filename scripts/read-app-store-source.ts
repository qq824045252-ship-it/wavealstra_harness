import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const APP_STORE_FACADE_PATH = "src/renderer/src/store/appStore.ts";
export const APP_STORE_MODULE_ROOT = "src/renderer/src/store/app";

export interface AppStoreSource {
  /** Repository-relative, forward-slash path, suitable for an assertion failure. */
  path: string;
  source: string;
}

/**
 * Source-level architecture rules must follow the complete implementation after
 * appStore becomes a facade. Keep files separate: a regex must not accidentally
 * match the end of one module and the beginning of another.
 *
 * Behavioural contracts should call the store instead. This reader is for the
 * remaining import/wiring and forbidden-code checks, not a source snapshot.
 */
export function readAppStoreSources(
  repoRoot = process.cwd(),
): AppStoreSource[] {
  const paths = [APP_STORE_FACADE_PATH];
  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = join(repoRoot, relativeDirectory);
    if (!existsSync(absoluteDirectory)) return;
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const path = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name))
        paths.push(path);
    }
  };
  visit(APP_STORE_MODULE_ROOT);
  return paths
    .sort()
    .map((path) => ({
      path,
      source: readFileSync(join(repoRoot, path), "utf8"),
    }));
}

/** Read one responsibility module explicitly; a missing/moved module fails loudly. */
export function readAppStoreModule(
  modulePath: string,
  repoRoot = process.cwd(),
): string {
  if (
    !/^[\w./-]+\.(?:ts|tsx|mts|cts)$/.test(modulePath) ||
    modulePath.split("/").includes("..") ||
    modulePath.startsWith("/")
  ) {
    throw new Error(
      `Expected a relative app-store module path, received ${modulePath}`,
    );
  }
  return readFileSync(
    join(repoRoot, APP_STORE_MODULE_ROOT, modulePath),
    "utf8",
  );
}
