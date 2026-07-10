[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRoot,

    [Parameter(Mandatory = $false)]
    [string]$SourceRoot = $PSScriptRoot,

    [Parameter(Mandatory = $false)]
    [string]$BackupParent = "",

    [switch]$OnlineAudit,

    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}
$TargetRoot = (Resolve-Path -LiteralPath $TargetRoot).Path
if ($SourceRoot -eq $TargetRoot) {
    throw "SourceRoot and TargetRoot must be different. Run Verify-Backend-V2.ps1 for an in-place verification."
}

$requiredSourceFiles = @(
    "backend\main.py",
    "api\index.py",
    "requirements.lock",
    "requirements-dev.lock",
    "package-lock.json",
    "scripts\verify_backend_v2.py",
    "Verify-Backend-V2.ps1",
    "Rollback-Backend-V2.ps1"
)
foreach ($relativePath in $requiredSourceFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot $relativePath) -PathType Leaf)) {
        throw "Invalid Backend V2 source package; missing $relativePath"
    }
}

$managedDirectories = @("backend", "api", "frontend", "tests", "scripts", "data", "docs")
$managedFiles = @(
    ".env.production.example",
    ".gitignore",
    ".vercelignore",
    "package.json",
    "package-lock.json",
    "pyproject.toml",
    "requirements.txt",
    "requirements.lock",
    "requirements-dev.lock",
    "tailwind.config.cjs",
    "vercel.json",
    "README.MD",
    "BACKEND_V2_ARCHITECTURE.md",
    "BACKEND_V2_AUDIT.md",
    "BACKEND_V2_CHANGELOG.md",
    "DEPLOY_BACKEND_V2.md",
    "Verify-Backend-V2.ps1",
    "Apply-Backend-V2.ps1",
    "Rollback-Backend-V2.ps1",
    "RELEASE_MANIFEST.sha256"
)

if ([string]::IsNullOrWhiteSpace($BackupParent)) {
    $BackupParent = Join-Path (Split-Path -Parent $TargetRoot) "MindPal_backups"
}
New-Item -ItemType Directory -Path $BackupParent -Force | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $BackupParent "backend-v2-$timestamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$existingDirectories = @()
$existingFiles = @()
foreach ($relativePath in $managedDirectories) {
    $sourcePath = Join-Path $TargetRoot $relativePath
    if (Test-Path -LiteralPath $sourcePath -PathType Container) {
        $existingDirectories += $relativePath
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupRoot $relativePath) -Recurse -Force
    }
}
foreach ($relativePath in $managedFiles) {
    $sourcePath = Join-Path $TargetRoot $relativePath
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        $existingFiles += $relativePath
        $backupPath = Join-Path $backupRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $backupPath -Force
    }
}

$manifest = [ordered]@{
    createdAt = (Get-Date).ToString("o")
    targetRoot = $TargetRoot
    sourceRoot = $SourceRoot
    managedDirectories = $managedDirectories
    managedFiles = $managedFiles
    existingDirectories = $existingDirectories
    existingFiles = $existingFiles
    preservedPaths = @(".env", ".env.local", "logs", "var", "local_data", "credentials")
    reusedDependencyPaths = @(".venv", "node_modules")
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupRoot "backup-manifest.json") -Encoding UTF8

Write-Host "Backup created: $backupRoot" -ForegroundColor Cyan

try {
    foreach ($relativePath in $managedDirectories) {
        $targetPath = Join-Path $TargetRoot $relativePath
        if (Test-Path -LiteralPath $targetPath) {
            Remove-Item -LiteralPath $targetPath -Recurse -Force
        }
        $sourcePath = Join-Path $SourceRoot $relativePath
        if (Test-Path -LiteralPath $sourcePath -PathType Container) {
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Recurse -Force
        }
    }
    foreach ($relativePath in $managedFiles) {
        $targetPath = Join-Path $TargetRoot $relativePath
        if (Test-Path -LiteralPath $targetPath) {
            Remove-Item -LiteralPath $targetPath -Force
        }
        $sourcePath = Join-Path $SourceRoot $relativePath
        if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
        }
    }

    $venvPython = Join-Path $TargetRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        if (Get-Command py -ErrorAction SilentlyContinue) {
            & py -3.12 -m venv (Join-Path $TargetRoot ".venv")
        } elseif (Get-Command python -ErrorAction SilentlyContinue) {
            $version = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
            if ([version]$version -lt [version]"3.12") {
                throw "Python 3.12+ is required; found $version"
            }
            & python -m venv (Join-Path $TargetRoot ".venv")
        } else {
            throw "Python 3.12+ was not found."
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Virtual environment creation failed."
        }
    }

    if (-not $SkipDependencyInstall) {
        Push-Location $TargetRoot
        try {
            & $venvPython -m pip install --disable-pip-version-check -r requirements-dev.lock
            if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

            & npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
        } finally {
            Pop-Location
        }
    }

    $verifyArguments = @(
        "-ProjectRoot", $TargetRoot,
        "-PythonExecutable", $venvPython
    )
    if ($OnlineAudit) { $verifyArguments += "-OnlineAudit" }
    & (Join-Path $TargetRoot "Verify-Backend-V2.ps1") @verifyArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Backend V2 verification failed."
    }

    Write-Host "MindPal Backend V2 deployed and verified." -ForegroundColor Green
    Write-Host "Rollback command:" -ForegroundColor Yellow
    Write-Host ".\Rollback-Backend-V2.ps1 -TargetRoot '$TargetRoot' -BackupRoot '$backupRoot'"
} catch {
    Write-Warning $_
    Write-Warning "Deployment failed. Restoring the previous managed source tree."
    & (Join-Path $SourceRoot "Rollback-Backend-V2.ps1") -TargetRoot $TargetRoot -BackupRoot $backupRoot
    throw
}
