import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Git's native minimum-edit diff handles distant edits without a quadratic
// table on Electron's main thread. Each line contains one opaque line hash.
export async function largeDiff(left: Buffer, right: Buffer, signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(),"mybuddy-pstack-diff-"));
  const lines = (bytes: Buffer) => (bytes.toString("hex").match(/.{16}/g) ?? []).join("\n") + "\n";
  try {
    await writeFile(join(dir,"before"), lines(left), {signal});
    await writeFile(join(dir,"after"), lines(right), {signal});
    try {
      await exec("git", ["diff","--no-index","--numstat","--minimal","--text","--no-ext-diff","--no-textconv","--","before","after"],
        {cwd:dir, encoding:"utf8", signal, timeout:12_000, windowsHide:true});
      return 0;
    } catch (error) {
      signal?.throwIfAborted();
      const result = error as { code?:number; stdout?:string };
      // With --no-index an actual difference returns 1.
      const stats = result.code === 1 && /^(\d+)\t(\d+)\t/.exec(result.stdout ?? "");
      return stats ? Number(stats[1]) + Number(stats[2]) : undefined;
    }
  } finally { await rm(dir, {recursive:true,force:true}); }
}
