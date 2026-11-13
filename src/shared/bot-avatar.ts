import { z } from "zod";
import manifest from "./bot-avatar-manifest.json";

export const BotAvatarIpc = "bot-work:avatars";
export const AVATAR_UPLOAD_BYTES = 2 * 1024 * 1024;
export const AVATAR_UPLOAD_LIMIT = 32;
const id = z.string().regex(/^(builtin:[a-z0-9-]{1,60}|upload:[a-f0-9]{64})$/);
const file = z.string().regex(/^[a-z0-9][a-z0-9.-]*\.(png|gif|webp)$/);
const resource = z.object({ file, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(1024 * 1024) }).strict();
export const avatarManifestSchema = z.object({
  version: z.literal(1), entries: z.array(z.object({
    id: z.string().regex(/^builtin:[a-z0-9-]{1,60}$/), label: z.string().min(1).max(80),
    copyright:z.string().min(1).max(1000),
    provenance: z.enum(["synthetic-test", "original-approved"]), approval: z.string().min(1).max(240),
    poster: resource, animation: resource.optional(),
  }).strict()).max(99),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length)
    ctx.addIssue({ code: "custom", message: "Avatar IDs must be unique" });
});
export const builtinBotAvatars = avatarManifestSchema.parse(manifest).entries;
export const botAvatarCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list") }).strict(),
  z.object({ kind: z.literal("read"), assetId: id, variant:z.enum(["poster","animation"]).optional() }).strict(),
  z.object({ kind: z.literal("import") }).strict(),
  z.object({ kind: z.literal("remove"), assetId: id }).strict(),
  z.object({ kind: z.literal("set"), botId: z.string().min(1).max(240), assetId: id.nullable(), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("motion"), enabled: z.boolean() }).strict(),
]);
export type BotAvatarCommand = z.infer<typeof botAvatarCommandSchema>;
export interface BotAvatarSnapshot {
  selections: Record<string, { assetId: string | null; revision: number }>;
  uploads: Array<{ id: string; label: string; animated?: boolean }>;
  motion: boolean;
}
export type BotAvatarResult = { ok: true; snapshot: BotAvatarSnapshot; image?: string; importedId?: string; cancelled?: boolean } | { ok: false; message: string };
