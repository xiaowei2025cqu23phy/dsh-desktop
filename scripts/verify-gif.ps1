# 验证 GIF 内容:抽取首帧统计色块种类,判断是否空白
Add-Type -AssemblyName System.Drawing
foreach ($g in @('demo-main', 'demo-remote', 'demo-screensaver')) {
  $frame = ".playwright-mcp\verify-$g.png"
  & ffmpeg -y -v error -i ".playwright-mcp\$g.gif" -vf "select=eq(n\,0)" -frames:v 1 $frame 2>$null
  $bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $frame))
  $colors = @{}
  for ($y = 0; $y -lt $bmp.Height; $y += 40) {
    for ($x = 0; $x -lt $bmp.Width; $x += 40) {
      $c = $bmp.GetPixel($x, $y)
      $key = "$([math]::Floor($c.R/64)),$([math]::Floor($c.G/64)),$([math]::Floor($c.B/64))"
      if ($colors.ContainsKey($key)) { $colors[$key]++ } else { $colors[$key] = 1 }
    }
  }
  $w = $bmp.Width; $h = $bmp.Height
  $bmp.Dispose()
  $distinct = $colors.Count
  $status = if ($distinct -gt 3) { 'OK' } else { 'BLANK?' }
  Write-Host "$g : ${w}x${h}, 色块 $distinct -> $status"
}
