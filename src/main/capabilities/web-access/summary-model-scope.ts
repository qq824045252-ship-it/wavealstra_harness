import { resolveModelScopeWithDiagnostics, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSessionModelInvocation } from "../../agent/ModelInvocationAdmission";

const nativeRuntimes = new WeakMap<object, ModelRuntime>();
/** A Durable data adapter may use the existing search summarizer without AgentSession admission. */
export function bindNativeSummaryRuntime(reader: object, runtime: ModelRuntime): void { nativeRuntimes.set(reader, runtime); }

export interface ModelLike {
	provider: string;
	id: string;
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
	find(provider: string, id: string): T | undefined;
	getAvailable(): readonly T[];
}

/**
 * Resolve a model through its native provider or a provider that routes that model ID.
 *
 * The direct registry fallback preserves explicit/native model resolution when a
 * provider's availability snapshot does not include the configured model. Callers
 * continue to apply their existing enabled-model and authentication checks.
 */
export function findModelWithProviderRouting<T extends ModelLike>(
	registry: ModelRegistryLike<T>,
	provider: string,
	id: string,
): T | undefined {
	const available = registry.getAvailable();
	const direct = available.find(model => model.provider === provider && model.id === id);
	if (direct) return direct;

	const routedId = `${provider}/${id}`;
	// If multiple routers expose the same model ID, Pi's available-model ordering
	// determines which route is selected. An explicit provider/model selector can
	// select a specific route when that distinction matters.
	const routed = available.find(model => model.id === routedId);
	return routed ?? registry.find(provider, id);
}

export function summaryModelValue(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/** Pi owns effective settings, pattern parsing, catalogue and request-time auth. */
export async function resolveSummaryModelScope(ctx: Pick<ExtensionContext, "sessionManager">) {
  const native = nativeRuntimes.get(ctx.sessionManager);
  if (native) return { models: await native.getAvailable(), isAllowed: () => true, complete: native.complete.bind(native), completeSimple: native.completeSimple.bind(native) };
  const invocation = getSessionModelInvocation(ctx.sessionManager);
  await invocation.settings.reload();
  const errors = invocation.settings.drainErrors();
  if (errors.length) throw errors[0]!.error;
  const patterns = invocation.settings.getEnabledModels();
  const models = patterns === undefined
    ? await invocation.runtime.getAvailable()
    : (await resolveModelScopeWithDiagnostics(patterns, invocation.runtime)).scopedModels.map(({ model }) => model);
  const allowed = new Set(models.map(summaryModelValue));
  const complete: ModelRuntime["complete"] = (model, context, options) => invocation.run(
    () => invocation.runtime.complete(model, context, options),
  );
  const completeSimple: ModelRuntime["completeSimple"] = (model, context, options) => invocation.run(
    () => invocation.runtime.completeSimple(model, context, options),
  );
  return { models, isAllowed: (model: ModelLike) => allowed.has(summaryModelValue(model)), complete, completeSimple };
}
