<#
.SYNOPSIS
  拉取并初始化 OpenMontage 第三方 Python 工程（视频剪辑/二创引擎）。
.DESCRIPTION
  - 从 GitHub codeload CDN 下载 zip（绕开此环境对 github.com 直连 git 的限制）
  - 解压到仓库根目录的 OpenMontage/
  - 创建 .venv 并安装 requirements.txt
  - 复制 .env.example -> .env
  该目录不纳入主仓库（见 .gitignore 的 /OpenMontage/），故本脚本用于在新机器/新 clone 上重建。
.PARAMETER OwnerRepo
  GitHub 仓库，默认 bondnd/openmontage
.PARAMETER Branch
  分支，默认 main
#>
param(
  [string]$OwnerRepo = "bondnd/openmontage",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$target = Join-Path $root "OpenMontage"
$codeload = "https://codeload.github.com/$OwnerRepo/zip/refs/heads/$Branch"

# 1) 已存在则跳过下载（幂等）
if (Test-Path (Join-Path $target "tools")) {
  Write-Host "[skip] OpenMontage/tools 已存在，跳过下载。"
} else {
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  $tmp = Join-Path $env:TEMP ("om_" + [guid]::NewGuid().ToString("N"))
  $zip = Join-Path $env:TEMP "openmontage.zip"
  Write-Host "[1/4] 下载 $codeload ..."
  Invoke-WebRequest -Uri $codeload -OutFile $zip -TimeoutSec 120
  Write-Host "[2/4] 解压 ..."
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-Item -Path $inner.FullName -Destination $target -Force
  Remove-Item $zip -Force
  Remove-Item $tmp -Recurse -Force
  Write-Host "      已解压到 $target"
}

# 3) 虚拟环境 + 依赖
$venvPy = Join-Path $target ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Write-Host "[3/4] 创建 venv 并安装依赖（可能需几分钟）..."
  & python -m venv (Join-Path $target ".venv")
  & $venvPy -m pip install --upgrade pip | Out-Null
  & $venvPy -m pip install -r (Join-Path $target "requirements.txt")
} else {
  Write-Host "[skip] venv 已存在，跳过安装。"
}

# 4) .env
if (-not (Test-Path (Join-Path $target ".env"))) {
  Copy-Item (Join-Path $target ".env.example") (Join-Path $target ".env")
  Write-Host "[4/4] 已复制 .env.example -> .env"
}

Write-Host ""
Write-Host "完成。请确保 .env.local 已配置："
Write-Host "  OPENMONTAGE_DIR=""$((Get-Item $target).FullName -replace '\\','/')"""
Write-Host "  OPENMONTAGE_PYTHON=""$((Get-Item $venvPy).FullName -replace '\\','/')"""
Write-Host "并本机已安装 ffmpeg/ffprobe 且在 PATH 中（OpenMontage 需要中文字体 C:/Windows/Fonts/msyh.ttc）。"
