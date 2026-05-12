$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$pythonPath = "python"
$outputDir = "output"
$endDate = Get-Date -Format "yyyy-MM-dd"
$watchMode = "auto"
$maxUniverse = 40
$topN = 10
$watchTop = 5
$intervalSeconds = 20
$repeatCount = 999999

if (-not $env:FUGLE_API_KEY -or [string]::IsNullOrWhiteSpace($env:FUGLE_API_KEY)) {
    Write-Host "FUGLE_API_KEY is not set." -ForegroundColor Yellow
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

Write-Host "Starting event monitor..." -ForegroundColor Green
Write-Host "Date: $endDate"
Write-Host "Watch mode: $watchMode"
Write-Host "Interval seconds: $intervalSeconds"
Write-Host ""

& $pythonPath "main.py" `
    --mode event-monitor `
    --stocks $watchMode `
    --end $endDate `
    --max-universe $maxUniverse `
    --top-n $topN `
    --watch-top $watchTop `
    --max-price 120 `
    --prefer-lower-price `
    --include-news `
    --interval-seconds $intervalSeconds `
    --repeat-count $repeatCount `
    --event-rise-threshold 0.035 `
    --event-drop-threshold -0.025 `
    --event-volume-multiplier 1.8 `
    --event-cooldown-seconds 600 `
    --output $outputDir `
    --notify
