[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRoot,

    [Parameter(Mandatory = $true)]
    [string]$BackupRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$TargetRoot = (Resolve-Path -LiteralPath $TargetRoot).Path
$BackupRoot = (Resolve-Path -LiteralPath $BackupRoot).Path
$manifestPath = Join-Path $BackupRoot "backup-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Backup manifest not found: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$managedDirectories = @($manifest.managedDirectories)
$managedFiles = @($manifest.managedFiles)

Write-Host "Rolling MindPal back from: $BackupRoot" -ForegroundColor Yellow

foreach ($relativePath in $managedDirectories) {
    $targetPath = Join-Path $TargetRoot $relativePath
    if (Test-Path -LiteralPath $targetPath) {
        Remove-Item -LiteralPath $targetPath -Recurse -Force
    }
}
foreach ($relativePath in $managedFiles) {
    $targetPath = Join-Path $TargetRoot $relativePath
    if (Test-Path -LiteralPath $targetPath) {
        Remove-Item -LiteralPath $targetPath -Force
    }
}

foreach ($relativePath in @($manifest.existingDirectories)) {
    $sourcePath = Join-Path $BackupRoot $relativePath
    $targetPath = Join-Path $TargetRoot $relativePath
    if (Test-Path -LiteralPath $sourcePath -PathType Container) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Recurse -Force
    }
}
foreach ($relativePath in @($manifest.existingFiles)) {
    $sourcePath = Join-Path $BackupRoot $relativePath
    $targetPath = Join-Path $TargetRoot $relativePath
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
    }
}

Write-Host "Rollback complete. Runtime secrets and local data were never modified." -ForegroundColor Green
