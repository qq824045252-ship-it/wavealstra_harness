import { Bot, ChevronRight, FileText } from 'lucide-react'
import type { RemoteHistoryMessage } from '@mybuddy/shared'
import { taskDotLabel, taskStatusDot } from '../lib/taskStatusDot'
import { localDoneAckAt, useRemoteStore } from '../store/remoteStore'
import { RemoteMarkdown } from './RemoteMarkdown'

export function DotsEntry({ placement, onOpen }: { placement: 'home' | 'drawer'; onOpen: (id: string) => void }) {
  const dots = useRemoteStore(state => state.bootstrap?.dots)
  const active = useRemoteStore(state => !!dots && state.activeTaskId === dots.id)
  const busy = useRemoteStore(state => dots ? state.runtimes[dots.id]?.busy : undefined)
  if (!dots) return null
  const status = taskStatusDot({ ...dots, busy: busy ?? dots.busy }, localDoneAckAt(dots.id))

  return <button type="button" className={`dots-entry dots-entry--${placement}`}
    aria-current={active ? 'page' : undefined} onClick={() => onOpen(dots.id)}>
    <span className="dots-entry-icon"><Bot size={21} aria-hidden /></span>
    <span className="dots-entry-label">
      <strong>MyBuddy Dots</strong>
      {placement === 'home' && <span>问问题、交办和跟进任务</span>}
    </span>
    {status && <span className={`task-status-dot task-status-dot--${status}`} role="img" aria-label={taskDotLabel(status)} />}
    <ChevronRight size={17} aria-hidden />
  </button>
}

const deliveryLabels = { conclusion: '交付结果', question: '待你确认', progress: '进展' } as const

export function DotsDelivery({ message, onOpenTask }: {
  message: RemoteHistoryMessage & { dotsDelivery: NonNullable<RemoteHistoryMessage['dotsDelivery']> }
  onOpenTask: (id: string) => void
}) {
  const delivery = message.dotsDelivery
  const task = useRemoteStore(state => state.bootstrap?.tasks.find(item => item.id === delivery.taskId && !item.archived))
  const taskAvailable = useRemoteStore(state => !task?.spaceId ||
    state.bootstrap?.spaces.some(space => space.id === task.spaceId && !space.archived && !space.effectiveArchived))
  const label = deliveryLabels[delivery.kind]
  const contents = <>
    {message.text.trim() && <RemoteMarkdown text={message.text} />}
    {delivery.files.length > 0 && <ul className="dots-delivery-files" aria-label="交付文件">
      {delivery.files.map(file => <li key={file.id}><FileText size={15} aria-hidden />{file.name}</li>)}
    </ul>}
    {task && taskAvailable && <button type="button" className="dots-delivery-link" onClick={() => onOpenTask(task.id)}>
      打开原任务 <ChevronRight size={15} aria-hidden />
    </button>}
  </>

  return <div className="dots-delivery" data-message-id={message.id}>
    {delivery.kind === 'progress' ? <details>
      <summary>{label}{delivery.title && ` · ${delivery.title}`}</summary>
      <div className="dots-delivery-body">{contents}</div>
    </details> : <>
      <div className="dots-delivery-heading"><strong>{label}</strong>{delivery.title && <span>{delivery.title}</span>}</div>
      {contents}
    </>}
  </div>
}
