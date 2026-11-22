import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const vendorDir = fileURLToPath(new URL("../vendor/canban-review/", import.meta.url));
const targetDir = join(vendorDir, "target");
const target = "wasm32-unknown-unknown";
const cargoDir = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const remaps = [`--remap-path-prefix=${cargoDir}=/cargo`, `--remap-path-prefix=${vendorDir}=/canban-review`];
const result = spawnSync("cargo", [
  "+1.97.1", "build", "--locked", "--release", "--target", target, "--target-dir", targetDir,
], {
  cwd: vendorDir,
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: remaps.join("\u001f") },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const binary = readFileSync(join(targetDir, target, "release", "mybuddy_canban_review.wasm"));
const asset = join(vendorDir, "canban-review.wasm.json");
const expected = `${JSON.stringify({ base64: binary.toString("base64") })}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(asset, "utf8") !== expected) {
    console.error("Canban review WASM differs from the locked Rust sources");
    process.exit(1);
  }
  console.log(`Canban review WASM matches the locked Rust sources (${binary.length} bytes)`);
} else {
  writeFileSync(asset, expected, "utf8");
  console.log(`Generated Canban review WASM (${binary.length} bytes)`);
}
