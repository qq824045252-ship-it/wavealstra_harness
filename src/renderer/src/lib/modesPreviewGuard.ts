/**
 * 设置页「装配预览」守卫（收口 P2）。
 *
 * 预览由主进程 assembleModePreview 基于【已保存】的 policy/preset 计算；
 * 设置页存在未保存草稿（dirty）时，预览无法反映草稿内容，直接禁用并提示，
 * 避免「编辑了建议模型/权限却预览到旧保存值」的 UI 误导。纯函数，便于单测。
 */
export function previewBlockedHint(dirty: boolean): string | null {
  if (!dirty) return null;
  return "预览基于已保存配置：有未保存修改，请先保存再预览";
}
