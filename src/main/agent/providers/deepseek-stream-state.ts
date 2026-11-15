import { deepseekRecord, type DeepSeekAssistantMetadata } from "../../../shared/deepseek";

/** Collect the provider-owned representation alongside Pi's normalized text and
 * ordinary tools. Hosted calls are never converted into executable tool calls. */
export class DeepSeekStreamState {
  private readonly responseItems = new Map<number, Record<string, unknown>>();
  private readonly anthropicBlocks = new Map<number, Record<string, unknown>>();
  private readonly toolJson = new Map<number, string>();
  constructor(readonly metadata: DeepSeekAssistantMetadata, private readonly api: string) {}

  observe(event: unknown): boolean {
    const value = deepseekRecord(event);
    if (!value) return false;
    if (this.api === "openai-responses") return this.responses(value);
    if (this.api === "anthropic-messages") return this.anthropic(value);
    const choice = Array.isArray(value.choices) ? deepseekRecord(value.choices[0]) : undefined;
    const delta = deepseekRecord(choice?.delta);
    if (typeof delta?.reasoning_content === "string") this.metadata.reasoningContent = (this.metadata.reasoningContent ?? "") + delta.reasoning_content;
    const progress = deepseekRecord(choice?.server_tool_event);
    if (progress) {
      (this.metadata.serverToolEvents ??= []).push(structuredClone(progress));
      if (progress.type === "step_reasoning_done") this.metadata.reasoningContent = "";
    }
    if (Array.isArray(delta?.server_tool_calls)) this.metadata.serverToolCalls = structuredClone(delta.server_tool_calls);
    if (Array.isArray(delta?.annotations)) this.metadata.annotations = structuredClone(delta.annotations);
    if (typeof delta?.title === "string") this.metadata.title = delta.title;
    this.usage(value.usage);
    return Boolean(progress?.call) || Array.isArray(delta?.server_tool_calls);
  }

  private usage(raw: unknown): void {
    const usage = deepseekRecord(deepseekRecord(raw)?.server_tool_use);
    if (usage) this.metadata.serverToolUsage = structuredClone(usage);
  }

  private responses(value: Record<string, unknown>): boolean {
    const item = deepseekRecord(value.item);
    const index = Number(value.output_index);
    if ((value.type === "response.output_item.added" || value.type === "response.output_item.done") && item && Number.isInteger(index)) {
      this.responseItems.set(index, structuredClone(item));
    }
    const response = deepseekRecord(value.response);
    if (Array.isArray(response?.output)) {
      this.responseItems.clear();
      response.output.forEach((output, slot) => { const record = deepseekRecord(output); if (record) this.responseItems.set(slot, structuredClone(record)); });
    }
    if (typeof response?.title === "string") this.metadata.title = response.title;
    this.usage(response?.usage);
    this.metadata.responsesOutput = [...this.responseItems.entries()].sort(([a], [b]) => a - b).map(([, output]) => structuredClone(output));
    this.metadata.annotations = this.responseAnnotations();
    return item?.type === "web_search_call" || String(value.type).startsWith("response.web_search_call.");
  }

  private responseAnnotations(): unknown[] {
    const annotations: unknown[] = [];
    for (const raw of this.metadata.responsesOutput ?? []) {
      const output = deepseekRecord(raw);
      if (output?.type !== "message" || !Array.isArray(output.content)) continue;
      for (const rawPart of output.content) {
        const part = deepseekRecord(rawPart);
        if (part?.type !== "output_text" || !Array.isArray(part.annotations)) continue;
        const text = typeof part.text === "string" ? [...part.text] : [];
        for (const rawCitation of part.annotations) {
          const citation = deepseekRecord(rawCitation);
          if (citation?.type !== "url_citation") continue;
          const start = citation.start_index; const end = citation.end_index;
          annotations.push({ type: "url_citation", url_citation: { ...citation,
            ...(Number.isInteger(start) && Number.isInteger(end) && Number(start) >= 0 && Number(end) <= text.length && Number(end) > Number(start)
              ? { cited_text: text.slice(Number(start), Number(end)).join("") } : {}) } });
        }
      }
    }
    return annotations;
  }

  private anthropic(value: Record<string, unknown>): boolean {
    const index = Number(value.index);
    const content = deepseekRecord(value.content_block);
    if (value.type === "content_block_start" && content && Number.isInteger(index)) this.anthropicBlocks.set(index, structuredClone(content));
    const block = this.anthropicBlocks.get(index);
    const delta = deepseekRecord(value.delta);
    if (value.type === "content_block_delta" && block && delta) {
      for (const [type, field] of [["text_delta", "text"], ["thinking_delta", "thinking"], ["signature_delta", "signature"]]) {
        if (delta.type === type && typeof delta[field] === "string") block[field] = String(block[field] ?? "") + delta[field];
      }
      if (delta.type === "citations_delta" && deepseekRecord(delta.citation)) {
        block.citations = [...(Array.isArray(block.citations) ? block.citations : []), structuredClone(delta.citation)];
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") this.toolJson.set(index, (this.toolJson.get(index) ?? "") + delta.partial_json);
    }
    if (value.type === "content_block_stop" && block && this.toolJson.has(index)) {
      try { block.input = JSON.parse(this.toolJson.get(index)!); } catch { /* Pi owns malformed ordinary call failures. */ }
      this.toolJson.delete(index);
    }
    const initial = deepseekRecord(value.message);
    this.usage(value.usage ?? initial?.usage);
    if (typeof delta?.title === "string") this.metadata.title = delta.title;
    if (typeof value.title === "string") this.metadata.title = value.title;
    this.metadata.anthropicContent = [...this.anthropicBlocks.entries()].sort(([a], [b]) => a - b).map(([, item]) => structuredClone(item));
    this.metadata.annotations = this.metadata.anthropicContent.flatMap(raw => {
      const item = deepseekRecord(raw);
      return item?.type === "text" && Array.isArray(item.citations) ? item.citations.flatMap(rawCitation => {
        const citation = deepseekRecord(rawCitation);
        return citation?.type === "web_search_result_location" ? [{ type: "url_citation", url_citation: {
          url: citation.url, title: citation.title, cited_text: citation.cited_text,
        } }] : [];
      }) : [];
    });
    return value.type === "content_block_start" && ["server_tool_use", "web_search_tool_result", "web_fetch_tool_result"].includes(String(content?.type));
  }
}
