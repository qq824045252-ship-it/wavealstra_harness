import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, Bell, Briefcase, Camera, Check,
  ChevronDown, ChevronRight, Copy, FileUp, Folder, Image,
  LoaderCircle, Settings, Menu, Plus, Redo2, RotateCcw, Sparkles, Square, Terminal,
  ThumbsDown, ThumbsUp, Wrench, X, Shield,
} from 'lucide-react'
import { App as CapacitorApp } from '@capacitor/app'
import type { RemoteConversationInteraction, RemoteTaskSummary } from '@mybuddy/shared'
import { useRemoteStore } from './store/remoteStore'
import { buildRemoteTimeline } from './store/remoteTimeline'
import { RemoteMarkdown } from './components/RemoteMarkdown'
import { buildSpaceTaskGroups, spaceBreadcrumb, type SpaceGroupNode } from './lib/spaceGroups'
import { taskModeLabel } from './lib/taskModeLabel'
import { ConnectPage } from './components/ConnectPage'
import { NewTaskSetupChips, NewTaskSetupSheet } from './components/NewTaskSetup'
import { AnimatedDisclosure, useScreenMotion } from './components/RemoteMotion'
import { RemoteConversationInteractionCard } from './components/RemoteConversationInteractionCard'
import './styles/app.css'

export function handleBackNavigation(): boolean {
  const s = useRemoteStore.getState()
  if (s.taskSetupSection) { s.setTaskSetupSection(null); return true }
  if (s.isConnectionSettingsOpen && s.client && s.bootstrap) { s.setConnectionSettingsOpen(false); return true }
  if (s.isPermissionSheetOpen) { s.setPermissionSheetOpen(false); return true }
  if (s.isModelSheetOpen) {
    s.setModelSheetOpen(false)
    return true
  }
  if (s.isAddToChatOpen) {
    s.setAddToChatOpen(false)
    return true
  }
  if (s.isNotificationsOpen) {
    s.setNotificationsOpen(false)
    return true
  }
  if (s.isDrawerOpen) {
    s.setDrawerOpen(false)
    return true
  }
  if (s.activeTaskId) {
    // P0：走 goHome() 统一丢弃模型/权限 transient 覆盖，避免泄漏到下一个任务
    s.goHome()
    return true
  }
  return false
}

