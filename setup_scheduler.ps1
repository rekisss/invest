#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── 確認 FUGLE_API_KEY 已設定 ────────────────────────────────────────────────
if (-not $env:FUGLE_API_KEY -or [string]::IsNullOrWhiteSpace($env:FUGLE_API_KEY)) {
    Write-Host "錯誤：請先在此 PowerShell 視窗設定 FUGLE_API_KEY，再執行本腳本。" -ForegroundColor Red
    Write-Host '  $env:FUGLE_API_KEY = "your_key_here"' -ForegroundColor Cyan
    exit 1
}

# ── 路徑 ─────────────────────────────────────────────────────────────────────
$pwsh      = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $pwsh) { $pwsh = "powershell.exe" }   # fallback to Windows PowerShell

$scanScript         = Join-Path $projectRoot "run_scan.ps1"
$eventScript        = Join-Path $projectRoot "run_event_monitor.ps1"
$dailyReportScript  = Join-Path $projectRoot "run_daily_report.ps1"

# ── 共用：傳遞 FUGLE_API_KEY 的 wrapper ──────────────────────────────────────
# Windows 工作排程器不繼承使用者的環境變數，所以用內嵌指令設定後再呼叫腳本
function Make-Action($scriptPath) {
    $cmd = @"
-NoProfile -WindowStyle Hidden -Command "& { `$env:FUGLE_API_KEY='$($env:FUGLE_API_KEY)'; & '$scriptPath' }"
"@
    return New-ScheduledTaskAction -Execute $pwsh -Argument $cmd
}

# ── 工作排程器任務定義 ────────────────────────────────────────────────────────
$tasks = @(
    @{
        Name    = "TW_Stock_盤前掃描"
        Action  = Make-Action $scanScript
        Trigger = New-ScheduledTaskTrigger -Weekly `
                    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
                    -At "08:45"
        Desc    = "每個交易日 08:45 執行盤前選股掃描，結果推送至 Discord"
    },
    @{
        Name    = "TW_Stock_盤中事件監控"
        Action  = Make-Action $eventScript
        Trigger = New-ScheduledTaskTrigger -Weekly `
                    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
                    -At "09:00"
        Desc    = "每個交易日 09:00 啟動盤中事件監控（每分鐘輪詢，共 270 次至 13:30）"
    },
    @{
        Name    = "TW_Stock_盤後總結"
        Action  = Make-Action $dailyReportScript
        Trigger = New-ScheduledTaskTrigger -Weekly `
                    -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday `
                    -At "14:15"
        Desc    = "每個交易日 14:15 執行盤後總結，推送收盤摘要至 Discord"
    }
)

# ── 設定排程 ─────────────────────────────────────────────────────────────────
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

foreach ($task in $tasks) {
    $existing = Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $task.Name -Confirm:$false
        Write-Host "已更新：$($task.Name)" -ForegroundColor Yellow
    } else {
        Write-Host "已建立：$($task.Name)" -ForegroundColor Green
    }

    Register-ScheduledTask `
        -TaskName   $task.Name `
        -Action     $task.Action `
        -Trigger    $task.Trigger `
        -Settings   $settings `
        -Principal  $principal `
        -Description $task.Desc | Out-Null
}

Write-Host ""
Write-Host "三段式盯盤排程設定完成！" -ForegroundColor Cyan
Write-Host "  08:45  盤前掃描    → $scanScript"
Write-Host "  09:00  盤中監控    → $eventScript"
Write-Host "  14:15  盤後總結    → $dailyReportScript"
Write-Host ""
Write-Host "注意：每次重開機後需要重新設定 FUGLE_API_KEY 再執行本腳本，" -ForegroundColor Yellow
Write-Host "      或直接在系統環境變數設定以免每次重設。" -ForegroundColor Yellow
Write-Host ""
Write-Host "查看排程任務：" -ForegroundColor Gray
Write-Host "  Get-ScheduledTask | Where-Object { `$_.TaskName -like 'TW_Stock_*' } | Format-Table" -ForegroundColor Gray
