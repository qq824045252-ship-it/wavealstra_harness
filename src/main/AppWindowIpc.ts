/** Trusted desktop controls must come from the host-owned top-level application document. */
export function isMainAppWindowRequest(event: {
  sender: { isDestroyed(): boolean; mainFrame: unknown };
  senderFrame: { url: string } | null;
}, window: { isDestroyed(): boolean; webContents: unknown } | null, rendererUrl: string): boolean {
  if (!window || window.isDestroyed() || event.sender.isDestroyed() || event.sender !== window.webContents
    || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url), expected = new URL(rendererUrl);
    actual.hash = expected.hash = "";
    actual.search = expected.search = "";
    return actual.href === expected.href;
  } catch { return false; }
}
