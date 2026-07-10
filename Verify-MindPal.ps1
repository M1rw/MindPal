[CmdletBinding()]
param(
    [string]$ProjectRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
Push-Location $ProjectRoot
try {
    Write-Host '[1/7] Installing locked frontend dependencies...'
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

    Write-Host '[2/7] Building production frontend...'
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

    Write-Host '[3/7] Compiling Python modules...'
    python -m compileall -q backend api
    if ($LASTEXITCODE -ne 0) { throw 'Python compilation failed.' }

    Write-Host '[4/7] Running Python tests...'
    $env:PYTHONPATH = '.'
    python -m pytest -q
    if ($LASTEXITCODE -ne 0) { throw 'Python tests failed.' }

    Write-Host '[5/7] Running Node regression tests...'
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Node tests failed.' }

    Write-Host '[6/7] Running deterministic frontend audit...'
    npm run audit:frontend
    if ($LASTEXITCODE -ne 0) { throw 'Frontend audit failed.' }

    Write-Host '[7/7] Auditing production npm dependencies...'
    npm audit --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm audit reported a vulnerability.' }

    Write-Host 'MindPal release verification passed.' -ForegroundColor Green
}
finally {
    Pop-Location
}
