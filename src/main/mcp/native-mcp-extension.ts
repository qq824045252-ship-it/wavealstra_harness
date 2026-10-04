import { createMcpExtension, type ExtensionFactory, type McpExtensionOptions } from '@earendil-works/pi-coding-agent';
import { classifyMcpToolCall } from '../security/McpSideEffectPolicy';

/** Set scheduling metadata; all execution, cancellation and queue ownership stay in Pi. */
export function createPolicyAwareNativeMcpExtension(options: McpExtensionOptions, providerIds: readonly string[]): ExtensionFactory {
  const native = createMcpExtension(options);
  return api => native({
    ...api,
    registerTool: tool => {
      const classification = classifyMcpToolCall(tool.name, undefined, providerIds);
      const readonly = tool.annotations?.readOnlyHint === true
        && (!classification || (classification.clearlyReadonly && !classification.sideEffect));
      api.registerTool({ ...tool, executionMode: readonly ? 'parallel' : 'sequential' });
    },
  });
}
