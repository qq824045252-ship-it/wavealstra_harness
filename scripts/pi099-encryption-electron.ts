import assert from 'node:assert/strict';
import { app, safeStorage } from 'electron';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpOAuthCredentialStore } from '@earendil-works/pi-coding-agent';
import { McpCredentialBackend } from '../src/main/mcp/McpCredentialBackend';
async function main(): Promise<void> {
await app.whenReady();
const temp=mkdtempSync(join(tmpdir(),'pi099-encryption-'));const report:any={startedAt:new Date().toISOString(),kind:'real Electron OS encryption',passed:false};
try {
  assert(safeStorage.isEncryptionAvailable(),'OS encryption is unavailable');
  const file=join(temp,'auth.encrypted.json'),url='http://127.0.0.1:1/test-only';
  const a=new McpOAuthCredentialStore(new McpCredentialBackend(file),join(temp,'locks'));
  assert.equal(a.tokens(url),undefined);
  a.forServer(url).save({tokens:{access_token:'LOCAL_TEST_MARKER_099',token_type:'Bearer',refresh_token:'LOCAL_REFRESH_TEST_099'}} as any);
  assert(!readFileSync(file,'utf8').includes('LOCAL_TEST_MARKER_099'));
  assert(!readFileSync(file,'utf8').includes('LOCAL_REFRESH_TEST_099'));
  const b=new McpOAuthCredentialStore(new McpCredentialBackend(file),join(temp,'locks'));
  assert.equal(b.tokens(url)?.access_token,'LOCAL_TEST_MARKER_099');
  b.remove(url);assert.equal(a.tokens(url),undefined);
  writeFileSync(file,JSON.stringify({plaintext:'must-be-rejected'}));
  assert.throws(()=>a.tokens(url),/Invalid encrypted MCP credential store/);
  Object.assign(report,{passed:true,encryptedAtRest:true,reopenedSuccessfully:true,sharedLogout:true,plaintextRejected:true});
  console.log('PASS real Electron OS-encrypted native MCP credentials');
} catch(error){report.error=String(error);console.error(report.error);}
finally{rmSync(temp,{recursive:true,force:true});report.finishedAt=new Date().toISOString();mkdirSync(resolve('artifacts/pi099-migration'),{recursive:true});writeFileSync(resolve('artifacts/pi099-migration/encryption.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1);}

}
void main().catch(error => { console.error(error); app.exit(1); });
