$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

$pythonPath = "python"
$outputDir = "output"
$endDate = Get-Date -Format "yyyy-MM-dd"
$maxUniverse = 40
$topN = 15
$watchTop = 5

if (-not $env:FUGLE_API_KEY -or [string]::IsNullOrWhiteSpace($env:FUGLE_API_KEY)) {
    Write-Host "FUGLE_API_KEY is not set." -ForegroundColor Red
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

Write-Host "盤後總結啟動" -ForegroundColor Green
Write-Host "日期: $endDate"
Write-Host ""

& $pythonPath "main.py" `
    --mode daily-report `
    --stocks auto `
    --end $endDate `
    --max-universe $maxUniverse `
    --top-n $topN `
    --watch-top $watchTop `
    --max-price 120 `
    --prefer-lower-price `
    --include-news `
    --output $outputDir `
    --notify
