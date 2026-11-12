import pathlib,json,hashlib,sqlite3,collections,datetime
out=pathlib.Path('/home/vivion/iq27-tmp/s27-d0k1hd7g/out/diagnostics/bot-scheduling/batch-2026-11-12T02-38-08-183Z-1742727')
report=json.loads((out/'report.json').read_text());dbpath=pathlib.Path(report['home'])/'.mybuddy/app.db';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();dbhash=sha(dbpath)
db=sqlite3.connect('file:'+str(dbpath)+'?mode=ro&immutable=1',uri=True);db.row_factory=sqlite3.Row
query=lambda s,a=():[dict(x) for x in db.execute(s,a)]
requests=[json.loads(x) for x in (out/'provider-requests.jsonl').read_text().splitlines()];audits=json.loads((out/'raw-usage-audit.json').read_text());diag=report['requestDiagnostics'];tools={x['callId']:x for x in report['toolDiagnostics']};msgs=query('SELECT * FROM bot_messages ORDER BY ordinal');receipts=query('SELECT * FROM bot_send_receipts');bindings=query('SELECT * FROM work_execution_bindings');ops=query('SELECT * FROM work_operation_receipts');snapshots=query('SELECT * FROM work_intent_snapshots');feedback=query('SELECT f.message_id,m.conversation_id,m.created_at,f.metadata_json FROM bot_work_feedback f JOIN bot_messages m ON m.message_id=f.message_id ORDER BY m.created_at');artifacts=query('SELECT a.*,b.work_id,b.intent_revision FROM work_generated_artifacts a JOIN work_execution_bindings b ON b.binding_id=a.binding_id')
convs=list(dict.fromkeys(c['user']['conversationId'] for c in report['cases']));cases=[]
for c in report['cases']:
 u=c['user'];linked=query('SELECT work_id,source_message_id,intent_revision,lifecycle FROM works WHERE source_message_id=?',(u['messageId'],));cases.append({'id':c['id'],'semanticType':c['type'],'requestId':u['requestId'],'messageId':u['messageId'],'conversationId':u['conversationId'],'uiInputAt':c['uiInputAt'],'uiInputMark':c['domInput']['name'],'answerMessageId':c.get('answer',{}).get('messageId'),'answerStatus':c.get('answer',{}).get('status'),'answerText':c.get('answer',{}).get('text'),'workLinks':linked})
art=[]
for r in artifacts:
 a=json.loads(r['payload_json']);p=pathlib.Path(a.get('snapshotPath','/nonexistent'));exists=p.is_file();digest=sha(p) if exists else None;size=p.stat().st_size if exists else None
 art.append({'workId':r['work_id'],'bindingId':r['binding_id'],'intentRevision':r['intent_revision'],**a,'currentDigest':digest,'currentSize':size,'immutableBytesVerified':exists and digest==a['digest'] and size==a['sizeBytes']})
deliveries=[]
for r in feedback:
 meta=json.loads(r['metadata_json']);files=meta.get('report',{}).get('files',[])
 for f in files:
  matches=[a for a in art if a['workId']==meta.get('workId') and a.get('snapshotPath')==f.get('openPath') and a['immutableBytesVerified']]
  if matches:deliveries.append({'messageId':r['message_id'],'conversationId':r['conversation_id'],'createdAt':r['created_at'],'workId':meta.get('workId'),'category':meta.get('category'),'eventId':meta.get('eventId'),'name':f.get('name'),'snapshotPath':f['openPath'],'digest':matches[0]['digest'],'sizeBytes':matches[0]['sizeBytes']})
orig=cases[0];work=orig['workLinks'][0]['work_id'];second=convs[1]
routeChecks=[]
for c in cases:
 for w in c['workLinks']:
  routed=[r for r in feedback if json.loads(r['metadata_json']).get('workId')==w['work_id']]
  routeChecks.append({'caseId':c['id'],'workId':w['work_id'],'expectedConversationId':c['conversationId'],'messageIds':[x['message_id'] for x in routed],'observedConversationIds':sorted(set(x['conversation_id'] for x in routed)),'allMatch':bool(routed) and all(x['conversation_id']==c['conversationId'] for x in routed)})
# Model transport-to-diagnostic correlation is one-to-one only when timing and exact token evidence match.
matches=[];used=set()
for wire in requests:
 idx=wire['requestIndex'];a=next((a for a in audits if a['requestIndex']==idx),None);usage=(a.get('usage') or [None])[-1] if a else None
 candidates=[]
 for d in diag:
  if abs(d['startedAt']-wire['at'])>1000 or d['id'] in used:continue
  u=d['usage'];total=(u.get('input') or 0)+(u.get('cacheRead') or 0)+(u.get('cacheWrite') or 0)
  if usage and usage.get('prompt_tokens')==total and usage.get('completion_tokens')==u.get('output'):candidates.append(d)
 d=candidates[0] if len(candidates)==1 else None
 if d:used.add(d['id'])
 phase='unknown';identity={};method='unmatched or ambiguous'
 if d:
  method='Unique start difference <=1000 ms plus exact provider prompt/completion usage, one-to-one'
  fg=next((m for m in msgs if d['executionScope']=='bot-foreground:'+m['message_id']),None)
  b=next((b for b in bindings if b['task_id']==d.get('taskId')),None)
  if fg:phase='foreground';identity={'messageId':fg['message_id'],'requestId':fg['request_id'],'conversationId':fg['conversation_id']}
  elif b:phase='native-child' if d['sourceKind']=='subagent' else 'native-main';identity={'workId':b['work_id'],'bindingId':b['binding_id'],'taskId':b['task_id']}
  else:
   u=next((m for m in wire['body']['messages'][::-1] if m['role']=='user'),{})
   try:context=json.loads(u.get('content',''));wid=context.get('originalRequest',{}).get('workId')
   except (ValueError,TypeError):context={};wid=None
   if wid and any(b['work_id']==wid for b in bindings):phase='watch-review' if context.get('watchSupervision') else 'completion-review';identity={'workId':wid,'reviewTarget':context.get('reviewTarget')}
 matches.append({'transportIndex':idx,'at':wire['at'],'diagnosticId':d['id'] if d else None,'diagnosticStatus':d['status'] if d else None,'startDifferenceMs':d['startedAt']-wire['at'] if d else None,'phase':phase,'identity':identity,'correlationMethod':method,'usage':usage,'httpStatus':a.get('httpStatus') if a else None})
