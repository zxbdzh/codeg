<#
  本地自用完整包构建（Windows）

  为什么必须走这个脚本：
  - Tauri 用 Cargo feature `custom-protocol` 区分生产/开发。缺这个 feature 时
    tauri-codegen 会嵌入空 assets，主窗口转而加载 tauri.conf.json 的
    devUrl（http://localhost:3000/workspace），表现为白屏 / ERR_CONNECTION_REFUSED。
  - `-j 1` 会把 rustc 的 jobserver 一起锁成单路 codegen，实测 25 分钟仍未完成；
    `-j 8` 约 13 分钟。只在这个阶段才值得降并发（内存吃紧用 -Jobs 4）。
#>
[CmdletBinding()]
param(
  # cargo 并行度；单 crate 前端阶段天然单线程，此值主要影响 codegen 并行
  [int]$Jobs = 8,
  # out/ 已是新产物时跳过 pnpm build
  [switch]$SkipFrontend,
  # 构建成功后备份并替换安装目录里的 codeg.exe
  [switch]$Replace,
  [string]$InstallDir = 'D:\software\codeg'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outIndex = Join-Path $root 'out\index.html'
$exe = Join-Path $root 'src-tauri\target\release\codeg.exe'

# 1. 前端静态导出：out/ 会被 Tauri 内嵌进 exe，不能省
if (-not $SkipFrontend) {
  Write-Host '[1/4] pnpm build'
  Push-Location $root
  pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build 失败，退出码 $LASTEXITCODE" }
  Pop-Location
}
if (-not (Test-Path $outIndex)) { throw "缺少 $outIndex，先不带 -SkipFrontend 跑一次" }

# 2. 编译 Rust：custom-protocol 决定嵌入真实 assets，漏掉就等于发了个 dev 包
Write-Host "[2/4] cargo build --release -j $Jobs --features tauri/custom-protocol"
$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -First 1
if ($kits) { $env:PATH = (Join-Path $kits.FullName 'x64') + ';' + $env:PATH }
$env:RUST_MIN_STACK = '134217728'
Push-Location (Join-Path $root 'src-tauri')
cargo build --release -j $Jobs --features tauri/custom-protocol
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "cargo build 失败，退出码 $code" }
if (-not (Test-Path $exe)) { throw "未生成 $exe" }

# 3. 校验前端产物确实内嵌（dev 产物则命中不到 chunk 路径）
Write-Host '[3/4] 校验内嵌 assets'
$html = Get-Content $outIndex -Raw
$needle = [regex]::Match($html, '/_next/static/chunks/[A-Za-z0-9._-]+\.(css|js)').Value
if (-not $needle) { throw '无法从 out/index.html 提取 chunk 路径' }
$rg = (Get-Command rg -ErrorAction SilentlyContinue).Source
if ($rg) {
  & $rg -a -q -F $needle $exe
  if ($LASTEXITCODE -ne 0) { throw "exe 未内嵌前端 assets（$needle 未命中），像是 dev 产物" }
  Write-Host "     命中 $needle"
} else {
  Write-Warning '未找到 rg，跳过内嵌校验'
}

# 4. 可选替换：Codeg 在跑时文件被占用，脚本会直接报错而不是静默失败
if ($Replace) {
  $dst = Join-Path $InstallDir 'codeg.exe'
  if (-not (Test-Path $dst)) { throw "找不到 $dst" }
  $bak = Join-Path $InstallDir ('codeg.exe.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Write-Host "[4/4] 备份到 $bak 并替换 $dst"
  Copy-Item $dst $bak -Force
  try { Copy-Item $exe $dst -Force } catch { throw "替换失败（Codeg 可能仍在运行）：$($_.Exception.Message)" }
  Write-Host "     已替换"
} else {
  Write-Host '[4/4] 跳过替换（加 -Replace 自动备份并替换）'
}

Write-Host "完成：$exe"
