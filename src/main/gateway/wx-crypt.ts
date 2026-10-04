import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 微信 / 企微回调消息加解密（AES-256-CBC + PKCS#7） */
export class WxCrypt {
  private readonly aesKey: Buffer;
  private readonly iv: Buffer;

  constructor(
    private readonly token: string,
    encodingAESKey: string,
    private readonly appId: string,
  ) {
    const key = Buffer.from(`${encodingAESKey}=`, "base64");
    if (key.length !== 32) {
      throw new Error("encodingAESKey 无效，应为 43 字符");
    }
    this.aesKey = key;
    this.iv = key.subarray(0, 16);
  }

  sha1Signature(timestamp: string, nonce: string, encrypt: string): string {
    const arr = [this.token, timestamp, nonce, encrypt].sort();
    return createHash("sha1").update(arr.join("")).digest("hex");
  }

  verify(signature: string, timestamp: string, nonce: string, encrypt: string): boolean {
    return this.sha1Signature(timestamp, nonce, encrypt) === signature;
  }

  decrypt(encryptBase64: string): { message: string; appId: string } {
    const encrypted = Buffer.from(encryptBase64, "base64");
    const decipher = createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const pad = decrypted[decrypted.length - 1];
    const content = decrypted.subarray(0, decrypted.length - pad);
    const msgLen = content.readUInt32BE(16);
    const message = content.subarray(20, 20 + msgLen).toString("utf-8");
    const appId = content.subarray(20 + msgLen).toString("utf-8");
    return { message, appId };
  }

  encrypt(message: string): string {
    const random = randomBytes(16);
    const msgBuf = Buffer.from(message, "utf-8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msgBuf.length, 0);
    const appIdBuf = Buffer.from(this.appId, "utf-8");
    const raw = Buffer.concat([random, lenBuf, msgBuf, appIdBuf]);
    const pad = 32 - (raw.length % 32);
    const padded = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
    const cipher = createCipheriv("aes-256-cbc", this.aesKey, this.iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  }
}

export function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>|<${tag}>(.*?)<\\/${tag}>`, "s");
  const m = xml.match(re);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}
