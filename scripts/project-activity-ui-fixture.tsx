import React from "react";
import { createRoot } from "react-dom/client";
import ProjectActivity from "../src/renderer/src/components/pages/project/ProjectActivity";
import "../src/renderer/src/styles/global.css";

const now = Date.now();
const min = 60_000;
const project: any = { id: "p1", name: "slack", createdAt: now - 3 * 86_400_000, updatedAt: now - 2 * 86_400_000, archived: false };
const tasks: any[] = [
  { id: "t1", title: "读取进度，写入slack", projectId: "p1", updatedAt: now - 40 * min, status: "completed" },
  { id: "t2", title: "整理本周客户反馈并归类", projectId: "p1", updatedAt: now - 5 * min, status: "in_progress" },
];
const posts: any[] = [
  { id: "n1", projectId: "p1", body: "本周五前把进度同步到 #project-status 频道，周报格式参考上次的模板。", createdAt: now - 90 * min },
];
let events: any[] = [
  { id: "e1", projectId: "p1", source: "gateway", kind: "message", title: "外部消息（alice）", body: "明天上线前请再确认一下 Slack 通知的频道配置。", triageStatus: "open", createdAt: now - 20 * min },
  { id: "e2", projectId: "p1", source: "cron", kind: "run", title: "定时任务完成：每日进度汇总", triageStatus: "dismissed", createdAt: now - 3 * 60 * min },
  { id: "e3", projectId: "p1", source: "document", kind: "note", title: "周会纪要 10-02", body: "决定：通知统一走 #project-status；风险：Slack token 本月底过期。", triageStatus: "open", createdAt: now - 26 * 60 * min,
    promotions: [{ id: "pr1", eventId: "e3", targetKind: "memory", targetId: "m1", targetTitle: "通知统一走 #project-status", createdAt: now }] },
];
(window as any).api = {
  getPathForFile: () => "",
  db: {
    listProjectPosts: async () => structuredClone(posts),
    listProjectEvents: async () => structuredClone(events),
    onProjectEventsChanged: () => () => {},
    createProjectPost: async (request: any) => { posts.push({ id: `n${posts.length + 1}`, projectId: request.projectId, body: request.body, createdAt: Date.now() }); },
    deleteProjectPost: async (id: string) => { posts.splice(posts.findIndex((p) => p.id === id), 1); },
    dismissProjectEvent: async (_p: string, id: string) => { events = events.map((e) => e.id === id ? { ...e, triageStatus: "dismissed" } : e); },
    reopenProjectEvent: async (_p: string, id: string) => { events = events.map((e) => e.id === id ? { ...e, triageStatus: "open" } : e); },
    promoteProjectEvent: async () => {},
    ingestProjectDocument: async () => {},
    importProjectFile: async () => {},
    pickImportFile: async () => null,
  },
};
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <div className="project-desk" style={{ height: "100vh" }}>
    <div className="project-desk-body">
      <div className="project-desk-main">
        <nav className="project-desk-tabs"><button type="button" className="project-desk-tab active">概览</button><button type="button" className="project-desk-tab">健康</button><button type="button" className="project-desk-tab">计划</button></nav>
        <div className="project-desk-scroll">
          <ProjectActivity project={project} tasks={tasks} onOpenTask={(id) => { (window as any).openedTask = id; }} />
        </div>
      </div>
    </div>
  </div>,
);
