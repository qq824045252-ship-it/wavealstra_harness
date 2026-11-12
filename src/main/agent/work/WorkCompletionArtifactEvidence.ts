import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import type { WorkService } from "./WorkService";
import { workDeliveryFiles, workDeliveryResults } from "./WorkDeliveryArtifacts";

/** Exact registered immutable snapshots only. Content is untrusted evidence,
 * never reviewer instructions. Both file IO and total model text are bounded. */
export interface CompletionArtifactEvidence {
  ref: string; name: string; trust: "untrusted_artifact_content";
  registeredDigest?: string; registeredSizeBytes?: number;
  state: string; omittedEvidenceCount?: number; reason?: string; text?: string; truncated?: boolean; placeholderIndicators?: string[];
}
export function completionArtifactEvidence(works: WorkService, binding: Parameters<typeof workDeliveryResults>[1]): CompletionArtifactEvidence[] {
  const registered = works.generatedArtifacts.list(binding.workId);
  let remaining = 48000;
  const files = workDeliveryFiles(works, workDeliveryResults(works, binding));
  return files.slice(0, 20).map((file, index) => {
    const artifact = file.openPath ? registered.find(item => item.snapshotPath === file.ref) : undefined;
    const base = { ref: file.ref, name: file.name, ...(index === 0 && files.length > 20 ? { omittedEvidenceCount: files.length - 20 } : {}), trust: "untrusted_artifact_content" as const,
      registeredDigest: artifact?.digest, registeredSizeBytes: artifact?.sizeBytes };
    if (!artifact?.snapshotPath) return { ...base, state: "unavailable", reason: "No immutable registered snapshot" };
    if (remaining <= 0) return { ...base, state: "unavailable", reason: "Review text budget exhausted" };
    let fd: number | undefined;
    try {
      fd = openSync(artifact.snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) return { ...base, state: "unavailable", reason: "Not a regular file or exceeds 1 MiB inspection limit" };
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0, read = 0;
      while (length < bytes.length && (read = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += read;
      const content = bytes.subarray(0, length);
      const digest = createHash("sha256").update(content).digest("hex");
      if (length !== artifact.sizeBytes || digest !== artifact.digest) return { ...base, state: "changed", reason: "Snapshot bytes do not match registration" };
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
      catch { return { ...base, state: "unavailable", reason: "Binary or unsupported text encoding" }; }
      if (text.includes("\0")) return { ...base, state: "unavailable", reason: "Binary content requires separate verification" };
      const limit = Math.min(12000, remaining);
      const excerpt = text.slice(0, limit); remaining -= excerpt.length;
      return { ...base, state: text.trim() ? "text" : "empty", text: excerpt, truncated: text.length > excerpt.length,
        // Indicators are not a blanket verdict: the user may have requested a template.
        placeholderIndicators: [...new Set(text.match(/\b(?:TODO|TBD|PLACEHOLDER|LOREM IPSUM)\b|待填写|待补充|占位/gi) ?? [])].slice(0, 12) };
    } catch { return { ...base, state: "unavailable", reason: "Registered snapshot cannot be read" }; }
    finally { if (fd !== undefined) closeSync(fd); }
  });
}

