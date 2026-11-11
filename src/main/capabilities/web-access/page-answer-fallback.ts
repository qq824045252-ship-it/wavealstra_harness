/** A failed synthesis must not erase a successfully fetched source. */
export function pageAnswerFallback(input: {
  mode: string; fetchError?: string | null; content: string; url: string;
  responseId: string; toolName: string; urlIndex?: number; aborted?: boolean;
}): { text: string; details: Record<string, unknown> } | null {
  if (input.mode !== "answer" || input.fetchError || input.aborted || !input.content.trim()) return null;
  const preview = input.content.slice(0, 4_000);
  return {
    text: `\n\nThe page was fetched, but the requested model answer failed. This is source text, NOT a verified answer. Do not refetch solely to recover this content.\nSource: ${input.url}\n<untrusted_page_content>\n${preview}\n</untrusted_page_content>\n${preview.length < input.content.length ? `Source preview truncated at ${preview.length} of ${input.content.length} characters. ` : ""}Use ${input.toolName}({ responseId: "${input.responseId}", urlIndex: ${input.urlIndex ?? 0}, offset: ${preview.length} }) for further source content if needed.`,
    details: { fetched: true, answerStatus: "failed", fallbackKind: "source-text", sourceChars: input.content.length, shownSourceChars: preview.length },
  };
}
