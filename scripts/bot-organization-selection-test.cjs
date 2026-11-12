const assert=require('node:assert/strict');
const {selection,selectionStatus}=require('./bot-organization-live-scenario.cjs');
const full=selection({});const rows=full.caseIds.map(id=>({id,status:'passed'}));
assert.equal(selectionStatus(rows,full).status,'passed');
for(const state of ['failed','running','not_run']){const sample=rows.map(x=>({...x}));sample[2].status=state;assert.equal(selectionStatus(sample,full).status,'failed');}
assert.equal(selectionStatus(rows.slice(1),full).status,'failed');
assert.equal(selectionStatus([...rows.slice(1),rows[1]],full).status,'failed');
const subset=selection({BOT_ORGANIZATION_CASES:'B,D'});
const partial=rows.map(x=>({...x,status:subset.selectedCases.has(x.id)?'passed':'not_run'}));
assert.equal(selectionStatus(partial,subset).status,'selected_passed');assert.equal(partial[0].status,'not_run');
const faults=selection({BOT_ORGANIZATION_C_FAULTS:'creation_storage'});
assert.equal(selectionStatus(rows,faults).status,'selected_passed');
for(const env of [{BOT_ORGANIZATION_CASES:'Z'},{BOT_ORGANIZATION_CASES:','},{BOT_ORGANIZATION_C_FAULTS:'wrong'},{BOT_ORGANIZATION_C_FAULTS:'creation_storage,creation_storage'},{BOT_ORGANIZATION_C_FAULTS:','}])assert.throws(()=>selection(env));
assert.equal(selectionStatus([],subset).status,'failed');
console.log('PASS organization selection/status behavior: full versus subset, incomplete/duplicate rows, failed/running/not_run, invalid cases/faults; pure isolated logic, not live-model acceptance');
