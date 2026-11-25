import { z } from "zod";

export const LIBRARY_NOTES_BACKUP_LIMIT = 256 * 1024 * 1024;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const date = z.number().int().nonnegative();
const webUrl = z.string().url().regex(/^https?:\/\//i);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const clipSource = z.object({
  title: z.string(), url: webUrl, capturedAt: date, failedImages: z.array(z.string()).optional(),
});

const folder = z.object({
  id, spaceId: id, parentId: id.nullable(), name: z.string().min(1), owner: z.string(), createdAt: date, updatedAt: date,
});

const item = z.object({
  id, spaceId: id, collectionId: id.nullable(),
  kind: z.enum(["markdown", "html", "csv", "office", "pdf", "image", "file", "url"]),
  title: z.string(), filename: z.string().min(1).regex(/^[^/\\:\x00-\x1f]+$/), mimeType: z.string().regex(/^[\w.+/-]+(?:; ?charset=[-\w]+)?$/),
  sizeBytes: z.number().int().nonnegative(), owner: z.string(), favorite: z.boolean(), pinned: z.boolean().optional(),
  tags: z.array(z.string()).optional(), trashedAt: date.optional(), clipSource: clipSource.optional(), url: webUrl.optional(),
  sourceType: z.enum(["created", "uploaded", "artifact", "url"]).optional(),
  contentHash: hash.optional(), createdAt: date, updatedAt: date, lastVisitedAt: date.nullable(),
});
const version = z.object({
  id, version: z.number().int().positive(), contentHash: hash, createdBy: z.string(), createdAt: date, body: bytes.nullable(),
});

export const libraryNotesBackup = z.object({
  format: z.literal("mybuddy-notes"),
  version: z.literal(1),
  folders: z.array(folder),
  items: z.array(z.object({ item, body: bytes.nullable(), history: z.array(version) })),
});

export type LibraryNotesBackup = z.infer<typeof libraryNotesBackup>;
