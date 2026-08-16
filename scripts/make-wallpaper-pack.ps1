# 生成鲸鱼系列壁纸包:5 主题 x 3 端(主窗口 16:9 / 手机 9:19 / 屏保 16:9)
# 主题:deep(深海剪影) beads(拼豆像素) starry(星空) geo(极简几何) cyber(赛博网格)
# 用法:.\scripts\make-wallpaper-pack.ps1 [-OutDir <dir>]
param(
  [string]$OutDir = "$PSScriptRoot\..\assets\wallpapers"
)

Add-Type -AssemblyName System.Drawing

$surfaces = @(
  @{ name = 'window';      w = 2560; h = 1440 },
  @{ name = 'phone';       w = 1080; h = 2280 },
  @{ name = 'screensaver'; w = 2560; h = 1440 }
)
$themes = @('deep', 'beads', 'starry', 'geo', 'cyber')

function New-GradientBrush($w, $h, $top, $bottom) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  return New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bottom, 90)
}

function New-WhalePath($w, $h) {
  # 鲸鱼剪影路径(相对尺寸,适配任意宽高)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $headX = $w * 0.36; $headY = $h * 0.62
  $bodyLen = $w * 0.42; $bodyH = $h * 0.16
  $tailX = $headX + $bodyLen
  $path.StartFigure()
  $path.AddBezier($headX, $headY, $headX + $bodyLen * 0.12, $headY - $bodyH * 0.9,
                  $headX + $bodyLen * 0.45, $headY - $bodyH * 0.55, $tailX - $bodyLen * 0.12, $headY - $bodyH * 0.05)
  $path.AddBezier($tailX - $bodyLen * 0.12, $headY - $bodyH * 0.05, $tailX - $bodyLen * 0.06, $headY - $bodyH * 0.1,
                  $tailX - $bodyLen * 0.02, $headY - $bodyH * 0.08, $tailX, $headY - $bodyH * 0.02)
  $path.AddBezier($tailX, $headY - $bodyH * 0.02, $tailX + $bodyLen * 0.14, $headY - $bodyH * 0.3,
                  $tailX + $bodyLen * 0.16, $headY - $bodyH * 0.05, $tailX + $bodyLen * 0.09, $headY)
  $path.AddBezier($tailX + $bodyLen * 0.09, $headY, $tailX + $bodyLen * 0.17, $headY + $bodyH * 0.16,
                  $tailX + $bodyLen * 0.12, $headY + $bodyH * 0.24, $tailX, $headY + $bodyH * 0.06)
  $path.AddBezier($tailX, $headY + $bodyH * 0.06, $headX + $bodyLen * 0.5, $headY + $bodyH * 0.62,
                  $headX + $bodyLen * 0.18, $headY + $bodyH * 0.5, $headX + $bodyLen * 0.04, $headY + $bodyH * 0.18)
  $path.CloseFigure()
  return $path
}

function Add-Stars($g, $w, $h, $rand, $count, $maxYRatio) {
  for ($i = 0; $i -lt $count; $i++) {
    $x = $rand.Next(0, $w); $y = $rand.Next(0, [int]($h * $maxYRatio))
    $a = $rand.Next(40, 140); $r = $rand.Next(1, 3)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, 200, 220, 255))
    $g.FillEllipse($brush, $x, $y, $r, $r)
    $brush.Dispose()
  }
}

function Add-Whale($g, $w, $h, $color) {
  $brush = New-Object System.Drawing.SolidBrush($color)
  $path = New-WhalePath $w $h
  $g.FillPath($brush, $path)
  # 眼睛
  $eye = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 200, 230, 255))
  $bodyH = $h * 0.16
  $eyeR = [Math]::Max(2, [int]($bodyH * 0.045))
  $g.FillEllipse($eye, [int]($w * 0.36 + $w * 0.42 * 0.13), [int]($h * 0.62 - $bodyH * 0.18), $eyeR * 2, $eyeR * 2)
  $eye.Dispose()
  # 腹鳍
  $finPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $finPath.StartFigure()
  $finPath.AddBezier($w * 0.36 + $w * 0.42 * 0.2, $h * 0.62 + $bodyH * 0.28,
                     $w * 0.36 + $w * 0.42 * 0.26, $h * 0.62 + $bodyH * 0.5,
                     $w * 0.36 + $w * 0.42 * 0.22, $h * 0.62 + $bodyH * 0.55,
                     $w * 0.36 + $w * 0.42 * 0.17, $h * 0.62 + $bodyH * 0.38)
  $finPath.CloseFigure()
  $g.FillPath($brush, $finPath)
  $brush.Dispose()
}

