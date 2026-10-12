# 安装 icloudpd exe 到 server/vendor/icloudpd-1.32.3-windows-amd64.exe（P0 照片库同步必需）
#
# 背景：icloudpd 官方 Release 提供免 Python 的 Windows 单文件 exe；
#       与 ffmpeg 一致，二进制只放 vendor，代码 spawn 该路径（config.ts 默认 + ICLOUDPD_EXE 可覆盖）。
#       下载源 = 本仓库 GitHub Release（vendor-binaries asset），与 ffmpeg-full.zip 同模式。
#
# 用法：powershell -File scripts/install-icloudpd.ps1
#       也可由 npm postinstall 自动调用。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # server/
$vendor = Join-Path $root 'vendor'
$version = '1.32.3'
$exeName = "icloudpd-$version-windows-amd64.exe"
$exe = Join-Path $vendor $exeName

$existing = Get-Item $exe -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "icloudpd 已存在（跳过下载）：$($existing.FullName)（$([math]::Round($existing.Length / 1MB, 1)) MB）"
  exit 0
}

$url = $env:ICLOUDPD_URL
if (-not $url) {
  $url = "https://github.com/isChen0111/icloud-app/releases/download/vendor-binaries/$exeName"
}
if (-not (Test-Path $vendor)) { New-Item -ItemType Directory -Force -Path $vendor | Out-Null }

Write-Host '[1/1] 下载 icloudpd exe（约 14MB），curl 将显示下载进度…'
curl.exe --fail --location --show-error --progress-bar --max-time 600 --output $exe $url
$exit = $LASTEXITCODE
if ($exit -ne 0 -or -not (Test-Path $exe) -or (Get-Item $exe).Length -lt 1MB) {
  if (Test-Path $exe) { Remove-Item $exe -Force }
  throw "下载 icloudpd 失败（curl exit=$exit）。请手动下载 $url 放到 $exe，或设 ICLOUDPD_URL。"
}
Write-Host "完成：$exe（$([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB）"
