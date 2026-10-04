/** ResizeObserver delivers during layout. Defer layout-changing work until the
 * next animation frame, coalesce notifications, and cancel queued work on cleanup.
 * This avoids resize -> React state -> resize feedback inside one delivery cycle.
 */
export function observeResizeOnFrame(targets: Element[], onResize: () => void): () => void {
  // Observe iframe DOM with its own window: parent/child layout delivery must
  // not share an observer rooted in a different document.
  const view = targets[0]?.ownerDocument.defaultView ?? window;
  const Observer = (view as Window & typeof globalThis).ResizeObserver;
  let frame: number | null = null;
  let disposed = false;
  const observer = new Observer(() => {
    if (disposed || frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (!disposed) onResize();
    });
  });
  for (const target of targets) observer.observe(target);
  return () => {
    disposed = true;
    observer.disconnect();
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
  };
}
