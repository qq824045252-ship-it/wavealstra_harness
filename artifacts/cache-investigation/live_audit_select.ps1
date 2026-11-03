param([string]$Path="$PSScriptRoot\live-experiment-audit.json",[string]$OutPath="$PSScriptRoot\live-experiment-selected.json")
$r=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json
$sets=@(
  @{label='runtime_fullbody';ids=@(1793500712909L,1793500712910L);reads=@(47616,158848)},
  @{label='runtime_nextturn';ids=@(1793500712915L);reads=@(47616)},
  @{label='append_only';ids=@(1793500712923L,1793500712924L,1793500712925L,1793500712926L);reads=@(0,19584,0,26112)},
  @{label='moving_tail';ids=@(1793500712927L,1793500712928L,1793500712929L,1793500712930L);reads=@(0,0,3968,25984)}
)
$selected=@()
foreach($set in $sets){
  for($i=0;$i -lt $set.ids.Count;$i++){
    $found=@($r.records|Where-Object {$_.route_id -eq $set.ids[$i]})
    if($found.Count -ne 1){throw 'Record did not match uniquely'}
    $x=$found[0]
    if($x.cache_read -ne $set.reads[$i]){throw 'Cache-read signature mismatch'}
    $started = if ($x.time -is [datetime]) { [datetimeoffset]$x.time } elseif ($x.time -is [datetimeoffset]) { $x.time } else { [datetimeoffset]::Parse([string]$x.time) }
    $ended=$started.AddMilliseconds([double]$x.usage.ms)
    $tr=@($x.tries_summary)
    $order=@($x.order_summary)
    $selected += [pscustomobject]@{
      experiment=$set.label;step=$i+1;route_id=$x.route_id;usage_line=$x.usage_line;routing_line=$x.routing_line
      request_start_beijing=$x.time;estimated_request_end_beijing=$ended.ToString('o');duration_ms=$x.usage.ms
      model=$x.model;served=$x.usage.served;input_uncached=$x.input_uncached;cache_read=$x.cache_read;prompt_total=$x.prompt_total;output=$x.output
      account_sha256=$x.account_sha256;session_sha256=$x.session_sha256;native_session_sha256=$x.native_session_sha256
      status=$x.status;route_done=$x.route.done;route_status=$x.route.status
      order_count=$x.order_count;tries_count=$x.try_count;http_asks=@($tr.http_asks)
      try_account_id_sha256=@($tr.account_id_sha256);order_account_id_sha256=@($order.account_id_sha256);order_account_who_sha256=@($order.account_who_sha256)
      order_who_matches_usage_account=(@($order|Where-Object {$_.account_who_sha256 -ne $x.account_sha256}).Count -eq 0)
      tries_match_order_id=(@($tr|Where-Object {$_.account_id_sha256 -notin @($order.account_id_sha256)}).Count -eq 0)
      retry_again=@($tr.again);retry_replan=@($tr.replan);retried_ms=$x.retried_ms;handed_on=$x.handed_on;usage_tries_field=$x.tries_field
      recorded_error=$x.usage.err;recorded_err_type=$x.usage.err_type
      response_id_sha256=$x.usage.response_id.sha256
    }
  }
}
$report=[ordered]@{
  matched_records=$selected.Count
  account_sha256_values=@($selected.account_sha256|Sort-Object -Unique)
  try_account_id_sha256_values=@($selected.try_account_id_sha256|Sort-Object -Unique)
  all_order_who_matches_usage_account=(@($selected|Where-Object {-not $_.order_who_matches_usage_account}).Count -eq 0)
  all_tries_match_order_id=(@($selected|Where-Object {-not $_.tries_match_order_id}).Count -eq 0)
  status_values=@($selected.status|Sort-Object -Unique);order_count_values=@($selected.order_count|Sort-Object -Unique)
  tries_count_values=@($selected.tries_count|Sort-Object -Unique);http_asks_values=@($selected.http_asks|Sort-Object -Unique)
  all_routes_done=(@($selected|Where-Object {-not $_.route_done}).Count -eq 0)
  no_recorded_retry_fields=(@($selected|Where-Object {$null -ne $_.retried_ms -or $null -ne $_.handed_on -or @($_.retry_again|Where-Object {$null -ne $_}).Count -gt 0 -or @($_.retry_replan|Where-Object {$null -ne $_}).Count -gt 0}).Count -eq 0)
  records=$selected
  limits=@('Identity matched by exact cache sequences and request start plus recorded duration to align completion timestamps.','No account prefilter was applied: the current experiment account equality was verified from current usage and route records.','Recorded single-account/single-HTTP-ask evidence rules out visible gateway account rotation/retries, not vendor-side internal routing or cache replication.','Estimated end time is usage.t+usage.ms, not an independently logged client receipt timestamp.')
}
$report|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $OutPath -Encoding utf8
$report.GetEnumerator()|Where-Object {$_.Key -ne 'records' -and $_.Key -ne 'limits'}|ForEach-Object {'{0}: {1}' -f $_.Key,($_.Value|ConvertTo-Json -Compress)}
$selected|Select-Object experiment,step,route_id,request_start_beijing,estimated_request_end_beijing,input_uncached,cache_read,output|ConvertTo-Json -Compress
