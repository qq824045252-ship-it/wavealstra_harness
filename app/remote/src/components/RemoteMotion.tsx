import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const easing = 'cubic-bezier(0.22, 1, 0.36, 1)'

// Animate the current DOM only: navigation must never keep an old task interactive.
export function useScreenMotion(key: string) {
  const ref = useRef<HTMLDivElement>(null)
  const previous = useRef<string | null>(null)
  useLayoutEffect(() => {
    const from = previous.current
    previous.current = key
    // Keep the fixed composer, drawers and sheets outside the transformed content.
    const node = ref.current?.querySelector<HTMLElement>('.chat-timeline, .home-scrollable-content, .claude-onboard')
    if (!node || from === key || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const offset = key === 'home' && from?.startsWith('chat:') ? -18 : key.startsWith('chat:') ? 22 : 0
    const animation = node.animate([
      { opacity: 0.55, transform: `translate3d(${offset}px, ${offset ? 0 : 8}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ], { duration: 240, easing })
    return () => animation.cancel()
  }, [key])
  return ref
}

export function AnimatedDisclosure({ open, children, floating = false }: { open: boolean; children: ReactNode; floating?: boolean }) {
  const [present, setPresent] = useState(open)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (open && !present) { setPresent(true); return }
    const node = ref.current
    if (!node) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.style.height = ''
      node.style.overflow = ''
      if (!open) setPresent(false)
      return
    }
    const height = node.getBoundingClientRect().height
    const start = node.style.height ? height : open ? 0 : height
    node.style.overflow = 'hidden'
    let active = true
    const animation = node.animate([
      { height: `${start}px`, opacity: open ? 0.4 : 1 },
      { height: `${open ? node.scrollHeight : 0}px`, opacity: open ? 1 : 0 },
    ], { duration: 180, easing })
    void animation.finished.then(() => {
      if (!active) return
      node.style.height = ''
      node.style.overflow = ''
      if (!open) setPresent(false)
    }).catch(() => undefined)
    return () => {
      active = false
      node.style.height = `${node.getBoundingClientRect().height}px`
      animation.cancel()
    }
  }, [open, present])
  if (!present) return null
  return <div ref={ref} className={`remote-disclosure${floating ? ' remote-popover' : ''}`} aria-hidden={!open} inert={!open}>{children}</div>
}
