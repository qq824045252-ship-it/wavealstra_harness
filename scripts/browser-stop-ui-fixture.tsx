import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ChatInput from "../src/renderer/src/components/chat/ChatInput";
import { useAppStore } from "../src/renderer/src/store/appStore";
export function mount(taskId: string, durable: any) {
  useAppStore.setState({activeTaskId:taskId,tasks:[{id:taskId,title:"Isolated stop acceptance",createdAt:Date.now(),updatedAt:Date.now(),welcomeMode:"working",status:"in_progress",messages:[],durable}] as any});
  const container=document.createElement("div");document.body.append(container);
  flushSync(()=>createRoot(container).render(<ChatInput />));
  return Boolean(document.querySelector('button[aria-label="停止生成"]'));
}
export function stopped() { return useAppStore.getState().tasks[0]?.durable?.busy === false; }
