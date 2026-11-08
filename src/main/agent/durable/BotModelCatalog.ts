/**
 * Durable 任务的模型归属解析：持久化的 `tasks.model_id` 是创建任务时的模型目录坐标，
 * 而模型目录（models.json）会随网关路由/厂商目录变更而收缩。任务模型被下线后，
 * Durable 运行时仍必须能打开历史并继续工作，因此这里给出**确定**的替换规则，
 * 而不是把「目录里没有」当成会话损坏。
 *
 * 解析顺序（先命中先用）：
 * 1. 原值在目录中仍可解析 —— 原样使用；
 * 2. 同 provider 下**模型名相同**的现存路由（`a/b/name` → `a/route/name`）：保留网关与模型家族；
 * 3. 全局默认模型（settings 的 defaultModelId）；
 * 4. 目录中第一个可用模型；
 * 5. 都没有：抛错，让调用方展示「没有可用模型」而不是继续假装正常。
 *
 * 每次替换都带 `repairedFrom`，调用方必须把它持久化并告诉用户，禁止静默换模型。
 */

export interface BotModelCandidate {
  provider: string;
  id: string;
  name?: string;
}

export interface BotModelCatalog {
  getModel(provider: string, modelId: string): BotModelCandidate | undefined;
  getModels(): readonly BotModelCandidate[];
  getAvailable(): Promise<readonly BotModelCandidate[]>;
}

export interface BotModelTarget {
  provider: string;
  modelId: string;
}

export interface BotModelResolution {
  target: BotModelTarget;
  /** 持久化值已失效时的原值；存在即表示这次解析做了替换。 */
  repairedFrom?: string;
  /** 替换原因，用于日志与用户提示。 */
  reason?: "same-model-other-route" | "default-model" | "first-available";
}

export const modelKey = (target: BotModelTarget): string => `${target.provider}/${target.modelId}`;

function splitModelId(id: string): BotModelTarget | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

const tail = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/** 路由变体后缀（`-fast`/`-batch`）：目录里没有对应变体时，按同一模型匹配。 */
const ROUTE_VARIANT = /-(?:fast|batch|turbo)$/i;

/** 同一模型的可能名字：原名优先，其次去掉路由变体后缀。 */
function modelNames(id: string): string[] {
  const name = tail(id);
  const stripped = name.replace(ROUTE_VARIANT, "");
  return stripped && stripped !== name ? [name, stripped] : [name];
}

function resolvable(catalog: BotModelCatalog, id: string | undefined): BotModelTarget | undefined {
  const target = id?.trim() ? splitModelId(id.trim()) : undefined;
  if (!target) return undefined;
  return catalog.getModel(target.provider, target.modelId) ? target : undefined;
}

async function availableModels(catalog: BotModelCatalog): Promise<readonly BotModelCandidate[]> {
  try { return await catalog.getAvailable(); }
  // 可用性查询失败（认证状态/网络）时仍可用静态目录做同名路由匹配。
  catch { return catalog.getModels(); }
}

/** 同 provider 下模型名相同的现存路由；目录顺序即产品顺序，取第一个。 */
function sameModelOtherRoute(candidates: readonly BotModelCandidate[], preferred: BotModelTarget): BotModelTarget | undefined {
  for (const wanted of modelNames(preferred.modelId)) {
    const hit = candidates.find(candidate => candidate.provider === preferred.provider
      && (candidate.id === wanted || candidate.id.endsWith(`/${wanted}`)));
    if (hit) return { provider: hit.provider, modelId: hit.id };
  }
  return undefined;
}

export async function resolveBotModel(
  catalog: BotModelCatalog,
  preferredId?: string,
  defaultId?: string,
): Promise<BotModelResolution> {
  const preferred = preferredId?.trim() ? splitModelId(preferredId.trim()) : undefined;
  if (preferred && catalog.getModel(preferred.provider, preferred.modelId)) return { target: preferred };

  const candidates = await availableModels(catalog);
  const repairedFrom = preferred ? modelKey(preferred) : undefined;

  if (preferred) {
    const sameRoute = sameModelOtherRoute(candidates, preferred);
    if (sameRoute) return { target: sameRoute, repairedFrom, reason: "same-model-other-route" };
  }

  const fallbackDefault = resolvable(catalog, defaultId);
  if (fallbackDefault) return { target: fallbackDefault, repairedFrom, reason: "default-model" };

  const first = candidates[0];
  if (first) return { target: { provider: first.provider, modelId: first.id }, repairedFrom, reason: "first-available" };

  throw new Error(preferred
    ? `模型 ${repairedFrom} 已不在模型目录中，且当前没有其它可用模型。请在「设置 → 模型」中启用一个模型后重试。`
    : "当前没有可用模型：请在「设置 → 模型」中启用一个模型后重试。");
}
