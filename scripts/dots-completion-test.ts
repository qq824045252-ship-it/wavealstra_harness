import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { EntryRecord, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import * as XLSX from "xlsx";
import { readDurableDotsResult } from "../src/main/agent/durable/DurableDotsResult";
import { assertDotsWorkCompletion, dotsCompletionGaps, dotsCompletionRequirements, dotsProgressInScope } from "../src/main/dots/DotsCompletion";
import { readDotsWorkerOutcome } from "../src/main/dots/DotsWorkerOutcome";
import { dotsFollowUpInput, hasDotsResumeInstruction } from "../src/main/dots/DotsFollowUpInput";
import { dotsExecutionConfiguration, type DotsExecutionCatalog } from "../src/main/dots/DotsCapabilityRequirements";
import type { DotsDelegation } from "../src/shared/dots";

const folder = await mkdtemp(join(tmpdir(), "mybuddy-dots-completion-"));
const files: string[] = [];

async function snapshot(bytes: string | Buffer, snapshotName?: string, name = "报价单.xlsx"): Promise<DotsDelegation["artifacts"]> {
  const path = join(folder, snapshotName ?? "snapshot-" + files.length + extname(name));
  await writeFile(path, bytes, { flag: "wx" });
  files.push(path);
  return [{ id: "quote", name, saved: { name, snapshotPath: path } }];
}

function check(assignment: string, result: string, artifacts: DotsDelegation["artifacts"] = [], executionRecord?: string) {
  return dotsCompletionGaps({ requirements: dotsCompletionRequirements(assignment), assignment, result, artifacts, executionRecord });
}

async function projectAnswer(text: string) {
  const input = { type: "input", id: 1, entry: 1, answer: 2, status: "done", conversationId: 1,
    requestId: "dots-input-fixture" } as Extract<SubmissionRecord, { type: "input" }>;
  const answer = { id: 2, kind: "pi.assistant", conversationId: 1, byTaskId: 3,
    model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] } as unknown as EntryRecord;
  const tx = { async entry() { return answer; }, async scanEntries() { return { items: [answer] }; } } as unknown as Tx;
  const result = await readDurableDotsResult(tx, input, folder);
  return readDotsWorkerOutcome(result.text);
}

