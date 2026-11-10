import { createRoot } from "react-dom/client";
import { WorkReport, WorkResultText } from "../src/renderer/src/components/pages/BotWorkResult";
import type { WorkFeedbackDto } from "../src/shared/bot-conversation";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
const summary = "## 检查结论\n\n文件校验完成，结果来自真实回读。\n\n" + Array.from({length:32},(_,i)=>`- 检查 ${i+1}：保存内容与回读一致。`).join("\n") + "\n\n最后一条证据。";
const report: NonNullable<WorkFeedbackDto["report"]> = {title:"并行任务报告",summary,artifactRefs:[],notices:["现场检查已记录"],current:true,reviewStatus:"proposed"};
const root=createRoot(document.getElementById("root")!);
const render=(kind:string)=>{
 const value = kind === "raw" ? {...report,summary:'{"unprojected":"'+'source'.repeat(350)+'"}'} : kind === "structured" ? {...report,structured:{version:1 as const,conclusions:[{text:"结构化结论",requestMessageId:"q",requestText:"核对文档",sources:[]}],observations:[]}} : report;
 const original=kind==="distinct" ? `后台成果，结果已返回\n${summary}\n现场检查已记录\n补充证据：第二次回读为 31 字节。` : kind==="structured" ? "原始 JSON 含独有字段" : `后台成果，结果已返回\n${value.summary}\n现场检查已记录`;
 root.render(<main style={{padding:16,maxWidth:1000,margin:"auto",fontFamily:"sans-serif"}}><WorkReport key={kind} report={value} originalText={original} renderMarkdown={text=><WorkResultText text={text}/>}/></main>);
};
Object.assign(window,{setReportCase:render});render("same");
