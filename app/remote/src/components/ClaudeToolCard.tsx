import { useState, type MouseEvent } from 'react'
import { Check, ChevronDown, Copy, Terminal, Wrench } from 'lucide-react'
import type { RemoteToolCall } from '@mybuddy/shared'
import { AnimatedDisclosure } from './RemoteMotion'

export function ClaudeToolCard({
  tool,
}: {
  tool: RemoteToolCall
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const isBash =
    tool.tool.toLowerCase().includes('bash') ||
    tool.tool.toLowerCase().includes('shell') ||
    tool.tool.toLowerCase().includes('cmd') ||
    tool.tool.toLowerCase().includes('terminal') ||
    tool.tool.toLowerCase().includes('command')

  const handleCopy = async (e: MouseEvent) => {
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

