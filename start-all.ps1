<#
  创星云 AI 数字员工 · 一键启动（方案 B）
  ==========================================
  龙虾（OpenClaw 网关，18789）的登录自启已关闭，重启机器 / 重登后网关不会自己起来，
  微信通道自然也就用不了。需要时双击 start-all.cmd（或运行本脚本）即可按正确顺序拉起：

      1) 网关（18789）      —— 微信消息进出的唯一通道
      2) 平台（Next.js 3000）—— 网页端 + 定时任务 + 微信通道自愈
      3) 微信通道自愈        —— 重新加载通道、重连微信、重建路由（解决「暂无法连接 OpenClaw」）

  用法：
      start-all.cmd              启动（已在跑的会自动跳过，可反复执行）
      start-all.cmd -Status      只看状态，不做任何改动
      start-all.cmd -Restart     先停掉再重启（需要相应权限）
      start-all.cmd -NoSelfHeal  只拉起服务，不做微信自愈

  退出码：0 全部就绪 / 1 有服务没起来
#>
[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Restart,
  [switch]$NoSelfHeal
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ProjectDir = $PSScriptRoot
if (-not $ProjectDir) { $ProjectDir = (Get-Location).Path }

$GatewayPort  = 18789
$PlatformPort = 3000
$LogDir       = Join-Path $ProjectDir 'logs'
$GatewayCmd   = Join-Path $env:USERPROFILE '.openclaw\gateway.cmd'
$NextBin      = Join-Path $ProjectDir 'node_modules\next\dist\bin\next'

function Say([string]$Text, [string]$Color = 'Gray') {
  # 空行用单个空格，避免 [Console]::WriteLine 在输出被重定向时不换行导致两行黏在一起
  if ([string]::IsNullOrEmpty($Text)) { Write-Host ' ' }
  else { Write-Host $Text -ForegroundColor $Color }
}
function Ok([string]$Text)   { Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Skip([string]$Text) { Write-Host "  [SKIP] $Text" -ForegroundColor DarkGray }
function Warn([string]$Text) { Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "  [FAIL] $Text" -ForegroundColor Red }

<#
  PowerShell 5.1 的 Start-Process 在「环境变量里同时存在 HTTP_PROXY 和 http_proxy」时会抛
  “字典中的关键字 HTTP_PROXY 所添加的关键字 http_proxy”（它内部用大小写不敏感的字典建子进程环境）。
  清理掉重复的小写项即可；网关与 Next 都走系统代理，不依赖这两个变量。
#>
function Normalize-ProxyEnv {
  foreach ($name in @('http_proxy', 'https_proxy', 'no_proxy', 'all_proxy')) {
    $upper = $name.ToUpperInvariant()
    if ((Test-Path "Env:\$name") -and (Test-Path "Env:\$upper")) {
      Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
    }
  }
}

function Get-ListeningPid([int]$Port) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) { return ($conn | Select-Object -First 1).OwningProcess }
  return $null
}

function Test-Listening([int]$Port) {
  if (Get-ListeningPid $Port) { return $true }
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(600)) { $client.Close(); return $false }
    $client.EndConnect($iar); $client.Close(); return $true
  } catch { return $false }
}

function Wait-Port([int]$Port, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Listening $Port) { return $true }
    Start-Sleep -Milliseconds 800
  }
  return (Test-Listening $Port)
}

# 端口在监听 ≠ 网关已经能用：它初始化完才接受 WS 连接。
# 用一次 WebSocket 握手做就绪探测（401/403 也算就绪——说明 WS 服务已在应答）。
function Test-GatewayWs([int]$Port) {
  if (-not (Test-Listening $Port)) { return $false }
  $ws = $null
  try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $task = $ws.ConnectAsync([Uri]"ws://127.0.0.1:$Port", [System.Threading.CancellationToken]::None)
    if (-not $task.Wait(4000)) { try { $ws.Abort() } catch { }; return $false }
    $state = $ws.State
    try { $ws.Dispose() } catch { }
    return ($state -eq [System.Net.WebSockets.WebSocketState]::Open)
  } catch {
    $msg = "$($_.Exception.Message) $($_.Exception.InnerException.Message)"
    if ($msg -match '401|403|Unauthorized|Forbidden|handshake') { return $true }
    return $false
  } finally {
    if ($ws) { try { $ws.Dispose() } catch { } }
  }
}

function Wait-GatewayWs([int]$Port, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-GatewayWs $Port) { return $true }
    Start-Sleep -Milliseconds 1500
  }
  return (Test-GatewayWs $Port)
}

function Wait-Http([int]$Port, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 4 -MaximumRedirection 0 -ErrorAction Stop
      if ($r.StatusCode -ge 200) { return $true }
    } catch {
      # 302/401/404 也算活着：Next 已经在响应
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { return $true }
    }
    Start-Sleep -Milliseconds 1500
  }
  return $false
}

