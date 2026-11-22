import { getCanbanReviewRuntime } from "./runtime";
import type { EngineRequest, EngineResponse } from "./engine";

const runtime = getCanbanReviewRuntime();
const respond = (response: EngineResponse): void => self.postMessage(response);

self.addEventListener("message", ({ data }: MessageEvent<EngineRequest>) => {
  try {
    switch (data.method) {
      case "parse":
        respond({ id: data.id, value: runtime.parse(...data.args) });
        break;
      case "formatHunkHeader":
        respond({ id: data.id, value: runtime.formatHunkHeader(...data.args) });
        break;
      case "expandGap":
        respond({ id: data.id, value: runtime.expandGap(...data.args) });
        break;
      case "formatPendingMarkdown":
        respond({ id: data.id, value: runtime.formatPendingMarkdown(...data.args) });
        break;
    }
  } catch (error) {
    respond({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
});
respond({ contextStep: runtime.contextStep });
