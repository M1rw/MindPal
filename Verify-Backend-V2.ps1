[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectRoot = $PSScriptRoot,

    [Parameter(Mandatory = $false)]
    [string]$PythonExecutable = "",

    [switch]$OnlineAudit
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$verifyScript = Join-Path $ProjectRoot "scripts\verify_backend_v2.py"
if (-not (Test-Path -LiteralPath $verifyScript -PathType Leaf)) {
    throw "Verification script not found: $verifyScript"
}

if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
    $venvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
        $PythonExecutable = $venvPython
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
        $PythonExecutable = "py"
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        $PythonExecutable = "python"
    } else {
        throw "Python 3.12+ was not found."
    }
}

Push-Location $ProjectRoot
try {
    $arguments = @()
    if ($PythonExecutable -eq "py") {
        $arguments += "-3.12"
    }
    $arguments += $verifyScript
    if ($OnlineAudit) {
        $arguments += "--online-audit"
    }

    & $PythonExecutable @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "MindPal Backend V2 verification failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