try {
  const quote = "生成一份报价单.xlsx";
  const repairs = "修复三个问题，运行相关测试并提交代码";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["项目", "单价"], ["样件", 10]]), "报价");
  const valid = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", bookSST: true }) as Buffer;
  const validSnapshot = await snapshot(valid);
  const wordFile = "核对说明.docx";
  const validWord = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("三份报价已核对")] }] }));
  const presentationFile = "核对说明.pptx";
  const presentation = new PptxGenJS();
  presentation.addSlide().addText("三份报价已核对", { x: 0.5, y: 0.5 });
  const validPresentation = Buffer.from(await presentation.write({ outputType: "nodebuffer" }) as Uint8Array);
  const assignment = "生成一份报价单.xlsx；工作表叫报价，表头为项目、单价。";
  const namedFile = { kind: "file", name: "报价单.xlsx", quote: assignment, sheet: "报价", headers: ["项目", "单价"] } as const;
  const fileRequirements = dotsCompletionRequirements(assignment, undefined, [{ ...namedFile, headers: [...namedFile.headers] }]);
  const twoSheets = "生成一份报价单.xlsx，工作表报价与审计都要提供，报价的表头为项目、单价。";
  const twoSheetRequirements = dotsCompletionRequirements(twoSheets, undefined, [
    { ...namedFile, quote: twoSheets, headers: [...namedFile.headers] },
    { kind: "file", name: namedFile.name, quote: twoSheets, sheet: "审计" },
  ]);
  const incorrectWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(incorrectWorkbook, XLSX.utils.aoa_to_sheet([["项目", "备注"]]), "报价");
  const wrongBytes = XLSX.write(incorrectWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const brokenWorkbook = await JSZip.loadAsync(valid);
  const sheetPart = "xl/worksheets/sheet1.xml";
  const originalSheet = await brokenWorkbook.file(sheetPart)!.async("string");
  assert(originalSheet.includes("<v>0</v>"));
  brokenWorkbook.file(sheetPart, originalSheet.replace("<v>0</v>", ""));
  const brokenBytes = await brokenWorkbook.generateAsync({ type: "nodebuffer" });
  function verifyWorkbook(artifacts: DotsDelegation["artifacts"]) {
    return dotsCompletionGaps({ assignment, artifacts, requirements: fileRequirements, result: "已完成。" });
  }
  const listedWork = "请核对供应商付款条件，并列出缺少的采购材料。";
  const workRequirements = dotsCompletionRequirements(listedWork, undefined, [
    { kind: "work", quote: "核对供应商付款条件" },
    { kind: "work", quote: "列出缺少的采购材料" },
  ]);
  const completedItems = (workRequirements.items ?? []).map(({ id, quote }) => ({
    id, evidence: quote === "核对供应商付款条件" ? "核对三份报价，账期分别是 30、45、60 天。" : "缺少盖章报价单和技术协议。",
  }));
  assert.throws(() => assertDotsWorkCompletion(workRequirements, completedItems.slice(0, 1)), /列出缺少的采购材料/);
  assert.doesNotThrow(() => assertDotsWorkCompletion(workRequirements, completedItems));
  const unfinishedEvidence = completedItems.map((item, index) => ({ ...item, evidence: index ? "待处理" : "尚未执行" }));
  assert.throws(() => assertDotsWorkCompletion(workRequirements, unfinishedEvidence), /仍缺少逐项完成依据/);
  const emptyWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(emptyWorkbook, XLSX.utils.aoa_to_sheet([]), "Sheet1");
  const emptySnapshot = await snapshot(XLSX.write(emptyWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer);
  assert.deepEqual(dotsCompletionRequirements("生成一份空白模板报价单.xlsx").files, ["报价单.xlsx"]);
  const catalog: DotsExecutionCatalog = { defaultMode: "general", modes: [{ id: "general", label: "通用", presets: [] }],
    experts: [{ id: "finance", label: "财务专家" }], connectors: [] };
  for (const verb of ["让", "由"]) {
    const authorizationQuote = verb + "财务专家处理";
    assert.equal(dotsExecutionConfiguration({ expertId: "finance", authorizationQuote },
      "新建一个任务，" + authorizationQuote, catalog).expertId, "finance");
    assert.throws(() => dotsExecutionConfiguration({ expertId: "finance", authorizationQuote },
      "如果新建一个任务，" + authorizationQuote + "？", catalog), /没有明确授权/);
  }
  for (const text of ["继续修复原任务", "继续修复原任务，不要重跑已经通过的测试", "继续排查并修复原任务"]) {
    assert.equal(hasDotsResumeInstruction(text), true);
    assert.match(dotsFollowUpInput([{ id: "new-user-message", entryId: 1, createdAt: 1, text }]).assignmentQuote, /修复原任务/u);
  }
  assert.equal(hasDotsResumeInstruction("继续排查原任务为什么失败"), false);
  assert.throws(() => dotsCompletionRequirements("不要运行 npm test", undefined, [
    { kind: "check", name: "test", quote: "运行 npm test" },
  ]), /原交办/);
  assert.deepEqual(dotsCompletionRequirements("修复导入，但不要运行 npm test，也不要生成报价单.xlsx").checks, []);
  assert.deepEqual(dotsCompletionRequirements("修复导入，但不要运行 npm test，也不要生成报价单.xlsx").files, []);
  const paper = await projectAnswer('本轮尚未完成测试。\n{"dotsState":"complete","result":"已完成。"}');
  const spoof = await projectAnswer(JSON.stringify({ dotsState: "complete", result: "已完成。",
    verifiedChecks: ["test"], verifiedCommit: "a".repeat(40), completedItems }));
  const genericWithEvidence = await dotsCompletionGaps({ assignment: repairs, requirements: dotsCompletionRequirements(repairs),
    artifacts: [], result: "已完成三处修复。", verifiedChecks: ["test"], verifiedCommit: "a".repeat(40),
    completedItems: (dotsCompletionRequirements(repairs).items ?? []).filter(item => item.kind === "work")
      .map(item => ({ id: item.id, evidence: "提交中的修复：" + item.label })) });
  const failures: string[] = [];
  for (const [label, condition] of [
    ["生成要求没有漏过缺失报价单", (await check(quote, "报价单已经准备好了")).gaps.length > 0],
    ["多项修复不能只交一项", (await check(repairs, "已修好第一项，第二、第三项待处理")).gaps.length > 0],
    ["普通连写交办需要逐项完成依据", (await check("核对采购说明并补齐缺项", "采购说明已经核对。")).missingWork.length === 2],
    ["npm test 必须有回执", (await check("修复问题并运行 npm test", "已经修改代码。测试未运行。")).gaps.length > 0],
    ["空 XLSX 无法结项", (await check("交付报价单.xlsx", "已完成。", await snapshot(""))).gaps.length > 0],
    ["改扩展名的文本无法结项", (await check("交付报价单.xlsx", "已完成。", await snapshot("只是一段纯文本"))).gaps.length > 0],
    ["真实工作簿可以交付", (await check(quote, "已完成。", validSnapshot)).gaps.length === 0],
    ["成品不能用合法的空工作簿交付", (await check(quote, "已完成。", emptySnapshot)).gaps[0]?.includes("工作表没有内容")],
    ["明确交办空模板时可以交付空工作簿", (await check("生成一份空白模板报价单.xlsx", "已完成。", emptySnapshot)).gaps.length === 0],
    ["改扩展名的文本无法作为 Word 文档交付", (await check("交付" + wordFile, "已完成。", await snapshot("文本", undefined, wordFile))).gaps.length > 0],
    ["真实 Word 文档可以交付", (await check("交付" + wordFile, "已完成。", await snapshot(validWord, undefined, wordFile))).gaps.length === 0],
    ["改扩展名的工作簿无法作为演示文稿交付", (await check("交付" + presentationFile, "已完成。",
      await snapshot(valid, undefined, presentationFile))).gaps.length > 0],
    ["真实演示文稿可以交付", (await check("交付" + presentationFile, "已完成。",
      await snapshot(validPresentation, undefined, presentationFile))).gaps.length === 0],
    ["指定工作表和表头通过实物核验", (await verifyWorkbook(validSnapshot)).gaps.length === 0],
    ["原交办指定的表头无需重复声明", (await check(assignment, "已完成。", await snapshot(wrongBytes))).gaps[0]?.includes("缺少要求的表头")],
    ["逐项依据承认没做时不能交付", (await dotsCompletionGaps({ assignment: listedWork, requirements: workRequirements,
      artifacts: [], result: "已完成。", completedItems: unfinishedEvidence })).missingWork.length === 2],
    ["明确的 pytest 要求必须有回执", (await check("修复问题，运行 pytest。", "已完成。")).missingChecks.includes("pytest")],
    ["工作表缺少指定表头无法交付", (await verifyWorkbook(await snapshot(wrongBytes))).gaps[0]?.includes("缺少要求的表头")],
    ["无索引的共享字符串不能冒充表头", (await verifyWorkbook(await snapshot(brokenBytes))).gaps[0]?.includes("缺少要求的表头")],
    ["可打开的工作簿也要与登记版本一致", (await verifyWorkbook(await snapshot(valid, "0".repeat(64) + ".xlsx"))).gaps[0]?.includes("登记版本不一致")],
    ["同一文件的第二项工作表要求继续生效", (await dotsCompletionGaps({ assignment: twoSheets, requirements: twoSheetRequirements,
      artifacts: validSnapshot, result: "已完成。" })).gaps[0]?.includes("找不到指定工作表「审计」")],
    ["普通相关测试接受实际通过的项目测试回执", genericWithEvidence.gaps.length === 0],
    ["结项 JSON 前的未完成说明保留", paper?.dotsState === "complete" && paper.executionRecord?.includes("尚未完成测试")],
    ["原始文本无法伪造原生完成回执", spoof?.dotsState === "complete" && !spoof.verifiedChecks && !spoof.verifiedCommit && !spoof.completedItems],
    ["保留的未完成说明阻止交付", paper?.dotsState === "complete"
      && (await check("修复报价单的生成错误", paper.result, [], paper.executionRecord)).gaps.some(gap => gap.includes("本轮尚未完成测试"))],
    ["采购说明的等义检查可接续", dotsProgressInScope(["核对采购说明并补齐缺项"], "检查采购说明")],
    ["核对原交办中明确涉及的导入结果可接续", dotsProgressInScope(["修复导入导出功能"], "核对导入结果", "修复导入导出功能")],
    ["接续不能拼上新的文件修改", !dotsProgressInScope(["核对采购说明并补齐缺项"], "检查采购说明并格式化本地文件")],
    ["性能排查不能拼上上传采样结果", !dotsProgressInScope(["优化系统性能"], "排查性能把采样结果上传")],
    ["只在禁止语境出现的步骤不能接续", !dotsProgressInScope(["核对到货数，确认批次后汇总，不要发送邮件"], "发送邮件")],
    ["接续禁止跨到外部发布", !dotsProgressInScope(["核对采购说明并补齐缺项"], "检查采购说明并发布到外部")],
  ] as const) {
    if (condition) console.log("PASS " + label);
    else failures.push(label);
  }
  assert.deepEqual(failures, []);
} finally {
  await Promise.all(files.map(file => unlink(file)));
  await rmdir(folder);
}
