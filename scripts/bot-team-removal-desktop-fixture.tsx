import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BotTeamManagement } from "../src/renderer/src/components/pages/BotTeamManagement";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import "../src/renderer/src/components/pages/BotWorkspacePage.css";
let item = { workId: "synthetic-removal", title: "合作完成一个项目", lifecycle: "active", team: {} } as WorkProjectionDto;
const calls: string[] = [];
Object.assign(window, { deletionCalls: calls, api: { botWork: {
  listWorks: async () => item.team?.removedAt ? [item] : [],
  teamControl: async (request: { kind: string }) => {
    if (request.kind === "list_templates") return { ok: true, templates: [] };
    calls.push(request.kind);
    if (request.kind === "stop_and_remove_work") item = { ...item, lifecycle: "closing", team: { ...item.team!, removalRequestedAt: 1 } };
    if (request.kind === "restore_work") item = { ...item, team: { ...item.team!, removedAt: undefined, removalRequestedAt: undefined } };
    return { ok: true };
  },
} } });
function Fixture() {
  const [work, setWork] = useState(item);
  Object.assign(window, { settleDeletion: () => { item = { ...item, lifecycle: "closed", team: { ...item.team!, removedAt: 2 } }; setWork(item); } });
  return <main style={{ padding: 24 }}><BotTeamManagement work={work} onChanged={() => setWork(item)} /></main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
