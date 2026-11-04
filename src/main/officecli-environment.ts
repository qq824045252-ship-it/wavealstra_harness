import { app } from "electron";
import { configureOfficeCli } from "./platform/officecli";

// Initialize before task/worker/terminal modules capture the process environment.
try {
  const binary = configureOfficeCli({ appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  if (binary) console.log(`[OfficeCLI] bundled binary=${binary}`);
} catch (error) {
  console.error("[OfficeCLI] bundled runtime unavailable", error);
}
