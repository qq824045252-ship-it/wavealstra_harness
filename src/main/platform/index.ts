/**
 * 平台边界（Platform boundary）。
 *
 * 业务服务不再散落 `process.platform === "win32"` 判断：所有「这个平台有没有 / 用哪种实现」
 * 的决策都收敛到 `src/main/platform/` 下的模块，服务只依赖平台无关的接口/工厂。
 *
 * 约定：
 * - 平台专属实现放在 `platform/<feature>/<platform>.ts` 或 `platform/<feature>.ts` 内部；
 * - 服务层不得再直接判断 `process.platform`（路径/大小写等纯语义判断除外）；
 * - 新增平台 = 新增一个 provider/backend 文件 + 在工厂里注册，而不是改业务代码。
 */
export type PlatformId = "windows" | "linux" | "macos";

/** 把 Node 的 platform 归一化成产品内部的三个目标平台。 */
export function platformId(platform: NodeJS.Platform = process.platform): PlatformId {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

/** 当前进程的平台（模块加载时固定；测试可传参覆盖）。 */
export const currentPlatformId: PlatformId = platformId();
