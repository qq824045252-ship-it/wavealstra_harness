/** Main-process identity shared by retained interaction and product-tool services. */
export interface ConversationExecutionContext {
  taskId: string;
  executionId: string;
  assistantMessageId: string;
}
