# 验证壁纸:统计色块与尺寸,确认主题差异
Add-Type -AssemblyName System.Drawing
$themes = @('deep', 'beads', 'starry', 'geo', 'cyber')
foreach ($theme in $themes) {
  $file = "assets\wallpapers\$theme\window.png"
  $bmp = [System.Drawing.Bitmap]::FromFile((Resolve-Path $file))
  $colors = @{}
  for ($y = 0; $y -lt $bmp.Height; $y += 24) {
    for ($x = 0; $x -lt $bmp.Width; $x += 24) {
      $c = $bmp.GetPixel($x, $y)
      $key = "$([math]::Floor($c.R/32)),$([math]::Floor($c.G/32)),$([math]::Floor($c.B/32))"
      if ($colors.ContainsKey($key)) { $colors[$key]++ } else { $colors[$key] = 1 }
    }
  }
  $top = ($colors.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1)
  Write-Host "$theme : $($bmp.Width)x$($bmp.Height), 色块 $($colors.Count), 主色 ($($top.Key))"
  $bmp.Dispose()
}
