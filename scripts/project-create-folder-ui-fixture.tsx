import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import NewProjectModal from "../src/renderer/src/components/pages/NewProjectModal";
import { calls, state } from "./project-create-folder-store-stub";
import "../src/renderer/src/styles/global.css";
import "../src/renderer/src/styles/project-create.css";

const saved: any[] = [];
const apiCalls: any[] = [];
let failBinding = false;
let projectSeq = 0;
(window as any).api = {
  pickLocalFolder: async () => ({ path: "C:/projects/new-project", name: "new-project" }),
  mcp: { listServers: async () => [] },
  db: {
    createProject: async (request: any) => {
      apiCalls.push(["createProject", request]);
      projectSeq += 1;
      return { ok: true, project: { id: `project-${projectSeq}`, name: request.name, description: request.description, instructions: request.instructions, templateId: request.templateId, policies: request.policies, resources: [], resourceBudgetChars: request.resourceBudgetChars ?? 128000, createdAt: Date.now(), updatedAt: Date.now() } };
    },
    updateProject: async (request: any) => {
      apiCalls.push(["updateProject", request]);
      if (failBinding) return { ok: false, error: "模拟目录绑定失败" };
      return { ok: true, project: { id: request.id, name: "目录项目", defaultSpaceId: request.defaultSpaceId, policies: { expert: { allow: [], deny: [], recommended: [] }, skill: { prefer: [], demote: [], hide: [], allow: [] }, connector: { allow: [], deny: [], recommended: [] }, mcp: { mode: "hard", allow: [], deny: [] } }, resources: [], resourceBudgetChars: 128000, createdAt: Date.now(), updatedAt: Date.now() } };
    },
  },
};

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [key, setKey] = useState(0);
  return <>
    <NewProjectModal key={key} open={open} onClose={() => setOpen(false)} onSaved={(project, notice) => { saved.push({ project, notice }); }} />
    <button id="reopen" onClick={() => { setKey((value) => value + 1); setOpen(true); }}>reopen</button>
  </>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Harness />);
(window as any).projectCreateFolderTest = {
  calls,
  apiCalls,
  saved,
  state,
  failNextBinding() { failBinding = true; },
  resetBinding() { failBinding = false; },
};