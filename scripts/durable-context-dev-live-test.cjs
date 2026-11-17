/** Ordinary task -> Durable context tools through an isolated pnpm dev app. */
const engine=process.env.CONTEXT_LIVE_ENGINE || 'billion-context';
if(!['billion-context','native'].includes(engine))throw Error('Unsupported CONTEXT_LIVE_ENGINE');
if(process.argv.includes('--check-harness')) {
 require('./desktop-dev-harness.cjs');require('./durable-context-dev-live-scenario.cjs');
 console.log('PASS ordinary-task dev harness imports; no app or model launch');
} else require('./desktop-dev-harness.cjs').run(require('./durable-context-dev-live-scenario.cjs').run, {
 name:'durable-context-live',liveModel:true,
 settings:{compactionEngine:engine,compactionTriggerRatio:0.8,compactionTriggerTokens:12000},
});
