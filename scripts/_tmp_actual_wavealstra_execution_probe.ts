import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ExecutionControlPlane } from "../src/main/execution/ExecutionControlPlane";

const cwd = "C:\\Users\\servi\\OneDrive\\project\\韦威恩";
const db = new Database(":memory:");
const plane = new ExecutionControlPlane(db);
try {
  await plane.initialize();
  const cases = [
    {
      command: 'ls "C:/Users/servi/OneDrive/project/韦威恩/"',
      expected: new Set(["direct", "gitbash"]),
    },
    {
      command: 'find "C:/Users/servi/OneDrive/project/韦威恩/" -maxdepth 2 -type f \\( -name "*.md" -o -name "*.txt" -o -name "README*" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" \\) | head -30',
      expected: new Set(["gitbash"]),
    },
    {
      command: 'ls "/c/Users/servi/OneDrive/project/韦威恩/00_公司总览/" >/dev/null && printf OK',
      expected: new Set(["gitbash"]),
    },
  ];
  for (const item of cases) {
    const inspected = plane.inspect({ type: "raw_shell", command: item.command, cwd });
    assert(inspected.routable, JSON.stringify(inspected));
    assert(item.expected.has(inspected.backendId), JSON.stringify(inspected));
    const result = await plane.execute({ type: "raw_shell", command: item.command, cwd });
    assert("success" in result && result.success, JSON.stringify(result));
    assert(item.expected.has(result.backendId), JSON.stringify(result));
    console.log("PASS", result.backendId, result.exitCode, item.command.slice(0, 90));
  }
} finally {
  plane.dispose();
  db.close();
}
console.log("actual WaveAlstra project ECP probe PASS");
