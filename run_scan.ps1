$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$pythonPath = "python"
$outputDir = "output"
$endDate = Get-Date -Format "yyyy-MM-dd"
$maxUniverse = 40
$topN = 15

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

Write-Host "Starting scan..." -ForegroundColor Green
Write-Host "Date: $endDate"
Write-Host "Max universe: $maxUniverse"
Write-Host "Top N: $topN"
Write-Host ""

& $pythonPath "main.py" `
    --mode scan `
    --stocks auto `
    --end $endDate `
    --max-universe $maxUniverse `
    --top-n $topN `
    --max-price 120 `
    --prefer-lower-price `
    --output $outputDir `
    --notify
