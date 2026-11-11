/** Injected before mounting the existing actual-page fixture. Only history uses real IPC. */
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { BotHistoryRequest } from "../src/shared/bot-conversation";

export function installHistoryLoadPerf() {
  const host = (window as any).historyLoadHost;
  const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const refresh = useAppStore.getState().refreshBotHistory;
  window.api!.agent.listModels = async () => [];
  let selection = { variant: "candidate", scenario: "ordinary" }, transport: any[] = [];
  // Disable the page's periodic refresh so samples contain exactly the intended requests.
  useAppStore.setState({ refreshBotHistory: async () => {} });
  window.api!.botWork.history = async (request: BotHistoryRequest) => {
    const start = performance.now(), response = await host.query({ ...selection, request });
    transport.push({ ...response.timing, roundTripMs: performance.now() - start, request });
    return response.history;
  };
  const current = () => useAppStore.getState().botHistories.bot;
  const check = (expected: number) => {
    if (current()?.messages.length !== expected) throw Error(`Expected ${expected} messages, got ${current()?.messages.length}`);
    const error = useAppStore.getState().botConversationErrors.bot || useAppStore.getState().botHistoryPages.bot?.error;
    if (error) throw Error(error);
  };
  Object.assign(window, { historyLoadPerf: {
    async load(variant: string, scenario: string) {
      selection = { variant, scenario };
      useAppStore.setState({ botHistories: {}, botHistoryPages: {}, botConversationErrors: {} });
      await paint(); transport = [];
      const start = performance.now(); await refresh("bot"); const refreshed = performance.now();
      await paint(); const painted = performance.now(); check(100);
      const scroller = document.querySelector<HTMLElement>(".bot-thread")!;
      return { variant, scenario, totalMs: painted - start, refreshMs: refreshed - start, afterRefreshFramesMs: painted - refreshed,
        domMessages: document.querySelectorAll("[data-message-id]").length, scrollHeight: scroller.scrollHeight,
        transport, history: current() };
    },
    async page() {
      const before = current()!.messages.length;
      // A real DOM click exercises the component handler and the real loadOlderBotHistory store path.
      const button = document.querySelector<HTMLButtonElement>(".bot-history-controls button")!;
      button.click();
      const deadline = performance.now() + 10000;
      while (current()!.messages.length === before || useAppStore.getState().botHistoryPages.bot?.loading) {
        if (performance.now() > deadline) throw Error("Paging timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await paint(); check(before + 100);
      return { messages: current()!.messages.length, calls: transport.length, history: current() };
    },
    async scroll() {
      const thread = document.querySelector<HTMLElement>(".bot-thread")!;
      thread.scrollTop = 0; thread.dispatchEvent(new Event("scroll", { bubbles: true })); await paint();
      const top = thread.scrollTop;
      thread.scrollTop = thread.scrollHeight; thread.dispatchEvent(new Event("scroll", { bubbles: true })); await paint();
      return { top, bottom: thread.scrollTop, height: thread.scrollHeight, viewport: thread.clientHeight };
    },
    async images() {
      const images = [...document.querySelectorAll<HTMLImageElement>("img.chat-inline-image")];
      // Lazy images can be far above the viewport. Decode every actual protocol URL without changing timing samples.
      await Promise.all(images.map(async image => { image.loading = "eager"; await image.decode(); }));
      const decoded = images.map(image => ({ src: image.src, width: image.naturalWidth, height: image.naturalHeight }));
      images[0]?.click(); await paint();
      const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="报告原图"]');
      if (!dialog?.open) throw Error("Report image preview did not open");
      await dialog.querySelector<HTMLImageElement>("img")!.decode();
      dialog.querySelector<HTMLButtonElement>("button")!.click(); await paint();
      if (document.querySelector('dialog[aria-label="报告原图"]')) throw Error("Report image preview did not close");
      return decoded;
    },
  } });
}
