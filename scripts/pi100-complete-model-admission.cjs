const fs=require('node:fs');
const file='src/main/agent/ModelInvocationAdmission.ts';let source=fs.readFileSync(file,'utf8');
const marker='  const originalSimple = runtime.streamSimple.bind(runtime);';if(!source.includes(marker))throw Error('Admission boundary not found');
const addition=`  // enabledModels is Pi's chat scope. Non-chat calls keep native typed catalogs, but
  // must still respect the product's explicit provider pause and session revocation.
  const typedValidator = (provider: string, signal?: AbortSignal) => {
    const invocation = invocationSettings.getStore();
    const settings = invocation?.settings ?? fallbackSettings();
    return async () => {
      signal?.throwIfAborted();
      await settings.reload();
      const errors = settings.drainErrors();
      if (errors.length) throw errors[0]!.error;
      const raw = settings.getSettings() as { pausedProviderModels?: Record<string, unknown> };
      if (Object.hasOwn(raw.pausedProviderModels ?? {}, provider)) {
        throw new Error('Provider ' + provider + ' is disabled in model settings');
      }
      signal?.throwIfAborted();
      invocation?.validate?.();
    };
  };
  if (typeof runtime.generateImages === 'function') {
    const originalImages = runtime.generateImages.bind(runtime);
    runtime.generateImages = async (model, context, options) => {
      const validate = typedValidator(model.provider, options?.signal);
      try {
        await validate();
        return await originalImages(model, context, {
          ...options,
          transformHeaders: async headers => {
            const result = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
            await validate(); return result;
          },
          onPayload: async (payload, selectedModel) => {
            const result = await options?.onPayload?.(payload, selectedModel);
            await validate(); return result;
          },
        });
      } catch (error) {
        return { api: model.api, provider: model.provider, model: model.id, output: [], timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error) };
      }
    };
  }
  if (typeof runtime.classify === 'function') {
    const originalClassify = runtime.classify.bind(runtime);
    runtime.classify = async (model, context, options) => {
      const validate = typedValidator(model.provider, options?.signal);
      try {
        await validate();
        return await originalClassify(model, context, {
          ...options,
          transformHeaders: async headers => {
            const result = options?.transformHeaders ? await options.transformHeaders(headers) : headers;
            await validate(); return result;
          },
          onPayload: async (payload, selectedModel) => {
            const result = await options?.onPayload?.(payload, selectedModel);
            await validate(); return result;
          },
        });
      } catch (error) {
        return { api: model.api, provider: model.provider, model: model.id, answers: {}, timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error instanceof Error ? error.message : String(error) };
      }
    };
  }
`;
source=source.replace(marker,addition+marker);fs.writeFileSync(file,source);
console.log('Extended existing request admission to native image/classifier methods; no new model runtime or automatic calls.');