phaseCounts=collections.Counter(x['phase'] for x in matches)
allcalls={c['id']:c for r in requests for m in r['body']['messages'] for c in m.get('tool_calls',[])}
failedTools=[]
for t in tools.values():
 if t['status']=='failed':
  result=next((m.get('content') for r in requests for m in r['body']['messages'] if m.get('tool_call_id')==t['callId']),None)
  failedTools.append({'diagnostic':t,'call':allcalls.get(t['callId']),'observedResult':result})
failures=[{'label':label,'assessment':'Raw assertion failure retained; no inferred cause.'} for label in report['failures']]
main=[json.loads(l) for l in (out/'main-probe-1744569.jsonl').read_text().splitlines()];openrows=[x for x in main if x['kind'].startswith('open-ipc-') or x['kind'].startswith('shell-open-')]
for f in failures:
 if 'openProbeEntries' in f['evidence']:f['evidence']['openProbeEntries']=len(openrows)
usageTotals=collections.Counter()
for x in matches:
 u=x['usage'] or {}
 for k in ['prompt_tokens','completion_tokens','total_tokens']:usageTotals[k]+=u.get(k,0)
 usageTotals['cached_prompt_tokens']+=(u.get('prompt_tokens_details') or {}).get('cached_tokens',0)
 usageTotals['reasoning_tokens']+=(u.get('completion_tokens_details') or {}).get('reasoning_tokens',0)
result={'scope':'Independent read-only persisted-state audit; preserves original 68/68 report and separately limits its file-open interpretation. No app launch or model call.','rawReport':str(out/'report.json'),'rawReportSha256':sha(out/'report.json'),'source':report['source'],'sourceManifestSha256':sha(pathlib.Path('/home/vivion/iq27-tmp/instrumented-v4/source-manifest.json')),'instrumentationManifestSha256':sha(pathlib.Path('/home/vivion/iq27-tmp/instrumented-v4/instrumentation-manifest.json')),'db':{'path':str(dbpath),'sha256Before':dbhash,'sha256After':sha(dbpath),'immutableRead':True,'walPresent':pathlib.Path(str(dbpath)+'-wal').exists()},'rawOutcome':{'status':report['status'],'pass':sum(x['passed'] for x in report['evidence']),'checks':len(report['evidence']),'fail':len(report['failures'])},'actualSemanticTypes':len({c['semanticType'] if c['semanticType']!='busy-direct-sample' else 'direct-answer' for c in cases}),'busyDirectSamples':len(report['busyProbes']),'plannedAmendment':'actually submitted; same Work revision2 and byte/delivery checks in raw report','persistedConversationIds':convs,'caseIdentityLinks':cases,'failureAssessments':failures,'independentRouteChecks':routeChecks,'immutableArtifacts':art,'verifiedDeliveries':deliveries,'modelAccounting':{'actualHttpCalls':len(requests),'diagnostics':len(diag),'phaseCounts':dict(phaseCounts),'unmatchedDiagnostics':[x['id'] for x in diag if x['id'] not in used],'matches':matches,'actualModels':sorted(set(x['body']['model'] for x in requests)),'usageTotals':dict(usageTotals),'firstHttpAt':min(x['at'] for x in requests),'lastHttpEndAt':max(x['endedAt'] for x in audits if x.get('endedAt')),'independentSummaryAndObservationStages':None,'monetaryCost':None},'toolAccounting':{'uniqueDiagnosticCallIds':len(tools),'uniqueTransportObservedCallIds':len(allcalls),'statusCounts':dict(collections.Counter(t['status'] for t in tools.values())),'failedTools':failedTools},'openProbeEntries':openrows,'busyLatency':report['busyLatency'],'windowSamples':report['windowSamples'],'navigationVisits':report['navigation']['visits'],'limitations':['Seven semantic types actually submitted; two repeated busy arithmetic probes are not extra types.','Both file button clicks reached exact immutable target IPC and shell.openPath returned empty error, but no visible external viewer was verified. Text launched detached nvim without tty; JSON stderr reports no application. Isolated HOME/XDG did not inherit user associations.','Original 68/68 counts only the defined assertions. It is not a complete Issue27 or successful visible-file-viewing pass.','Write-call accounting counts real transport-observed write tools. It is not a proof against every possible equivalent filesystem mutation mechanism.','Source fixed at414bf2bf; later main21 changes were not injected during the batch.','No physical scanout, target-specific paint, multiple main windows, native390 width, real GitHub webhook, all-platform or full latest-source regression claim.']}
(out/'independent-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({'audit':str(out/'independent-audit.json'),'sha256':sha(out/'independent-audit.json'),'phases':dict(phaseCounts),'tokens':dict(usageTotals),'routeChecks':routeChecks,'tools':result['toolAccounting']['statusCounts'],'unchangedDb':dbhash==sha(dbpath)},ensure_ascii=False))
