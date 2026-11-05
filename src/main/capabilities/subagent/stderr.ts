import { redactBlueprintSecrets } from "../../../shared/blueprint-secret-policy";

const MAX_CHARS = 4_000;
const PRIVATE_KEY_START = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

export class SubagentStderr {
  private completed = "";
  private line = "";
  private overflow = false;
  private privateKey = false;

  constructor(private readonly onLine?: (text: string) => void) {}

  private safeLine(): string {
    if (this.privateKey || PRIVATE_KEY_START.test(this.line)) return "[redacted]";
    if (this.overflow) return "[stderr line omitted: too long]";
    return redactBlueprintSecrets(this.line)
      .replace(/\b(Bearer|Basic)\s+[^\s,"';]+/gi, "$1 [redacted]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1[redacted]")
      .replace(/\b(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
      .trim();
  }

  get tail(): string {
    return [this.completed, this.safeLine()].filter(Boolean).join("\n").slice(-MAX_CHARS);
  }

  flush(): void {
    const safe = this.safeLine();
    if (PRIVATE_KEY_START.test(this.line)) this.privateKey = true;
    if (PRIVATE_KEY_END.test(this.line)) this.privateKey = false;
    this.line = "";
    this.overflow = false;
    if (safe) {
      this.completed = [this.completed, safe].filter(Boolean).join("\n").slice(-MAX_CHARS);
      this.onLine?.(safe);
    }
  }

  push(text: string): void {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!this.overflow) {
        if (this.line.length + parts[i].length > MAX_CHARS) {
          if (PRIVATE_KEY_START.test(this.line + parts[i])) this.privateKey = true;
          this.line = "";
          this.overflow = true;
        } else {
          this.line += parts[i];
        }
      }
      if (i < parts.length - 1) this.flush();
    }
  }
}
