/**
 * Binary Artifact 解码 — 共享严格 data URI decoder（V3.5 hotfix §13/§14）
 *
 * 此前 PDF/DOCX/XLSX/PPTX 各自维护 atob 解码；空 content（"") 会静默解码成
 * 0 字节数组，最终以 JSZip "End of data reached / Corrupted zip" 等底层报错
 * 出现，无法定位真实原因（hydration 缺失）。
 *
 * 本模块统一：
 * - 严格输入校验（非空 / data: 前缀 / comma / base64 参数 / payload 非空 / byteLength > 0）
 * - 统一异常语义（BinaryArtifactError，面向用户的中文提示）
 * - 不允许 silent empty bytes
 * - ZIP magic 校验（PPTX/DOCX/XLSX 均为 ZIP/OOXML）
 */
export class BinaryArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryArtifactError";
  }
}

export interface DecodedBinary {
  mimeType: string;
  bytes: Uint8Array;
}

/** data URI → mime + bytes（严格校验，绝不静默返回空字节） */
export function decodeBase64DataUri(content: string): DecodedBinary {
  if (!content) {
    throw new BinaryArtifactError("内容尚未加载或二进制数据为空");
  }
  if (!content.startsWith("data:")) {
    throw new BinaryArtifactError("内容不是 data URI（数据可能尚未加载）");
  }
  const comma = content.indexOf(",");
  if (comma < 0) {
    throw new BinaryArtifactError("data URI 缺少数据部分");
  }
  const header = content.slice(5, comma);
  const [mimeType, ...params] = header.split(";");
  if (!params.includes("base64")) {
    throw new BinaryArtifactError("data URI 不是 base64 编码");
  }
  const encoded = content.slice(comma + 1);
  if (!encoded) {
    throw new BinaryArtifactError("base64 数据为空");
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (err) {
    throw new BinaryArtifactError(`base64 解码失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!binary) {
    throw new BinaryArtifactError("base64 解码结果为空");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (bytes.length === 0) {
    throw new BinaryArtifactError("二进制数据为空");
  }
  return { mimeType: mimeType || "", bytes };
}

/** OOXML/ZIP magic 校验（PPTX/DOCX/XLSX 均为 PK\x03\x04） */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** data URI 是否看起来是合法的二进制 base64 data URI（面板 gate 用） */
export function isBinaryDataUri(content: string): boolean {
  return (
    content.startsWith("data:") &&
    content.includes(",") &&
    content.slice(0, content.indexOf(",")).includes("base64")
  );
}
