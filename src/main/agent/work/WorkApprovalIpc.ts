import type { WorkActionDecisionResult } from "../../../shared/bot-work-approval";

interface Sender {
  isDestroyed(): boolean;
  mainFrame: unknown;
}
interface SenderEvent {
  sender: Sender;
  senderFrame: { url: string } | null;
}
interface MainWindow {
  isDestroyed(): boolean;
  webContents: Sender;
}

function documentUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href;
  } catch { return undefined; }
}

/** Only the host-owned app window's top-level application document may decide background permissions. */
export function workApprovalIpcHandler(options: {
  getMainWindow: () => MainWindow | null;
  rendererUrl: string;
  decideAction: (request: unknown) => WorkActionDecisionResult;
}): (event: SenderEvent, request: unknown) => WorkActionDecisionResult {
  const trustedUrl = documentUrl(options.rendererUrl);
  return (event, request) => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender.isDestroyed()
      || event.sender !== window.webContents || !event.senderFrame
      || event.senderFrame !== window.webContents.mainFrame
      || !trustedUrl || documentUrl(event.senderFrame.url) !== trustedUrl) {
      return { ok: false, code: "forbidden", message: "只能从应用主窗口决定后台操作授权" };
    }
    return options.decideAction(request);
  };
}
