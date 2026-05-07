$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

# Edit these values if you want different defaults.
$pythonPath = "python"
$outputDir = "output"
$endDate = Get-Date -Format "yyyy-MM-dd"
$maxUniverse = 120
$topN = 15
$watchTop = 10
$intervalSeconds = 120
$repeatCount = 999

if (-not $env:FINMIND_TOKEN -or [string]::IsNullOrWhiteSpace($env:FINMIND_TOKEN)) {
    Write-Host "FINMIND_TOKEN is not set." -ForegroundColor Yellow
    Write-Host "Set it first in this window, for example:" -ForegroundColor Yellow
    Write-Host '$env:FINMIND_TOKEN="your_finmind_token"' -ForegroundColor Cyan
    exit 1
}

if (Test-Path ".vendor") {
    if ([string]::IsNullOrWhiteSpace($env:PYTHONPATH)) {
        $env:PYTHONPATH = Join-Path $projectRoot ".vendor"
    }
    else {
        $env:PYTHONPATH = (Join-Path $projectRoot ".vendor") + ";" + $env:PYTHONPATH
    }
}

Write-Host "Starting Sponsor monitor..." -ForegroundColor Green
Write-Host "Date: $endDate"
Write-Host "Watch symbols: $watchTop"
Write-Host "Interval seconds: $intervalSeconds"
Write-Host ""

& $pythonPath "main.py" `
    --mode sponsor-monitor `
    --stocks auto `
    --end $endDate `
    --max-universe $maxUniverse `
    --top-n $topN `
    --watch-top $watchTop `
    --interval-seconds $intervalSeconds `
    --repeat-count $repeatCount `
    --output $outputDir `
    --notify
