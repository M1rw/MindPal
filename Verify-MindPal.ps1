[CmdletBinding()]
param(
    [string]$ProjectRoot = $PSScriptRoot,
    [switch]$OnlineAudit
)
& (Join-Path $PSScriptRoot "Verify-Backend-V2.ps1") -ProjectRoot $ProjectRoot -OnlineAudit:$OnlineAudit
exit $LASTEXITCODE
