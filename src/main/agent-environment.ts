import { homedir } from "node:os";
import { join } from "node:path";

// Run before Pi or capabilities capture their configuration paths. The main
// entry's body runs only after all of its static dependencies initialize.
if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = join(homedir(), ".mybuddy");
}
