import { useState } from "react";
import type { MemoryIndexIssue, MemoryIndexResult } from "@shared/memory-kernel";

const issueTitles = {
  missing: "未找到本地语义模型",
  invalid: "语义模型文件校验失败",
  runtime: "语义索引未能运行",
  index: "部分记忆未能建立索引",
};

export default function MemoryIndexFeedback({ result }: { result: MemoryIndexResult | { issue: MemoryIndexIssue } }): React.JSX.Element {
  const [copyStatus, setCopyStatus] = useState("");
  const { issue } = result;
  const counts: string[] = [];
  if ("indexed" in result) {
    counts.push(`本次新增 ${result.indexed} 条`, `已有索引 ${result.current} 条`);
    if (result.failed) counts.push(`失败 ${result.failed} 条`);
    if (result.pending) counts.push(`待处理 ${result.pending} 条`);
    if (result.skipped) counts.push(`记忆已变更，跳过 ${result.skipped} 条`);
  }
  if (!issue) return <div className="memory-status" role="status">{counts.join("，")}</div>;
  const install = issue.kind === "missing" || issue.kind === "invalid";
  return <div className="memory-status memory-index-feedback">
    <div role="alert"><strong>{issueTitles[issue.kind]}</strong>{"indexed" in result && <span>{[...counts, "仍可按关键词检索"].join("，")}。</span>}</div>
    <details>
      <summary>{install ? "模型安装与修复指引" : "查看原因与处理方法"}</summary>
      <p>{issue.detail}</p>
      {install && <p>从已有安装或备份取得完整的 MyBuddy BGE-M3 INT8 v1 模型包。按下方路径创建目录，将 manifest.json、model.onnx、bge-m3-int8.onnx.data、tokenizer.json 和包内其他文件直接放入该目录。</p>}
      {issue.modelDirectory && <div className="memory-index-path">
        <code>{issue.modelDirectory}</code>
        <button type="button" className="btn btn-sm" onClick={async () => {
          try { await navigator.clipboard.writeText(issue.modelDirectory!); setCopyStatus("已复制"); }
          catch { setCopyStatus("请选中路径复制"); }
        }}>复制路径</button>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>}
      <p>{install ? "文件就位后，点击上方「重试语义索引」重新校验并补齐。" : "点击上方「重试语义索引」继续处理。若仍失败，请在反馈中附上这里显示的错误原因。"}</p>
    </details>
  </div>;
}
