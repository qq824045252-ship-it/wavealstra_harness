(() => {
  const service = globalThis.__cacheInvestigationService;
  const taskId = 'local-1793579906915-0';
  const session = service?.registry.get(taskId)?.session;
  if (!session || service.isTaskBusy(taskId)) throw new Error('Target session unavailable or busy');
  if (globalThis.__mybuddyCacheAudit) return { installed: true, alreadyInstalled: true };
  const req = process.mainModule.require.bind(process.mainModule);
  const fs = req('node:fs');
  const crypto = req('node:crypto');
  const output = 'C:/Users/servi/Documents/GitHub/wavealstra_harness/artifacts/cache-investigation/runtime-watch-20261102.jsonl';
  const agent = session.agent;
  const original = agent.streamFunction;
  const deadline = Date.now() + 24 * 60 * 60 * 1000;
  const maxCalls = 16;
  let calls = 0, previous, stopped = false, expiryTimer;
  const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
  const append = value => {
    try {
      if (fs.existsSync(output) && fs.statSync(output).size > 2 * 1024 * 1024) return;
      fs.appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
    } catch { /* Diagnostics never change request behaviour. */ }
  };
  const stop = reason => {
    if (stopped) return;
    stopped = true;
    clearTimeout(expiryTimer);
    if (agent.streamFunction === wrapped) agent.streamFunction = original;
    if (globalThis.__mybuddyCacheAudit?.stop === stop) delete globalThis.__mybuddyCacheAudit;
    append({ phase: 'stopped', reason, calls });
  };
  function wrapped(model, context, options = {}) {
    if (stopped || Date.now() > deadline || calls >= maxCalls) {
      stop(Date.now() > deadline ? 'deadline' : 'call-limit');
      return Reflect.apply(original, this, [model, context, options]);
    }
    const call = ++calls;
    const base = { call, model: model.id, provider: model.provider, api: model.api };
    const fetchOriginal = options.fetch ?? globalThis.fetch;
    const decorated = {
      ...options,
      onPayload: async (payload, selected) => {
        const replacement = await options.onPayload?.(payload, selected);
        try {
          const actual = replacement === undefined ? payload : replacement;
          const items = Array.isArray(actual.input) ? actual.input : [];
          const itemHashes = items.map(hash);
          let shared = 0;
          if (previous) while (shared < previous.length && shared < itemHashes.length && previous[shared] === itemHashes[shared]) shared++;
          const fields = { ...actual }; delete fields.input;
          append({ ...base, phase: 'payload', keyHash: hash(actual.prompt_cache_key ?? ''), payloadHash: hash(actual), baseFieldsHash: hash(fields), inputItems: items.length, inputItemHashes: itemHashes, previousItems: previous?.length ?? null, sharedPreviousItems: previous ? shared : null, firstChangedItem: previous && shared < previous.length ? shared : null });
          previous = itemHashes;
        } catch { /* no request mutation */ }
        return replacement;
      },
      fetch: async (input, init) => {
        try {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const affinity = {};
          for (const name of ['session_id', 'session-id', 'thread-id', 'x-session-affinity', 'x-client-request-id', 'x-session-id']) if (headers.has(name)) affinity[name] = hash(headers.get(name));
          append({ ...base, phase: 'wire', bodyHash: typeof init?.body === 'string' ? hash(init.body) : null, bodyBytes: typeof init?.body === 'string' ? Buffer.byteLength(init.body) : null, affinityHeaderHashes: affinity });
        } catch { /* leave original transport untouched */ }
        return fetchOriginal(input, init);
      },
      onResponse: async (response, selected) => {
        try { append({ ...base, phase: 'response', status: response.status }); } catch {}
        return options.onResponse?.(response, selected);
      },
      onProviderStreamEvent: async (...args) => {
        try {
          const event = args[0];
          if (event?.type === 'response.completed' || event?.type === 'response.incomplete') {
            const usage = event.response?.usage;
            append({ ...base, phase: 'usage', responseType: event.type, inputTokens: usage?.input_tokens ?? null, cachedTokens: usage?.input_tokens_details?.cached_tokens ?? null, outputTokens: usage?.output_tokens ?? null, totalTokens: usage?.total_tokens ?? null });
            if (calls >= maxCalls) stop('call-limit');
          }
        } catch { /* log failures never affect streaming */ }
        return options.onProviderStreamEvent?.(...args);
      },
    };
    return Reflect.apply(original, this, [model, context, decorated]);
  }
  agent.streamFunction = wrapped;
  expiryTimer = setTimeout(() => stop('deadline'), deadline - Date.now());
  expiryTimer.unref?.();
  globalThis.__mybuddyCacheAudit = { stop, output, deadline, taskId, get calls() { return calls; } };
  append({ phase: 'installed', taskId, maxCalls, deadline: new Date(deadline).toISOString(), rawContentRecorded: false, rawCredentialsRecorded: false });
  return { installed: true, targetTask: taskId, maxCalls, deadline: new Date(deadline).toISOString(), output, rawContentRecorded: false, rawCredentialsRecorded: false };
})()
