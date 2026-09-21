# Testlauf: Spiel mit Mod und Testtreiber starten, auf Ergebnis warten, Protokoll zeigen.
# Aufruf: powershell -File tools\run_test.ps1 <plan> [sekunden] [handy-modus] [port]
#   handy-modus: leer = kein simuliertes Handy, sonst "echo", "still" oder "spaet" (siehe fake-phone.js)
#   port: lokaler voicigame-Server, gegen den Spiel und Test-Handy laufen
# Das Spiel kann nur einmal laufen: eine Sperrdatei verhindert, dass zwei Arbeitskopien gleichzeitig testen.
# Jeder Lauf trägt den Mod aus der eigenen Arbeitskopie (Ordner dieses Skripts) in override.cfg ein.
param([string]$Plan = "lobby", [int]$Seconds = 75, [string]$Phone = "", [int]$Port = 8080)
# powershell -File verschluckt ein leeres "" als Argument: dann rutscht der Port in $Phone
if ($Phone -match '^\d+$') { $Port = [int]$Phone; $Phone = "" }

# Spielordner: Umgebungsvariable VG_GAME_DIR, sonst tools\game_dir.txt (lokal, nicht im Repo), sonst Steam-Standardpfad
$game = $env:VG_GAME_DIR
if (-not $game -and (Test-Path "$PSScriptRoot\game_dir.txt")) { $game = (Get-Content "$PSScriptRoot\game_dir.txt" -Raw).Trim() }
if (-not $game) { $game = "${env:ProgramFiles(x86)}\Steam\steamapps\common\The Choicer Voicer" }
$ud = "$env:APPDATA\YeahMaybe\ChoicerVoicer"
$tools = $PSScriptRoot
$repo = (Split-Path $tools -Parent).Replace('\', '/')

# Sperre: warten, solange ein anderer Testlauf das Spiel benutzt (älter als 15 min = verwaist)
$lock = "$ud\voicigame_game.lock"
$waitUntil = (Get-Date).AddMinutes(20)
while ((Test-Path $lock) -and ((Get-Item $lock).LastWriteTime -gt (Get-Date).AddMinutes(-15))) {
  if ((Get-Date) -gt $waitUntil) { "FEHLER: Spiel ist durch einen anderen Testlauf belegt: $(Get-Content $lock)"; exit 1 }
  Start-Sleep 5
}
Set-Content -Path $lock -Value "$repo $(Get-Date -Format s)" -Encoding UTF8

try {
  # Mod und Testtreiber aus dieser Arbeitskopie, Server-Adresse für den Mod
  # flush_stdout_on_print: jede Protokollzeile sofort schreiben, sonst fehlt nach dem Beenden das Ende
  $cfg = "[application]`r`n`r`nrun/flush_stdout_on_print=true`r`n`r`n[autoload]`r`n`r`nVoicigame=`"*$repo/mod/voicigame/main.gd`"`r`nVoicigameTest=`"*$repo/tools/test_driver.gd`"`r`n"
  [IO.File]::WriteAllText("$game\override.cfg", $cfg)
  $vcfg = "[server]`r`n`r`nurl=`"http://localhost:$Port`"`r`n"
  if ($env:VG_LANG) { $vcfg += "`r`n[ui]`r`n`r`nlang=`"$($env:VG_LANG)`"`r`n" }   # Sprache des Mods zum Testen
  [IO.File]::WriteAllText("$ud\voicigame.cfg", $vcfg)
  $env:SERVER = "http://localhost:$Port"

  if (Test-Path "$ud\voicigame_test") { Remove-Item "$ud\voicigame_test" -Recurse -Force }
  New-Item -ItemType Directory -Force "$ud\voicigame_test" | Out-Null
  Get-Process | Where-Object { $_.ProcessName -like "The Choicer Voicer*" } | Stop-Process -ErrorAction SilentlyContinue

  $phoneProc = $null
  if ($Phone -ne "") {
    # "dub-echo" usw.: Dub-Handy (fake-dub-phone.js), Figuren über die Umgebungsvariable CLAIM
    $phoneJs = "fake-phone.js"; $phoneMode = $Phone
    if ($Phone -like "dub-*") { $phoneJs = "fake-dub-phone.js"; $phoneMode = $Phone.Substring(4) }
    $phoneProc = Start-Process -FilePath "node" -ArgumentList "`"$tools\$phoneJs`"", "`"$ud\voicigame_test\room.txt`"", "Testhandy", $phoneMode `
      -WorkingDirectory $tools -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$ud\voicigame_test\phone.txt" -RedirectStandardError "$ud\voicigame_test\phone_err.txt"
  }

  # Plan "join": ein simulierter Host (fake-host.js) macht die Show, das Spiel tritt als PC-Spieler bei
  $hostProc = $null
  if ($Plan -eq "join" -and -not $env:VG_EXTERNAL_HOST) {
    $pack = "$ud\game\packs_voice\The Choicer Voicer Tutorial Pack"
    $env:ROOM_FILE = "$ud\voicigame_test\host_room.txt"
    $env:HEARTBEAT = "1"
    $hostProc = Start-Process -FilePath "node" -ArgumentList "`"$tools\fake-host.js`"", "`"$pack\ChoicerVoicerTutorialPack1.wav`"", "`"$pack\ChoicerVoicerTutorialPack2.wav`"" `
      -WorkingDirectory $tools -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$ud\voicigame_test\host.txt" -RedirectStandardError "$ud\voicigame_test\host_err.txt"
  }

  $env:VOICIGAME_TEST = $Plan
  Start-Process -FilePath "$game\The Choicer Voicer.exe" -WorkingDirectory $game | Out-Null
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path "$ud\voicigame_test\log.txt") {
      if ((Get-Content "$ud\voicigame_test\log.txt" -Raw) -cmatch "(?m)^(ENDE|FEHLER)") { break }
    }
    Start-Sleep -Milliseconds 500
  }
  Start-Sleep 1
  $gp = Get-Process | Where-Object { $_.ProcessName -like "The Choicer Voicer*" }
  foreach ($g in $gp) { "Spiel am Ende: reagiert=$($g.Responding), CPU=$([int]$g.CPU) s, RAM=$([int]($g.WorkingSet64/1MB)) MB" }
  $gp | Stop-Process -ErrorAction SilentlyContinue
  if ($phoneProc -and -not $phoneProc.HasExited) { Stop-Process -Id $phoneProc.Id -ErrorAction SilentlyContinue }
  if ($hostProc -and -not $hostProc.HasExited) { Stop-Process -Id $hostProc.Id -ErrorAction SilentlyContinue }
  Start-Sleep 1
  # Protokoll sichern, bevor ein anderer Testlauf das Spiel startet und es überschreibt
  Copy-Item "$ud\logs\godot.log" "$ud\voicigame_test\godot.log" -ErrorAction SilentlyContinue
  # Ergebnisse auch in die eigene Arbeitskopie, der nächste Testlauf leert den Testordner
  $keep = Join-Path $tools "last_run"
  if (Test-Path $keep) { Remove-Item $keep -Recurse -Force }
  Copy-Item "$ud\voicigame_test" $keep -Recurse -ErrorAction SilentlyContinue
  "=== Testlog"
  Get-Content "$ud\voicigame_test\log.txt" -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($Phone -ne "") {
    "=== Handy"
    Get-Content "$ud\voicigame_test\phone.txt", "$ud\voicigame_test\phone_err.txt" -ErrorAction SilentlyContinue
  }
  if ($hostProc) {
    "=== Test-Host"
    Get-Content "$ud\voicigame_test\host.txt", "$ud\voicigame_test\host_err.txt" -ErrorAction SilentlyContinue
  }
  "=== Fotos"
  Get-ChildItem "$ud\voicigame_test" -Filter *.png -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
  "=== Fehler im Spielprotokoll"
  Select-String -Path "$ud\logs\godot.log" -Pattern "SCRIPT ERROR|Parse Error|Compile Error|Voicigame:|WARNING: Voicigame" -Context 0,1 |
    Select-Object -First 30 | ForEach-Object { $_.Line; $_.Context.PostContext }
}
finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
