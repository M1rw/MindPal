$paths = @(
  ($env:LOCALAPPDATA + '\Google\Chrome\User Data\Default\Preferences'),
  ($env:LOCALAPPDATA + '\Google\Chrome\User Data\Profile 1\Preferences')
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $raw = Get-Content -Raw -LiteralPath $p
    if ($raw -match 'mindpal-demo') {
      Write-Output "FOUND $p"
      $raw | Select-String -Pattern 'mindpal-demo' -AllMatches | Select-Object -ExpandProperty Line
    }
  }
}
