import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryCorrection, parseDeliveryContract, verifyDeliveryContract } from "../src/main/agent/hooks/DeliveryContract.ts";

const root = await mkdtemp(join(tmpdir(), "delivery-contract-"));
try {
  const contract = parseDeliveryContract('生成 report.md，章节：背景、结论。附上附件 data.csv。');
  assert.deepEqual(contract, { document: "report.md", headings: ["背景", "结论"], attachments: ["data.csv"] });
  assert.equal(parseDeliveryContract('如何生成 report.md？'), undefined);
  assert.equal(parseDeliveryContract('生成 report.md，不需要附件'), undefined);
  assert.deepEqual(parseDeliveryContract('生成 report.md，必须包含章节「结论」和附件 evidence.csv。'), { document: "report.md", headings: ["结论"], attachments: ["evidence.csv"] });
  assert.deepEqual(parseDeliveryContract('写入report.md，章节「结论」'), { document: "report.md", headings: ["结论"], attachments: [] });
  assert.equal(deliveryCorrection('新增章节「建议」', contract!), false);
  assert.equal(parseDeliveryContract('生成 report.md 或 draft.md'), undefined);
  assert.equal(parseDeliveryContract('生成 ../report.md'), undefined);
  assert.equal(deliveryCorrection('漏了附件 data.csv', contract!), true);
  assert.equal((await verifyDeliveryContract(root, contract!)).status, "missing");
  await writeFile(join(root, "report.md"), "# 背景\n内容\n```md\n# 结论\n```\n");
  assert.deepEqual((await verifyDeliveryContract(root, contract!)).missing, ["标题: 结论", "data.csv"]);
  await writeFile(join(root, "report.md"), "# 背景\n内容\n## 结论\n内容\n");
  await writeFile(join(root, "data.csv"), "a,b\n1,2\n");
  const result = await verifyDeliveryContract(root, contract!);
  assert.equal(result.status, "passed");
  assert.match(result.evidence["data.csv"], /^[a-f0-9]{64}$/);
  assert.equal((await verifyDeliveryContract(root, { ...contract!, document: "../report.md" })).status, "unknown");
  await mkdir(join(root, "dir"));
  try {
    await symlink(join(root, "report.md"), join(root, "dir", "link.md"), "file");
    assert.equal((await verifyDeliveryContract(root, { ...contract!, document: "dir/link.md" })).status, "unknown");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  console.log("delivery contract checks passed");
} finally { await rm(root, { recursive: true, force: true }); }
