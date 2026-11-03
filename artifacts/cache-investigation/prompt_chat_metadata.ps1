param([string]$AuditPath="$PSScriptRoot\audit-evidence.json",[string]$MetaPath="$PSScriptRoot\prompt-metadata-evidence.json",[string]$OutPath="$PSScriptRoot\prompt-chat-metadata.json")
$a=Get-Content -LiteralPath $AuditPath -Raw|ConvertFrom-Json
$m=Get-Content -LiteralPath $MetaPath -Raw|ConvertFrom-Json
$rows=@()
foreach($x in $m.calls){
  $q=@($a.routing_candidates|Where-Object {$_.record.id -eq $x.route_id})[0].record
  $tools=($q.prompt.parts|Where-Object {$_.kind -eq 'tools'}).tokens
  $chat=$q.prompt.parts|Where-Object {$_.kind -eq 'chat'}
  $items=@($chat.items)
  $tail=$items[-1]
  $previous=$items[-2]
  $err=$x.tools_rounding_error_bound
  $rows += [pscustomobject]@{
    route_id=$x.route_id;time_beijing=$x.time_beijing;model=$x.model
    native_users=$x.native_user_messages_so_far;prompt_turns=$x.prompt_turns;chat_item_count=$items.Count
    chat_item_n=@($items|ForEach-Object {[int]$_.n})
    tools_tokens=$tools
    chat_items=@($items|ForEach-Object {[pscustomobject]@{name_sha256=$_.name.sha256;tokens=$_.tokens;n=[int]$_.n;item_tools_ratio=[double]$_.tokens/$tools}})
    final_turn_tokens=$tail.tokens;final_turn_tools_ratio=[double]$tail.tokens/$tools
    final_turn_ratio_rounding_low=([double]$tail.tokens-.5)/($tools+$err)
    final_turn_ratio_rounding_high=([double]$tail.tokens+.5)/($tools-$err)
    preceding_turn_tokens=$previous.tokens;preceding_turn_tools_ratio=[double]$previous.tokens/$tools
  }
}
$phases=@($rows|Group-Object native_users|ForEach-Object {
  $g=$_.Group
  $lo=($g|Measure-Object final_turn_ratio_rounding_low -Maximum).Maximum
  $hi=($g|Measure-Object final_turn_ratio_rounding_high -Minimum).Minimum
  [pscustomobject]@{
    native_users=[int]$_.Name;calls=$g.Count;prompt_turns=@($g.prompt_turns|Sort-Object -Unique)
    first_time=$g[0].time_beijing;last_time=$g[-1].time_beijing
    final_turn_ratio_min=($g|Measure-Object final_turn_tools_ratio -Minimum).Minimum
    final_turn_ratio_max=($g|Measure-Object final_turn_tools_ratio -Maximum).Maximum
    final_turn_common_interval=@($lo,$hi);constant_final_turn_estimate_ratio_feasible=($lo -le $hi)
    preceding_turn_ratio_first=$g[0].preceding_turn_tools_ratio;preceding_turn_ratio_last=$g[-1].preceding_turn_tools_ratio
    preceding_turn_tokens_first=$g[0].preceding_turn_tokens;preceding_turn_tokens_last=$g[-1].preceding_turn_tokens
  }
})
[ordered]@{phases=$phases;calls=$rows;limits=@('Chat item names are parser turn ordinals; their SHA-256 values do not hash actual message content.','One extra final parsed user turn with an approximately stable size is consistent with a rebuilt trailing capsule; no wire roles or input arrays were recovered.','A stable token estimate cannot exclude text replacement with equal estimated length.')}|ConvertTo-Json -Depth 20|Set-Content -LiteralPath $OutPath -Encoding utf8
$phases|ConvertTo-Json -Depth 6 -Compress
