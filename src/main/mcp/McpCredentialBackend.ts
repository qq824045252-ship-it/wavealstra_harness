import { safeStorage } from 'electron';
import { FileAuthStorageBackend, type AuthStorageBackend } from '@earendil-works/pi-coding-agent';

type Result<T> = { result: T; next?: string };
/** Pi keeps refresh/PKCE semantics; the desktop host keeps credentials OS-encrypted at rest. */
export class McpCredentialBackend implements AuthStorageBackend {
  private readonly file: FileAuthStorageBackend;
  constructor(filePath: string) { this.file = new FileAuthStorageBackend(filePath); }
  private decode(raw: string | undefined): string | undefined {
    if (!raw?.trim()) return undefined;
    const record = JSON.parse(raw) as { version?: number; ciphertext?: string };
    if (Object.keys(record).length === 0) return undefined;
    if (record.version !== 1 || typeof record.ciphertext !== 'string') throw new Error('Invalid encrypted MCP credential store');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable');
    return safeStorage.decryptString(Buffer.from(record.ciphertext, 'base64'));
  }
  private encode(raw: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption is unavailable; refusing plaintext storage');
    return JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(raw).toString('base64') });
  }
  withLock<T>(fn: (current: string | undefined) => Result<T>): T {
    return this.file.withLock(raw => {
      const result = fn(this.decode(raw));
      return { result: result.result, ...(result.next !== undefined ? { next: this.encode(result.next) } : {}) };
    });
  }
  withLockAsync<T>(fn: (current: string | undefined) => Promise<Result<T>>, options?: Parameters<AuthStorageBackend['withLockAsync']>[1]): Promise<T> {
    return this.file.withLockAsync(async raw => {
      const result = await fn(this.decode(raw));
      return { result: result.result, ...(result.next !== undefined ? { next: this.encode(result.next) } : {}) };
    }, options);
  }
}
