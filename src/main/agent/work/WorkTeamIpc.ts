import type { WorkTeamControlResult } from "../../../shared/bot-work-team";

interface Sender { isDestroyed(): boolean; mainFrame: unknown }
interface SenderEvent { sender: Sender; senderFrame: { url: string } | null }
interface MainWindow { isDestroyed(): boolean; webContents: Sender }

function documentUrl(value: string): string | undefined {
  try { const url = new URL(value); url.hash = ""; url.search = ""; return url.href; }
  catch { return undefined; }
}

/** Team setup is a trusted user action, never an authority supplied by model payloads. */
export function createWorkTeamIpcHandler(options: {
  getMainWindow: () => MainWindow | null;
  rendererUrl: string;
  control: (request: unknown) => WorkTeamControlResult;
}): (event: SenderEvent, request: unknown) => WorkTeamControlResult {
  const trustedUrl = documentUrl(options.rendererUrl);
  return (event, request) => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender.isDestroyed()
      || event.sender !== window.webContents || !event.senderFrame
      || event.senderFrame !== window.webContents.mainFrame
      || !trustedUrl || documentUrl(event.senderFrame.url) !== trustedUrl) {
      return { ok: false, code: "forbidden", message: "只能从应用主窗口管理 Bot 团队" };
    }
    return options.control(request);
  };
}
