import type { BotCreateResult } from "../../../shared/bot-create";

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

/** Only the host-owned app window's top-level application document may create identities. */
export function createBotIpcHandler(options: {
  getMainWindow: () => MainWindow | null;
  rendererUrl: string;
  createBot: (request: unknown) => BotCreateResult;
}): (event: SenderEvent, request: unknown) => BotCreateResult {
  const trustedUrl = documentUrl(options.rendererUrl);
  return (event, request) => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender.isDestroyed()
      || event.sender !== window.webContents || !event.senderFrame
      || event.senderFrame !== window.webContents.mainFrame
      || !trustedUrl || documentUrl(event.senderFrame.url) !== trustedUrl) {
      return { ok: false, code: "forbidden", message: "只能从应用主窗口创建 Bot" };
    }
    return options.createBot(request);
  };
}
