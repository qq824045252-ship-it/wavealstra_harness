/** Public gateway metadata only. Never read the user's models.json or credentials. */
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const positive = (...values) => values.find(value => Number.isSafeInteger(value) && value > 0);
function liveModelFromCatalog(catalog, selectedModel, outputPressure = false) {
  const entry = catalog?.data?.find(model => model.id === selectedModel);
  if (!entry) throw Error(`Live model ${selectedModel} is missing from the gateway model catalog`);
  const contextWindow = positive(entry.context_window, entry.context_length, entry.max_input_tokens);
  const maxTokens = positive(entry.max_output_tokens);
  if (!contextWindow || !maxTokens) throw Error(`Live model ${selectedModel} does not publish valid context/output limits; refusing to invent a test cap`);
  const efforts = (entry.supported_reasoning_levels || []).map(value => typeof value === 'string' ? value : value.effort).filter(value => typeof value === 'string');
  const model = {
    id: selectedModel, name: 'Frontdoor live verification', reasoning: entry.reasoning === true || efforts.length > 0,
    input: entry.modalities?.input?.includes('image') ? ['text', 'image'] : ['text'], contextWindow,
    maxTokens: outputPressure ? Math.min(4096, maxTokens) : maxTokens,
    ...(efforts.length ? {thinkingLevelMap: Object.fromEntries(levels.map(level => [level, efforts.includes(level) ? level : level === 'off' && efforts.includes('none') ? 'none' : null]))} : {}),
    // This recorder does not claim price evidence from a catalog that omits it.
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
  };
  return {model, evidence: {modelId: selectedModel, declaredContextWindow: contextWindow, declaredMaxOutputTokens: maxTokens,
    effectiveMaxOutputTokens: model.maxTokens, reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap,
    mode: outputPressure ? 'explicit-output-pressure' : 'gateway-model-configuration', pricing: 'not-measured'}};
}
async function loadLiveModel(baseUrl, selectedModel, outputPressure = false) {
  const source = baseUrl.replace(/\/$/, '') + '/models';
  const response = await fetch(source, {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw Error(`Live model catalog returned HTTP ${response.status}`);
  const result = liveModelFromCatalog(await response.json(), selectedModel, outputPressure);
  return {...result, evidence: {...result.evidence, source, capturedAt: new Date().toISOString()}};
}
module.exports = {liveModelFromCatalog, loadLiveModel};
