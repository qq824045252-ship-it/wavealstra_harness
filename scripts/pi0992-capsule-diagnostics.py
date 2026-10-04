from pathlib import Path
p=Path(__file__).resolve().parent/'pi0992-memory-capsule-test.ts';s=p.read_text(encoding='utf-8')
s=s.replace("assert(capsules.every(c=>c.length===1),'duplicate capsule');", "assert(capsules.every(c=>c.length===1),'capsule count diagnostic: '+JSON.stringify(sent.map(c=>c.messages.map((m:any)=>({role:m.role,customType:m.customType,canary:JSON.stringify(m.content).includes('CANARY_PROJECT_OLD'),keys:Object.keys(m)})))));")
p.write_text(s,encoding='utf-8',newline='\n')
