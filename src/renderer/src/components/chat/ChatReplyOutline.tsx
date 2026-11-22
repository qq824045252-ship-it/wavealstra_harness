import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import "./ChatReadability.css";

const MIN_SECTIONS = 3;

export function ChatReplyOutline({ reply, streaming }: { reply: RefObject<HTMLDivElement | null>; streaming?: boolean }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<HTMLElement[]>([]);
  const [open, setOpen] = useState(false);
  useBlockNativeSurfaces(open && !streaming && headings.length >= MIN_SECTIONS);
  useEffect(() => {
    const root = reply.current;
    if (!root || streaming) return;
    const read = () => {
      const next = Array.from(root.querySelectorAll<HTMLElement>(".md-chat :is(h1,h2,h3,h4,h5,h6)"))
        .filter(heading => heading.closest(".md")?.classList.contains("md-chat") && heading.textContent?.trim());
      setHeadings(previous => previous.length === next.length && previous.every((heading, i) => heading === next[i]) ? previous : next);
    };
    read();
    const observer = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement
        && (node.matches("h1,h2,h3,h4,h5,h6") || node.querySelector("h1,h2,h3,h4,h5,h6"))))) read();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [reply, streaming]);
  if (streaming || headings.length < MIN_SECTIONS) return null;
  return <>
    <button type="button" className="chat-reading-button" popoverTarget={id} aria-label="跳转到回复段落">段落</button>
    <div id={id} ref={menu} popover="auto" className="chat-reading-popover" role="navigation" aria-label="回复段落"
      onToggle={event => setOpen(event.newState === "open")}>
      {headings.map((heading, index) => <button type="button" key={index} onClick={() => {
        menu.current?.hidePopover();
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
      }}>{heading.textContent?.trim()}</button>)}
    </div>
  </>;
}
