import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Inspection {
  files: string[];
  parseErrors: string[];
  unresolved: string[];
  layers: string[];
  cycles: string[];
}

/** Real temporary source trees run through the gate's scanner and checks. No
 * repository writes, source-text assertions, exception baseline, or second graph
 * implementation. Production completeness thresholds remain unchanged.
 */
export function testArchitectureGraphFixtures(inspect: (root: string) => Inspection): number {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-architecture-graph-"));
  let cases = 0;
  const check = (name: string, files: Record<string, string>, verify: (result: Inspection) => void) => {
    const directory = join(root, name);
    for (const [relativePath, source] of Object.entries(files)) {
      const path = join(directory, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    try {
      verify(inspect(directory));
      cases++;
    } catch (error) {
      throw new Error(`architecture fixture ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const complete = (result: Inspection) => {
    assert.deepEqual(result.parseErrors, [], "every fixture source must parse");
    assert.deepEqual(result.unresolved, [], "every internal fixture import must resolve");
  };
  try {
    const legal = {
      "src/main/consumer.ts": 'import { value } from "@mybuddy/shared"; export const desktop = value;',
      "app/remote/src/consumer.ts": 'import { value } from "@mybuddy/shared/value"; export const remote = value;',
      "shared/src/index.ts": 'export { value } from "./value";',
      "shared/src/value.ts": "export const value = 1;",
    };
    check("legal-shared-imports", legal, result => {
      complete(result);
      assert.deepEqual([...result.files].sort(), Object.keys(legal).sort(), "shared files must be graph nodes, including alias targets");
      assert.deepEqual(result.layers, []);
      assert.deepEqual(result.cycles, []);
    });

    for (const typeOnly of [false, true]) {
      check(typeOnly ? "shared-type-back-import" : "shared-runtime-back-import", {
        "src/main/desktop.ts": "export interface Desktop {} export const desktop = 1;",
        "shared/src/value.ts": typeOnly
          ? 'import type { Desktop } from "../../src/main/desktop"; export type Shared = Desktop;'
          : 'import { desktop } from "../../src/main/desktop"; export const shared = desktop;',
      }, result => {
        complete(result);
        assert.deepEqual(result.layers, ["layer:shared/src/value.ts->src/main/desktop.ts"], "shared must not depend on desktop implementation, even through types");
        assert.deepEqual(result.cycles, [], "a one-way violation is not a runtime cycle");
      });
    }

    check("cross-shared-runtime-cycle", {
      "src/main/desktop.ts": 'export { shared } from "@mybuddy/shared"; export const desktop = 1;',
      "shared/src/index.ts": 'export { shared } from "./value";',
      "shared/src/value.ts": 'import { desktop } from "../../src/main/desktop"; export const shared = desktop;',
    }, result => {
      complete(result);
      assert.deepEqual(result.layers, ["layer:shared/src/value.ts->src/main/desktop.ts"]);
      assert.deepEqual(result.cycles, ["cycle:shared/src/index.ts|shared/src/value.ts|src/main/desktop.ts"],
        "runtime cycles must retain both shared-package nodes and the desktop alias edge");
    });

    check("shared-type-only-cycle", {
      "shared/src/a.ts": 'import type { B } from "./b"; export interface A { b?: B }',
      "shared/src/b.ts": 'import type { A } from "./a"; export interface B { a?: A }',
    }, result => {
      complete(result);
      assert.deepEqual(result.layers, []);
      assert.deepEqual(result.cycles, [], "erased type-only dependencies must not become runtime cycles");
    });

    check("shared-unresolved-import", {
      "shared/src/value.ts": 'export { value } from "./missing";',
    }, result => {
      assert.deepEqual(result.parseErrors, []);
      assert.deepEqual(result.unresolved, ["shared/src/value.ts:./missing"], "missing shared imports must remain visible to graph completeness checks");
    });

    check("shared-parse-error", {
      "shared/src/value.ts": "export const value = ;",
    }, result => {
      assert.deepEqual(result.parseErrors, ["shared/src/value.ts"], "malformed shared files must not silently disappear from the graph");
    });
    return cases;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
