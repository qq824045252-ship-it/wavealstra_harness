import React from "react";
import { createRoot } from "react-dom/client";
import { BotWorkDetails } from "../src/renderer/src/components/pages/BotWorkDetails";
import type { WorkProjectionDto } from "../src/shared/bot-work";
import { useAppStore } from "../src/renderer/src/store/appStore";
useAppStore.setState({ botIdentities: [], refreshBotWork: async () => {} });
const root = createRoot(document.getElementById("root")!);
Object.assign(window, { renderArtifactFixture(work: WorkProjectionDto) {
  root.render(<BotWorkDetails work={work} ownerName="Artifact fixture" includeClosed={false} />);
} });
