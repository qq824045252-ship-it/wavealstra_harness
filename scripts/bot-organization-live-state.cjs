/** Test-driver observation only: a durable foreground receipt is not yet a Work. */
const assert=require('node:assert/strict');
exports.observeRecipientWork=async(readJournal,readWork)=>{
  const journal=await readJournal();
  if(!journal.collaboration.workId)return {work:null,journal};
  assert(journal.receivers?.some(item=>item.requestId),'B normal foreground has a durable receipt before its Work');
  return {work:await readWork(journal.collaboration.workId),journal};
};