function Get-EnvToken {
  foreach ($file in @('.env.local', '.env')) {
    $path = Join-Path $ProjectDir $file
    if (-not (Test-Path $path)) { continue }
    $content = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    foreach ($key in @('SCHEDULE_API_TOKEN', 'CONTENT_INGEST_TOKEN')) {
      $m = [regex]::Match($content, "(?m)^\s*$key\s*=\s*`"?([^`"\r\n]+)`"?")
      if ($m.Success) { return $m.Groups[1].Value.Trim() }
    }
  }
  return $null
}

function Get-NodeExe {
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    (Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions\22.22.2-6\node.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# ---------------------------------------------------------------- 状态
function Show-Status {
  Say ''
  Say '========== 当前状态 ==========' 'Cyan'
  $gp = Get-ListeningPid $GatewayPort
  if ($gp) { Ok "网关 18789 运行中（PID $gp）" } else { Warn '网关 18789 未运行 —— 微信收发消息全靠它' }
  $pp = Get-ListeningPid $PlatformPort
  if ($pp) { Ok "平台 3000 运行中（PID $pp）" } else { Warn "平台 $PlatformPort 未运行" }
  Say ''
}

# ---------------------------------------------------------------- 启动：网关
function Start-Gateway {
  if (Test-Listening $GatewayPort) {
    $p = Get-ListeningPid $GatewayPort
    Skip "网关已在运行（PID $p）"
    return $true
  }
  if (-not (Test-Path $GatewayCmd)) {
    Fail "找不到网关启动脚本：$GatewayCmd"
    Warn '可手动启动：D:\OpenClaw\openclaw.cmd gateway start'
    return $false
  }
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

  Say "  正在启动网关（18789）..." 'Gray'
  $started = Get-Date
  # 允许脚本“主动”启动网关：gateway.cmd 里用这个变量绕过“登录自启已停用”的守卫。
  $env:OPENCLAW_AUTOSTART_BYPASS = '1'
  $env:NODE_OPTIONS = ''
  Normalize-ProxyEnv
  $out = Join-Path $LogDir 'gateway.out.log'
  $err = Join-Path $LogDir 'gateway.err.log'
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$GatewayCmd`"" `
      -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop | Out-Null
  } catch {
    Fail "启动失败：$($_.Exception.Message)"
    return $false
  }
  Remove-Item Env:\OPENCLAW_AUTOSTART_BYPASS -ErrorAction SilentlyContinue

  # 网关启动很慢：要过数据库就绪、12 个 agent 装配等阶段（实测光 database-readiness 就 12s+），
  # 所以给到 180 秒，别过早判失败。
  if (Wait-Port $GatewayPort 180) {
    Ok "网关端口已监听（18789，等待约 $([int]((Get-Date) - $started).TotalSeconds)s）"
    # 再等 WS 就绪，避免「端口开了但网关还没初始化完」就去自愈
    if (-not (Wait-GatewayWs $GatewayPort 90)) {
      Warn '端口已监听但 WebSocket 还没就绪，网关可能仍在初始化（首次启动会更慢）'
      Warn '稍等一会儿再跑一次 start-all.cmd 即可；平台自愈也会在启动后自动重试'
    } else {
      Ok "网关已就绪（WebSocket 可连接，总耗时约 $([int]((Get-Date) - $started).TotalSeconds)s）"
    }
    return $true
  }
  Fail "网关 180 秒内没有监听 18789（大概率启动失败，不是慢）。日志尾部："
  if (Test-Path $err) { Get-Content $err -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Say "      $_" 'DarkGray' } }
  Warn "完整日志：$out / $err"
  return $false
}

# ---------------------------------------------------------------- 启动：平台
function Start-Platform {
  if (Test-Listening $PlatformPort) {
    $p = Get-ListeningPid $PlatformPort
    Skip "平台已在运行（PID $p）"
    return $true
  }
  if (-not (Test-Path $NextBin)) {
    Fail "找不到 Next.js：$NextBin"
    Warn "先在 $ProjectDir 执行 npm install"
    return $false
  }
  $node = Get-NodeExe
  if (-not $node) { Fail '找不到 node.exe'; return $false }

  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  Say "  正在启动平台（$PlatformPort）..." 'Gray'
  $env:NODE_OPTIONS = ''
  $env:NODE_ENV = 'development'
  Normalize-ProxyEnv
  $out = Join-Path $LogDir 'next-dev.out.log'
  $err = Join-Path $LogDir 'next-dev.err.log'
  try {
    Start-Process -FilePath $node -ArgumentList "`"$NextBin`"", 'dev' -WorkingDirectory $ProjectDir `
      -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop | Out-Null
  } catch {
    Fail "启动失败：$($_.Exception.Message)"
    return $false
  }
  $started = Get-Date
  if (Wait-Http $PlatformPort 150) {
    Ok "平台已就绪（http://localhost:$PlatformPort，等待约 $([int]((Get-Date) - $started).TotalSeconds)s）"
    return $true
  }
  Fail "平台 150 秒内没有响应，请查看日志：$out / $err"
  return $false
}

# ---------------------------------------------------------------- 微信通道自愈
function Invoke-SelfHeal {
  $token = Get-EnvToken
  if (-not $token) {
    Warn '没读到平台 Agent 令牌（SCHEDULE_API_TOKEN），跳过微信自愈'
    return
  }
  $url = "http://127.0.0.1:$PlatformPort/api/wechat/self-heal"
  for ($i = 1; $i -le 3; $i++) {
    try {
      # 必须自己按 UTF-8 解码：PS 5.1 的 Invoke-RestMethod 在没有 charset 头时不按 UTF-8 解，中文会变乱码。
      $raw = Invoke-WebRequest -Uri $url -Method Post -TimeoutSec 180 -UseBasicParsing `
        -Headers @{ Authorization = "Bearer $token" } -ErrorAction Stop
      $text = [System.Text.Encoding]::UTF8.GetString($raw.RawContentStream.ToArray())
      $res = $text | ConvertFrom-Json
      if (-not $res.ok) { throw ($res.error) }
      $d = $res.data
      $restored = @($d.restored)
      $failed = @($d.failed)
      Ok "微信通道自愈完成：扫描 $($d.scanned) 条绑定，恢复 $($restored.Count) 个通道"
      if ($restored.Count) { Say ("         已恢复：" + ($restored -join ', ')) 'DarkGray' }
      if ($failed.Count) {
        foreach ($f in $failed) {
          $who = if ($f.botId) { $f.botId } else { '(无 bot 身份)' }
          Warn "需人工处理：$who —— $($f.reason)"
        }
      }
      Say ("         路由映射 $($d.routing.mappings) 条 / 涉及用户 $($d.routing.users) 个") 'DarkGray'
      return
    } catch {
      if ($i -lt 3) {
        Warn "自愈第 $i 次失败（$($_.Exception.Message)），10 秒后重试..."
        Start-Sleep -Seconds 10
      } else {
        Fail "微信自愈失败：$($_.Exception.Message)"
        Warn "网关刚起时通道可能还没连上，稍后重跑一次 start-all.cmd 即可"
      }
    }
  }
}

# ---------------------------------------------------------------- 停止
function Stop-Service-Port([int]$Port, [string]$Name) {
  $procId = Get-ListeningPid $Port
  if (-not $procId) { Skip "$Name 未在运行"; return }
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Ok "已停止 $Name（PID $procId）"
  } catch {
    Fail "停止 $Name 失败（可能是管理员权限启动的进程）：$($_.Exception.Message)"
  }
}

# ================================================================ main
Say ''
Say '=====================================================' 'Cyan'
Say '   创星云 AI 数字员工 · 一键启动' 'Cyan'
Say '=====================================================' 'Cyan'

if ($Status) { Show-Status; exit 0 }

if ($Restart) {
  Say ''
  Say '[0/3] 停止现有进程' 'White'
  Stop-Service-Port $PlatformPort '平台'
  Stop-Service-Port $GatewayPort '网关'
  Start-Sleep -Seconds 2
}

Say ''
Say '[1/3] 龙虾网关（18789）' 'White'
$gwOk = Start-Gateway

Say ''
Say '[2/3] 平台服务（3000）' 'White'
$webOk = Start-Platform

$healOk = $true
if ($NoSelfHeal) {
  Say ''
  Skip '已指定 -NoSelfHeal，跳过微信通道自愈'
} elseif ($webOk) {
  Say ''
  Say '[3/3] 微信通道自愈（重连微信 + 重建路由）' 'White'
  Invoke-SelfHeal
  $healOk = $true
}

Show-Status

Say '  日志目录：' 'DarkGray'
Say "    $LogDir" 'DarkGray'
Say ''
if ($gwOk -and $webOk) {
  Say '一切就绪。微信里给机器人发条消息试试。' 'Green'
  Say '如果微信仍显示「暂无法连接 OpenClaw」，把微信里的 ClawBot 退出再进一次（客户端缓存），' 'Gray'
  Say '或者稍等一分钟再跑一次 start-all.cmd。' 'Gray'
  exit 0
} else {
  Say '有服务没起来，请按上面的 [FAIL] 提示处理，或把日志发给小腾。' 'Yellow'
  exit 1
}
