# Dub-Modus (Synchronisieren)

Ein Video, jeder spricht die Zeilen seiner Figuren. Läuft im Browser allein (ohne Spiel) oder zusammen mit dem Spiel (Mod).

## Wie das Spiel es macht (Original 0.5.3 und Steam-Mod)

- Pack: Ordner in `user://game/packs_voice/<Pack>/`, flach
  - `dub_video.ogv` (Theora), `_backing_track.*` (Musik ohne Stimmen), `_pack_info.ini` (title, authors, icon)
  - je Zeile `<Name>.ogg` + `<Name>.ini` (`caption`, `dub_timestamps=[…]`, `dub_characters=[…]`, `image`) + Bild
- Reihenfolge: Dateiname, nach Figur, zufällig oder chronologisch (Auswahl im Spiel)
- Zeile: Rauschen, Bild der Zeile im Fernseher, Clip läuft einmal, Untertitel blendet ein, Wellenform baut sich auf
- Aufnehmen: Clip läuft, 0,125 s später startet die Aufnahme über den Kanal `Plmic`, Länge = Clip
- Ende: Wertung je Zeile (Spektrum Clip gegen Aufnahme), blauer Ergebnis-Bildschirm, „Watch“ spielt Video stumm + Musik + Aufnahmen an ihren Zeitstempeln, „Save Dub“ speichert `recordings/dub_recordings/<Pack>/<Zeit>/_dubrecord_<Zeile>.wav`
- Steam-Mod zusätzlich: Lobby mit Code, Chat, Figuren claimen (erste Figur einer Zeile zählt), „der Reihe nach“, Pack-Bereitschaft je Spieler, freie Figuren beim Start zufällig verteilt, Pause bei Verbindungsverlust (20 s, dann weiter), Zuschauen, Weitermachen einer Sitzung, gemeinsames Anschauen (Host startet), Synchron-Versatz per Ziehen der Wellenform

## Was voicigame daraus macht

| Funktion | Browser | Spiel (Mod) |
|---|---|---|
| Raum | „Selbst einen Raum erstellen“ auf der Startseite | Voicigame-Kachel, Lobby, „Synchronisieren“ |
| Pack | ZIP oder Ordner hochladen (Spielleitung) | Pack in der Dub-Auswahl des Spiels, Mod lädt es hoch |
| Figuren claimen, der Reihe nach, nur zuschauen | ja | ja (PC-Spieler claimt in der Einblendung) |
| Pack-Bereitschaft | Fortschritt je Spieler, Start erst wenn alle bereit, „Trotzdem starten“ | ja |
| Runde starten | Spielleitung | PC oder Spielleitung im Browser |
| Zeile aufnehmen | wie im Spiel: anhören, aufnehmen, synchron anhören, weiter | PC normal; Web-Zeilen spielt der Mod über `Plmic` ein |
| Zeile mit zwei Figuren | beide nehmen getrennt auf, gemischt | ebenso (PC + Web oder Web + Web) |
| Versatz | Aufnahme auf der Wellenform ziehen | wie im Steam-Mod |
| Pause, Überspringen | 20 s Pause, dann ohne ihn weiter; Spielleitung kann überspringen | ja |
| Ergebnis | Wertung je Zeile, Gesamt, „am genauesten“ | Wertung des Spiels, geht auch an die Browser |
| Gemeinsam anschauen | zeitgleich auf allen Geräten | „Watch“ im Spiel startet für alle |
| Speichern | Video (MP4) vom Server, Aufnahmen als ZIP | „Save Dub“ des Spiels, Video-Export vom Server nach `Videos/Voicigame` |
| Chat | ja | Einblendung in der Lobby |

## Nachrichten

WebSocket (`/ws`, Typen beginnen mit `dub.`), der Zustand steht in `state.dub`.

- Browser an Server: `dub.open {key}` (Ersteller wird Spielleitung), `dub.claim {character, on}`, `dub.spectate`, `dub.ready {have, need, version}`, `dub.activity`, `dub.chat`, `dub.time`
- Spielleitung und Spiel: `dub.settings {chrono, orderMode}`, `dub.assign`, `dub.start {force}`, `dub.skip {clipId}` (nur diese Zeile, doppelt geschickt ändert nichts), `dub.hub`, `dub.reset`, `dub.watch`, `dub.watch.stop`, `dub.export`
- nur Spiel: `dub.open {source:'game'}`, `local.set`, `dub.claim {playerId, on}`, `dub.done` (letzte Zeile eingespielt), `dub.scores`, `dub.close`
- Server an alle: `state`, `dub.watch {at}` (Serverzeit), `dub.watch.stop`, `dub.hub`, `dub.time {t, server}`; an das Spiel zusätzlich `dub.take {clipId, playerId, url}`

HTTP (`/api/rooms/:code/dub/…`, Zugang über `?t=<Token>` oder `X-Host-Key`)

