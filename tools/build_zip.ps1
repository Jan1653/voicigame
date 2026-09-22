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
# Jeden Eintrag selbst anlegen, mit / als Trenner: Compress-Archive und CreateFromDirectory schreiben in
# Windows PowerShell 5 Pfade mit \ (verstößt gegen das ZIP-Format, unter Linux entsteht dann kein Ordner)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$tmp = "$zip.tmp"
if (Test-Path $tmp) { Remove-Item $tmp -Force }
$fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew)
$archive = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $stage -File -Recurse | ForEach-Object {
    $name = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $archive.Dispose()
  $fs.Dispose()
}
Move-Item $tmp $zip -Force   # gleiche Version: neu bauen
Remove-Item $stage -Recurse -Force
"$zip ($([math]::Round((Get-Item $zip).Length / 1KB)) KB, Version $version)"
