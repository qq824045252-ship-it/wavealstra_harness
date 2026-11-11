/** Actual Sidebar row callback regression test; no React, desktop, or Git-history dependency. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const checkProjectionEquivalence = require('./sidebar-projection-dev-equivalence.cjs');

const current = fs.readFileSync(path.join(__dirname, '../src/renderer/src/components/Sidebar.tsx'), 'utf8');
const declaration = '    let tasksById: Map<string, Task> | undefined;\n';
const indexedLookup = `          if (!tasksById) {
            tasksById = new Map<string, Task>();
            for (const task of tasks) if (!tasksById.has(task.id)) tasksById.set(task.id, task);
          }
          const task = tasksById.get(n.id);`;
assert.equal(current.split(declaration).length - 1, 1, 'Exactly one projection-local index declaration');
assert.equal(current.split(indexedLookup).length - 1, 1, 'Exactly one indexed task lookup');
// Restore only the old lookup in the same current callback. This keeps the
// comparison independent of shallow CI history and unrelated future JSX edits.
const original = current.replace(declaration, '').replace(indexedLookup, '          const task = tasks.find((t) => t.id === n.id);');
const parity = checkProjectionEquivalence(original, current);

function compile(source) {
  const marker = '  const visibleRows = useMemo((): VisibleRow[] => {';
  const endMarker = '  }, [tree, spaces, tasks, expandedSpaceIds, foregroundRequests, foregroundConversations, foregroundLimits, expandedConversations]);';
  assert.equal(source.split(marker).length - 1, 1);
  assert.equal(source.split(endMarker).length - 1, 1);
  const start = source.indexOf(marker) + marker.length;
  const body = source.slice(start, source.indexOf(endMarker, start));
  const parameters = 'tree,spaces,tasks,expandedSpaceIds,foregroundRequests,foregroundConversations,foregroundLimits,expandedConversations';
  return new Function(esbuild.transformSync(`function project(${parameters}) {${body}}; return project;`, { loader: 'ts', target: 'es2022' }).code)();
}
const before = compile(original), after = compile(current);
const node = id => ({ kind: 'task', id, title: id });
const tree = [node('task'), node('unknown')];
const first = { id: 'task', title: 'First', status: 'in_progress', doneAckedAt: 0, messages: [] };
const args = tasks => [tree, [], tasks, [], [], [], {}, {}];
const firstRows = after(...args([first]));
assert.equal(firstRows.length, 1);
assert.equal(firstRows[0].task, first);
for (const changes of [
  { status: 'completed', doneAckedAt: 20 },
  { title: 'Renamed', isFavorited: true, spaceSortOrder: 9000 },
  { status: 'pending', messages: [{ id: 'message', interactions: [{ status: 'pending' }] }] },
]) {
  const replacement = { ...first, ...changes };
  const nextRows = after(...args([replacement]));
  assert.deepEqual(nextRows, before(...args([replacement])));
  assert.equal(nextRows[0].task, replacement, 'A later projection uses the current Task object and all current fields');
  assert.equal(firstRows[0].task, first, 'Prior rows keep their original Task object');
}
assert.deepEqual(after(...args([])), [], 'Removed tasks do not survive an earlier projection');
const second = { ...first, title: 'Second duplicate' };
assert.equal(after(...args([first, second]))[0].task, first);
assert.equal(after(...args([second, first]))[0].task, second, 'Reordered input changes the first match on the next call');

// Guard the algorithmic reduction without a machine-dependent timing budget.
const count = 1000;
let idReads = 0;
const manyTasks = Array.from({ length: count }, (_, i) => ({ get id() { idReads++; return `task-${i}`; } }));
const manyTree = Array.from({ length: count }, (_, i) => node(`task-${count - 1 - i}`));
const manyArgs = [manyTree, [], manyTasks, [], [], [], {}, {}];
before(...manyArgs);
const oldReads = idReads;
idReads = 0;
const result = after(...manyArgs);
assert.equal(result.length, count);
assert.equal(oldReads, count * (count + 1) / 2);
assert(idReads <= count * 2, `Task id reads must be linear; got ${idReads}`);
console.log(`PASS sidebar row lookup: ${parity.cases} full-value/reference parity cases, between-call freshness, ${oldReads} -> ${idReads} task id reads`);
