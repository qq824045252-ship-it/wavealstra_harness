# 分析 PNG 截图的像素分布（判断空白/内容/布局）
Add-Type -AssemblyName System.Drawing
param([string]$Path = "C:\Users\servi\Documents\GitHub\wavealstra_harness\main-window-probe.png")

$bmp = [System.Drawing.Bitmap]::FromFile($Path)
$w = $bmp.Width; $h = $bmp.Height
Write-Output "尺寸: ${w}x${h}"

# 采样网格（每 40px 采一个点）统计颜色分布
$samples = 0; $white = 0; $dark = 0; $colored = 0
$colors = @{}
$step = 40
for ($x = 0; $x -lt $w; $x += $step) {
  for ($y = 0; $y -lt $h; $y += $step) {
    $c = $bmp.GetPixel($x, $y)
    $samples++
    $lum = 0.299*$c.R + 0.587*$c.G + 0.114*$c.B
    if ($lum -gt 240) { $white++ }
    elseif ($lum -lt 40) { $dark++ }
    $maxc = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
    $minc = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
    if (($maxc - $minc) -gt 30) { $colored++ }
    $key = "$([Math]::Floor($c.R/64))$([Math]::Floor($c.G/64))$([Math]::Floor($c.B/64))"
    if ($colors.ContainsKey($key)) { $colors[$key]++ } else { $colors[$key] = 1 }
  }
}
Write-Output "采样点: $samples"
Write-Output ("白色(>240): {0:P1}  深色(<40): {1:P1}  彩色: {2:P1}" -f ($white/$samples), ($dark/$samples), ($colored/$samples))
Write-Output "主要色簇:"
$colors.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 6 | ForEach-Object { "  rgb($(($_.Key[0]-as[int])*64),$(($_.Key[1]-as[int])*64),$(($_.Key[2]-as[int])*64)): $($_.Value) 点" }
$bmp.Dispose()
