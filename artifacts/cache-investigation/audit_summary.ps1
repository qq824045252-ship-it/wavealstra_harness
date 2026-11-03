param([string]$EvidencePath = "$PSScriptRoot\audit-evidence.json", [string]$OutPath = "$PSScriptRoot\audit-target-summary.json")
$r = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
$rows = @()
foreach ($m in $r.native_usage_matches) {
  if ($m.matches.Count -ne 1) { throw "Native record did not match uniquely" }
  $match = $m.matches[0]
  $u = $r.usage_candidates[$match.usage_candidate_index]
  $found = @($r.routing_candidates | Where-Object { $_.record.id -eq $match.route_id })
  if ($found.Count -ne 1) { throw "Route record did not match uniquely" }
  $route = $found[0].record
  $v = $u.record
  $rows += [pscustomobject]@{
    native_index = $m.native_index; usage_line = $u.line; routing_line = $found[0].line
    route_id = $match.route_id; time_beijing = $v.t; requested = $v.req; model = $v.model; served = $v.served
    input_uncached = $v.in; cache_read = $v.cache_read; prompt_total = $v.in + $v.cache_read
    native_input = $match.native_input; native_input_excludes_cache = $match.input_excludes_cache
    output = $v.out; status = $v.status; provider = $v.provider
    account_sha256 = $v.providerAccount.sha256; session_sha256 = $v.session.sha256; native_session_sha256 = $v.native_session.sha256
    response_id_sha256 = $v.response_id.sha256
    tries_count = @($route.tries).Count; try_account_id_sha256 = @($route.tries | ForEach-Object { $_.id.sha256 })
    order_count = @($route.order).Count; order_account_id_sha256 = @($route.order | ForEach-Object { $_.id.sha256 })
    order_who_sha256 = @($route.order | ForEach-Object { $_.who.sha256 })
    try_status = @($route.tries | ForEach-Object { $_.status }); http_asks = @($route.tries | ForEach-Object { $_.net.asks })
    try_again_ms = @($route.tries | ForEach-Object { $_.again }); retried_ms = $v.retried_ms
    masking_ms = $v.masking_ms; route_masking_ms = $route.masking
    affinity = $route.affinity; pinned = $route.pinned
    prompt_tokens = $route.prompt.tokens; prompt_counted = $route.prompt.counted; prompt_turns = $route.prompt.turns
    prompt_parts = @($route.prompt.parts | ForEach-Object { [pscustomobject]@{kind=$_.kind;tokens=$_.tokens;item_count=@($_.items).Count} })
    archive_present = $null -ne $v.archive -or $null -ne $route.archive
  }
}
$models = @($rows | Group-Object model | ForEach-Object {
  $g=$_.Group
  [pscustomobject]@{model=$_.Name;count=$_.Count;sum_input_uncached=($g|Measure-Object input_uncached -Sum).Sum;sum_cache_read=($g|Measure-Object cache_read -Sum).Sum;sum_output=($g|Measure-Object output -Sum).Sum;cache_read_values=@($g.cache_read|Sort-Object -Unique);first_time=$g[0].time_beijing;last_time=$g[-1].time_beijing}
})
$report = [ordered]@{
  matched_calls=$rows.Count;all_native_matches_unique=$true
  all_native_input_excludes_cache=(@($rows | Where-Object {-not $_.native_input_excludes_cache}).Count -eq 0)
  account_sha256_values=@($rows.account_sha256 | Sort-Object -Unique)
  route_account_id_sha256_values=@($rows.try_account_id_sha256 | Sort-Object -Unique)
  session_sha256_values=@($rows.session_sha256 | Sort-Object -Unique)
  status_values=@($rows.status | Sort-Object -Unique)
  tries_count_values=@($rows.tries_count | Sort-Object -Unique)
  order_count_values=@($rows.order_count | Sort-Object -Unique)
  http_asks_values=@($rows.http_asks | Sort-Object -Unique)
  masking_ms_range=[ordered]@{min=($rows|Measure-Object masking_ms -Minimum).Minimum;max=($rows|Measure-Object masking_ms -Maximum).Maximum}
  archive_present_count=@($rows|Where-Object {$_.archive_present}).Count
  models=$models;calls=$rows
}
$report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutPath -Encoding utf8
$report.GetEnumerator() | Where-Object {$_.Key -ne 'calls'} | ForEach-Object { '{0}: {1}' -f $_.Key, ($_.Value|ConvertTo-Json -Depth 5 -Compress) }
