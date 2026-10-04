/** 去掉尾部斜杠，便于比较空间文件夹路径。 */
export function normalizeSpacePath(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

/** 路径比较键：去尾斜杠、统一分隔符、小写（Windows 盘符/路径大小写不敏感）。 */
export function spacePathKey(p: string): string {
  return normalizeSpacePath(p).replace(/\\/g, "/").toLowerCase();
}

export function spaceFolderBasename(p: string): string {
  const norm = normalizeSpacePath(p);
  return norm.split(/[\\/]/).pop() || norm;
}

export interface RelocatableSpace {
  id: string;
  name: string;
  path?: string;
}

/**
 * 打开本地文件夹时，判断是否应回收已有空间（而不是再建一个空的）。
 *
 * 命中条件：目标路径尚未被占用，且某空间「旧路径已不存在 / 从未绑路径」，
 * 同时空间名或旧文件夹名与新文件夹名一致。
 *
 * 旧路径仍在 → 视为复制/第二个同名目录，不回收。
 */
export function findSpaceToRemount<T extends RelocatableSpace>(
  spaces: T[],
  newPath: string,
  newName: string,
  pathExists: (absPath: string) => boolean,
): T | undefined {
  const destKey = spacePathKey(newPath);
  if (spaces.some((space) => space.path && spacePathKey(space.path) === destKey)) {
    return undefined;
  }

  const nameKey = newName.trim().toLowerCase();
  const destBase = spaceFolderBasename(newPath).toLowerCase();

  const candidates: Array<{ space: T; rank: number }> = [];
  for (const space of spaces) {
    if (space.path && pathExists(space.path)) continue;
    const nameMatch = nameKey !== "" && space.name.trim().toLowerCase() === nameKey;
    const baseMatch = Boolean(space.path) && spaceFolderBasename(space.path!).toLowerCase() === destBase;
    if (!nameMatch && !baseMatch) continue;
    candidates.push({ space, rank: baseMatch ? 0 : 1 });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0]?.space;
}
