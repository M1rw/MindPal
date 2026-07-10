[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRoot
)

$ErrorActionPreference = 'Stop'
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetRoot = (Resolve-Path -LiteralPath $TargetRoot).Path
$required = @('requirements.txt', 'requirements.lock', 'package.json', 'vercel.json')
foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $TargetRoot $name) -PathType Leaf)) {
        throw "Missing required project file: $name"
    }
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path (Split-Path -Parent $TargetRoot) "MindPal_backups\vercel-python-$timestamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$managed = @('package.json', 'package-lock.json', 'vercel.json')

try {
    foreach ($name in $managed) {
        $target = Join-Path $TargetRoot $name
        if (Test-Path -LiteralPath $target) {
            Copy-Item -LiteralPath $target -Destination (Join-Path $backupRoot $name) -Force
        }
        Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination $target -Force
    }

    $lockText = Get-Content -LiteralPath (Join-Path $TargetRoot 'requirements.lock') -Raw
    if ($lockText -notmatch '(?m)^fastapi==') {
        throw 'requirements.lock does not contain a pinned FastAPI dependency.'
    }

    Push-Location $TargetRoot
    try {
        & npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Production-mode npm installation failed.' }
        if (-not (Test-Path -LiteralPath (Join-Path $TargetRoot 'node_modules\.bin\tailwindcss.cmd'))) {
            throw 'Tailwind CLI was not installed as a regular dependency.'
        }
        if (-not (Test-Path -LiteralPath (Join-Path $TargetRoot 'node_modules\.bin\esbuild.cmd'))) {
            throw 'esbuild was not installed as a regular dependency.'
        }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    } finally {
        Pop-Location
    }

    Write-Host 'Vercel Python/frontend dependency configuration applied and verified.' -ForegroundColor Green
    Write-Host 'Disable any Vercel dashboard Install Command override, then redeploy with Clear Build Cache.' -ForegroundColor Yellow
    Write-Host "Backup: $backupRoot"
} catch {
    Write-Warning $_
    foreach ($name in $managed) {
        $backup = Join-Path $backupRoot $name
        if (Test-Path -LiteralPath $backup) {
            Copy-Item -LiteralPath $backup -Destination (Join-Path $TargetRoot $name) -Force
        }
    }
    throw
}
