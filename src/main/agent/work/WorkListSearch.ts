/** Search the same derived guidance as WorkProjectionBuilder, without hydrating detail. */
export function workNextStepsSearchSql(input: { gaps: string; currentBinding: string }): string {
  const { currentBinding } = input;
  const gapCount = input.gaps.replace(/^EXISTS\(SELECT 1 /, '(SELECT count(*) ');
  const unresolved = `coalesce(json_extract(c.value,'$.origin'),'')!='assistant_proposal'
    AND coalesce(json_extract(c.value,'$.status'),'')!='waived'
    AND NOT (json_extract(c.value,'$.status')='satisfied'
      AND json_extract(c.value,'$.verifiedIntentRevision') IS json_extract(c.value,'$.requiredIntentRevision'))`;
  const environment = `(coalesce(json_extract(c.value,'$.requiresRealEnvironmentCheck'),0)!=0
    OR length(trim(coalesce(json_extract(c.value,'$.requiredEnvironment'),'')))>0)`;
  const criteria = (environmentRequired: boolean) => `(SELECT group_concat(json_extract(c.value,'$.text'),'、')
    FROM json_each(w.criteria_json) c WHERE ${unresolved} AND ${environmentRequired ? '' : 'NOT '}${environment})`;
  const accepted = `EXISTS(SELECT 1 FROM work_deliverables d JOIN work_execution_bindings b ON b.binding_id=d.execution_id
    WHERE d.work_id=w.work_id AND d.status='accepted' AND d.intent_revision=w.intent_revision
    AND d.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL AND b.status!='invalidated'
    AND d.deliverable_id IN (SELECT value FROM json_each(w.accepted_deliverable_ids_json)))`;
  return `
    CASE WHEN w.lifecycle='closing' THEN CASE WHEN json_extract(w.watch_rule_json,'$.termination') IS NOT NULL
      THEN '已停止新检查，等待在途回执与最后一轮汇报' ELSE '等待在途执行结束' END ELSE '' END || char(10) ||
    CASE WHEN w.lifecycle='paused' THEN CASE WHEN EXISTS(SELECT 1 FROM work_action_admissions ad WHERE ad.work_id=w.work_id AND ad.state='admitted')
      THEN '已暂停，正在结算在途操作' ELSE '事项已暂停，恢复后继续' END ELSE '' END || char(10) ||
    CASE WHEN json_extract(w.watch_rule_json,'$.termination') IS NULL AND ${input.gaps}
      THEN '保留已确认成果，仍有 ' || ${gapCount} || ' 项必要缺口待核对：未执行动作可关联后续证据覆盖，其余缺口按原身份处理' ELSE '' END || char(10) ||
    CASE WHEN w.lifecycle!='closed' AND json_extract(w.watch_rule_json,'$.termination') IS NULL THEN
      coalesce((SELECT group_concat('需要你的决定：'||k.reason,char(10)) FROM work_blockers k
        WHERE k.work_id=w.work_id AND k.status='open' AND k.waiting_for_user_input=1),'') || char(10) ||
      coalesce('等待实测反馈：'||${criteria(true)},'') || char(10) || coalesce('待验收：'||${criteria(false)},'') || char(10) ||
      CASE WHEN NOT ${accepted}
        AND NOT EXISTS(SELECT 1 FROM work_execution_bindings b WHERE ${currentBinding} AND b.status IN ('pending','submitted','running','unknown'))
        AND NOT EXISTS(SELECT 1 FROM work_deliverables d WHERE d.work_id=w.work_id AND d.status='proposed'
          AND d.intent_revision=w.intent_revision AND d.input_snapshot_id=w.input_snapshot_id)
        THEN '安排后台执行' ELSE '' END ELSE '' END`;
}

/** First nonempty guidance line for a compact active-work card. */
export function workFirstNextStepSql(input: { gaps: string; currentBinding: string }): string {
  return `(SELECT substr(guidance,1,instr(guidance||char(10),char(10))-1)
    FROM (SELECT trim((${workNextStepsSearchSql(input)}),char(10)) AS guidance))`;
}
