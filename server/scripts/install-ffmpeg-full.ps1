# 安装带 libheif 的 ffmpeg full 版到 server/vendor/ffmpeg-full（HEIC 解码必需）
#
# 背景：sharp 官方预编译不含 HEVC 解码器；必须用 BtbN full 构建（含 libheif）。
# 二进制只放 vendor，代码 spawn 该路径，不再覆盖 node_modules。
#
# 用法：powershell -File scripts/install-ffmpeg-full.ps1
# 也可由 npm postinstall 自动调用。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # server/
$vendor = Join-Path $root 'vendor'
$zip = Join-Path $vendor 'ffmpeg-full.zip'
$unzipDir = Join-Path $vendor 'ffmpeg-full'

function Find-FfmpegTools {
  if (-not (Test-Path $unzipDir)) { return $null }
  foreach ($ffmpeg in Get-ChildItem $unzipDir -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue) {
    $ffprobe = Join-Path $ffmpeg.DirectoryName 'ffprobe.exe'
    if (Test-Path $ffprobe -PathType Leaf) {
      return [pscustomobject]@{
        FfmpegPath = $ffmpeg.FullName
        FfprobePath = $ffprobe
      }
    }
  }
  return $null
}

$existing = Find-FfmpegTools
if ($existing) {
  Write-Host "FFmpeg 和 FFprobe 已存在（跳过下载）：$($existing.FfmpegPath)"
  exit 0
}

$zipUrl = $env:FFMPEG_FULL_URL
if (-not $zipUrl) {
  $zipUrl = 'https://github.com/isChen0111/icloud-app/releases/download/vendor-binaries/ffmpeg-full.zip'
}
if (-not (Test-Path $vendor)) { New-Item -ItemType Directory -Force -Path $vendor | Out-Null }

if (Test-Path $zip) {
  Write-Host "[1/2] 使用已有压缩包：$zip"
} else {
  Write-Host '[1/2] 下载 ffmpeg full 版（约 170MB，含 libheif），curl 将显示下载进度…'
  curl.exe --fail --location --show-error --progress-bar --max-time 600 --output $zip $zipUrl
  $exit = $LASTEXITCODE
  if ($exit -ne 0 -or -not (Test-Path $zip) -or (Get-Item $zip).Length -lt 1MB) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    throw "下载 ffmpeg-full.zip 失败（curl exit=$exit）。请手动下载 $zipUrl 放到 $zip，或设 FFMPEG_FULL_URL。"
  }
  Write-Host "[1/2] 下载完成：$([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB"
}

Write-Host '[2/2] 解压到 server/vendor/ffmpeg-full …'
if (Test-Path $unzipDir) { Remove-Item $unzipDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $unzipDir | Out-Null
Expand-Archive -Force -Path $zip -DestinationPath $unzipDir

$tools = Find-FfmpegTools
if (-not $tools) { throw '解压后未找到同目录的 ffmpeg.exe 和 ffprobe.exe' }
Write-Host "完成：$($tools.FfmpegPath)（$((Get-Item $tools.FfmpegPath).Length) 字节）"
