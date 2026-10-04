const fs=require('node:fs');const f='scripts/pi100-integrity-audit.cjs';let s=fs.readFileSync(f,'utf8');
const pack=fs.readFileSync('scripts/pi100-package.cjs','utf8');const line=pack.split('\n').find(l=>l.startsWith('function fingerprint(){'));
if(!line||s.includes('function fingerprint(){'))throw Error('Unexpected fingerprint source state');
s=s.replace("const buildId=process.argv[2];",line+"\nconst buildId=process.argv[2];");
s=s.replace("try{\n const names=", "try{\n assert.equal(fingerprint(),build.sourceFingerprint,'Source changed after the verified build');report.sourceUnchanged=true;\n const names=");
fs.writeFileSync(f,s);console.log('Integrity now checks the complete current source fingerprint as well as binaries and reports.');
