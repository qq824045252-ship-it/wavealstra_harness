import "../src/main/pi-bundled-runtime";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAuthPath, getModelsPath } from "../src/main/paths";
import { registerMyBuddyProviders } from "../src/main/agent/providers";

async function main() {
  const started = Date.now();
  console.log(JSON.stringify({ auth: getAuthPath(), models: getModelsPath() }));
  const timer = setInterval(() => console.log(`still-waiting ${Date.now()-started}ms`), 2000);
  try {
    const runtime = await ModelRuntime.create({ authPath: getAuthPath(), modelsPath: getModelsPath(), allowModelNetwork: true });
    registerMyBuddyProviders(runtime);
    await runtime.refresh({ allowNetwork: false });
    console.log(`created ${Date.now()-started}ms`);
    console.log(`availableNow=${runtime.getAvailableNow().length}`);
  } finally { clearInterval(timer); }
}
main().catch((e)=>{ console.error(e); process.exitCode=1; });
