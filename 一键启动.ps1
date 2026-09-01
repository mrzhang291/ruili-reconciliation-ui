$ErrorActionPreference = 'Stop'

try {
    Set-Location -LiteralPath $PSScriptRoot

    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'Install Node.js 22.13 or newer, then try again.'
    }

    & $node.Source (Join-Path $PSScriptRoot 'scripts\start-all.mjs') @args
    if ($LASTEXITCODE -ne 0) {
        throw "Startup failed. Logs: $PSScriptRoot\.runtime\logs"
    }
}
catch {
    Write-Host "`n[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    if (-not $env:BILLCOMPARE_NO_PAUSE) {
        Read-Host 'Press Enter to close'
    }
    exit 1
}

exit 0
