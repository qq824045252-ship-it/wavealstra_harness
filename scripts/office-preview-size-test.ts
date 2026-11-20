import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { decodeOfficeDataUri, officeTextPreview, previewWorkspaceFile } from "../src/main/workspace/WorkspaceService";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "office-preview-"));
  try {
    const path = join(dir, "中文明细.xlsx");
    const book = XLSX.utils.book_new();
    const rows = Array.from({ length: 8000 }, (_, i) => [i, "报销明细"]);
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "明细");
    const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: false });
    assert.ok(bytes.length > 500 * 1024);
    await writeFile(path, bytes);
    const preview = await previewWorkspaceFile(path);
    assert.deepEqual(decodeOfficeDataUri(preview.content), bytes);
    assert.match(await officeTextPreview("xlsx", preview.content, preview.name), /报销明细/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
void main();
