'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
exports.instrumentHarness=source=>{
 const once=(a,b)=>{if(!source.includes(a))throw Error('Probe injection anchor changed: '+a);source=source.replace(a,b);};
 once('    delete env.ELECTRON_RUN_AS_NODE;',`    delete env.ELECTRON_RUN_AS_NODE;
    env.NODE_OPTIONS = [env.NODE_OPTIONS || '', '--require=' + ${JSON.stringify(path.join(__dirname,'main-probe.cjs'))}].filter(Boolean).join(' ');
    env.IQ27_PROBE_HOME = home; env.IQ27_PROBE_OUT = out;`);
 once('    try { await require(process.env.ISSUE27_SCENARIO)',`    const probeSources = ${JSON.stringify(['main-probe.cjs','collector.cjs','bootstrap.cjs','analyze.cjs','open-probe.cjs'].map(n=>path.join(__dirname,n)))};
    report.phaseProbeSources=probeSources.map(file=>({file,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
    const phaseProbe = await require(${JSON.stringify(path.join(__dirname,'collector.cjs'))}).start({rpc,evaluate,out,socket});
    try { await require(process.env.ISSUE27_SCENARIO)`);
 once('      report.source.finishedFingerprint=fingerprint();',`      report.phaseProbe=await phaseProbe.stop();
      report.phaseProbeSourcesAfter=probeSources.map(file=>({file,sha256:require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
      assert.deepEqual(report.phaseProbeSourcesAfter,report.phaseProbeSources,'probe scripts must remain unchanged during the batch');
      assert(!report.phaseProbe.dataLossOccurred,'Chromium trace must not report lost data');
      fs.writeFileSync(path.join(out,'probe-sources.json'),JSON.stringify(report.phaseProbeSources,null,2));
      report.source.finishedFingerprint=fingerprint();`);
 return source;
};
