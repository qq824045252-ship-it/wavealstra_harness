import { Entry } from "@napi-rs/keyring";
import type { BuiltinCredentialId } from "../../shared/builtin-capabilities";

const SERVICE = "MyBuddy Builtin Capabilities";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

function assertId(id: BuiltinCredentialId): string {
  const normalized = id.trim().toLowerCase();
  if (!SAFE_ID.test(normalized)) throw new Error("非法 Provider credential id");
  return normalized;
}
export class BuiltinCredentialStore {
  private entry(id: BuiltinCredentialId): Entry {
    return new Entry(SERVICE, assertId(id));
  }

  has(id: BuiltinCredentialId): boolean {
    try {
      return Boolean(this.entry(id).getPassword());
    } catch {
      return false;
    }
  }

  get(id: BuiltinCredentialId): string | null {
    try {
      return this.entry(id).getPassword();
    } catch {
      return null;
    }
  }

  set(id: BuiltinCredentialId, secret: string): void {
    const value = secret.trim();
    if (!value) throw new Error("Credential 不能为空");
    this.entry(id).setPassword(value);
  }

  clear(id: BuiltinCredentialId): void {
    try {
      this.entry(id).deletePassword();
    } catch {
      // Clearing a missing credential is idempotent.
    }
  }
}