function Add-Moon($g, $w, $h, $moonColor) {
  $moonX = [int]($w * 0.72); $moonY = [int]($h * 0.2)
  $moonR = [int]($h * 0.09)
  $glowR = [int]($moonR * 2.6)
  $haloSteps = @(@{ r = 1.0; a = 30 }, @{ r = 0.7; a = 42 }, @{ r = 0.45; a = 60 })
  foreach ($step in $haloSteps) {
    $r = [int]($glowR * $step.r)
    $halo = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($step.a, 210, 230, 255))
    $g.FillEllipse($halo, $moonX - $r, $moonY - $r, $r * 2, $r * 2)
    $halo.Dispose()
  }
  $moon = New-Object System.Drawing.SolidBrush($moonColor)
  $g.FillEllipse($moon, $moonX - $moonR, $moonY - $moonR, $moonR * 2, $moonR * 2)
  $moon.Dispose()
}

function New-Rendered($theme, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rand = New-Object System.Random(42)
  switch ($theme) {
    'deep' {
      # 深海剪影:深蓝渐变 + 月光 + 鲸鱼 + 气泡
      $g.FillRectangle((New-GradientBrush $w $h ([System.Drawing.Color]::FromArgb(8, 18, 46)) ([System.Drawing.Color]::FromArgb(14, 58, 74))), (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
      Add-Stars $g $w $h $rand 200 0.55
      Add-Moon $g $w $h ([System.Drawing.Color]::FromArgb(235, 255, 255, 240))
      Add-Whale $g $w $h ([System.Drawing.Color]::FromArgb(235, 4, 10, 20))
      # 气泡
      for ($i = 0; $i -lt 26; $i++) {
        $bx = $rand.Next(0, $w); $by = $rand.Next([int]($h * 0.45), $h)
        $br = $rand.Next(3, [int]($h * 0.02))
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($rand.Next(30, 90), 200, 230, 245), [Math]::Max(1, $br / 5))
        $g.DrawEllipse($pen, $bx, $by, $br * 2, $br * 2)
        $pen.Dispose()
      }
    }
    'beads' {
      # 拼豆像素:小图绘制后放大成马赛克,叠加珠点高光
      $tw = [int]($w / 28); $th = [int]($h / 28)
      $small = New-Object System.Drawing.Bitmap($tw, $th)
      $sg = [System.Drawing.Graphics]::FromImage($small)
      $sg.FillRectangle((New-GradientBrush $tw $th ([System.Drawing.Color]::FromArgb(10, 24, 56)) ([System.Drawing.Color]::FromArgb(18, 64, 82))), (New-Object System.Drawing.Rectangle(0, 0, $tw, $th)))
      $srand = New-Object System.Random(7)
      Add-Stars $sg $tw $th $srand 30 0.55
      Add-Moon $sg $tw $th ([System.Drawing.Color]::FromArgb(235, 255, 255, 240))
      Add-Whale $sg $tw $th ([System.Drawing.Color]::FromArgb(235, 6, 12, 24))
      $sg.Dispose()
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
      $g.DrawImage($small, 0, 0, $w, $h)
      # 珠点高光(每个像素块左上小亮点)
      $bx = $w / $tw; $by = $h / $th
      $glint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 255, 255, 255))
      for ($yy = 0; $yy -lt $th; $yy += 2) {
        for ($xx = 0; $xx -lt $tw; $xx += 2) {
          $g.FillEllipse($glint, $xx * $bx + $bx * 0.18, $yy * $by + $by * 0.18, $bx * 0.3, $by * 0.3)
        }
      }
      $glint.Dispose()
      $small.Dispose()
    }
    'starry' {
      # 星空:深紫蓝渐变 + 密集星点 + 银河 + 鲸鱼剪影
      $g.FillRectangle((New-GradientBrush $w $h ([System.Drawing.Color]::FromArgb(12, 8, 42)) ([System.Drawing.Color]::FromArgb(24, 14, 62))), (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
      Add-Stars $g $w $h $rand 500 0.85
      # 银河带
      $galaxy = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, 150, 170, 255))
      $gx = $w * 0.2; $gy = $h * 0.15
      $g.FillEllipse($galaxy, [int]$gx, [int]$gy, [int]($w * 0.6), [int]($h * 0.05))
      $g.FillEllipse($galaxy, [int]($gx + $w * 0.1), [int]($gy + $h * 0.06), [int]($w * 0.5), [int]($h * 0.04))
      $galaxy.Dispose()
      Add-Moon $g $w $h ([System.Drawing.Color]::FromArgb(235, 255, 240, 210))
      Add-Whale $g $w $h ([System.Drawing.Color]::FromArgb(240, 2, 4, 12))
    }
    'geo' {
      # 极简几何:青蓝渐变 + 半透明几何图形 + 细鲸鱼线条
      $g.FillRectangle((New-GradientBrush $w $h ([System.Drawing.Color]::FromArgb(16, 42, 66)) ([System.Drawing.Color]::FromArgb(10, 70, 90))), (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
      # 几何圆环
      $ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(50, 120, 220, 255), [Math]::Max(2, $h / 400))
      $g.DrawEllipse($ringPen, [int]($w * 0.08), [int]($h * 0.12), [int]($w * 0.3), [int]($w * 0.3))
      $g.DrawEllipse($ringPen, [int]($w * 0.62), [int]($h * 0.55), [int]($w * 0.26), [int]($w * 0.26))
      $ringPen.Dispose()
      # 三角
      $triBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, 57, 197, 207))
      $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
      $tri.AddPolygon(@(
        (New-Object System.Drawing.PointF(($w * 0.84), ($h * 0.18))),
        (New-Object System.Drawing.PointF(($w * 0.96), ($h * 0.3))),
        (New-Object System.Drawing.PointF(($w * 0.74), ($h * 0.3)))))
      $g.FillPath($triBrush, $tri)
      $triBrush.Dispose()
      # 细线鲸鱼(轮廓)
      $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 190, 230, 255), [Math]::Max(2, $h / 300))
      $path = New-WhalePath $w $h
      $g.DrawPath($linePen, $path)
      $linePen.Dispose()
    }
    'cyber' {
      # 赛博网格:深底 + 发光网格 + 霓虹鲸鱼
      $g.FillRectangle((New-GradientBrush $w $h ([System.Drawing.Color]::FromArgb(6, 8, 20)) ([System.Drawing.Color]::FromArgb(12, 6, 34))), (New-Object System.Drawing.Rectangle(0, 0, $w, $h)))
      # 网格线
      $gridPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(26, 0, 200, 255), 1)
      $step = [int]($h / 24)
      for ($x = 0; $x -le $w; $x += $step) { $g.DrawLine($gridPen, $x, 0, $x, $h) }
      for ($y = 0; $y -le $h; $y += $step) { $g.DrawLine($gridPen, 0, $y, $w, $y) }
      $gridPen.Dispose()
      # 霓虹鲸鱼(发光描边)
      $glowPen1 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(90, 0, 240, 255), [Math]::Max(6, $h / 120))
      $glowPen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 0, 200, 255), [Math]::Max(3, $h / 240))
      $path = New-WhalePath $w $h
      $g.DrawPath($glowPen1, $path)
      $g.DrawPath($glowPen2, $path)
      $glowPen1.Dispose(); $glowPen2.Dispose()
      # 霓虹圆点
      for ($i = 0; $i -lt 40; $i++) {
        $x = $rand.Next(0, $w); $y = $rand.Next(0, $h)
        $r = $rand.Next(2, 6)
        $dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($rand.Next(60, 160), 0, 220, 255))
        $g.FillEllipse($dot, $x, $y, $r, $r)
        $dot.Dispose()
      }
    }
  }
  $g.Dispose()
  return $bmp
}

# 生成
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$manifest = @()
foreach ($theme in $themes) {
  $themeDir = Join-Path $OutDir $theme
  New-Item -ItemType Directory -Force -Path $themeDir | Out-Null
  $entry = @{ id = $theme; name = $theme }
  foreach ($surface in $surfaces) {
    $bmp = New-Rendered $theme $surface.w $surface.h
    $file = Join-Path $themeDir "$($surface.name).png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "生成 $theme/$($surface.name) ($($surface.w)x$($surface.h))"
  }
}
Write-Host '壁纸包生成完成'
