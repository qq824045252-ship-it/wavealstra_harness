import type {
  RemoteAcpAgentSummary,
  RemoteAcpCreateRequest,
  RemoteAcpCreateResponse,
  RemoteAcpPermissionPolicy,
  RemoteAcpPromptRequest,
  RemoteAcpPromptResponse,
  RemoteApprovalRequest,
  RemoteBootstrap,
  RemoteEventEnvelope,
  RemoteConversationInteractionAnswer,
  RemoteConversationInteractionMutationResult,
  RemoteModelRefreshResult,
  RemoteModelSetting,
  RemoteNotification,
  RemotePairResponse,
  RemotePromptRequest,
  RemotePromptResponse,
  RemoteRuntimeSnapshot,
  RemoteTaskHistory,
} from '@mybuddy/shared'

export class RemoteApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export class RemoteClient {
  constructor(readonly baseUrl: string, private readonly token: string) {}

  static async pair(baseUrl: string, request: { pairingId: string; secret: string; deviceName: string; installationId?: string }): Promise<RemotePairResponse> {
    const payload = {
      pairingId: request.pairingId,
      secret: request.secret,
      deviceName: request.deviceName,
      installationId: request.installationId,
    }
    const response = await fetch(`${baseUrl}/v1/pair/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    })
    return RemoteClient.read<RemotePairResponse>(response)
  }

  static async pairDirect(baseUrl: string, request: { deviceName?: string; installationId?: string; code: string }): Promise<RemotePairResponse> {
    const payload = {
      deviceName: request.deviceName || 'Android',
      installationId: request.installationId,
      code: request.code,
    }
    const response = await fetch(`${baseUrl}/v1/pair/direct`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    })
    return RemoteClient.read<RemotePairResponse>(response)
  }

  bootstrap() { return this.get<RemoteBootstrap>('/v1/bootstrap') }
  modelSettings() { return this.get<RemoteModelSetting[]>('/v1/models/settings') }
  setModelEnabled(id: string, enabled: boolean) { return this.post<RemoteModelSetting[]>('/v1/models/settings', { id, enabled }) }
  refreshModels() { return this.post<RemoteModelRefreshResult>('/v1/models/refresh', {}) }
  history(taskId: string) { return this.get<RemoteTaskHistory>(`/v1/tasks/${encodeURIComponent(taskId)}/history`) }
  runtime(taskId: string) { return this.get<RemoteRuntimeSnapshot>(`/v1/tasks/${encodeURIComponent(taskId)}/runtime`) }
  notifications() { return this.get<RemoteNotification[]>('/v1/notifications?limit=100') }
  createTask(request: RemotePromptRequest) { return this.post<RemotePromptResponse>('/v1/tasks', request) }
  /** 新任务第一轮直接交给 ACP 外部 Agent（契约字段名是 acpAgentId，本地用 agentId 复用请求类型） */
  createAcpTask(request: RemoteAcpCreateRequest) {
    const { agentId, ...rest } = request
    return this.post<RemoteAcpCreateResponse>('/v1/tasks', { ...rest, acpAgentId: agentId })
  }
  prompt(taskId: string, request: RemotePromptRequest) { return this.post<RemotePromptResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/prompt`, request) }
  abort(taskId: string) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/abort`, {}) }
  /** 「已结束」绿点确认：打开任务 = 已查看。电脑端写 tasks.done_acked_at，多设备共享同一状态。 */
  ackDone(taskId: string) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/ackDone`, {}) }
  /** 删除任务：服务端走安全回收（可恢复），不是物理删除。 */
  deleteTask(taskId: string) { return this.del(`/v1/tasks/${encodeURIComponent(taskId)}`) }
  approve(taskId: string, toolCallId: string, request: RemoteApprovalRequest) { return this.post(`/v1/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(toolCallId)}/respond`, request) }
  /** ACP 外部 Agent 目录：手机端 Agent 选择器；refresh=1 让电脑端重新探测 CLI/adapter */
  acpAgents(refresh = false) { return this.get<RemoteAcpAgentSummary[]>(`/v1/acp/agents${refresh ? '?refresh=1' : ''}`) }
  /** 修改某 Agent 的权限策略（ask / auto-allow / auto-deny）；电脑端下一轮即生效 */
  setAcpPermission(agentId: string, policy: RemoteAcpPermissionPolicy) {
    return this.post<RemoteAcpAgentSummary[]>(`/v1/acp/agents/${encodeURIComponent(agentId)}/permission`, { policy })
  }
  /** 在电脑端起一轮真实 ACP 进程执行（长任务；流式输出走 /v1/events） */
  acpPrompt(taskId: string, request: RemoteAcpPromptRequest) {
    return this.post<RemoteAcpPromptResponse>(`/v1/tasks/${encodeURIComponent(taskId)}/acp`, request)
  }
  respondInteraction(taskId: string, interactionId: string, answer: RemoteConversationInteractionAnswer) {
    return this.post<RemoteConversationInteractionMutationResult>(
      `/v1/tasks/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
      { answer },
    )
  }
  cancelInteraction(taskId: string, interactionId: string) {
    return this.post<RemoteConversationInteractionMutationResult>(
      `/v1/tasks/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(interactionId)}/cancel`,
      {},
    )
  }
  readNotification(id: string) { return this.post(`/v1/notifications/${encodeURIComponent(id)}/read`, {}) }
  readAllNotifications() { return this.post('/v1/notifications/read-all', {}) }
  clearAllNotifications() { return this.post('/v1/notifications/clear-all', {}) }

  async eventStream(lastEventId: number, signal: AbortSignal, onEvent: (event: RemoteEventEnvelope) => void, onOpen?: () => void, onActivity?: () => void): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/events`, {
      headers: { authorization: `Bearer ${this.token}`, 'last-event-id': String(lastEventId) }, signal,
    })
    if (!response.ok || !response.body) throw new RemoteApiError('事件流连接失败', response.status)
    onActivity?.()
    onOpen?.()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      onActivity?.()
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (data) onEvent(JSON.parse(data) as RemoteEventEnvelope)
        boundary = buffer.indexOf('\n\n')
      }
    }
  }

  async image(taskId: string, artifactId: string, version: number): Promise<Blob> {
    const path = '/v1/tasks/' + encodeURIComponent(taskId) + '/artifacts/' + encodeURIComponent(artifactId) + '/image?v=' + version;
    const response = await fetch(this.baseUrl + path, {
      headers: this.headers(), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return RemoteClient.read<never>(response);
    if (!/^image\/(png|jpeg|gif|webp|bmp|avif)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new RemoteApiError('服务端未返回图片', 415);
    if (Number(response.headers.get('content-length')) > 16 * 1024 * 1024) throw new RemoteApiError('图片超过预览限制', 413);
    const blob = await response.blob();
    if (blob.size > 16 * 1024 * 1024) throw new RemoteApiError('图片超过预览限制', 413);
    return blob;
  }

  private get<T>(path: string): Promise<T> {
    return fetch(`${this.baseUrl}${path}`, { headers: this.headers(), cache: 'no-store', signal: AbortSignal.timeout(20_000) }).then(RemoteClient.read<T>)
  }
  private post<T = { ok: true }>(path: string, body: unknown): Promise<T> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(RemoteClient.read<T>)
  }
  private del<T = { ok: true }>(path: string): Promise<T> {
    return fetch(`${this.baseUrl}${path}`, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(20_000) }).then(RemoteClient.read<T>)
  }
  private headers() { return { authorization: `Bearer ${this.token}` } }
  private static async read<T>(response: Response): Promise<T> {
    const value = await response.json().catch(() => ({})) as { error?: { message?: string } }
    if (!response.ok) throw new RemoteApiError(value.error?.message || `HTTP ${response.status}`, response.status)
    return value as T
  }
}
