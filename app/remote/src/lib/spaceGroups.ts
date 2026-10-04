import type { RemoteSpaceSummary, RemoteTaskSummary } from '@mybuddy/shared'

/**
 * 抽屉任务列表的空间分组（桌面端 workspace-tree 的轻量对齐版）。
 * 语义与桌面侧栏一致：
 * - effectiveArchived 的空间连同其任务不进入默认列表（桌面 isTaskEffectiveArchived 口径）；
 * - spaceId 为空、或指向已删除/已归档空间的任务 → 「独立任务」区；
 * - 远程契约没有 spaceSortOrder / space.createdAt，排序降级为：
 *   空间 = sortOrder 显式优先 → 名称；任务 = 置顶优先 → updatedAt 新→旧。
 */

export interface SpaceGroupNode {
  space: RemoteSpaceSummary
  /** 直接挂在该空间下的任务 */
  tasks: RemoteTaskSummary[]
  children: SpaceGroupNode[]
  /** 子树任务总数（含嵌套子空间），文件夹徽标用 */
  totalTasks: number
}

export interface SpaceTaskGroups {
  roots: SpaceGroupNode[]
  standalone: RemoteTaskSummary[]
}

function compareTasks(a: RemoteTaskSummary, b: RemoteTaskSummary): number {
  const pin = Number(b.isFavorited) - Number(a.isFavorited)
  if (pin !== 0) return pin
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id.localeCompare(b.id)
}

function compareSpaces(a: RemoteSpaceSummary, b: RemoteSpaceSummary): number {
  const aOrder = a.sortOrder > 0 ? a.sortOrder : Number.POSITIVE_INFINITY
  const bOrder = b.sortOrder > 0 ? b.sortOrder : Number.POSITIVE_INFINITY
  if (aOrder !== bOrder) return aOrder - bOrder
  const byName = a.name.localeCompare(b.name, 'zh-Hans-CN')
  return byName !== 0 ? byName : a.id.localeCompare(b.id)
}

export function buildSpaceTaskGroups(
  spaces: RemoteSpaceSummary[],
  tasks: RemoteTaskSummary[],
): SpaceTaskGroups {
  const spaceById = new Map(spaces.map((s) => [s.id, s]))
  const visible = new Set(spaces.filter((s) => !s.effectiveArchived).map((s) => s.id))

  const tasksBySpace = new Map<string, RemoteTaskSummary[]>()
  const standalone: RemoteTaskSummary[] = []
  for (const task of tasks) {
    const space = task.spaceId ? spaceById.get(task.spaceId) : undefined
    if (space && visible.has(space.id)) {
      const arr = tasksBySpace.get(space.id)
      if (arr) arr.push(task)
      else tasksBySpace.set(space.id, [task])
    } else if (space?.effectiveArchived) {
      // 已归档空间中的任务：与桌面侧栏默认视图一致，不展示
      continue
    } else {
      // 无空间 / 空间行已删除（悬空 spaceId）→ 独立任务
      standalone.push(task)
    }
  }
  standalone.sort(compareTasks)

  const childrenOf = new Map<string | null, RemoteSpaceSummary[]>()
  for (const space of spaces) {
    if (!visible.has(space.id)) continue
    // 父空间被归档/已删除时回退到根层，避免子空间从树里消失
    const parent = space.parentId && visible.has(space.parentId) ? space.parentId : null
    const arr = childrenOf.get(parent)
    if (arr) arr.push(space)
    else childrenOf.set(parent, [space])
  }

  const visited = new Set<string>()
  const build = (space: RemoteSpaceSummary): SpaceGroupNode => {
    visited.add(space.id)
    const node: SpaceGroupNode = {
      space,
      tasks: (tasksBySpace.get(space.id) ?? []).sort(compareTasks),
      children: [],
      totalTasks: 0,
    }
    for (const child of (childrenOf.get(space.id) ?? []).sort(compareSpaces)) {
      if (visited.has(child.id)) continue // 脏数据环防御
      node.children.push(build(child))
    }
    node.totalTasks = node.tasks.length + node.children.reduce((sum, c) => sum + c.totalTasks, 0)
    return node
  }

  const roots = (childrenOf.get(null) ?? []).sort(compareSpaces).map(build)
  return { roots, standalone }
}
