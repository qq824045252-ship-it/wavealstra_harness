/** 模拟官方 MyBuddy 本地静态页预览地址 */
export function artifactPreviewUrl(taskId: string, filename: string): string {
  const safe = filename.replace(/[^\w.\-]+/g, "_");
  return `http://127.0.0.1:55158/static-html/${taskId}/${safe}`;
}
