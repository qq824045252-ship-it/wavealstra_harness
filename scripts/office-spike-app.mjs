// 1H — Office spike 页面逻辑（外部文件，CSP script-src 'self'）
const t = (label, value) => {
  const line = { kind: "metric", name: label, value: `${value}` };
  console.log("SPIKE|" + JSON.stringify(line));
  const rep = document.getElementById("report");
  if (rep) rep.textContent += `${label}: ${value}\n`;
};

const FIX = "../fixtures/artifacts/synthetic/office/";

try {
  // ===== DOCX: docx-preview =====
  const t0 = performance.now();
  const { renderAsync } = await import("../../out/spike-office/docx-preview.mjs");
  t("docx-preview cold import", `${(performance.now() - t0).toFixed(1)} ms`);

  const docxBlob = await (await fetch(`${FIX}docx-rich.docx`)).blob();
  const host = document.getElementById("docx-host");
  const tR = performance.now();
  await renderAsync(docxBlob, host, undefined, { inWrapper: false, ignoreWidth: true });
  const pages = host.querySelectorAll(".docx").length;
  t("docx renderAsync (9.7KB 文档)", `${(performance.now() - tR).toFixed(1)} ms (${pages} 页)`);
  host.innerHTML = "";

  // ===== XLSX: SheetJS =====
  const t1 = performance.now();
  const XLSX = await import("../../out/spike-office/xlsx.mjs");
  t("xlsx cold import", `${(performance.now() - t1).toFixed(1)} ms`);

  const xlsxBuf = await (await fetch(`${FIX}xlsx-rich.xlsx`)).arrayBuffer();
  const tP = performance.now();
  const wb = XLSX.read(new Uint8Array(xlsxBuf), { type: "array" });
  const tParse = performance.now() - tP;
  const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).length;
  t(`xlsx 解析 (${(xlsxBuf.byteLength / 1024).toFixed(0)}KB, ${wb.SheetNames.length} sheets)`, `${tParse.toFixed(1)} ms`);
  t("xlsx sheet1 行数", `${sheetRows}`);

  // ===== PPTX: jszip 解包可行性 =====
  const t2 = performance.now();
  const { default: JSZip } = await import("../../out/spike-office/jszip.mjs");
  const pptxBuf = await (await fetch(`${FIX}pptx-rich.pptx`)).arrayBuffer();
  const zip = await JSZip.loadAsync(pptxBuf);
  const slides = Object.keys(zip.files).filter((n) => n.startsWith("ppt/slides/slide") && n.endsWith(".xml")).length;
  const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/")).length;
  t(`pptx 解包 (${(pptxBuf.byteLength / 1024).toFixed(0)}KB)`, `${(performance.now() - t2).toFixed(1)} ms`);
  t("pptx slide 数 / media 数", `${slides} / ${media}`);
  // 提取第一页 XML 大小作为渲染复杂度参考
  const slideXml = await zip.files["ppt/slides/slide1.xml"].async("string");
  t("pptx slide1 XML", `${(slideXml.length / 1024).toFixed(1)} KB`);

  console.log("SPIKE|" + JSON.stringify({ kind: "done" }));
} catch (err) {
  console.log("ERROR|" + String((err && err.stack) || err).slice(0, 600));
  console.log("SPIKE|" + JSON.stringify({ kind: "done" }));
}
