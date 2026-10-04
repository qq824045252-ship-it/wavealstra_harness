from pathlib import Path
root=Path(__file__).resolve().parent.parent
p=root/'scripts/pi0992-memory-capsule-test.ts';s=p.read_text(encoding='utf-8').replace("memory.update({id:atom.id,content:'CANARY_PROJECT_NEW'})","memory.update({id:atom.id,title:'Calibration reference CANARY_PROJECT_NEW',content:'CANARY_PROJECT_NEW'})");p.write_text(s,encoding='utf-8',newline='\n')
s=(root/'scripts/build-native-control-portable.cjs').read_text(encoding='utf-8').replace('release-native-pi-','release-pi0992-').replace('artifacts/pi-native-control','artifacts/pi0992-memory')
s=s.replace(" await run('remote-build'", " await run('memory-races','pnpm run test:pi0992-memory-race');\n await run('memory-capsules','pnpm run test:pi0992-memory-capsule');\n await run('mcp-compat','pnpm run test:pi0992-mcp-config');\n await run('remote-build'")
(root/'scripts/build-pi0992-portable.cjs').write_text(s,encoding='utf-8',newline='\n')
s=(root/'scripts/pi-native-core-integrity.cjs').read_text(encoding='utf-8').replace('0.99.1','0.99.2').replace('artifacts/pi-native-control','artifacts/pi0992-memory')
(root/'scripts/pi0992-core-integrity.cjs').write_text(s,encoding='utf-8',newline='\n')
s=(root/'scripts/pi-native-desktop-live.cjs').read_text(encoding='utf-8').replace('artifacts/pi-native-control','artifacts/pi0992-memory').replace('native-pi-desktop-','pi0992-desktop-').replace('native-pi-real-model-packaged-desktop-composer','pi0992-real-model-packaged-desktop-composer')
(root/'scripts/pi0992-desktop-live.cjs').write_text(s,encoding='utf-8',newline='\n')
print('Pinned 0.99.2 build/integrity/desktop harnesses prepared; corrected fixture update to change both title and content.')
