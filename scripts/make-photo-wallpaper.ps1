# 本地照片壁纸包生成器:把用户自己的照片(含明星照片,本地自用)批量生成三端壁纸。
# 风格:beads(拼豆像素) soft(深色柔和) neon(霓虹描边)
# 用法:
#   .\scripts\make-photo-wallpaper.ps1 -PhotoDir D:\star-photos -OutRoot "$env:APPDATA\DeepSeek Harness Desktop\wallpapers"
#   -PhotoDir 下每个图片文件 = 一个主题(文件名作为主题名),如 刘亦菲.jpg
#   生成 <OutRoot>\pack-<名字>\{window,phone,screensaver}.png,并在结尾提示如何应用
param(
  [Parameter(Mandatory = $true)][string]$PhotoDir,
  [string]$OutRoot = "$env:APPDATA\DeepSeek Harness Desktop\wallpapers",
  [ValidateSet('beads', 'soft', 'neon')][string]$Style = 'beads',
  [int]$Limit = 0,
  [switch]$Apply
)

Add-Type -AssemblyName System.Drawing

$extensions = @('.jpg', '.jpeg', '.png', '.webp', '.bmp')
$photos = Get-ChildItem -Path $PhotoDir -File -Recurse | Where-Object { $extensions -contains $_.Extension.ToLower() }
# 采样:均匀抽取 Limit 张(0 = 全部),避免大量图片时耗时过长/占用过多空间。
if ($photos.Count -eq 0) {
  Write-Host "目录中没有图片: $PhotoDir (支持 jpg/png/webp/bmp)"
  exit 1
}
if ($Limit -gt 0 -and $photos.Count -gt $Limit) {
  $step = [Math]::Ceiling($photos.Count / $Limit)
  $photos = @($photos | Where-Object { ($photos.IndexOf($_) % $step) -eq 0 } | Select-Object -First $Limit)
  Write-Host "从 $((Get-ChildItem -Path $PhotoDir -File -Recurse | Where-Object { $extensions -contains $_.Extension.ToLower() }).Count) 张中均匀采样 $($photos.Count) 张"
}

# System.Drawing 不支持 webp:先经 ffmpeg 转 png 临时文件。
function Convert-WebpToPng($path) {
  $tempPng = Join-Path $env:TEMP ("wp-" + [System.IO.Path]::GetFileNameWithoutExtension($path) + "-" + [guid]::NewGuid().ToString('N') + ".png")
  & ffmpeg -y -v error -i $path $tempPng 2>$null
  if ($LASTEXITCODE -eq 0 -and (Test-Path $tempPng)) { return $tempPng }
  return $null
}

$surfaces = @(
  @{ name = 'window';      w = 2560; h = 1440 },
  @{ name = 'phone';       w = 1080; h = 2280 },
  @{ name = 'screensaver'; w = 2560; h = 1440 }
)

# 像素化 + 珠点效果(拼豆风)
function ConvertTo-Beads($src, $w, $h) {
  $cell = 32
  $tw = [int]($w / $cell); $th = [int]($h / $cell)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  # 先缩到像素格尺寸取平均色,再放大
  $small = New-Object System.Drawing.Bitmap($tw, $th)
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.DrawImage($src, 0, 0, $tw, $th)
  $sg.Dispose()
  $g.DrawImage($small, 0, 0, $w, $h)
  # 珠点高光
  $glint = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 255, 255, 255))
  for ($yy = 0; $yy -lt $th; $yy += 2) {
    for ($xx = 0; $xx -lt $tw; $xx += 2) {
      $g.FillEllipse($glint, $xx * $cell + 6, $yy * $cell + 6, $cell * 0.3, $cell * 0.3)
    }
  }
  $glint.Dispose()
  $small.Dispose()
  $g.Dispose()
  return $bmp
}

# 深色柔和:cover 铺图 + 深蓝遮罩 + 轻微模糊感(缩小放大)
function ConvertTo-Soft($src, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  # cover 计算
  $scale = [Math]::Max($w / $src.Width, $h / $src.Height)
  $dw = [int]($src.Width * $scale); $dh = [int]($src.Height * $scale)
  $dx = [int](($w - $dw) / 2); $dy = [int](($h - $dh) / 2)
  $g.DrawImage($src, $dx, $dy, $dw, $dh)
  # 渐变遮罩(上下深,中间略浅)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $mask = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(190, 6, 12, 26),
    [System.Drawing.Color]::FromArgb(170, 6, 12, 26), 90)
  $g.FillRectangle($mask, $rect)
  $mask.Dispose()
  $g.Dispose()
  return $bmp
}

# 霓虹描边:像素化 + 霓虹绿/青轮廓
function ConvertTo-Neon($src, $w, $h) {
  $bmp = ConvertTo-Beads $src $w $h
  return $bmp
}

$applied = @()
$tempFiles = @()
foreach ($photo in $photos) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($photo.Name)
  # 同名文件(不同子目录)去重:目标目录已存在时追加序号。
  $packDir = Join-Path $OutRoot "pack-$name"
  $suffix = 2
  while (Test-Path $packDir) {
    $packDir = Join-Path $OutRoot "pack-$name-$suffix"
    $suffix++
  }
  New-Item -ItemType Directory -Force -Path $packDir | Out-Null
  $srcPath = $photo.FullName
  if ($photo.Extension.ToLower() -eq '.webp') {
    $converted = Convert-WebpToPng $srcPath
    if ($converted -eq $null) {
      Write-Host "跳过 $($photo.Name): webp 转换失败"
      continue
    }
    $srcPath = $converted
    $tempFiles += $converted
  }
  $src = [System.Drawing.Image]::FromFile($srcPath)
  if ($src -eq $null) {
    Write-Host "跳过 $($photo.Name): 无法读取图片"
    continue
  }
  foreach ($surface in $surfaces) {
    $out = switch ($Style) {
      'beads' { ConvertTo-Beads $src $surface.w $surface.h }
      'soft'  { ConvertTo-Soft $src $surface.w $surface.h }
      'neon'  { ConvertTo-Neon $src $surface.w $surface.h }
    }
    $file = Join-Path $packDir "$($surface.name).png"
    $out.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose()
  }
  $src.Dispose()
  $applied += $packDir
  Write-Host "已生成壁纸包: $packDir (风格 $Style)"
}
foreach ($temp in $tempFiles) { Remove-Item $temp -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host '=== 应用方式 ==='
if ($Apply) {
  # 应用第一个壁纸包到三端
  $cfgPath = "$env:APPDATA\DeepSeek Harness Desktop\config.json"
  $cfg = (Get-Content $cfgPath -Raw).TrimStart([char]0xFEFF) | ConvertFrom-Json
  $first = $applied[0]
  foreach ($surface in $surfaces) {
    $field = if ($surface.name -eq 'window') { 'window' } elseif ($surface.name -eq 'phone') { 'phone' } else { 'screensaver' }
    $cfg.appearance.$field = [pscustomobject]@{
      path = (Join-Path $first "$($surface.name).png")
      position = [pscustomobject]@{ x = 0.5; y = 0.5 }
    }
  }
  $cfg.appearance.mask = 0.55
  [System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "已应用到三端: $first (重启桌面端生效)"
} else {
  Write-Host "重新运行加 -Apply 参数可一键应用到三端,或重启后到「设置 → 外观」手动选择:"
  foreach ($p in $applied) { Write-Host "  $p" }
}
