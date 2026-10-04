/**
 * 强制把场景文案 md 写到 ~/.mybuddy/modes/（若缺失）。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
import { MODE_BLOCK_IDS, WELCOME_MODES } from "../src/shared/mode-profile";

const root = join(homedir(), ".mybuddy", "modes");
mkdirSync(root, { recursive: true });

for (const id of WELCOME_MODES) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const seed = MODE_SEEDS[id];
  for (const b of MODE_BLOCK_IDS) {
    const p = join(dir, `${b}.md`);
    if (!existsSync(p)) {
      writeFileSync(p, seed.blocks[b].replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n", "utf-8");
      console.log("wrote", p);
    } else {
      console.log("exists", p);
    }
  }
  const pol = join(dir, "policy.json");
  if (!existsSync(pol)) {
    writeFileSync(pol, JSON.stringify(seed.policy, null, 2) + "\n", "utf-8");
    console.log("wrote", pol);
  } else {
    console.log("exists", pol);
  }
}

console.log("\nlisting:");
for (const f of readdirSync(root, { recursive: true })) {
  console.log(" ", f);
}
