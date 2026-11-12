/** Directory metadata durability after publication. POSIX errors are never treated as success. */
import { open } from 'node:fs/promises';
import { currentNodePlatform } from './runtime';

export async function syncPublishedDirectory(directory: string, platform: NodeJS.Platform = currentNodePlatform): Promise<void> {
  // Node cannot open directory handles for fsync on Windows. File content is still
  // flushed before rename; power-loss rename durability there needs platform validation.
  if (platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
