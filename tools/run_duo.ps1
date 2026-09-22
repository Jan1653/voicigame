# Testlauf mit zwei Spielen: Host (Plan dubduo) und ein zweites Spiel als Mitspieler (Plan dubmitglied),
# das im eigenen Spiel mitmacht. Aufruf: powershell -File tools\run_duo.ps1 [sekunden] [port]
#   Host        Spielordner wie bei run_test.ps1 (VG_GAME_DIR oder tools\game_dir.txt), Daten wie immer
#   Mitspieler  VG_MEMBER_DIR: eigener Ordner mit einer Spiel-exe, eigener Datenordner %APPDATA%\VoicigameMember
#   VG_MEMBER_FRESH=1  Test-Pack beim Mitspieler vorher in den Papierkorb: er muss es herunterladen
#   DUO_WEB=n          zusätzlich n Browser-Handys (fake-dub-phone.js), Figuren über DUO_CLAIM
# Läuft schon ein Spiel (etwa das des Nutzers), bricht das Skript ab, statt es zu beenden.
param([int]$Seconds = 900, [int]$Port = 8080)

$tools = $PSScriptRoot
$repo = (Split-Path $tools -Parent).Replace('\', '/')
$game = $env:VG_GAME_DIR
if (-not $game -and (Test-Path "$tools\game_dir.txt")) { $game = (Get-Content "$tools\game_dir.txt" -Raw).Trim() }
$member = $env:VG_MEMBER_DIR
if (-not $game -or -not $member) { "FEHLER: VG_GAME_DIR/game_dir.txt und VG_MEMBER_DIR angeben"; exit 1 }
$ud = "$env:APPDATA\YeahMaybe\ChoicerVoicer"
$mud = "$env:APPDATA\VoicigameMember"
$running = Get-Process | Where-Object { $_.ProcessName -like "*Choicer*Voicer*" }
if ($running) { "FEHLER: Das Spiel läuft schon ($($running.Id -join ', ')). Erst schließen."; exit 1 }

function Exe($dir) {
  $e = Join-Path $dir "The Choicer Voicer.exe"
  if (Test-Path $e) { return $e }
  return (Get-ChildItem $dir -Filter "*.exe" | Where-Object { $_.Name -match "choicer" -and $_.Name -notmatch "\.console\.exe$" } | Select-Object -First 1).FullName
}
Add-Type -AssemblyName Microsoft.VisualBasic
function Trash($path) {
  if (Test-Path $path) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
}

$lock = "$ud\voicigame_game.lock"
Set-Content -Path $lock -Value "$repo duo $(Get-Date -Format s)" -Encoding UTF8
$procs = @()
try {
  $mod = "$repo/mod/voicigame"
  $autoload = "[autoload]`r`n`r`nVoicigame=`"*$mod/main.gd`"`r`nVoicigameTest=`"*$repo/tools/test_driver.gd`"`r`n"
  $server = "[server]`r`n`r`nurl=`"http://localhost:$Port`"`r`n"
  # Host
  [IO.File]::WriteAllText("$game\override.cfg", "[application]`r`n`r`nrun/flush_stdout_on_print=true`r`n`r`n$autoload")
  [IO.File]::WriteAllText("$ud\voicigame.cfg", $server)
  if (Test-Path "$ud\voicigame_test") { Trash "$ud\voicigame_test" }
  New-Item -ItemType Directory -Force "$ud\voicigame_test" | Out-Null
  # Mitspieler: eigener Datenordner, damit sich die beiden Spiele nichts überschreiben
  [IO.File]::WriteAllText("$member\override.cfg", "[application]`r`n`r`nconfig/use_custom_user_dir=true`r`nconfig/custom_user_dir_name=`"VoicigameMember`"`r`nrun/flush_stdout_on_print=true`r`n`r`n$autoload")
  New-Item -ItemType Directory -Force $mud | Out-Null
  [IO.File]::WriteAllText("$mud\voicigame.cfg", $server + "`r`n[join]`r`n`r`nname=`"PC-Freund`"`r`n")
  if (Test-Path "$mud\voicigame_test") { Trash "$mud\voicigame_test" }
  New-Item -ItemType Directory -Force "$mud\voicigame_test" | Out-Null
  if ($env:VG_MEMBER_FRESH -eq "1") {
    Get-ChildItem "$mud\game\packs_voice" -Directory -Filter "Voicigame Dub*" -ErrorAction SilentlyContinue | ForEach-Object { Trash $_.FullName }
  }

  $env:SERVER = "http://localhost:$Port"
  $env:VOICIGAME_TEST = "dubduo"
  $procs += Start-Process -FilePath (Exe $game) -WorkingDirectory $game -PassThru
  Start-Sleep 2
  $env:VOICIGAME_TEST = "dubmitglied"
  $env:DUO_ROOM_FILE = "$ud\voicigame_test\room.txt"
  $procs += Start-Process -FilePath (Exe $member) -WorkingDirectory $member -PassThru
  $phones = @()
  for ($i = 1; $i -le [int]$env:DUO_WEB; $i++) {
    $env:CLAIM = if ($env:DUO_CLAIM) { $env:DUO_CLAIM } else { "Guy A" }
    $env:TIMEOUT_S = "$Seconds"
    $phones += Start-Process -FilePath "node" -ArgumentList "`"$tools\fake-dub-phone.js`"", "`"$ud\voicigame_test\room.txt`"", "Handy$i", "echo" `
      -WorkingDirectory $tools -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$ud\voicigame_test\phone$i.txt" -RedirectStandardError "$ud\voicigame_test\phone${i}_err.txt"
  }

  $deadline = (Get-Date).AddSeconds($Seconds)
  $done = { param($f) (Test-Path $f) -and ((Get-Content $f -Raw) -cmatch "(?m)^(ENDE|FEHLER)") }
  while ((Get-Date) -lt $deadline) {
    if ((& $done "$ud\voicigame_test\log.txt") -and (& $done "$mud\voicigame_test\log.txt")) { break }
    Start-Sleep -Milliseconds 700
  }
  Start-Sleep 2
  foreach ($p in $procs) { if (-not $p.HasExited) { "Spiel $($p.Id) am Ende: reagiert=$($p.Responding)" } }
  $procs | Where-Object { -not $_.HasExited } | Stop-Process -ErrorAction SilentlyContinue
  $phones | Where-Object { -not $_.HasExited } | Stop-Process -ErrorAction SilentlyContinue
  Start-Sleep 1
  $keep = Join-Path $tools "last_run_duo"
  if (Test-Path $keep) { Trash $keep }
  New-Item -ItemType Directory -Force $keep | Out-Null
  Copy-Item "$ud\voicigame_test" "$keep\host" -Recurse -ErrorAction SilentlyContinue
  Copy-Item "$mud\voicigame_test" "$keep\mitspieler" -Recurse -ErrorAction SilentlyContinue
  Copy-Item "$ud\logs\godot.log" "$keep\host\godot.log" -ErrorAction SilentlyContinue
  Copy-Item "$mud\logs\godot.log" "$keep\mitspieler\godot.log" -ErrorAction SilentlyContinue
  foreach ($side in @(@("Host", $ud), @("Mitspieler", $mud))) {
    "=== $($side[0])"
    Get-Content "$($side[1])\voicigame_test\log.txt" -Encoding UTF8 -ErrorAction SilentlyContinue
    "--- Fehler im Spielprotokoll ($($side[0]))"
    Select-String -Path "$($side[1])\logs\godot.log" -Pattern "SCRIPT ERROR|Parse Error|Compile Error|WARNING: Voicigame" -Context 0,1 -ErrorAction SilentlyContinue |
      Select-Object -First 20 | ForEach-Object { $_.Line; $_.Context.PostContext }
  }
  for ($i = 1; $i -le [int]$env:DUO_WEB; $i++) { "=== Handy$i"; Get-Content "$ud\voicigame_test\phone$i.txt" -Tail 8 -ErrorAction SilentlyContinue }
}
finally {
  Remove-Item $lock -ErrorAction SilentlyContinue
}
