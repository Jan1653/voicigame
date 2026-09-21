# Baut die ZIP zum Hochladen (GameBanana usw.): Mod-Ordner, Installationsskripte, Kurzanleitung, Lizenz.
# Aufruf: powershell -File tools\build_zip.ps1   ->  dist\Voicigame-<Version>.zip
# Version aus mod\voicigame\main.gd (const VERSION). Vorher dort hochzählen.
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$mod = Join-Path $repo "mod\voicigame"
$version = (Select-String -Path (Join-Path $mod "main.gd") -Pattern 'const VERSION := "([^"]+)"').Matches[0].Groups[1].Value
$dist = Join-Path $repo "dist"
$stage = Join-Path $dist "stage-$version"
$zip = Join-Path $dist "Voicigame-$version.zip"

# Zwischenordner mit Kopien, danach wieder weg
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage "voicigame") | Out-Null
# Nur die Mod-Dateien: Skripte und Übersetzungen, keine Testdateien
Get-ChildItem $mod -File | Where-Object { $_.Extension -eq ".gd" -or $_.Name -eq "lang.json" } |
  Copy-Item -Destination (Join-Path $stage "voicigame")
Copy-Item (Join-Path $PSScriptRoot "zip\*") $stage
Copy-Item (Join-Path $repo "LICENSE") (Join-Path $stage "LICENSE.txt")
# .NET statt Compress-Archive: das schreibt in Windows PowerShell 5 Pfade mit \ (verstößt gegen das ZIP-Format)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$tmp = "$zip.tmp"
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $tmp, [IO.Compression.CompressionLevel]::Optimal, $false)
Move-Item $tmp $zip -Force   # gleiche Version: neu bauen
Remove-Item $stage -Recurse -Force
"$zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB, Version $version)"
