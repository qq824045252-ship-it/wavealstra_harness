import { open, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { assertPathInsideTask } from "../task/TaskExecutionWorkspace";
import { digest } from "./OfficeFile";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function readOfficeEvidenceFile(root: string, requestedPath: string, extension: ".xlsx" | ".docx" | ".pptx" | ".png",
  signal?: AbortSignal) {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const path = assertPathInsideTask(canonicalRoot, await realpath(resolve(canonicalRoot, requestedPath)));
  if (extname(path).toLowerCase() !== extension) throw new Error(`请选择任务目录中的 ${extension} 文件。`);
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error("Office 核验文件为空、不是普通文件或超过 32 MiB。");
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await stat(path, { bigint: true });
    if (offset !== bytes.length || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      assertPathInsideTask(canonicalRoot, await realpath(path)) !== path) {
      throw new Error("核验期间文件已修改或替换，请重新读取。");
    }
    signal?.throwIfAborted();
    return { path, bytes, sha256: digest(bytes) };
  } finally {
    await file.close();
  }
}
