/**
 * Test-only deterministic hash embedding — never used in production paths.
 * Isolated here so production code can be verified to contain no hash fallback.
 */
export const TEST_DIM = 1024;
const SYNONYM_GROUPS: string[][] = [
  ["温度补偿", "temperature compensation"],
  ["卡尔费休", "Karl Fischer", "KF"],
  ["差分电容", "differential capacitance"],
  ["取样", "sampling"],
  ["溶剂挥发", "solvent evaporation"],
  ["环境水分", "ambient moisture"],
  ["离线", "offline"],
  ["漂移", "drift"],
  ["AD7124", "ad7124"],
  ["VDS-100", "vds-100"],
];
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function hashEmbeddingForTests(text: string, dim = TEST_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const low = text.toLowerCase();
  let expanded = low;
  for (const g of SYNONYM_GROUPS) if (g.some((t) => low.includes(t.toLowerCase()))) expanded += " " + g.join(" ").toLowerCase();
  for (let i = 0; i < expanded.length; i++) {
    const ch = expanded[i]!; const code = ch.charCodeAt(0);
    const idx = Math.abs((code * 31 + i * 17) % dim); vec[idx]! += 1;
    if (i + 1 < expanded.length) { const bg = expanded.slice(i, i + 2); const h = hashString(bg); vec[h % dim]! += 0.5; }
  }
  let norm = 0; for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm); if (norm > 1e-9) for (let i = 0; i < dim; i++) vec[i]! /= norm;
  return vec;
}
