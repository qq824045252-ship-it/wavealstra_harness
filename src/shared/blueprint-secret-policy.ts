const SENSITIVE_FILE = /^(?:\.env(?:\..+)?|credentials?(?:\.(?:json|ya?ml|toml))?|secrets?(?:\.(?:json|ya?ml|toml))?|auth\.json|oauth\.json|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|.+\.(?:pem|key|p12|pfx))$/i;
const FORBIDDEN_CAPTURE_SEGMENT = /^(?:node_modules|cache|\.cache|\.next|dist|build|logs|\.mybuddy-task\.json)$/i;
const TEMP_LOG_FILE = /\.log$/i;
const SECRET_KEY = "api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|authorization";

export function isBlueprintSensitivePath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some((part) =>
    SENSITIVE_FILE.test(part) || FORBIDDEN_CAPTURE_SEGMENT.test(part) || TEMP_LOG_FILE.test(part),
  );
}

/** Redact high-confidence literal credentials without rewriting ordinary password/token variable usage. */
export function redactBlueprintSecrets(content: string): string {
  const quotedLiteral = new RegExp(`(["']?)(${SECRET_KEY})\\1(\\s*[:=]\\s*)(["'])([^"'\\r\\n]+)\\4`, "gi");
  const unquotedLiteral = new RegExp(`(^|[\\r\\n])(\\s*(?:${SECRET_KEY})\\s*[:=]\\s*)([^\\r\\n#]+)`, "gi");
  return content
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]")
    .replace(quotedLiteral, "$1$2$1$3$4[redacted]$4")
    .replace(unquotedLiteral, (match, prefix: string, assignment: string, rawValue: string) => {
      const value = rawValue.trim();
      if (!value || value === "[redacted]" || /^(?:\$|process\.env\.|import\.meta\.env\.|env\.|secretRef\b|credentialRef\b)/i.test(value)) return match;
      return `${prefix}${assignment}[redacted]`;
    });
}

export function assertBlueprintSecretFree(value: unknown): void {
  const secretKey = new RegExp(`^(?:${SECRET_KEY})$`, "i");
  const visit = (current: unknown, key?: string): void => {
    if (typeof current === "string") {
      const trimmed = current.trim();
      if ((key && secretKey.test(key) && trimmed && trimmed !== "[redacted]") || redactBlueprintSecrets(current) !== current) {
        throw new Error("Blueprint definition 包含疑似 credential/token，请先移除或替换为 [redacted]");
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current && typeof current === "object") {
      for (const [childKey, child] of Object.entries(current as Record<string, unknown>)) visit(child, childKey);
    }
  };
  visit(value);
}
