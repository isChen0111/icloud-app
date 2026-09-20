# 安装带 libheif 的 ffmpeg full 版（HEIC 解码必需）
#
# 背景：npm 的 ffmpeg-static 是精简构建，不含 HEIF 解码器；
#       sharp 官方预编译也不含 libde265（iPhone HEIC 是 HEVC 编码）。
#       因此必须用 BtbN 的 full 构建替换（含 libheif，可解 HEIC）。
#
# 重装依赖（npm install）后 ffmpeg-static 会被还原成精简版，
# 需要重新执行本脚本。
#
# 用法：powershell -File scripts\install-ffmpeg-full.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # server/
$vendor = Join-Path $root 'vendor'
$zip = Join-Path $vendor 'ffmpeg-full.zip'
$unzipDir = Join-Path $vendor 'ffmpeg-full'

Write-Host '[1/3] 下载 ffmpeg full 版（约 170MB，含 libheif）…'
# 下载地址：优先用环境变量 FFMPEG_FULL_URL，否则默认从项目自己的 GitHub Release 拉。
# 项目 Release 里放一份锁定版本的 ffmpeg-full.zip，避免 BtbN 滚动更新导致版本漂移。
$zipUrl = $env:FFMPEG_FULL_URL
if (-not $zipUrl) {
  $zipUrl = 'https://github.com/isChen0111/icloud-app/releases/download/vendor-binaries/ffmpeg-full.zip'
}
if (-not (Test-Path $zip)) {
  curl.exe -s -L -m 600 -o $zip $zipUrl
  $exit = $LASTEXITCODE
  # curl 失败（网络/404/超时）或文件太小（错误页 <1MB）都算失败
  if ($exit -ne 0 -or -not (Test-Path $zip) -or (Get-Item $zip).Length -lt 1MB) {
    if (Test-Path $zip) { Remove-Item $zip -Force }
    throw "下载 ffmpeg-full.zip 失败（curl exit=$exit）。请手动下载 $zipUrl 放到 $zip，或设 FFMPEG_FULL_URL 环境变量。"
  }
}

Write-Host '[2/3] 解压…'
if (-not (Test-Path $unzipDir)) {
  Expand-Archive -Force -Path $zip -DestinationPath $unzipDir
}

Write-Host '[3/3] 替换 node_modules/ffmpeg-static 下的二进制…'
$binDir = Get-ChildItem $unzipDir -Recurse -Directory | Where-Object { $_.Name -eq 'bin' } | Select-Object -First 1
if (-not $binDir) { throw '未在 zip 中找到 bin 目录' }
$dst = Join-Path $root 'node_modules\ffmpeg-static'
Copy-Item (Join-Path $binDir.FullName 'ffmpeg.exe') (Join-Path $dst 'ffmpeg.exe') -Force
Copy-Item (Join-Path $binDir.FullName 'ffprobe.exe') (Join-Path $dst 'ffprobe.exe') -Force

Write-Host "完成：$(Get-Item (Join-Path $dst 'ffmpeg.exe') | Select-Object -ExpandProperty Length) 字节"
