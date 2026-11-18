import { useMemo } from "react";
import type { ChatMessage } from "@/types";
import { useAppStore } from "@/store/appStore";
import type { SearchProviderRun, WebSearchReport } from "@shared/web-search";
import { searchProviderLabel } from "./SearchSettings";

const LABEL = { queued: "等待", running: "搜索中", success: "返回结果", empty: "无网页结果", timeout: "超时", error: "失败", cancelled: "已取消" };
const EMPTY: ChatMessage[] = [];

function latestSearch(messages: ChatMessage[]): WebSearchReport | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type === "tool" && block.toolCall.tool === "web_search" && block.toolCall.webSearch
        && block.toolCall.webSearch.status !== "running") return block.toolCall.webSearch;
    }
  }
}

function runLabel(run: SearchProviderRun): string {
  if (run.skippedReason === "unavailable") return "未调用（不可用）";
  if (run.skippedReason === "request-limit") return "未调用（达到请求上限）";
  return LABEL[run.status];
}

export default function LatestSearchRun(): React.JSX.Element {
  const messages = useAppStore(state => state.tasks?.find(task => task.id === state.activeTaskId)?.messages ?? EMPTY);
  const report = useMemo(() => latestSearch(messages), [messages]);
  return <section className="search-latest" aria-label="上次实际搜索">
    <strong>上次实际搜索 <small>· 当前会话</small></strong>
    {!report ? <p>当前会话已加载的记录中暂无搜索结果。</p> : <>
      {report.runs.length ? <ul>{[...new Set(report.runs.map(run => run.provider))].map(provider => {
        const runs = report.runs.filter(run => run.provider === provider);
        const outcomes = [...new Set(runs.map(runLabel))];
        return <li key={provider}><span>{searchProviderLabel(provider)}：</span>{outcomes.join("、")}</li>;
      })}</ul> : <p>该次搜索没有返回供应商调用记录。</p>}
      {report.notice && <p>{report.notice}</p>}
    </>}
  </section>;
}
