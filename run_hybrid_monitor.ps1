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

if (-not $env:FUGLE_API_KEY -or [string]::IsNullOrWhiteSpace($env:FUGLE_API_KEY)) {
    Write-Host "FUGLE_API_KEY is not set." -ForegroundColor Yellow
    Write-Host "Set it first in this window, for example:" -ForegroundColor Yellow
    Write-Host '$env:FUGLE_API_KEY="your_fugle_api_key"' -ForegroundColor Cyan
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

Write-Host "Starting hybrid monitor..." -ForegroundColor Green
Write-Host "Date: $endDate"
Write-Host "Watch mode: $watchMode"
Write-Host "Max universe: $maxUniverse"
Write-Host "Top N: $topN"
Write-Host "Watch symbols: $watchTop"
Write-Host ""

& $pythonPath "main.py" `
    --mode hybrid-monitor `
    --stocks $watchMode `
    --end $endDate `
    --max-universe $maxUniverse `
    --top-n $topN `
    --watch-top $watchTop `
    --max-price 120 `
    --prefer-lower-price `
    --output $outputDir `
    --notify