| Aufruf | Zweck |
|---|---|
| `POST pack/begin`, `PUT pack/file?name&offset`, `POST pack/commit` | Pack in Dateien hochladen (Stücke erlaubt, abgebrochenes Stück wird verworfen, `409 bad_offset` nennt den Stand), übernehmen; `reuse` = gleiches Pack, neue Reihenfolge |
| `PUT pack/zip` | Pack als ZIP |
| `GET pack.json`, `GET file/:name[?fmt=mp3]`, `GET video` | Pack für die Browser |
| `POST takes/:clipId[?player=local-1]`, `GET takes/:clipId/:playerId` | Aufnahmen (WAV) |
| `GET export.mp4`, `GET takes.zip` | Ergebnis |

## Entscheidungen

- Aufnahme im Browser: Clip und Mikrofon im selben AudioContext, Start auf das Sample genau (AudioWorklet), Latenz von Ausgabe und Mikrofon wird abgezogen; Rest per Ziehen
- Echo-Unterdrückung beim Dub an, damit der Clip aus dem Lautsprecher nicht in der Aufnahme landet; Kopfhörer empfohlen
- Web-Aufnahmen liegen genau auf dem Clip (t = 0). Im Spiel laufen sie ab Aufnahmebeginn ein, dadurch passen sie im Spiel und im Export gleich
- Video: Browser können Theora nicht mehr, der Server wandelt `dub_video.ogv` einmal in MP4 (H.264, bis 720p). Ohne ffmpeg: Originalvideo (nur manche Browser)
- Export wie Voicitool: Musik + alle Aufnahmen an ihren Zeitstempeln, zu laut = gesamt leiser auf 0,99, dazu das Video; H.264/AAC. Fehlende Aufnahmen und übernommene Zeilen: Originalton
- ffmpeg sparsam: eine Aufgabe gleichzeitig, niedrige Priorität, 2 Threads, Zeitlimit (`FFMPEG`, `FFMPEG_THREADS`)
- Grenzen: `DUB_MAX_PACK_MB` (Standard 800), `DUB_MAX_TAKE_MB` (25)
- Reihenfolge im Browser-Raum: Standard „wie im Video“ (wählbar); im Spiel-Raum die Reihenfolge des Spiels
- Spielleitung: wer den Raum im Browser erstellt hat, sonst der erste verbundene Web-Spieler; das Spiel darf immer
- Wertung im Browser-Raum: Auswertung am Handy (Tonhöhe, Timing, Länge); im Spiel-Raum die Wertung des Spiels
- Unfertige Solo-Sitzung des Spiels: Abfrage wird ausgeblendet, der Ordner `.temp/dub_mode/<Pack>` während der Runde in `<Pack> (vor Voicigame)` umbenannt. Der Ordner der Runde bekommt die Datei `voicigame_runde.txt`; danach (oder nach einem Absturz beim nächsten Start) kommt er in den Papierkorb und die Solo-Sitzung zurück
- Mod und Server im Spiel-Raum:
  - neue Runde aus dem Spiel: erst `dub.hub` (vorige Runde endet), dann Pack neu oder wiederverwenden
  - Szene mittendrin verlassen: offene PC-Aufnahmen noch schicken (höchstens 15 s), dann `dub.hub`
  - PC-Aufnahmen werden vorgemerkt und erst geschickt, wenn der Server bei ihrer Zeile ist (der PC darf den Web-Spielern voraus sein)
  - Spielleitung geht mittendrin in die Lobby: das Spiel hält an und zeigt die Lobby, weiter mit „Runde starten“
  - Pack-Upload in 2-MB-Stücken, bis zu 6 Versuche mit Pause, fortgesetzt ab dem Stand des Servers
  - Handy-Aufnahme lässt sich 4-mal nicht laden: Zeile bleibt im Original
  - „Gemeinsam anschauen“ erst, wenn das Spiel die letzte Zeile eingespielt hat (`dub.done`)
  - Video-Download zuerst als `.part`, nur bei Erfolg umbenannt, sonst Papierkorb
  - Signal `scene_left` von `dub_hook.gd`: Dub-Szene verlassen
- Web-Spieler, die die Verbindung verlieren: 20 s Pause, dann wird ihre Zeile übersprungen und ihre weiteren Zeilen gehen an die anderen
- Wertung im Spiel: der Bewertungsalgorithmus des Spiels schwankt bei sehr kurzen Zeilen (auch bei perfekter Aufnahme gelegentlich 0 %)
- Aufnahmen und Packs liegen nur im Raum auf dem Server und verschwinden mit ihm (3 h ohne Aktivität)

## Testen

- `tools/fake-dub-phone.js`: simuliertes Handy (kann auch Raum erstellen und Pack hochladen)
- `tools/run_test.ps1 -Plan dub -Seconds 660 -Phone dub-echo -Port <port>`: zwei Runden im Spiel mit Test-Pack „Voicigame Dub [Test]“ (Kopie, zwei Zeilen mit zwei Figuren), prüft die Review-Befunde (`PRÜFUNG`-Zeilen). Umgebung: `CLAIM`, `ROUNDS=2`, `WATCH_EARLY=1`; zweites Handy separat (`spaet`, Guy A und Guy B)
- `tools/run_test.ps1 dubshot`: nur Fotos vom Dub-Modus des Spiels
