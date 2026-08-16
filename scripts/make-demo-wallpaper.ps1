# 生成"鲸鱼海洋"演示壁纸:深海渐变 + 月光 + 鲸鱼剪影 + 气泡 + 星点
param(
  [string]$OutPath = "$env:APPDATA\DeepSeek Harness Desktop\wallpapers\demo-whale.png",
  [int]$W = 2560,
  [int]$H = 1440
)

Add-Type -AssemblyName System.Drawing

$dir = Split-Path $OutPath
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 深海垂直渐变:顶部深蓝 → 底部深青
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(8, 18, 46),
  [System.Drawing.Color]::FromArgb(14, 58, 74),
  90)
$g.FillRectangle($bgBrush, $rect)

# 星点(上半区)
$rand = New-Object System.Random(42)
for ($i = 0; $i -lt 220; $i++) {
  $x = $rand.Next(0, $W)
  $y = $rand.Next(0, [int]($H * 0.55))
  $a = $rand.Next(40, 130)
  $r = $rand.Next(1, 3)
  $star = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, 200, 220, 255))
  $g.FillEllipse($star, $x, $y, $r, $r)
  $star.Dispose()
}

# 月光:右上光晕(同心半透明圆)+ 月盘
$moonX = [int]($W * 0.72); $moonY = [int]($H * 0.2)
$moonR = [int]($H * 0.09)
$glowR = [int]($moonR * 2.6)
$haloSteps = @(
  @{ r = 1.0; a = 34 },
  @{ r = 0.8; a = 42 },
  @{ r = 0.6; a = 55 },
  @{ r = 0.42; a = 75 }
)
foreach ($step in $haloSteps) {
  $r = [int]($glowR * $step.r)
  $halo = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($step.a, 210, 230, 255))
  $g.FillEllipse($halo, $moonX - $r, $moonY - $r, $r * 2, $r * 2)
  $halo.Dispose()
}
$moonBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 240))
$g.FillEllipse($moonBrush, $moonX - $moonR, $moonY - $moonR, $moonR * 2, $moonR * 2)

# 月光光柱(月亮下方淡光)
$pillar = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 210, 230, 255))
$g.FillRectangle($pillar, $moonX - [int]($moonR * 0.5), $moonY + $moonR, [int]$moonR, [int]($H * 0.5))

# 鲸鱼剪影(中下部,深色)
$whaleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 4, 10, 20))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$s = [Math]::Min($W, $H) / 100.0   # 缩放基准

# 鲸鱼身体:头部圆 → 背拱 → 尾部收窄(贝塞尔)
$headX = $W * 0.36; $headY = $H * 0.62
$bodyLen = $W * 0.42; $bodyH = $H * 0.16
$tailX = $headX + $bodyLen

# 身体上轮廓
$path.StartFigure()
$path.AddBezier($headX, $headY, $headX + $bodyLen * 0.12, $headY - $bodyH * 0.9,
                $headX + $bodyLen * 0.45, $headY - $bodyH * 0.55, $tailX - $bodyLen * 0.12, $headY - $bodyH * 0.05)
# 尾柄
$path.AddBezier($tailX - $bodyLen * 0.12, $headY - $bodyH * 0.05, $tailX - $bodyLen * 0.06, $headY - $bodyH * 0.1,
                $tailX - $bodyLen * 0.02, $headY - $bodyH * 0.08, $tailX, $headY - $bodyH * 0.02)
# 尾鳍上叶
$path.AddBezier($tailX, $headY - $bodyH * 0.02, $tailX + $bodyLen * 0.14, $headY - $bodyH * 0.3,
                $tailX + $bodyLen * 0.16, $headY - $bodyH * 0.05, $tailX + $bodyLen * 0.09, $headY - $bodyH * 0.0)
# 尾鳍下叶
$path.AddBezier($tailX + $bodyLen * 0.09, $headY, $tailX + $bodyLen * 0.17, $headY + $bodyH * 0.16,
                $tailX + $bodyLen * 0.12, $headY + $bodyH * 0.24, $tailX, $headY + $bodyH * 0.06)
# 身体下轮廓(腹部)
$path.AddBezier($tailX, $headY + $bodyH * 0.06, $headX + $bodyLen * 0.5, $headY + $bodyH * 0.62,
                $headX + $bodyLen * 0.18, $headY + $bodyH * 0.5, $headX + $bodyLen * 0.04, $headY + $bodyH * 0.18)
$path.CloseFigure()
$g.FillPath($whaleBrush, $path)

# 鲸鱼眼睛(小白点)
$eyeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 200, 230, 255))
$eyeR = [Math]::Max(2, [int]($bodyH * 0.045))
$g.FillEllipse($eyeBrush, [int]($headX + $bodyLen * 0.13), [int]($headY - $bodyH * 0.18), $eyeR * 2, $eyeR * 2)

# 腹鳍
$finPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$finPath.StartFigure()
$finPath.AddBezier($headX + $bodyLen * 0.2, $headY + $bodyH * 0.28, $headX + $bodyLen * 0.26, $headY + $bodyH * 0.5,
                   $headX + $bodyLen * 0.22, $headY + $bodyH * 0.55, $headX + $bodyLen * 0.17, $headY + $bodyH * 0.38)
$finPath.CloseFigure()
$g.FillPath($whaleBrush, $finPath)

# 气泡
for ($i = 0; $i -lt 26; $i++) {
  $bx = $rand.Next(0, $W)
  $by = $rand.Next([int]($H * 0.45), $H)
  $br = $rand.Next(3, [int]($bodyH * 0.12))
  $alpha = $rand.Next(30, 90)
  $bubble = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($alpha, 200, 230, 245), [Math]::Max(1, $br / 5))
  $g.DrawEllipse($bubble, $bx, $by, $br * 2, $br * 2)
  $bubble.Dispose()
}

# 底部海床微光
$sea = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60, 8, 30, 44))
$g.FillRectangle($sea, 0, [int]($H * 0.94), $W, [int]($H * 0.06))

$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "演示壁纸已生成: $OutPath ($W x $H)"
