import { statSync } from "node:fs";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { FileError, Result } from "@earendil-works/pi-durable/env";

/** JsonlStorage recovery runs before Harness.readOnly; deny its filesystem mutations too. */
export class DurableReadOnlyFiles extends NodeExecutionEnv {
  override async createDir(path: string) {
    if (!statSync(path).isDirectory()) throw new Error("Read-only Durable directory does not exist");
    return { ok: true, value: undefined } satisfies Result<void, FileError>;
  }
  private deny(): never { throw new Error("Read-only Durable storage cannot repair or modify a journal"); }
  override async writeFile(): Promise<never> { return this.deny(); }
  override async appendFile(): Promise<never> { return this.deny(); }
  override async truncateFile(): Promise<never> { return this.deny(); }
  override async renameFile(): Promise<never> { return this.deny(); }
  override async remove(): Promise<never> { return this.deny(); }
  override async createTempDir(): Promise<never> { return this.deny(); }
  override async createTempFile(): Promise<never> { return this.deny(); }
}
