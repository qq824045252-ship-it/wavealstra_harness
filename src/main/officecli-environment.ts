import { configureOfficeCli } from "./platform/officecli";

// Initialize before task/worker/terminal modules capture the process environment.
try {
  configureOfficeCli();
} catch (error) { console.error("[OfficeCLI] configured binary unavailable", error); }
