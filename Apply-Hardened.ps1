[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetRoot,
    [string]$SourceRoot = $PSScriptRoot,
    [switch]$OnlineAudit
)
Write-Warning "Apply-Hardened.ps1 is retained for compatibility. Deploying Backend V2."
& (Join-Path $PSScriptRoot "Apply-Backend-V2.ps1") -TargetRoot $TargetRoot -SourceRoot $SourceRoot -OnlineAudit:$OnlineAudit
exit $LASTEXITCODE
