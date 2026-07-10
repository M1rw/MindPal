[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$TargetRoot = 'E:\Synthos\MindPal',

    [Parameter(Mandatory = $false)]
    [string]$SourceRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not (Test-Path -LiteralPath $TargetRoot)) {
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}
$TargetRoot = (Resolve-Path -LiteralPath $TargetRoot).Path

if ($SourceRoot -eq $TargetRoot) {
    & (Join-Path $SourceRoot 'Verify-MindPal.ps1') -ProjectRoot $TargetRoot
    exit $LASTEXITCODE
}

$required = @(
    'frontend\index.html',
    'backend\main.py',
    'package-lock.json',
    'Verify-MindPal.ps1'
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $relative))) {
        throw "Invalid hardened source package; missing $relative"
    }
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupRoot = Join-Path (Split-Path -Parent $TargetRoot) "MindPal_backup_$timestamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$excludedDirs = @('node_modules', '.venv', 'venv', 'env', '.git', '.pytest_cache', '__pycache__', 'logs', 'var', 'local_data')
$excludedFiles = @('.env', '.env.local', 'firebase-service-account.json', 'google-application-credentials.json')

Write-Host "Backing up code to $backupRoot"
$backupArgs = @($TargetRoot, $backupRoot, '/E', '/COPY:DAT', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
if ($excludedDirs.Count) { $backupArgs += '/XD'; $backupArgs += $excludedDirs }
if ($excludedFiles.Count) { $backupArgs += '/XF'; $backupArgs += $excludedFiles }
& robocopy @backupArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Backup failed with robocopy exit code $LASTEXITCODE" }

Write-Host "Applying hardened source to $TargetRoot"
$copyArgs = @($SourceRoot, $TargetRoot, '/E', '/COPY:DAT', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
if ($excludedDirs.Count) { $copyArgs += '/XD'; $copyArgs += $excludedDirs }
if ($excludedFiles.Count) { $copyArgs += '/XF'; $copyArgs += $excludedFiles }
& robocopy @copyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed with robocopy exit code $LASTEXITCODE" }

& (Join-Path $TargetRoot 'Verify-MindPal.ps1') -ProjectRoot $TargetRoot
if ($LASTEXITCODE -ne 0) {
    throw "Verification failed. Restore from $backupRoot"
}

Write-Host "Hardened MindPal applied successfully. Backup: $backupRoot" -ForegroundColor Green
