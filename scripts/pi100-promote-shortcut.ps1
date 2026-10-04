param([Parameter(Mandatory=$true)][ValidatePattern('^build-\d+$')][string]$BuildId)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$base=Join-Path $root 'artifacts\pi100-upgrade'
$build=Get-Content (Join-Path $base "$BuildId\build.json") -Raw | ConvertFrom-Json
$audit=Get-Content (Join-Path $base 'integrity-results.json') -Raw | ConvertFrom-Json
if($build.status -ne 'passed' -or $audit.status -ne 'passed' -or $audit.buildId -ne $BuildId){throw 'Matching passing build and integrity audit are required'}
$actual=(Get-FileHash -LiteralPath $build.cleanAsar -Algorithm SHA256).Hash.ToLowerInvariant()
if($actual -ne $build.asarSha256 -or $actual -ne $audit.asarSha256){throw 'Packaged bytes changed after acceptance'}
$desktop=[Environment]::GetFolderPath('Desktop')
$links=@(Get-ChildItem -LiteralPath $desktop -Filter '*MyBuddy*.lnk')
if($links.Count -ne 1){throw 'Expected one existing MyBuddy shortcut; refusing an ambiguous update'}
$ws=New-Object -ComObject WScript.Shell
$link=$ws.CreateShortcut($links[0].FullName)
$expected=Join-Path $env:LOCALAPPDATA 'Programs\MyBuddy\portable\release-pi-minimal-mode-20261001145538853\MyBuddy.exe'
if($link.TargetPath -ne $expected -and $link.TargetPath -ne $build.cleanExecutable){throw 'Shortcut changed since inspection; not overwriting another update'}
$before=@{path=$links[0].FullName;target=$link.TargetPath;arguments=$link.Arguments;workingDirectory=$link.WorkingDirectory}
$backup=Join-Path $base ('shortcut-before-'+(Get-Date -Format 'yyyyMMddHHmmssfff')+'.lnk')
Copy-Item -LiteralPath $links[0].FullName -Destination $backup
$link.TargetPath=$build.cleanExecutable
$link.WorkingDirectory=Split-Path -Parent $build.cleanExecutable
$link.IconLocation=$build.cleanExecutable+',0'
$link.Description='MyBuddy - Pi 1.0.0 (verified portable build)'
$link.Save()
$check=$ws.CreateShortcut($links[0].FullName)
if($check.TargetPath -ne $build.cleanExecutable){throw 'Shortcut did not retain the new target'}
$result=@{status='passed';at=(Get-Date).ToUniversalTime().ToString('o');buildId=$BuildId;asarSha256=$actual;before=$before;after=@{path=$links[0].FullName;target=$check.TargetPath;workingDirectory=$check.WorkingDirectory};backup=$backup;oldReleasePreserved=$true;runningApplicationsStopped=$false}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $base 'promotion-results.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5
