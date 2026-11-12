import JSZip from "jszip";
import { createHash } from "node:crypto";
import { deliveryFileBytes, type FrozenDeliveryFile } from "../agent/work/WorkDeliveryArtifacts";
import { GatewayWorkNotSentError } from "./work-outbound";

/** One effect owns one QQ reply slot. Multiple immutable files travel as an
 * explicitly labelled archive, never as untracked extra messages. */
export async function qqWorkMedia(originals: FrozenDeliveryFile[], summary: string) {
  const files = originals.map(file => ({ ...file }));
  if (!files.length) return undefined;
  if (files.length > 128) throw new GatewayWorkNotSentError("QQ 成果压缩包最多包含 128 个文件，未发送");
  let total = 0;
  const bytes = files.map(file => {
    if (!file.name || file.name.length > 180 || /[\\/\x00-\x1f\x7f]/.test(file.name)
      || file.bytes > 10 * 1024 * 1024 || file.bytes <= 0) {
      throw new GatewayWorkNotSentError("QQ 文件名称无效或不在 0 < 大小 ≤ 10 MiB 范围，未发送");
    }
    total += file.bytes;
    if (total > 20 * 1024 * 1024) throw new GatewayWorkNotSentError("QQ 成果总大小超过 20 MiB，未发送");
    try { return deliveryFileBytes(file); }
    catch { throw new GatewayWorkNotSentError("冻结附件哈希不一致，未发送"); }
  });
  if (files.length === 1) return { file: { ...files[0], base64: Buffer.from(bytes[0]).toString("base64") }, originals: files, content: summary, bundled: false };
  const zip = new JSZip();
  const entries = files.map((file, index) => ({ path: `files/${String(index + 1).padStart(3, "0")}-${file.name}`,
    originalName: file.name, sha256: file.sha256, bytes: file.bytes }));
  const options = { date: new Date("1980-01-01T00:00:00Z"), createFolders: false, compression: "STORE" as const };
  entries.forEach((entry, index) => zip.file(entry.path, bytes[index], options));
  zip.file("manifest.json", JSON.stringify({ format: "mybuddy-work-results-v1", summary, files: entries }, null, 2), options);
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "DOS" });
  if (archive.length > 20 * 1024 * 1024) throw new GatewayWorkNotSentError("QQ 成果压缩包超过官方单次上传 20 MiB 上限，未发送");
  const sha256 = createHash("sha256").update(archive).digest("hex");
  return { file: { name: `work-results-${sha256.slice(0, 12)}.zip`, sha256, bytes: archive.length, base64: archive.toString("base64") },
    originals: files, bundled: true, content: `【成果压缩包：${files.length} 个原始文件，未分别发送；内含文件清单与 SHA-256】\n${summary}` };
}
