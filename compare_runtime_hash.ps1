$p = 'E:\Synthos\MindPal\frontend\voice\dist\assets\runtime.js'
Get-FileHash -Algorithm SHA256 -LiteralPath $p | Format-List
Get-Item -LiteralPath $p | Select-Object Length,LastWriteTime
