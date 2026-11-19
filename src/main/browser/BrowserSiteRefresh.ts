import { WebContentsView, type Session, type WebContents, type DownloadItem, type Event } from "electron";
import { setTimeout as delay } from "node:timers/promises";

/** Give a site's own client a chance to perform silent refresh. Only its home
 * document is opened. No user tab, business form, or sign-in button is touched. */
export async function refreshSiteHome(session: Session, origin: string, signal: AbortSignal,
  hasExtended: () => Promise<boolean>): Promise<"checked" | "sign_in_required"> {
  signal.throwIfAborted();
  const view = new WebContentsView({ webPreferences: {
    session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: true,
  } });
  const wc = view.webContents;
  view.setBounds({ x: 0, y: 0, width: 960, height: 720 });
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  let leftSite = false;
  const stayOnSite = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (event.isMainFrame && !event.url.startsWith(origin + "/")) { leftSite = true; event.preventDefault(); }
  };
  const denyDownload = (event: Event, _item: DownloadItem, source: WebContents) => {
    if (source === wc) event.preventDefault();
  };
  const close = () => { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); };
  wc.on("will-redirect", stayOnSite);
  wc.on("will-frame-navigate", stayOnSite);
  session.on("will-download", denyDownload);
  signal.addEventListener("abort", close, { once: true });
  try {
    await wc.loadURL(origin + "/", { extraHeaders: "Cache-Control: no-cache" });
    const until = Date.now() + 3000;
    do {
      signal.throwIfAborted();
      if (leftSite) return "sign_in_required";
      if (await hasExtended()) return "checked";
      const challenge = await wc.executeJavaScript(`Array.from(document.querySelectorAll('input[type=password],input[autocomplete="one-time-code"]'))
        .some(el => el.checkVisibility({visibilityProperty:true,opacityProperty:true}) && el.getClientRects().length > 0)`);
      if (challenge) return "sign_in_required";
      await delay(250, undefined, { signal });
    } while (Date.now() < until);
    return "checked";
  } catch (error) {
    if (leftSite && !signal.aborted) return "sign_in_required";
    throw error;
  } finally {
    session.off("will-download", denyDownload);
    signal.removeEventListener("abort", close);
    close();
  }
}
