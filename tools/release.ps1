# Baut die ZIP und legt sie als Release auf GitHub ab (Tag = Mod-Version aus main.gd).
# Aufruf: powershell -File tools\release.ps1 [-Notes "Text"] [-Force]
#   ohne -Notes: die Commits seit dem letzten Tag als Liste
#   -Force: Release gibt es schon -> ZIP und Text ersetzen
# Vorher committen und pushen: das Release hängt am aktuellen Stand von main.
param([string]$Notes = "", [switch]$Force)
$ErrorActionPreference = "Stop"

$repo = Split-Path $PSScriptRoot -Parent
$version = (Select-String -Path (Join-Path $repo "mod\voicigame\main.gd") -Pattern 'const VERSION := "([^"]+)"').Matches[0].Groups[1].Value
$zip = Join-Path $repo "dist\Voicigame-$version.zip"

Push-Location $repo
try {
  # Nichts Halbfertiges veröffentlichen
  if (git status --porcelain) { throw "Es gibt noch nicht committete Änderungen." }
  $ahead = (git rev-list --count "origin/main..HEAD").Trim()
  if ($ahead -ne "0") { throw "$ahead Commit(s) sind noch nicht gepusht." }

  powershell -File (Join-Path $PSScriptRoot "build_zip.ps1")
  if (-not (Test-Path $zip)) { throw "ZIP fehlt: $zip" }

  if (-not $Notes) {
    $last = git tag --sort=-v:refname | Select-Object -First 1
    $range = if ($last) { "$last..HEAD" } else { "HEAD" }
    $Notes = ((git log $range --no-merges --pretty=format:"- %s" | Select-Object -First 20) -join "`n")
  }
  $Notes = "$Notes`n`nUnzip and run install.bat (Windows) or install.sh (Linux). Voicitool installs and updates the mod on its own."

  gh release view $version --json tagName > $null 2> $null
  $exists = ($LASTEXITCODE -eq 0)
  if ($exists -and -not $Force) { throw "Release $version gibt es schon (mit -Force ersetzen)." }
  if ($exists) {
    gh release edit $version --title "Voicigame $version" --notes $Notes
    gh release upload $version $zip --clobber
  } else {
    gh release create $version $zip --title "Voicigame $version" --notes $Notes
  }
  if ($LASTEXITCODE -ne 0) { throw "gh hat abgebrochen (Code $LASTEXITCODE)." }
  "Release $version steht: " + (gh release view $version --json url --jq .url)
} finally {
  Pop-Location
}
