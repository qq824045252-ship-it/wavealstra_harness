import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const evidence = JSON.parse(readFileSync(new URL('./runtime-seed-paired-evidence.json', import.meta.url), 'utf8'));
const rows = evidence.rows;
assert.equal(rows.length, 7);
for (const field of ['accountHash', 'keyHash', 'turnHash', 'baseFieldsHash']) {
  assert.equal(new Set(rows.map(row => row[field])).size, 1, `${field} must stay fixed`);
}
assert(rows.every(row => row.status === 200 && row.toolCalls === 1));
assert.equal(new Set(rows.slice(1).map(row => row.sentTurnStateHash)).size, 1);
assert(rows.slice(1).every(row => row.sentTurnStateHash));
const capsule = rows[0].inputItemHashes.at(-1);
assert(rows.every(row => row.inputItemHashes.filter(hash => hash === capsule).length === 1));
const anchors = rows.filter(row => row.mode === 'anchor');
const anchorIndex = rows[0].inputItemHashes.indexOf(capsule);
assert(anchors.every(row => row.inputItemHashes.indexOf(capsule) === anchorIndex));
for (let i = 1; i < anchors.length; i++) {
  const previous = anchors[i - 1].inputItemHashes;
  assert.deepEqual(anchors[i].inputItemHashes.slice(0, previous.length), previous);
}
const pairs = [];
for (const stage of [2, 3, 4]) {
  const tail = rows.find(row => row.stage === stage && row.mode === 'tail');
  const anchor = rows.find(row => row.stage === stage && row.mode === 'anchor');
  assert(tail && anchor);
  assert.equal(tail.inputTokens, anchor.inputTokens);
  assert.deepEqual([...tail.inputItemHashes].sort(), [...anchor.inputItemHashes].sort());
  assert.deepEqual(tail.inputItemHashes.filter(hash => hash !== capsule), anchor.inputItemHashes.filter(hash => hash !== capsule));
  assert.equal(tail.inputItemHashes.at(-1), capsule);
  pairs.push({ stage, inputTokens: tail.inputTokens, tailCacheRead: tail.cachedTokens, anchoredCacheRead: anchor.cachedTokens });
}
assert.deepEqual(rows.slice(1).map(row => row.mode), ['tail', 'anchor', 'anchor', 'tail', 'tail', 'anchor']);
console.log(JSON.stringify({ passed: true, scope: 'Offline metadata verification; no network or credentials', sameAccountKeyTurnBaseFields: true, sameRoutingState: true, identicalItemsExceptCapsulePosition: true, anchorPreservesEntirePriorInput: true, pairs }, null, 2));
