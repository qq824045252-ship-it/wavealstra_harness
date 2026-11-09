import type { Attachment } from "@/types";

export const MAX_COMPOSER_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_COMPOSER_ATTACHMENTS = 10;

export function mergeComposerAttachments(current: Attachment[], incoming: Attachment[]): Attachment[] {
  const merged = [...current];
  for (const attachment of incoming) {
    if (!attachment.path) throw new Error(`附件“${attachment.name}”没有可读取的文件路径，请重新选择。`);
    if (!merged.some(item => item.path === attachment.path)) merged.push(attachment);
  }
  if (merged.length > MAX_COMPOSER_ATTACHMENTS) throw new Error(`一次最多添加 ${MAX_COMPOSER_ATTACHMENTS} 个附件。`);
  return merged;
}

/** Shared file ingress for task chat and Bot, including pathless clipboard images. */
export async function composerFiles(files: FileList | File[]): Promise<Attachment[]> {
  const result: Attachment[] = [];
  for (const file of Array.from(files)) {
    if (file.size > MAX_COMPOSER_ATTACHMENT_BYTES) throw new Error(`附件“${file.name}”超过 25 MB，请选择较小文件。`);
    const path = window.api?.getPathForFile?.(file) || (file as File & { path?: string }).path;
    if (path) { result.push({ name: file.name || path.split(/[/\\]/).pop() || "file", path }); continue; }
    if (!window.api?.saveTempFile) throw new Error("当前主机无法保存粘贴或拖入的附件，请重新连接后再试。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const saved = await window.api.saveTempFile({ name: file.name || (file.type.startsWith("image/") ? "screenshot.png" : "attachment.bin"), base64: btoa(binary), mimeType: file.type || undefined });
    if (!saved?.path) throw new Error(`附件“${file.name || "粘贴文件"}”保存失败，尚未添加。`);
    result.push({ name: saved.name || file.name || "attachment.bin", path: saved.path });
  }
  return result;
}

export async function pickComposerAttachment(): Promise<Attachment | undefined> {
  if (!window.api?.pickLocalFile) throw new Error("当前主机无法选择本地附件。");
  const file = await window.api.pickLocalFile();
  if (!file) return;
  if (!file.path) throw new Error("所选附件没有可读取的文件路径。");
  return { name: file.name || file.path.split(/[/\\]/).pop() || "文件", path: file.path };
}

export function pastedComposerFiles(data: DataTransfer): File[] {
  if (data.files.length) return Array.from(data.files);
  return Array.from(data.items).filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
}
