Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile("C:\Users\servi\AppData\Local\Temp\pi-clipboard-5aeb27b8-4945-466f-99f0-c73905a7404e.png")
$w = $bmp.Width; $h = $bmp.Height
Write-Output "尺寸: ${w}x${h}"
$samples = 0; $white = 0; $dark = 0; $colored = 0
$step = 40
for ($x = 0; $x -lt $w; $x += $step) {
  for ($y = 0; $y -lt $h; $y += $step) {
    $c = $bmp.GetPixel($x, $y); $samples++
    $lum = 0.299*$c.R + 0.587*$c.G + 0.114*$c.B
    if ($lum -gt 240) { $white++ } elseif ($lum -lt 40) { $dark++ }
    $maxc = [Math]::Max($c.R, [Math]::Max($c.G, $c.B)); $minc = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
    if (($maxc - $minc) -gt 30) { $colored++ }
  }
}
Write-Output ("采样: {0}  白色: {1:P1}  深色: {2:P1}  彩色: {3:P1}" -f $samples, ($white/$samples), ($dark/$samples), ($colored/$samples))
$bmp.Dispose()
