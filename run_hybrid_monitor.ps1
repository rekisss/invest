$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$pythonPath = "python"
$outputDir = "output"
$endDate = Get-Date -Format "yyyy-MM-dd"
$watchFile = "watchlist.csv"
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
Write-Host "Watch file: $watchFile"
Write-Host "Watch symbols: $watchTop"
Write-Host ""

& $pythonPath "main.py" `
    --mode hybrid-monitor `
    --stocks $watchFile `
    --end $endDate `
    --watch-top $watchTop `
    --output $outputDir `
    --notify