export function App() {
  const client = useRemoteStore((state) => state.client)
  const bootstrap = useRemoteStore((state) => state.bootstrap)
  const activeTaskId = useRemoteStore((state) => state.activeTaskId)
  const initialize = useRemoteStore((state) => state.initialize)
  const resync = useRemoteStore((state) => state.resync)
  const screen = !client || !bootstrap ? 'connect' : activeTaskId ? `chat:${activeTaskId}` : 'home'
  const screenRef = useScreenMotion(screen)
  const showConnectionSettings = useRemoteStore(s => s.isConnectionSettingsOpen)
  const [incomingLink, setIncomingLink] = useState<{ id: number; url: string } | null>(null)
  const linkSequence = useRef(0)

  useEffect(() => {
    let alive = true
    const consume = (url?: string) => {
      if (!alive || !url?.startsWith('mybuddy://pair')) return
      useRemoteStore.setState({ isConnectionSettingsOpen: true, isPermissionSheetOpen: false, isModelSheetOpen: false, isAddToChatOpen: false, isDrawerOpen: false, isNotificationsOpen: false })
      setIncomingLink(current => current?.url === url ? current : { id: ++linkSequence.current, url })
    }
    const listener = CapacitorApp.addListener('appUrlOpen', event => consume(event.url))
    void listener.then(() => CapacitorApp.getLaunchUrl()).then(result => consume(result?.url)).catch(() => undefined)
    return () => { alive = false; void listener.then(handle => handle.remove()) }
  }, [])

  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => {
    let alive = true
    let syncing = false
    const resume = () => {
      if (alive && document.visibilityState === 'visible' && !useRemoteStore.getState().isConnectionSettingsOpen) void useRemoteStore.getState().resume().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    const handle = CapacitorApp.addListener('appStateChange', state => { if (state.isActive) resume() })
    // Read-only anti-entropy: recovers a missed final event and suspended mobile connections.
    const timer = window.setInterval(() => {
      if (!alive || syncing || document.visibilityState !== 'visible' || useRemoteStore.getState().isConnectionSettingsOpen) return
      syncing = true
      void resync().catch(() => undefined).finally(() => { syncing = false })
    }, 7000)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('online', resume)
      void handle.then(h => h.remove())
    }
  }, [resync])

  // 全局 Android 边缘返回手势 & 系统 Back 键拦截，实现分级退出
  useEffect(() => {
    const listener = CapacitorApp.addListener('backButton', () => {
      const handled = handleBackNavigation()
      if (!handled) {
        void CapacitorApp.exitApp()
      }
    })

    const onPopState = () => {
      const handled = handleBackNavigation()
      if (handled) {
        window.history.pushState({ app: 'mybuddy' }, '')
      }
    }
    window.history.pushState({ app: 'mybuddy' }, '')
    window.addEventListener('popstate', onPopState)

    return () => {
      void listener.then((handle) => handle.remove())
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  return <div ref={screenRef} className="remote-screen" data-screen={screen}>
    {!client || !bootstrap ? <ConnectPage brand={<MyBuddyIcon className="onboard-brand-icon" size={48} />} incomingLink={incomingLink} onConsumed={id => setIncomingLink(current => current?.id === id ? null : current)} /> : activeTaskId ? <ChatPage /> : <HomePage />}
    {client && bootstrap && showConnectionSettings && <div className="connection-settings-overlay"><ConnectPage brand={<MyBuddyIcon className="onboard-brand-icon" size={48} />} incomingLink={incomingLink} onConsumed={id => setIncomingLink(current => current?.id === id ? null : current)} /></div>}
    {client && bootstrap && !activeTaskId && <NewTaskSetupSheet />}
  </div>
}

/* ==========================================================================
   2. Home Page (Claude 1:1 Start Screen & Floating Composer)
   ========================================================================== */
function HomePage() {
  const bootstrap = useRemoteStore((state) => state.bootstrap)
  const selectedModelId = useRemoteStore((state) => state.selectedModelId)
  const openTask = useRemoteStore((state) => state.openTask)
  const createTask = useRemoteStore((state) => state.create)
  const creating = useRemoteStore((state) => state.creating)
  const showDrawer = useRemoteStore((state) => state.isDrawerOpen)
  const setShowDrawer = useRemoteStore((state) => state.setDrawerOpen)
  const attachments = useRemoteStore((state) => state.attachments)
  const clearAttachments = useRemoteStore((state) => state.clearAttachments)
  const addAttachment = useRemoteStore((state) => state.addAttachment)

  const [text, setText] = useState('')
  const [isInputFocused, setIsInputFocused] = useState(false)

  const tasks = useMemo(() => {
    return [...(bootstrap?.tasks ?? [])]
      .filter((task) => !task.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [bootstrap])

  const recents = tasks.slice(0, 4)
  const greeting = pickGreeting()

  // P1 修复：发送失败（网络/校验 400）时恢复草稿与附件，不再让用户输入凭空消失
  const handleSend = async () => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || creating) return
    const pending = attachments
    const draftText = text
    clearAttachments()
    setText('')
    try {
      await createTask(value, pending)
    } catch (error) {
      setText(draftText)
      for (const att of pending) addAttachment(att)
      alert(`发送失败：${error instanceof Error ? error.message : '请检查连接后重试'}`)
    }
  }

  return (
    <>
      <header className="claude-header">
        <div className="header-left">
          <button
            type="button"
            className="header-icon-btn"
            aria-label="菜单"
            onClick={() => setShowDrawer(true)}
          >
            <Menu size={20} />
          </button>
          <div className="header-brand">
            <MyBuddyIcon className="header-brand-icon" size={18} />
            <span>Mybuddy</span>
          </div>
        </div>
      </header>

      <main className={`claude-home ${isInputFocused ? 'keyboard-focused' : ''}`}>
        <div className="home-scrollable-content">
          <section className="home-hero">
            <MyBuddyIcon className="home-brand-icon" size={56} />
            <h1 className="home-greeting-title">{greeting}</h1>
            <p className="home-greeting-sub">你想让 MyBuddy 帮你做什么？</p>
          </section>

          {recents.length > 0 && (
            <section className="home-recents-section">
              <div className="home-section-header">最近对话</div>
              <div className="home-recents-list">
                {recents.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className="home-recent-card"
                    onClick={() => void openTask(task.id)}
                  >
                    <div className="home-recent-info">
                      <span className="home-recent-title">{task.title}</span>
                      <span className="task-mode-label">{taskModeLabel(task, bootstrap?.taskModes)}</span>
                      <span className="home-recent-time">
                        {formatRelativeTime(task.updatedAt)}
                      </span>
                    </div>
                    {task.busy ? (
                      <span className="home-recent-badge busy">执行中</span>
                    ) : task.pendingActionCount > 0 ? (
                      <span className="home-recent-badge pending">
                        {task.pendingActionCount} 个审批
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <FloatingComposer
          value={text}
          onChange={setText}
          onSend={handleSend}
          sending={creating}
          onFocus={() => setIsInputFocused(true)}
          onBlur={() => setIsInputFocused(false)}
          placeholder="问问 MyBuddy 或输入一个任务…"
          effectiveModelId={selectedModelId ?? bootstrap?.defaultModelId ?? null}
        />
      </main>

      <ClaudeDrawer
        open={showDrawer}
        onClose={() => setShowDrawer(false)}
        onNewChat={(spaceId) => {
          useRemoteStore.getState().startNewTask(spaceId)
          setText('')
        }}
        tasks={tasks}
        onSelectTask={(id) => {
          setShowDrawer(false)
          void openTask(id)
        }}
      />

      <AddToChatSheet />
      <PermissionSheet />
      <SelectModelSheet />
    </>
  )
}

/* ==========================================================================
   3. Chat Page (Claude 1:1 Conversation Stream, Markdown & Thinking)
   ========================================================================== */
function ChatPage() {
  const activeTaskId = useRemoteStore((state) => state.activeTaskId)!
  const histories = useRemoteStore((state) => state.histories)
  const runtimes = useRemoteStore((state) => state.runtimes)
  const live = useRemoteStore((state) => state.live)
  const bootstrap = useRemoteStore((state) => state.bootstrap)
  const selectedModelId = useRemoteStore((state) => state.selectedModelId)
  const send = useRemoteStore((state) => state.send)
  const sending = useRemoteStore((state) => state.sending)
  const abort = useRemoteStore((state) => state.abort)
  const approve = useRemoteStore((state) => state.approve)
  const respondInteraction = useRemoteStore((state) => state.respondInteraction)
  const cancelInteraction = useRemoteStore((state) => state.cancelInteraction)
  const attachments = useRemoteStore((state) => state.attachments)
  const clearAttachments = useRemoteStore((state) => state.clearAttachments)
  const addAttachment = useRemoteStore((state) => state.addAttachment)

  const [text, setText] = useState('')
  const [isInputFocused, setIsInputFocused] = useState(false)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  // 发送时记录「当前用户气泡数」，等新气泡真正渲染（数量 +1）再锚定置顶。
  // 不能再用一次性 flag：回复中追加提问时，旧回复的 text_delta 会抢跑 effect、
  // 把 flag 消耗在旧气泡上，导致新提问沉底（用户反馈 bug）。
  const pendingAnchorUserCountRef = useRef<number | null>(null)
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({})
  const showDrawer = useRemoteStore((state) => state.isDrawerOpen)
  const setShowDrawer = useRemoteStore((state) => state.setDrawerOpen)
  const openTask = useRemoteStore((state) => state.openTask)
  const goHome = useRemoteStore((state) => state.goHome)

  const task = bootstrap?.tasks.find((item) => item.id === activeTaskId)
  const messages = useMemo(() => buildRemoteTimeline(
    histories[activeTaskId]?.messages ?? [], live[activeTaskId] ?? {},
  ), [histories, live, activeTaskId])

  const runtime = runtimes[activeTaskId]
  const durable = histories[activeTaskId]?.durable
  const interactionsByMessage = useMemo(() => {
    const map = new Map<string, RemoteConversationInteraction[]>()
    for (const interaction of runtime?.interactions ?? []) {
      const list = map.get(interaction.assistantMessageId) ?? []
      list.push(interaction)
      map.set(interaction.assistantMessageId, list)
    }
    return map
  }, [runtime?.interactions])
  const visibleAssistantIds = useMemo(
    () => new Set(messages.filter(message => message.role === 'assistant').map(message => message.id)),
    [messages],
  )
  const orphanPendingInteractions = useMemo(
    () => (runtime?.interactions ?? []).filter(interaction =>
      interaction.status === 'pending' && !visibleAssistantIds.has(interaction.assistantMessageId)),
    [runtime?.interactions, visibleAssistantIds],
  )
  const isBusy = (runtime?.busy ?? !!task?.busy) || sending
  const lastAssistantId = useMemo(
    () => [...messages].reverse().find((m) => m.role === 'assistant')?.id,
    [messages],
  )
  const drawerTasks = useMemo(
    () => [...(bootstrap?.tasks ?? [])].filter((t) => !t.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [bootstrap],
  )

  const handleScroll = () => {
    const el = timelineRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const isNear = distFromBottom < 100
    isNearBottomRef.current = isNear
    setShowScrollBottom(!isNear)
  }

  const turnView = useRef({ taskId: '', userCount: 0 })
  const handleComposerFocus = () => setIsInputFocused(true)
  const handleComposerBlur = () => setIsInputFocused(false)

  // Match desktop: pin a NEW user turn once. Tokens, tools and SVG sizing do not
  // acquire permission to pull a reader back to the bottom.
  useLayoutEffect(() => {
    const el = timelineRef.current
    if (!el) return
    const users = el.querySelectorAll<HTMLElement>('.message-bubble-user')
    const user = users[users.length - 1]
    const previous = turnView.current
    const ownSend = pendingAnchorUserCountRef.current !== null && users.length > pendingAnchorUserCountRef.current
    const pin = previous.taskId !== activeTaskId || (previous.userCount === 0 && users.length > 0)
      || ownSend || (users.length > previous.userCount && isNearBottomRef.current)
    turnView.current = { taskId: activeTaskId, userCount: users.length }
    if (ownSend) pendingAnchorUserCountRef.current = null
    // A passive snapshot must not change the scroll range either. Recomputing
    // spacer height after asynchronous SVG decoding can clamp scrollTop even
    // when no code explicitly scrolls. Only a new-turn/navigation pin owns it.
    if (!pin || !user) return
    const spacer = el.querySelector<HTMLElement>('.chat-bottom-spacer')
    const composer = document.querySelector<HTMLElement>('.claude-composer-wrapper')
    const composerHeight = composer?.getBoundingClientRect().height ?? 150
    el.parentElement?.style.setProperty('--remote-composer-height', composerHeight + 'px')
    if (spacer) {
      const tail = spacer.offsetTop - user.offsetTop
      spacer.style.height = Math.max(24, el.clientHeight - composerHeight - 28 - tail) + 'px'
    }
    if (pin) {
      const target = el.scrollTop + user.getBoundingClientRect().top - el.getBoundingClientRect().top - 12
      el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight))
      isNearBottomRef.current = true
      setShowScrollBottom(false)
    }
  }, [activeTaskId, messages])

  useEffect(() => {
    const el = timelineRef.current
    const composer = document.querySelector<HTMLElement>('.claude-composer-wrapper')
    if (!el || !composer) return
    const observer = new ResizeObserver(() => {
      el.parentElement?.style.setProperty('--remote-composer-height', composer.getBoundingClientRect().height + 'px')
    })
    observer.observe(composer)
    return () => observer.disconnect()
  }, [activeTaskId])

  const scrollToBottom = () => {
    const el = timelineRef.current
    if (!el) return
    isNearBottomRef.current = true
    setShowScrollBottom(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const armUserAnchor = () => {
    pendingAnchorUserCountRef.current = messages.filter((m) => m.role === 'user').length
    setShowScrollBottom(false)
  }

  // P1 修复：发送失败（网络/校验 400）时恢复草稿与附件，不再让用户输入凭空消失
  const handleSend = async () => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || sending) return
    const pending = attachments
    const draftText = text
    clearAttachments()
    setText('')
    armUserAnchor()
    try {
      await send(value, pending)
    } catch (error) {
      setText(draftText)
      for (const att of pending) addAttachment(att)
      pendingAnchorUserCountRef.current = null
      alert(`发送失败：${error instanceof Error ? error.message : '请检查连接后重试'}`)
    }
  }

  // 重试/重新生成：找到该 assistant 消息之前的最近一条用户消息，重新下发一轮
  const retryFrom = (assistantMessageId: string) => {
    if (sending) return
    const idx = messages.findIndex((m) => m.id === assistantMessageId)
    for (let i = idx - 1; i >= 0; i--) {
      const prev = messages[i]
      if (prev.role === 'user' && prev.text.trim()) {
        armUserAnchor()
        void send(prev.text.trim()).catch(() => { pendingAnchorUserCountRef.current = null })
        break
      }
    }
  }

  const copyMessage = (value: string) => {
    void navigator.clipboard.writeText(value).catch(() => undefined)
  }

  const toggleFeedback = (id: string, value: 'up' | 'down') => {
    setFeedback((prev) => {
      const next = { ...prev }
      if (next[id] === value) delete next[id]
      else next[id] = value
      return next
    })
  }

  return (
    <>
      <header className="claude-header">
        <div className="header-left">
          <button
            type="button"
            className="header-icon-btn"
            aria-label="菜单"
            onClick={() => setShowDrawer(true)}
          >
            <Menu size={20} />
          </button>
          <div className="header-task-info"><span className="header-title-chat">{task?.title ?? '对话'}</span>
            {task && <span className="task-mode-label">{taskModeLabel(task, bootstrap?.taskModes)}</span>}
          </div>
        </div>

        <div className="header-right">
          {isBusy && (
            <button
              type="button"
              className="header-icon-btn"
              style={{ color: 'var(--status-danger)' }}
              aria-label="停止"
              onClick={() => void abort()}
            >
              <Square size={16} />
            </button>
          )}
          <button
            type="button"
            className="header-icon-btn"
            aria-label="新对话"
            onClick={goHome}
          >
            <Plus size={20} />
          </button>
        </div>
      </header>

      <main className={`claude-chat ${isInputFocused ? 'keyboard-focused' : ''}`}>
        <div
          ref={timelineRef}
          className="chat-timeline"
          onScroll={handleScroll}
        >
          {messages.map((message) => {
            if (message.role === 'user') {
              return (
                <div key={message.id} data-message-id={message.id} className="message-bubble-user">
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="message-attachments-row">
                      {message.attachments.map((att) => (
                        <span key={att.name} className="message-attachment-chip">
                          <FileUp size={11} />
                          {att.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {message.text}
                </div>
              )
            }

            return (
              <div key={message.id} data-message-id={message.id} className="message-bubble-assistant">
                {(message.thinking || (message.tools && message.tools.length > 0) || message.streaming) && (
                  <ProcessPanel thinking={message.thinking} tools={message.tools} activity={message.activity} running={!!message.streaming || (message.id === lastAssistantId && isBusy)} />
                )}

                <RemoteMarkdown text={message.text} taskId={activeTaskId} images={histories[activeTaskId]?.imageArtifacts} artifacts={message.artifacts} />
                {(interactionsByMessage.get(message.id) ?? []).map(interaction => (
                  <RemoteConversationInteractionCard
                    key={interaction.id}
                    interaction={interaction}
                    onRespond={answer => respondInteraction(interaction.id, answer)}
                    onCancel={() => cancelInteraction(interaction.id)}
                  />
                ))}
                {message.streaming && message.activity === 'responding' && <span className="streaming-caret response-streaming-caret" aria-label="正在生成回复" />}

                {message.text.trim().length > 0 && (
                  <div className="assistant-actions">
                    <button type="button" className="assistant-action-btn" aria-label="复制" onClick={() => copyMessage(message.text)}>
                      <Copy size={15} />
                    </button>
                    <button type="button" className="assistant-action-btn" aria-label="重试" onClick={() => retryFrom(message.id)}>
                      <Redo2 size={15} />
                    </button>
                    <button
                      type="button"
                      className={`assistant-action-btn ${feedback[message.id] === 'up' ? 'on' : ''}`}
                      aria-label="有用"
                      onClick={() => toggleFeedback(message.id, 'up')}
                    >
                      <ThumbsUp size={15} />
                    </button>
                    <button
                      type="button"
                      className={`assistant-action-btn ${feedback[message.id] === 'down' ? 'on' : ''}`}
                      aria-label="没用"
                      onClick={() => toggleFeedback(message.id, 'down')}
                    >
                      <ThumbsDown size={15} />
                    </button>
                    {message.id === lastAssistantId && (
                      <button type="button" className="assistant-action-btn" aria-label="重新生成" onClick={() => retryFrom(message.id)}>
                        <RotateCcw size={15} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {durable && <div role="status">
            {durable.compacting && <p>Pi Durable 正在压缩上下文</p>}
            {durable.retry && <p>Pi Durable 正在重试：{durable.retry.error}</p>}
            {durable.pendingInputs.map(input => <p key={input.id}>{input.mode === 'steer' ? '引导' : '接续'}已入队：{input.text}</p>)}
          </div>}
          {orphanPendingInteractions.map(interaction => (
            <RemoteConversationInteractionCard
              key={interaction.id}
              interaction={interaction}
              onRespond={answer => respondInteraction(interaction.id, answer)}
              onCancel={() => cancelInteraction(interaction.id)}
            />
          ))}

          {runtime?.pendingActions.map((action) => (
            <div className="approval-card" key={action.toolCallId}>
              <div className="approval-card-head">
                <Sparkles size={16} />
                <span>工具执行审批 · {action.tool}</span>
              </div>
              <div className="approval-card-body">{action.summary}</div>
              {action.detail && (
                <div className="approval-card-detail">{action.detail}</div>
              )}
              <div className="approval-card-actions">
                <button
                  type="button"
                  className="btn-pill btn-pill-secondary"
                  onClick={() => void approve(action.toolCallId, 'deny')}
                >
                  拒绝
                </button>
                <button
                  type="button"
                  className="btn-pill btn-pill-primary"
                  onClick={() => void approve(action.toolCallId, 'allow-once')}
                >
                  允许一次
                </button>
                {action.approvalKind === 'external-write' && (
                  <button
                    type="button"
                    className="btn-pill btn-pill-secondary"
                    onClick={() => void approve(action.toolCallId, 'allow-task-dir')}
                  >
                    允许任务目录
                  </button>
                )}
              </div>
            </div>
          ))}

          {!isBusy && <div className="chat-disclaimer">MyBuddy is AI and can make mistakes.</div>}
          <div className="chat-bottom-spacer" />
        </div>

        {showScrollBottom && (
          <button
            type="button"
            className="scroll-bottom-btn"
            onClick={scrollToBottom}
            aria-label="回到底部"
          >
            <ArrowDown size={17} />
          </button>
        )}

        <FloatingComposer
          value={text}
          onChange={setText}
          onSend={handleSend}
          sending={sending}
          isBusy={isBusy}
          onAbort={() => void abort()}
          onFocus={handleComposerFocus}
          onBlur={handleComposerBlur}
          placeholder="给 MyBuddy 发送回复…"
          effectiveModelId={selectedModelId ?? task?.modelId ?? bootstrap?.defaultModelId ?? null}
        />
      </main>

      <ClaudeDrawer
        open={showDrawer}
        onClose={() => setShowDrawer(false)}
        onNewChat={(spaceId) => useRemoteStore.getState().startNewTask(spaceId)}
        tasks={drawerTasks}
        onSelectTask={(id) => {
          setShowDrawer(false)
          void openTask(id)
        }}
      />

      <AddToChatSheet />
      <PermissionSheet />
      <SelectModelSheet />
    </>
  )
}

/* ==========================================================================
   4. Floating Composer (Claude 1:1 Composite Floating Input Card)
   ========================================================================== */
function FloatingComposer({
  value,
  onChange,
  onSend,
  sending,
  isBusy,
  onAbort,
  placeholder,
  onFocus,
  onBlur,
  effectiveModelId,
}: {
  value: string
  onChange: (text: string) => void
  onSend: () => void
  sending: boolean
  isBusy?: boolean
  onAbort?: () => void
  placeholder: string
  onFocus?: () => void
  onBlur?: () => void
  /** P1 修复：父组件按「手机显式选择 → 任务模型 → 电脑端默认」三层解析后传入 */
  effectiveModelId?: string | null
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const bootstrap = useRemoteStore((s) => s.bootstrap)
  const setAddToChatOpen = useRemoteStore((s) => s.setAddToChatOpen)
  const setModelSheetOpen = useRemoteStore((s) => s.setModelSheetOpen)
  const setPermissionSheetOpen = useRemoteStore(s => s.setPermissionSheetOpen)
  const permissionMode = useRemoteStore(s => s.toolAccessMode)
  const activeTaskId = useRemoteStore(s => s.activeTaskId)
  const selectedWelcomeMode = useRemoteStore(s => s.selectedWelcomeMode)
  const selectedModePresetId = useRemoteStore(s => s.selectedModePresetId)
  const modes = bootstrap?.taskModes ?? []
  const selectedMode = modes.find(mode => mode.id === selectedWelcomeMode)
  const validNewTaskMode = !!selectedMode?.tags.some(tag => tag.id === selectedModePresetId)
  const isBot = (activeTaskId ? bootstrap?.tasks.find(task => task.id === activeTaskId)?.welcomeMode : selectedWelcomeMode) === 'bot'
  const effectivePermission = bootstrap?.tasks.find(task => task.id === activeTaskId)?.permissionMode ?? bootstrap?.defaultPermissionMode
  const permissionLabel = permissionMode === 'follow' ? effectivePermission === 'auto' ? '完全访问' : effectivePermission === 'readonly' ? '只读模式' : '默认权限' : permissionMode === 'auto' ? '完全访问' : PERMISSION_NAMES[permissionMode]
  const attachments = useRemoteStore((s) => s.attachments)
  const removeAttachment = useRemoteStore((s) => s.removeAttachment)


  // 胶囊显示当前真正会生效的模型（effectiveModelId 已含任务级解析）；目录缺失时兜底文案
  const modelLabel = useMemo(() => {
    const models = bootstrap?.models ?? []
    const active = effectiveModelId ? models.find((m) => m.id === effectiveModelId) : undefined
    return active?.name ?? '默认模型'
  }, [bootstrap, effectiveModelId])

  // Match the 58px minimum and 160px multiline cap in CSS.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '58px'
    const scrollH = el.scrollHeight
    if (scrollH > 58) {
      el.style.height = `${Math.min(scrollH, 160)}px`
    }
  }, [value])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  const hasContent = value.trim().length > 0 || attachments.length > 0

  return (
    <div className="claude-composer-wrapper">
      {!activeTaskId && <NewTaskSetupChips />}
      <div
        className="claude-composer-card"
        onClick={() => textareaRef.current?.focus()}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments-row">
            {attachments.map((att) => (
              <div key={att.id} className="composer-attachment-chip">
                <span className="attachment-chip-name">{att.name}</span>
                <button
                  type="button"
                  className="attachment-chip-del"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeAttachment(att.id)
                  }}
                  aria-label="移除附件"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          className="composer-input-area"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onClick={(e) => e.stopPropagation()}
          placeholder={placeholder}
          rows={1}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <button
              type="button"
              className="composer-circle-btn"
              aria-label="添加附件与设置"
              onClick={(e) => {
                e.stopPropagation()
                setAddToChatOpen(true)
              }}
            >
              <Plus size={18} strokeWidth={2.2} />
            </button>

            <button
              type="button"
              className="composer-model-pill"
              aria-label={`选择模型：${modelLabel}`}
              title={modelLabel}
              onClick={(e) => {
                e.stopPropagation()
                setModelSheetOpen(true)
              }}
            >
              <Sparkles size={17} />
            </button>
            {!isBot && <button type="button" className={`composer-permission-pill ${permissionMode === 'auto' || (permissionMode === 'follow' && effectivePermission === 'auto') ? 'full-access' : ''}`} aria-label="权限控制" title={`${permissionMode === 'follow' ? '跟随：' : ''}${permissionLabel}`} onClick={e => { e.stopPropagation(); setPermissionSheetOpen(true) }}>
              <Shield size={17} />
            </button>}
          </div>

          <div className="composer-toolbar-right">
            {isBusy ? (
              <button
                type="button"
                className="composer-main-btn stop"
                aria-label="停止"
                onClick={(e) => {
                  e.stopPropagation()
                  onAbort?.()
                }}
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="composer-main-btn"
                disabled={sending || !hasContent || (!activeTaskId && !validNewTaskMode)}
                onClick={(e) => {
                  e.stopPropagation()
                  onSend()
                }}
                aria-label="发送"
              >
                <ArrowUp size={18} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ==========================================================================
   Add To Chat Bottom Sheet（附件真实上传 / 权限真实下发）
   ========================================================================== */
/** 与服务端 zod 上限对齐：单附件 base64 ≤ 4,000,000 字符 ≈ 3MB 原始字节 */
const ATTACHMENT_MAX_BYTES = 3_000_000
const ATTACHMENT_MAX_COUNT = 4

function AddToChatSheet() {
  const open = useRemoteStore((s) => s.isAddToChatOpen)
  const setOpen = useRemoteStore((s) => s.setAddToChatOpen)
  const bootstrap = useRemoteStore((s) => s.bootstrap)
  const activeTaskId = useRemoteStore((s) => s.activeTaskId)
  const selectedProjectId = useRemoteStore((s) => s.selectedProjectId)
  const selectedSpaceId = useRemoteStore((s) => s.selectedSpaceId)
  const setTaskSetupSection = useRemoteStore((s) => s.setTaskSetupSection)
  const addAttachment = useRemoteStore((s) => s.addAttachment)
  const attachments = useRemoteStore((s) => s.attachments)

  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const projects = (bootstrap?.projects ?? []).filter((p) => !p.archived)
  // 已有任务里 projectId 只在 create() 时生效：send() 不支持迁移项目，隐藏避免「假动作」
  const inExistingTask = activeTaskId != null

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  // P1 修复：选文件阶段就做数量/大小校验，与后端 zod 限制闭环，避免发送时 400
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (attachments.length >= ATTACHMENT_MAX_COUNT) {
      alert(`最多添加 ${ATTACHMENT_MAX_COUNT} 个附件`)
      return
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      alert(`「${file.name}」超过 3MB 上限`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      addAttachment({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: file.name,
        size: file.size,
        dataUrl: typeof reader.result === 'string' ? reader.result : undefined,
      })
      setOpen(false)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  return (
    <>
      <div
        className={`claude-sheet-backdrop ${open ? 'open' : ''}`}
        onClick={() => setOpen(false)}
      />
      <div className={`claude-sheet ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="claude-sheet-grabber" />
        <div className="claude-sheet-header">
          <button
            type="button"
            className="claude-sheet-close-btn"
            onClick={() => setOpen(false)}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
          <span className="claude-sheet-title">添加附件与设置</span>
        </div>

        {/* Hidden inputs */}
        <input
          type="file"
          ref={cameraInputRef}
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <input
          type="file"
          ref={photoInputRef}
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <input
          type="file"
          ref={fileInputRef}
          accept="*/*"
          style={{ display: 'none' }}
          onChange={handleFile}
        />

        {/* 3-card grid */}
        <div className="add-to-chat-grid">
          <button
            type="button"
            className="add-to-chat-card"
            onClick={() => cameraInputRef.current?.click()}
          >
            <div className="add-to-chat-icon-wrap">
              <Camera size={22} />
            </div>
            <span className="add-to-chat-card-label">拍照</span>
          </button>

          <button
            type="button"
            className="add-to-chat-card"
            onClick={() => photoInputRef.current?.click()}
          >
            <div className="add-to-chat-icon-wrap">
              <Image size={22} />
            </div>
            <span className="add-to-chat-card-label">图片</span>
          </button>

          <button
            type="button"
            className="add-to-chat-card"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="add-to-chat-icon-wrap">
              <FileUp size={22} />
            </div>
            <span className="add-to-chat-card-label">文件</span>
          </button>
        </div>

        {/* List options */}
        <div className="add-to-chat-list">
          {!inExistingTask && <button type="button" className="add-to-chat-row" onClick={() => { setOpen(false); setTaskSetupSection('location') }}>
            <div className="add-to-chat-row-left"><div className="add-to-chat-row-icon"><Folder size={18} /></div><div className="add-to-chat-row-info"><span className="add-to-chat-row-title">所属空间</span><span className="add-to-chat-row-subtitle">{selectedSpaceId ? spaceBreadcrumb(bootstrap?.spaces ?? [], selectedSpaceId) : '独立任务'}</span></div></div>
            <ChevronRight size={18} />
          </button>}
          {!inExistingTask && <button type="button" className="add-to-chat-row" onClick={() => { setOpen(false); setTaskSetupSection('project') }}>
            <div className="add-to-chat-row-left"><div className="add-to-chat-row-icon"><Folder size={18} /></div><div className="add-to-chat-row-info"><span className="add-to-chat-row-title">所属项目</span><span className="add-to-chat-row-subtitle">{selectedProject?.name ?? (projects.length ? '不加入项目' : '电脑端暂无项目')}</span></div></div>
            <ChevronRight size={18} />
          </button>}

        </div>
      </div>
    </>
  )
}

const PERMISSION_NAMES = { follow: '跟随电脑 / 当前任务', ask: '默认权限', readonly: '只读模式', auto: '允许完全访问' } as const

function PermissionSheet() {
  const open = useRemoteStore(s => s.isPermissionSheetOpen)
  const setOpen = useRemoteStore(s => s.setPermissionSheetOpen)
  const mode = useRemoteStore(s => s.toolAccessMode)
  const setMode = useRemoteStore(s => s.setToolAccessMode)
  const descriptions = { follow: '新对话使用电脑端默认权限，已有对话沿用任务权限。', ask: '敏感操作在执行前请求确认。', readonly: '仅允许读取与分析，不修改文件或执行命令。', auto: '允许直接执行更多操作，包括文件修改或外部执行。' }
  return <>
    <div className={`claude-sheet-backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
    <div className={`claude-sheet remote-permission-sheet ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
      <div className="claude-sheet-grabber" />
      <div className="claude-sheet-header"><button className="claude-sheet-close-btn" onClick={() => setOpen(false)} aria-label="关闭权限控制"><X size={20} /></button><span className="claude-sheet-title">权限控制</span></div>
      <div className="permission-options" role="radiogroup" aria-label="权限模式">
        {(Object.keys(PERMISSION_NAMES) as Array<keyof typeof PERMISSION_NAMES>).map(value => <button key={value} role="radio" aria-checked={mode === value} className="permission-option" onClick={() => {
          if (value === 'auto' && !window.confirm('确认允许完全访问？\nAI 可以直接执行更多操作，包括文件修改或外部执行。仅在信任当前任务时使用。')) return
          setMode(value); setOpen(false)
        }}><span><strong>{PERMISSION_NAMES[value]}</strong><small>{descriptions[value]}</small></span>{mode === value && <Check size={18} />}</button>)}
      </div>
      <p className="permission-sheet-note">选择后随下一条消息应用，提交成功后恢复“跟随”。</p>
    </div>
  </>
}

/* ==========================================================================
   Select Model Bottom Sheet（数据来自 /v1/bootstrap 的真实模型目录）
   ========================================================================== */
function SelectModelSheet() {
  const open = useRemoteStore((s) => s.isModelSheetOpen)
  const setOpen = useRemoteStore((s) => s.setModelSheetOpen)
  const selectedModelId = useRemoteStore((s) => s.selectedModelId)
  const setSelectedModelId = useRemoteStore((s) => s.setSelectedModelId)
  const bootstrap = useRemoteStore((s) => s.bootstrap)
  const activeTaskId = useRemoteStore((s) => s.activeTaskId)

  const models = bootstrap?.models ?? []
  const defaultModel = models.find((m) => m.id === bootstrap?.defaultModelId)
  // P1 修复：跟随档说明按三层解析展示——已有任务先看任务自身模型，新任务看电脑端默认
  const taskModel = activeTaskId
    ? bootstrap?.tasks.find((t) => t.id === activeTaskId)?.modelId
    : undefined
  const followModel = models.find((m) => m.id === (taskModel ?? bootstrap?.defaultModelId))
  const followDesc = activeTaskId
    ? (taskModel ? `任务当前：${followModel?.name ?? taskModel}` : defaultModel ? `默认：${defaultModel.name}` : '使用电脑端设置的默认模型')
    : (defaultModel ? `默认：${defaultModel.name}` : '使用电脑端设置的默认模型')

  const handleSelect = (id: string | null) => {
    setSelectedModelId(id)
    setOpen(false)
  }

  const modelDesc = (m: (typeof models)[number]) => {
    const parts: string[] = [m.vendor]
    if (m.contextWindow) parts.push(`${Math.round(m.contextWindow / 1000)}K 上下文`)
    if (m.supportsReasoning) parts.push('深度思考')
    if (m.supportsImages) parts.push('支持图片')
    return parts.join(' · ')
  }

  return (
    <>
      <div
        className={`claude-sheet-backdrop ${open ? 'open' : ''}`}
        onClick={() => setOpen(false)}
      />
      <div className={`claude-sheet ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="claude-sheet-grabber" />
        <div className="claude-sheet-header">
          <button
            type="button"
            className="claude-sheet-close-btn"
            onClick={() => setOpen(false)}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
          <span className="claude-sheet-title">Select model</span>
        </div>

        <div className="select-model-group">
          <button
            type="button"
            className={`select-model-item ${selectedModelId === null ? 'active' : ''}`}
            onClick={() => handleSelect(null)}
          >
            <div className="select-model-info">
              <div className="select-model-title-row">
                <span className="select-model-name">{activeTaskId ? '跟随任务 / 电脑默认' : '跟随电脑默认'}</span>
              </div>
              <span className="select-model-desc">{followDesc}</span>
            </div>
            {selectedModelId === null && <Check size={20} className="select-model-check" strokeWidth={2.5} />}
          </button>

          {models.map((m) => {
            const active = selectedModelId === m.id
            return (
              <button
                key={m.id}
                type="button"
                className={`select-model-item ${active ? 'active' : ''}`}
                onClick={() => handleSelect(m.id)}
              >
                <div className="select-model-info">
                  <div className="select-model-title-row">
                    <span className="select-model-name">{m.name}</span>
                    {m.id === bootstrap?.defaultModelId && <span className="select-model-badge">默认</span>}
                  </div>
                  <span className="select-model-desc">{modelDesc(m)}</span>
                </div>
                {active && <Check size={20} className="select-model-check" strokeWidth={2.5} />}
              </button>
            )
          })}

          {models.length === 0 && (
            <div style={{ padding: '18px 16px', fontSize: '13px', color: 'var(--fg-muted)' }}>
              暂未获取到电脑端模型目录，稍后下拉刷新后重试。
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* ==========================================================================
   Claude Tool Execution Card (1:1 Collapsible Bash / Tool Card)
   ========================================================================== */
function ClaudeToolCard({
  tool,
}: {
  tool: { id: string; tool: string; summary: string; detail?: string; output?: string; status: string }
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const isBash =
    tool.tool.toLowerCase().includes('bash') ||
    tool.tool.toLowerCase().includes('shell') ||
    tool.tool.toLowerCase().includes('cmd') ||
    tool.tool.toLowerCase().includes('terminal') ||
    tool.tool.toLowerCase().includes('command')

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const content = [tool.summary, tool.output ?? tool.detail].filter(Boolean).join('\n\n')
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore
    }
  }

  return (
    <div className={`claude-tool-card ${open ? 'open' : ''} ${tool.status}`}>
      <div
        className="tool-card-header"
        aria-expanded={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(prev => !prev) } }}
        onClick={() => setOpen((prev) => !prev)}
        role="button"
        tabIndex={0}
      >
        <div className="tool-card-header-left">
          {isBash ? (
            <Terminal size={14} className="tool-card-icon" />
          ) : (
            <Wrench size={14} className="tool-card-icon" />
          )}
          <span className="tool-card-name">{tool.tool}</span>
          {tool.summary && <span className="tool-card-summary">{tool.summary}</span>}
        </div>

        <div className="tool-card-header-right">
          <span className={`tool-card-status ${tool.status}`}>
            {tool.status === 'running' && '运行中'}
            {tool.status === 'success' && '完成'}
            {tool.status === 'error' && '失败'}
            {tool.status === 'pending' && '等待'}
          </span>
          <ChevronDown className="tool-card-chevron" size={13} />
        </div>
      </div>

      <AnimatedDisclosure open={open}>
        <div className="tool-card-content">
          <div className="tool-card-console">
            <div className="tool-console-topbar">
              <span>{tool.output !== undefined ? '工具输出' : '调用参数'}</span>
              <button type="button" className="tool-console-copy" onClick={handleCopy}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? '已复制' : '复制'}
              </button>
            </div>
            <div className="tool-console-body">
              {tool.summary && <div className="tool-console-cmd">$ {tool.summary}</div>}
              {(tool.output ?? tool.detail) ? (
                <div className="tool-console-output">{tool.output ?? tool.detail}</div>
              ) : (
                <div className="tool-console-empty">(无控制台输出)</div>
              )}
            </div>
          </div>
        </div>
      </AnimatedDisclosure>
    </div>
  )
}

/* ==========================================================================
   5. Process Panel — 思考过程 + 工具调用合并为一个折叠面板
   ========================================================================== */
function ProcessPanel({ thinking, tools, activity, running = false }: {
  thinking?: string
  tools?: Array<{ id: string; tool: string; summary: string; detail?: string; output?: string; status: string }>
  running?: boolean
  activity?: 'thinking' | 'responding' | 'tool'
}) {
  const toolList = tools ?? []
  const anyRunning = running || toolList.some((t) => t.status === 'running' || t.status === 'pending')
  const anyError = toolList.some((t) => t.status === 'error')
  const [open, setOpen] = useState(false)
  const thinkingRef = useRef<HTMLDivElement>(null)
  const followThinking = useRef(true)
  const thinkingActive = running && activity === 'thinking'
  useLayoutEffect(() => {
    const node = thinkingRef.current
    if (node && followThinking.current && thinkingActive) node.scrollTop = node.scrollHeight
  }, [thinking, open, thinkingActive])
  const toggle = () => { followThinking.current = true; setOpen(value => !value) }

  if (!thinking && toolList.length === 0 && !running) return null

  const runningCount = toolList.filter((t) => t.status === 'running').length
  const successCount = toolList.filter((t) => t.status === 'success').length

  const activeTool = toolList.find((tool) => tool.status === 'running')
  const title = activeTool
    ? activeTool.tool === 'request_user_input' ? '等待用户回答…' : `正在执行 ${activeTool.tool}…`
    : running ? activity === 'thinking' ? '正在思考…' : activity === 'responding' ? '正在生成回复…' : '等待模型响应…'
      : thinking ? '思考记录' : toolList.length ? `调用了 ${toolList.length} 个工具` : '等待回复…'

  return (
    <div className={`process-panel ${open ? 'open' : ''} ${anyRunning ? 'running' : anyError ? 'error' : 'success'}`} aria-busy={anyRunning}>
      <div
        className="process-panel-header"
        aria-expanded={open}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        onClick={toggle}
        role="button"
        tabIndex={0}
      >
        <div className="process-panel-left">
          {anyRunning ? <LoaderCircle size={13} className="process-panel-icon process-spinner" /> : <Sparkles size={13} className="process-panel-icon" />}
          <span className="process-panel-title" role="status">{title}</span>
          {toolList.length > 0 && (
            <span className="process-panel-sub">
              {anyRunning ? `运行中 ${runningCount}/${toolList.length}` : `完成 ${successCount}/${toolList.length}`}
            </span>
          )}
        </div>
        <div className="process-panel-right">
          {toolList.length > 0 && (
            <span className={`tool-card-status ${anyRunning ? 'running' : anyError ? 'error' : 'success'}`}>
              {anyRunning ? '运行中' : anyError ? '包含错误' : '完成'}
            </span>
          )}
          <ChevronDown className="process-panel-chevron" size={14} />
        </div>
      </div>

      {thinkingActive && thinking && !open && (
        <div className="process-thinking-preview" aria-label="实时思考内容">
          <div className="process-thinking-preview-text">{Array.from(thinking).slice(-600).join('')}<span className="streaming-caret" aria-hidden="true" /></div>
        </div>
      )}

      <AnimatedDisclosure open={open}>
        <div className="process-panel-body">
          {thinking && (
            <div className="process-thinking" ref={node => {
              thinkingRef.current = node
              if (node && thinkingActive && followThinking.current) node.scrollTop = node.scrollHeight
            }} onScroll={event => {
              const node = event.currentTarget
              followThinking.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
            }}>
              <div className="process-section-label">思考过程</div>
              {thinking}{thinkingActive && <span className="streaming-caret" aria-hidden="true" />}
            </div>
          )}
          {toolList.map((tool) => (
            <ClaudeToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      </AnimatedDisclosure>
    </div>
  )
}

/* ==========================================================================
   7. Claude Sidebar Drawer (Space-grouped Task Tree & User Profile)
   ========================================================================== */
function ClaudeDrawer({
  open,
  onClose,
  onNewChat,
  tasks,
  onSelectTask,
}: {
  open: boolean
  onClose: () => void
  onNewChat: (spaceId?: string) => void
  tasks: RemoteTaskSummary[]
  onSelectTask: (id: string) => void
}) {
  const taskModes = useRemoteStore((state) => state.bootstrap?.taskModes)
  const setConnectionSettingsOpen = useRemoteStore((state) => state.setConnectionSettingsOpen)
  const spaces = useRemoteStore((state) => state.bootstrap?.spaces)
  const activeTaskId = useRemoteStore((state) => state.activeTaskId)
  const notifications = useRemoteStore((state) => state.notifications)
  const readNotification = useRemoteStore((state) => state.readNotification)
  const showNotifications = useRemoteStore((state) => state.isNotificationsOpen)
  const setShowNotifications = useRemoteStore((state) => state.setNotificationsOpen)
  const unreadCount = notifications.filter((notice) => !notice.readAt).length
  // 折叠集合：默认全部展开，记录被收起的 spaceId
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  const groups = useMemo(() => buildSpaceTaskGroups(spaces ?? [], tasks), [spaces, tasks])

  const toggleSpace = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const renderTask = (task: RemoteTaskSummary, depth: number) => (
    <button
      key={task.id}
      type="button"
      className={`drawer-item-btn ${task.id === activeTaskId ? 'active' : ''}`}
      style={{ paddingLeft: 12 + depth * 18 }}
      onClick={() => onSelectTask(task.id)}
    >
      <span className="drawer-task-title">{task.title}</span>
      <span className="task-mode-label">{taskModeLabel(task, taskModes)}</span>
    </button>
  )

  const renderSpace = (node: SpaceGroupNode, depth: number): React.ReactNode => {
    const isCollapsed = collapsed.has(node.space.id)
    return (
      <div key={node.space.id} className="drawer-space">
        <div className="drawer-space-row">
        <button
          type="button"
          className="drawer-space-header"
          style={{ paddingLeft: 12 + depth * 18 }}
          onClick={() => toggleSpace(node.space.id)}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Folder size={15} className="drawer-space-icon" />
          <span className="drawer-space-name">{node.space.name}</span>
          {node.totalTasks > 0 && <span className="drawer-space-count">{node.totalTasks}</span>}
        </button>
        <button type="button" className="drawer-space-new-task" aria-label={`在 ${node.space.name} 中新建任务`}
          title={node.space.pathMissing ? '文件夹不可用，请在电脑端修复' : `在 ${node.space.name} 中新建任务`}
          disabled={node.space.pathMissing} onClick={() => onNewChat(node.space.id)}><Plus size={18} /></button>
        </div>
        <AnimatedDisclosure open={!isCollapsed}>
          <div className="drawer-space-children">
            {node.children.map((child) => renderSpace(child, depth + 1))}
            {node.tasks.map((task) => renderTask(task, depth + 1))}
            {node.totalTasks === 0 && node.children.length === 0 && (
              <div className="drawer-space-empty" style={{ paddingLeft: 12 + (depth + 1) * 18 }}>暂无任务</div>
            )}
          </div>
        </AnimatedDisclosure>
      </div>
    )
  }

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? 'open' : ''}`}
        onClick={onClose}
      />
      <aside className={`claude-drawer ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
        <div className="drawer-top-bar">
          <div className="header-brand">
            <MyBuddyIcon className="header-brand-icon" size={18} />
            <span>Mybuddy</span>
          </div>
          <button type="button" className="drawer-new-chat-btn" onClick={() => onNewChat()}>
            <Plus size={14} /> 新对话
          </button>
        </div>

        <div className="drawer-task-groups">
          {groups.roots.length > 0 && <div className="drawer-group-title">空间任务</div>}
          {groups.roots.map((node) => renderSpace(node, 0))}

          {groups.standalone.length > 0 && (
            <>
              <div className="drawer-group-title">独立任务</div>
              {groups.standalone.map((task) => renderTask(task, 0))}
            </>
          )}

          {groups.roots.length === 0 && groups.standalone.length === 0 && (
            <div style={{ color: 'var(--fg-muted)', fontSize: '13px', padding: '20px 10px' }}>
              暂无历史对话
            </div>
          )}
        </div>

        <div className="drawer-footer">
          <div className="drawer-user-pill">
            <div className="drawer-user-avatar">人</div>
            <span className="drawer-user-name">人类指挥官</span>
          </div>
          <div className="drawer-footer-actions">
            <button
              type="button"
              className="header-icon-btn header-badge-btn"
              aria-label="通知"
              onClick={() => setShowNotifications(!showNotifications)}
            >
              <Bell size={17} />
              {unreadCount > 0 && (
                <span className="notification-count-badge">{unreadCount}</span>
              )}
            </button>
            <button
              type="button"
              className="header-icon-btn"
              aria-label="连接设置"
              onClick={() => { onClose(); setConnectionSettingsOpen(true) }}
            >
              <Settings size={17} />
            </button>
          </div>
        </div>

        <AnimatedDisclosure open={showNotifications} floating>
          <NotificationsOverlay
            notifications={notifications}
            onClose={() => setShowNotifications(false)}
            onSelect={async (notice) => {
              setShowNotifications(false)
              await readNotification(notice.id)
              if (notice.taskId) {
                onClose()
                onSelectTask(notice.taskId)
              }
            }}
          />
        </AnimatedDisclosure>
      </aside>
    </>
  )
}

/* ==========================================================================
   8. Notifications Dropdown
   ========================================================================== */
function NotificationsOverlay({
  notifications,
  onClose,
  onSelect,
}: {
  notifications: Array<{ id: string; title: string; body?: string; createdAt: number; taskId?: string; readAt?: number | null }>
  onClose: () => void
  onSelect: (notice: any) => void
}) {
  const readAllNotifications = useRemoteStore((state) => state.readAllNotifications)
  const clearAllNotifications = useRemoteStore((state) => state.clearAllNotifications)
  const unreadCount = notifications.filter((n) => !n.readAt).length

  return (
    <div className="notifications-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="notifications-title" style={{ padding: 0 }}>通知</span>
          {unreadCount > 0 ? (
            <span style={{ fontSize: '11px', color: 'var(--accent)', fontWeight: 600, backgroundColor: 'var(--accent-soft)', padding: '1px 6px', borderRadius: 999 }}>
              {unreadCount} 条新通知
            </span>
          ) : (
            <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
              全部已读
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {unreadCount > 0 && (
            <button
              type="button"
              className="btn-action-notice read-all"
              onClick={() => void readAllNotifications()}
            >
              全部已读
            </button>
          )}
          {notifications.length > 0 && (
            <button
              type="button"
              className="btn-action-notice clear-all"
              onClick={() => void clearAllNotifications()}
            >
              全部清理
            </button>
          )}
          <button type="button" className="header-icon-btn" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="关闭通知">
            <X size={15} />
          </button>
        </div>
      </div>
      {notifications.length === 0 ? (
        <div style={{ padding: '24px 10px', textAlign: 'center', fontSize: '13px', color: 'var(--fg-muted)' }}>
          暂无通知
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {notifications.map((n) => {
            const isUnread = !n.readAt
            return (
              <button
                key={n.id}
                type="button"
                className={`notification-row ${isUnread ? 'unread' : ''}`}
                onClick={() => onSelect(n)}
              >
                <div className="notice-title-row">
                  {isUnread && <span className="notice-unread-dot" title="新通知" />}
                  <strong>{n.title}</strong>
                </div>
                {n.body && <span>{n.body}</span>}
                <time>{new Date(n.createdAt).toLocaleTimeString()}</time>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ==========================================================================
   Helpers & SVG Marks
   ========================================================================== */
// Desktop source: build/pi-source/favicon.svg.
function MyBuddyIcon({ className = '', size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 800 800"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="800" height="800" rx="120" fill="#09090b" />
      <path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z" />
      <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  )
}

function pickGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return '深夜了，还在忙什么呢？'
  if (hour < 11) return '早上好，今天想做什么？'
  if (hour < 14) return '中午好，需要帮点什么？'
  if (hour < 18) return '下午好，继续推进任务吧。'
  if (hour < 22) return '晚上好，今天进展如何？'
  return '夜深了，休息还是再战？'
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  return new Date(timestamp).toLocaleDateString()
}
