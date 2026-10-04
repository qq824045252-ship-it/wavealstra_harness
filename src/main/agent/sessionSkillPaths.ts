/**
 * 会话候选技能路径合成（唯一规则，createSession 与 assembleModePreview 共用）。
 *
 * 运行时只有一套 Skill Resolver：Global Skills + 当前 Expert Private Skills +
 * 当前 Active Connector Private Skills => 统一经 Mode/Tag skillPolicy 过滤。
 * 这里只负责「哪些私有目录进入候选」：仅当前选中专家 / 当前 Active 连接器，
 * 不扫描其它已安装专家或连接器；空/未安装/非法 id 由来源服务静默跳过。
 */

export interface SessionSkillPathSources {
  /** 当前专家私有技能目录（未安装/停用 → null） */
  expertSkillDir: (expertId: string) => string | null;
  /** Active 连接器私有技能目录列表（内部做 installed + enabled 门禁） */
  connectorSkillDirs: (connectorIds: string[]) => string[];
}

export function collectSessionSkillPaths(
  expertId: string | null | undefined,
  connectorIds: string[] | undefined,
  sources: SessionSkillPathSources,
): string[] {
  const paths: string[] = [];
  const expert = expertId?.trim();
  if (expert) {
    const dir = sources.expertSkillDir(expert);
    if (dir) paths.push(dir);
  }
  paths.push(...sources.connectorSkillDirs(connectorIds ?? []));
  return paths;
}
