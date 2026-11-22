import { app } from "electron";
import { getMyBuddyDir } from "../paths";
import { claimDurableStorageLease, DurableStorageOwnedError, type DurableStorageLease } from "../agent/durable/DurableStorageLease";

// Electron forwards ordinary launches using userData. Distinct userData directories can still share one MyBuddy database.
function acquireHostDataLease(): DurableStorageLease | undefined {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  const directory = getMyBuddyDir();
  try {
    return claimDurableStorageLease(directory);
  } catch (error) {
    if (!(error instanceof DurableStorageOwnedError)) throw error;
    const owner = error.owner.pid > 0 ? `（PID ${error.owner.pid}）` : "";
    console.error(`[ResidentHost] MyBuddy 数据目录已由另一宿主${owner}使用：${directory}。Dots 在原宿主运行。`);
    app.exit(0);
    return;
  }
}

export const hostDataLease = acquireHostDataLease();
