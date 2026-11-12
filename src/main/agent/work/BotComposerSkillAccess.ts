import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { LearnedSkillRevisionSource } from "../../skills/SkillsService";

const learnedSchema = z.object({ source: z.literal("memory-learned"), candidateId: z.string().min(1),
  sourceMemoryIds: z.array(z.string().min(1)).min(1), scopeType: z.enum(["global", "workspace", "project", "bot"]),
  scopeId: z.string().nullable().optional() });
export interface BotComposerSkillAccess { canRead(input: { id: string; directory: string }): boolean }

/** Frozen packages keep provenance; current installation and memory decide whether they remain usable. */
export function createBotComposerSkillAccess(input: {
  identity: { botId: string; shared: boolean };
  current: (id: string) => LearnedSkillRevisionSource | undefined;
  runnable: (id: string, sourceMemoryIds: string[]) => boolean;
  /** Background tasks may carry a host-resolved project/workspace scope. */
  scopeAllowed?: (source: LearnedSkillRevisionSource) => boolean;
}): BotComposerSkillAccess {
  const provenance = new Map<string, string>();
  return { canRead(pack) {
    try {
      const metaPath = join(pack.directory, "_skillhub_meta.json");
      const raw: unknown = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : undefined;
      const header = z.object({ source: z.string().optional() }).optional().parse(raw);
      const current = input.current(pack.id);
      if (header?.source !== "memory-learned") return !current && !provenance.has(pack.directory);
      const frozen = learnedSchema.parse(raw);
      const fingerprint = JSON.stringify(frozen);
      const previous = provenance.get(pack.directory);
      if (previous && previous !== fingerprint) return false;
      provenance.set(pack.directory, fingerprint);
      if (!current || current.candidateId !== frozen.candidateId || current.scopeType !== frozen.scopeType
        || (current.scopeId ?? null) !== (frozen.scopeId ?? null)
        || JSON.stringify([...current.sourceMemoryIds].sort()) !== JSON.stringify([...frozen.sourceMemoryIds].sort())) return false;
      // Foreground has no project/workspace authority. Shared ingress cannot mount personal methods.
      if (input.scopeAllowed ? !input.scopeAllowed(current)
        : frozen.scopeType !== "global" && (frozen.scopeType !== "bot" || input.identity.shared
          || frozen.scopeId !== input.identity.botId)) return false;
      if (!input.runnable(current.skillId, frozen.sourceMemoryIds)) return false;
      const currentText = readFileSync(current.filePath, "utf8");
      const currentHeaderEnd = currentText.startsWith("---") ? currentText.indexOf("\n---", 3) : -1;
      if (currentHeaderEnd >= 0 && /^disable-model-invocation\s*:\s*["']?true["']?\s*$/m.test(currentText.slice(3, currentHeaderEnd))) return false;
      const rawSkill = readFileSync(join(pack.directory, "SKILL.md"), "utf8");
      const end = rawSkill.startsWith("---") ? rawSkill.indexOf("\n---", 3) : -1;
      const headerText = end < 0 ? "" : rawSkill.slice(3, end).trim();
      const body = end < 0 ? rawSkill : rawSkill.slice(end + 4).replace(/^\r?\n/, "");
      const fields = Object.fromEntries(headerText.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^([\w-]+)\s*:\s*(.*)$/);
        return match ? [[match[1], match[2].replace(/^["']|["']$/g, "").trim()]] : [];
      }));
      if (fields["disable-model-invocation"] === "true") return false;
      return createHash("sha256").update(`${(fields.description ?? "").trim()}\n${body.trim()}`).digest("hex") === current.contentHash;
    } catch { return false; }
  } };
}
