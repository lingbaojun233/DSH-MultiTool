# draw.ps1 -- render one explanation frame with GDI+ (no browser needed).
#
# Why GDI+ instead of a headless browser: Edge/Chromium refuses to run under the
# service accounts used for scheduled tasks (exits in ~40ms as SYSTEM, hangs under a
# fresh local user). System.Drawing has no such restriction and starts in ~80ms.
#
# Input: a JSON spec (UTF-8) written by the Node side.
# Output: one PNG per "step" (shapes with step <= i), so a scene can reveal content progressively.
#
# ASCII only: PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as ANSI, so any non-ASCII
# byte in this file would be mojibake. All Chinese text comes from the JSON file.
param(
  [Parameter(Mandatory = $true)][string]$SpecFile,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Width = 1920,
  [int]$Height = 1080
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function ToColor([string]$hex, [int]$alpha = 255) {
  if (-not $hex) { $hex = '#e8eefc' }
  $h = $hex.TrimStart('#')
  if ($h.Length -eq 3) { $h = '' + $h[0] + $h[0] + $h[1] + $h[1] + $h[2] + $h[2] }
  $r = [Convert]::ToInt32($h.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($h.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($h.Substring(4, 2), 16)
  return [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b)
}

function New-Font([double]$size, [string]$style = 'Regular') {
  $styleEnum = [System.Drawing.FontStyle]::Regular
  if ($style -eq 'Bold') { $styleEnum = [System.Drawing.FontStyle]::Bold }
  # Microsoft YaHei: the one CJK font guaranteed on this box.
  try { return New-Object System.Drawing.Font('Microsoft YaHei', $size, $styleEnum, [System.Drawing.GraphicsUnit]::Pixel) }
  catch { return New-Object System.Drawing.Font('Segoe UI', $size, $styleEnum, [System.Drawing.GraphicsUnit]::Pixel) }
}

function Draw-Arrow($g, $pen, [double]$x1, [double]$y1, [double]$x2, [double]$y2, [double]$size) {
  $angle = [Math]::Atan2($y2 - $y1, $x2 - $x1)
  $a1 = $angle - [Math]::PI / 7
  $a2 = $angle + [Math]::PI / 7
  $p1 = New-Object System.Drawing.PointF ([float]($x2 - $size * [Math]::Cos($a1))), ([float]($y2 - $size * [Math]::Sin($a1)))
  $p2 = New-Object System.Drawing.PointF ([float]($x2 - $size * [Math]::Cos($a2))), ([float]($y2 - $size * [Math]::Sin($a2)))
  $g.DrawLine($pen, $p1, $p2)
  $g.DrawLine($pen, $x2, $y2, $p2.X, $p2.Y)
  $g.DrawLine($pen, $x2, $y2, $p1.X, $p1.Y)
}

function Draw-Formula($g, $shape, $font, $brush) {
  # Formula: each run may be normal/sup/sub; measure then advance x.
  $x = [double]$shape.x
  $y = [double]$shape.y
  $size = [double]$shape.size
  foreach ($run in $shape.runs) {
    $t = [string]$run.t
    $f = $font
    $dy = 0
    if ($run.sup) { $f = New-Font ($size * 0.68); $dy = -$size * 0.42 }
    elseif ($run.sub) { $f = New-Font ($size * 0.68); $dy = $size * 0.22 }
    $m = $g.MeasureString($t, $f)
    $g.DrawString($t, $f, $brush, [float]$x, [float]($y + $dy))
    $x += $m.Width - 2
  }
}

$spec = Get-Content -Path $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$shapes = @($spec.shapes)
$maxStep = 1
foreach ($s in $shapes) { if ($s.step -and [int]$s.step -gt $maxStep) { $maxStep = [int]$s.step } }
if ($spec.steps) { $maxStep = [int]@($spec.steps).Count }

for ($step = 1; $step -le $maxStep; $step++) {
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  # Background: vertical gradient, matching the text-card look
  $bg1 = ToColor ($spec.bg1) 255
  $bg2 = ToColor ($spec.bg2) 255
  $rect = New-Object System.Drawing.Rectangle 0, 0, $Width, $Height
  $pTop = New-Object System.Drawing.Point 0, 0
  $pBottom = New-Object System.Drawing.Point 0, $Height
  $brushBg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($pTop, $pBottom, $bg1, $bg2)
  $g.FillRectangle($brushBg, $rect)
  $brushBg.Dispose()

  # Title
  if ($spec.title) {
    $tf = New-Font 40 'Bold'
    $tb = New-Object System.Drawing.SolidBrush((ToColor $spec.titleColor 255))
    $g.DrawString([string]$spec.title, $tf, $tb, [float]60, [float]40)
    $tb.Dispose(); $tf.Dispose()
  }

  foreach ($s in $shapes) {
    $need = 1
    if ($s.step) { $need = [int]$s.step }
    if ($need -gt $step) { continue }

    switch ($s.type) {
      'line' {
        $pen = New-Object System.Drawing.Pen((ToColor $s.color), [float]$s.width)
        if ($s.dash) { $pen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash }
        $g.DrawLine($pen, [float]$s.x1, [float]$s.y1, [float]$s.x2, [float]$s.y2)
        if ($s.arrow) { Draw-Arrow $g $pen ([double]$s.x1) ([double]$s.y1) ([double]$s.x2) ([double]$s.y2) 18 }
        $pen.Dispose()
      }
      'polyline' {
        $pen = New-Object System.Drawing.Pen((ToColor $s.color), [float]$s.width)
        $pts = @()
        foreach ($p in $s.points) { $pts += New-Object System.Drawing.PointF([float]$p[0], [float]$p[1]) }
        if ($pts.Count -ge 2) { $g.DrawLines($pen, [System.Drawing.PointF[]]$pts) }
        $pen.Dispose()
      }
      'rect' {
        $b = New-Object System.Drawing.SolidBrush((ToColor $s.fill 200))
        $g.FillRectangle($b, [float]$s.x, [float]$s.y, [float]$s.w, [float]$s.h)
        $b.Dispose()
        if ($s.stroke) {
          $p = New-Object System.Drawing.Pen((ToColor $s.stroke), [float]($s.width))
          $g.DrawRectangle($p, [float]$s.x, [float]$s.y, [float]$s.w, [float]$s.h)
          $p.Dispose()
        }
      }
      'circle' {
        $d = [double]$s.r * 2
        $b = New-Object System.Drawing.SolidBrush((ToColor $s.fill))
        $g.FillEllipse($b, [float]([double]$s.cx - $s.r), [float]([double]$s.cy - $s.r), [float]$d, [float]$d)
        $b.Dispose()
        if ($s.stroke) {
          $p = New-Object System.Drawing.Pen((ToColor $s.stroke), [float]$s.width)
          $g.DrawEllipse($p, [float]([double]$s.cx - $s.r), [float]([double]$s.cy - $s.r), [float]$d, [float]$d)
          $p.Dispose()
        }
      }
      'text' {
        $f = New-Font ([double]$s.size) $(if ($s.bold) { 'Bold' } else { 'Regular' })
        $b = New-Object System.Drawing.SolidBrush((ToColor $s.color 255))
        $m = $g.MeasureString([string]$s.text, $f)
        $x = [double]$s.x
        if ($s.align -eq 'center') { $x = $x - $m.Width / 2 }
        elseif ($s.align -eq 'right') { $x = $x - $m.Width }
        $g.DrawString([string]$s.text, $f, $b, [float]$x, [float]$s.y)
        $b.Dispose(); $f.Dispose()
      }
      'formula' {
        $f = New-Font ([double]$s.size) 'Regular'
        $b = New-Object System.Drawing.SolidBrush((ToColor $s.color 255))
        Draw-Formula $g $s $f $b
        $b.Dispose(); $f.Dispose()
      }
    }
  }

  $file = Join-Path $OutDir ("gdi-{0}-{1}.png" -f $spec.index, $step)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Output $file
}
