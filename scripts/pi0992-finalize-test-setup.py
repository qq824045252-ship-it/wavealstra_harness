from pathlib import Path
import json
root=Path(__file__).resolve().parent.parent
p=root/'scripts/pi0992-memory-capsule-test.ts';s=p.read_text(encoding='utf-8')
a=s.index('else{assert.equal(sent.length,2);const capsules=');b=s.index('\n  const persisted=',a)
s=s[:a]+'''else{assert.equal(sent.length,2);
    // Pi converts custom messages to provider user messages. Inspect transmitted
    // content, not the host-only customType which is deliberately no longer present.
    const capsules=sent.map(c=>c.messages.filter((m:any)=>JSON.stringify(m.content).includes('CANARY_PROJECT_OLD')));
    assert(capsules.every(c=>c.length===1),'exactly one capsule per provider request');
    assert.deepEqual(capsules[0],capsules[1],'capsule changed inside one logical user turn');
  }'''+s[b:]
p.write_text(s,encoding='utf-8',newline='\n')
p=root/'package.json';v=json.loads(p.read_text(encoding='utf-8'))
v['scripts']['test:pi0992-memory-capsule']='esbuild scripts/pi0992-memory-capsule-test.ts --bundle --platform=node --format=esm --packages=external --outfile=out/tests/pi0992-memory-capsule-test.mjs && node scripts/test-guard.mjs out/tests/pi0992-memory-capsule-test.mjs'
p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
print('Provider-level capsule count assertion corrected for native Pi custom-to-user serialization.')
