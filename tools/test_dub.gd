extends RefCounted
## Nur für Tests: Dub-Pläne für den Testtreiber (Umgebungsvariable VOICIGAME_TEST, beginnt mit "dub").
##   dubshot   Fotos vom Dub-Modus des Spiels (ohne Handy), zum Vergleich mit der Webseite
##   dub       zwei Runden mit PC und zwei Web-Handys, prüft dabei die Befunde aus dem Review (PRÜFUNG-Zeilen)
##             Handys: tools/fake-dub-phone.js (run_test.ps1 startet eines, ein zweites startet der Aufrufer)
##   dubduo    Host mit einem zweiten Spiel als Mitspieler, das im eigenen Spiel mitmacht (tools/run_duo.ps1)
##   dubmitglied  das zweite Spiel dazu: tritt bei, holt das Pack, spielt seine Figur

const SOURCE_PACK := "user://game/packs_voice/Family Guy - Sneakers O'Toole/"
const TEST_PACK := "user://voicigame_test/pack/Voicigame Dub [Test]/"
const TEMP_SESSION := "user://game/.temp/dub_mode/Voicigame Dub [Test]"


## Pack für die Fotos: Ordnername unter packs_voice in der Umgebungsvariable VG_PACK, sonst das Test-Pack.
func _shot_pack() -> String:
	var name := OS.get_environment("VG_PACK")
	return "user://game/packs_voice/%s/" % name if name != "" else SOURCE_PACK

var d: Node   # der Testtreiber (Fotos, Protokoll, Suchen)


func run(driver: Node, plan: String) -> void:
	d = driver
	match plan:
		"dubshot":
			await _dubshot()
		"dub":
			await _dub()
		"dubduo":
			await _duo()
		"dubmitglied":
			await _member()
		_:
			d._note("FEHLER: unbekannter Plan " + plan)


## Fotos und Protokoll zusätzlich dorthin kopieren (Umgebungsvariable VOICIGAME_COPY_TO), damit der nächste Testlauf sie nicht löscht.
func _copy_results() -> void:
	var to := OS.get_environment("VOICIGAME_COPY_TO")
	if to == "":
		return
	DirAccess.make_dir_recursive_absolute(to)
	for f in DirAccess.get_files_at("user://voicigame_test/"):
		DirAccess.copy_absolute(ProjectSettings.globalize_path("user://voicigame_test/" + f), to.path_join(f))


func _wait(s: float) -> void:
	await d.get_tree().create_timer(s).timeout


func _dubshot() -> void:
	var pack := _shot_pack()
	var res = GameplayResourceDubMode.new(pack)
	if res.failed_to_load:
		d._note("FEHLER: Pack nicht lesbar: " + pack)
		return
	d._note("Pack: %s, %d Clips, Video: %s" % [res.pack_info.display_name, res.omni_clip_array.data.size(), res.video != null])
	var metro = d.get_node("/root/Metro")
	var m = d.get_node("/root/M")
	metro.gameplay_resource_dub_mode = res
	m.session_type = m.SESSION_TYPE.VIDEO_DUB
	m.world.enter_dub_mode()
	var dm: Node = await d._wait_for(func(n): return n.scene_file_path.ends_with("dub_mode.tscn"), 20.0)
	if dm == null:
		d._note("FEHLER: Dub-Modus nicht geladen")
		return
	await _wait(3.0)
	# Unfertige Sitzung des Nutzers: Abfrage nur ausblenden, nichts laden oder verwerfen
	dm.load_last_session_prompt.hide()
	await d._shot("dub_idle")
	dm._begin_from_idle()
	await _wait(0.4)
	await d._shot("dub_clip_start")
	await _wait(2.0)
	await d._shot("dub_clip_play")
	await _wait(3.0)
	await d._shot("dub_clip_idle")
	dm._enact()
	await _wait(1.2)
	await d._shot("dub_recording")
	await _wait(3.5)
	await d._shot("dub_after_record")
	dm._hear_again()
	await _wait(1.0)
	await d._shot("dub_hear_again")
	await _wait(3.0)
	# Rest überspringen: gleich zum Ende (ohne _button_next, das würde Zwischenstände des Spiels anlegen)
	dm.clip_index = dm.performance_array.size()
	dm._enter_finish()
	await _wait(3.0)
	await d._shot("dub_results")
	dm._toggle_screen_size()
	await _wait(0.5)
	await d._shot("dub_expanded")
	dm._toggle_screen_size()
	dm.watch()
	await _wait(2.0)
	await d._shot("dub_watch")
	await _wait(6.0)
	await d._shot("dub_watch2")
	dm.stop()
	dm.show_settings()
	await _wait(0.8)
	await d._shot("dub_settings")
	dm.hide_settings()
	_copy_results()
	d._note("ENDE")


## Test-Pack: Kopie des Family-Guy-Packs unter eigenem Namen, zwei Zeilen mit zwei Figuren.
func _make_test_pack() -> bool:
	DirAccess.make_dir_recursive_absolute(TEST_PACK)
	for f in DirAccess.get_files_at(SOURCE_PACK):
		if DirAccess.copy_absolute(SOURCE_PACK + f, TEST_PACK + f) != OK:
			return false
	_set_chars("5_guya2.ini", '["Guy A", "Brian"]')
	_set_chars("7_guyb1.ini", '["Guy B", "Sneakers O\'Toole"]')
	var info := FileAccess.open(TEST_PACK + "_pack_info.ini", FileAccess.WRITE)
	info.store_string('[data]\n\ntitle="Voicigame Dub [Test]"\n')
	info.close()
	return true


func _set_chars(file: String, chars: String) -> void:
	var text := FileAccess.get_file_as_string(TEST_PACK + file)
	var lines := text.split("\n")
	for i in lines.size():
		if lines[i].begins_with("dub_characters="):
			lines[i] = "dub_characters=" + chars
	var f := FileAccess.open(TEST_PACK + file, FileAccess.WRITE)
	f.store_string("\n".join(lines))
	f.close()




## Kennt der Server diese Figur schon? (Die Zeilen kommen nach und nach an.)
func _has_char(hook, name: String) -> bool:
	for c in hook._dub().get("characters", []):
		if c is Dictionary and str(c.get("name", "")) == name:
			return true
	return false


## Das Pack ist beim Server angekommen: entweder alle Originaldateien, oder das fertige Web-Pack
## für die Browser (dann bleiben die Originale auf diesem PC, und das ist der bessere Fall).
func _pack_delivered(hook) -> bool:
	if hook._upload_state == "done":
		return true
	return hook._upload_state in ["local", "uploading"] and str(hook._web.get("state", "")) == "done"


func _check(nr: String, ok: bool, text: String) -> void:
	d._note("PRÜFUNG %s: %s, %s" % [nr, "OK" if ok else "FEHLER", text])


## Absturz während einer Runde nachstellen: Solo-Sitzung beiseitegelegt, Rundenordner mit Kennzeichen.
func _check_crash_restore(DubHook) -> void:
	var parked: String = TEMP_SESSION + DubHook.PARK_SUFFIX
	DirAccess.make_dir_recursive_absolute(parked)
	var f := FileAccess.open(parked + "/voicigame_test_marker.txt", FileAccess.WRITE)
	f.store_string("solo")
	f.close()
	DirAccess.make_dir_recursive_absolute(TEMP_SESSION)
	f = FileAccess.open(TEMP_SESSION + "/" + DubHook.ROUND_MARK, FileAccess.WRITE)
	f.store_string("runde")
	f.close()
	f = FileAccess.open(TEMP_SESSION + "/preserved_x.wav", FileAccess.WRITE)
	f.store_string("x")
	f.close()
	DubHook.restore_parked()
	var ok := FileAccess.file_exists(TEMP_SESSION + "/voicigame_test_marker.txt") \
		and not FileAccess.file_exists(TEMP_SESSION + "/" + DubHook.ROUND_MARK) and not DirAccess.dir_exists_absolute(parked)
	_check("21 Absturz", ok, "Solo-Sitzung zurück, Rundenrest im Papierkorb")


func _dub() -> void:
	if not _make_test_pack():
		d._note("FEHLER: Test-Pack nicht kopiert")
		return
	_set_chars("6_otoole3.ini", '["Brian"]')   # Zeile 6 nur PC, direkt nach Zeile 5 (PC + Handy)
	var DubHook = load(d.get_node("/root/Voicigame").get_script().resource_path.get_base_dir() + "/dub_hook.gd")
	_check_crash_restore(DubHook)
	var texts := [DubHook.upload_error_text(413, "too_large"), DubHook.upload_error_text(0, ""),
		DubHook.upload_error_text(409, "bad_offset"), DubHook.upload_error_text(500, "xyz")]
	_check("22 Fehlertexte", not str(texts).contains("too_large") and not str(texts).contains("bad_offset"), str(texts))
	DubHook.test_fail_uploads = 2          # Befund 18: zwei Stücke scheitern
	DubHook.test_no_local = false
	DubHook.test_broken_take = "4_otoole2" # Befund 19: diese Aufnahme lässt sich nie laden

	var master: Node = await d._wait_for(func(n): return n.has_method("NewSlide"))
	master.NewSlide("res://scenes/nav_specific/play_flow/select_member_count.tscn", false)
	var menu: Node = await d._wait_for(func(n): return n.scene_file_path.ends_with("select_member_count.tscn"))
	await _wait(1.5)
	var vg = d.get_node("/root/Voicigame")
	vg._open_lobby(menu)
	await _wait(1.0)
	vg._lobby._show_host()   # Auswahlseite: „Lobby erstellen“
	await _wait(3.0)
	var f := FileAccess.open("user://voicigame_test/room.txt", FileAccess.WRITE)
	f.store_string(vg.bridge.room_code)
	f.close()
	d._note("Raum: %s" % vg.bridge.room_code)
	var t := 0.0
	while vg.bridge.web_players().size() < 2 and t < 40.0:
		await _wait(0.5)
		t += 0.5
	d._note("Web-Spieler: %s" % [vg.bridge.web_players().map(func(p): return p.name)])
	if vg.bridge.web_players().is_empty():
		d._note("FEHLER: kein Web-Spieler")
		return

	vg._start_dub(true)
	await _wait(2.5)
	var dm: Node = await _enter_dub(vg)
	var hook = vg.dub_hook
	if hook == null:
		d._note("FEHLER: Dub-Hook nicht angehängt")
		return
	t = 0.0
	# Fertig ist es, wenn das Pack beim Server ist und die beiden Fehlversuche verbraucht sind
	# (oder nichts mehr hochgeladen wird, weil der Server das Pack schon kannte).
	while t < 90.0 and not (_pack_delivered(hook)
			and (DubHook.test_fail_uploads == 0 or hook._upload_state in ["done", "local"])):
		await _wait(0.5)
		t += 0.5
	# Kennt der Server das Pack schon (Pack-Speicher), wird gar nichts hochgeladen: dann bleiben die
	# absichtlichen Fehlschläge ungenutzt stehen, und das ist genauso richtig.
	var from_cache: bool = DubHook.test_fail_uploads == 2
	_check("18 Hochladen", _pack_delivered(hook) and (DubHook.test_fail_uploads == 0 or from_cache),
		"%s, Web-Pack %s, nach %.1f s, %s" % [hook._upload_state, str(hook._web.get("state", "")), t,
		"Pack lag schon auf dem Server" if from_cache else "zwei Stücke absichtlich gescheitert und wiederholt"])
	# Figuren gibt es erst, wenn der Server die Beschreibungen gelesen hat
	t = 0.0
	while t < 20.0 and not _has_char(hook, "Brian"):
		await _wait(0.5)
		t += 0.5
	hook._claim_local("Brian")
	await _wait(3.0)
	await _start_when_ready(hook)
	await d._shot("hub")

	# Runde 1 laufen lassen und dabei prüfen
	var last := ""
	var step := 0
	var enabled_after_web := {}    # Befund 9: Zeile -> Knöpfe am PC waren frei
	var saw_pending_wait := false  # Befund 4: PC-Aufnahme musste auf den Server warten
	var saw_wait_game := false     # Befund 14
	var hub_done := false          # Befund 8
	var dv: Dictionary = {}
	while not (dm.performing_finished and hook._scores_sent) and step < 900:
		await _wait(0.5)
		step += 1
		dv = hook._dub()
		var turn = dv.get("turn")
		var clip := str(turn.get("clipId", "")) if turn is Dictionary else ""
		var now := "Spiel Zeile %d, Server %s %s, Leiste: %s" % [dm.clip_index + 1, dv.get("phase", ""), clip, hook._banner_text.text]
		if now != last:
			d._note(now)
			last = now
		if step % 10 == 0:
			await d._shot("runde_%03d" % step)
		var i: int = dm.clip_index
		if i >= 0 and i < hook.order.size() and hook._turn_for(hook.order[i]).get("recorders", []).has("local-1"):
			if not hook._busy and dm.btn_hear_again.enabled and dm.btn_refresh_mic.enabled:
				enabled_after_web[i + 1] = true
		for p in hook._local_pending.values():
			if p.clip != clip:
				saw_pending_wait = true
		if dv.get("waitGame", false):
			saw_wait_game = true
		# Befund 8: Spielleitung geht mitten in der Runde in die Lobby (hier als Spiel geschickt, gleiche Wirkung)
		if not hub_done and clip == "3_guya1":
			hub_done = true
			# Läuft gerade eine Einspielung, spielt das Spiel diese Zeile noch zu Ende und hält vor der nächsten an
			var was_busy: bool = hook._busy
			var from: int = dm.clip_index
			vg.bridge._send({"type": "dub.hub"})
			await _wait(2.0)
			while hook._busy:
				await _wait(0.5)
			await _wait(1.0)
			var at: int = dm.clip_index
			await _wait(4.0)
			await d._shot("lobby_mitten_in_der_runde")
			var dv2: Dictionary = hook._dub()
			var allowed := [from, from + 1] if was_busy else [from]
			_check("8 Lobby mittendrin", dm.clip_index == at and allowed.has(at) and hook._hub.visible and str(dv2.get("phase", "")) == "hub" and not hook._busy,
				"Spiel bleibt bei Zeile %d stehen, Lobby eingeblendet (Einspielung lief: %s)" % [at + 1, was_busy])
			hook.start_round(true)
			await _wait(1.5)
	await _wait(2.0)
	await d._shot("ergebnis")
	dv = hook._dub()
	d._note("Aufnahmen am Server: %d, Wertungen vom Spiel: %s" % [dv.get("takes", []).size(), str(dv.get("gameScores", {}))])
	for i in dm.performance_array.size():
		var inst = dm.performance_array[i]
		var a = inst.member_audio
		d._note("Zeile %d %s: %s %.2f s, Wertung %.0f %%" % [i + 1, inst.shared_omniclip.file_name_agnostic,
			a.get_class() if a else "KEINE", a.get_length() if a else 0.0, clampf(inst.score, 0, 5) * 20.0])
	var local_takes: Array = dv.get("takes", []).filter(func(x): return x.playerId == "local-1").map(func(x): return x.clipId)
	# Welche Zeilen der PC bekommt, entscheidet der Server (und die Lobby mittendrin würfelt neu).
	# Geprüft wird deshalb: jede Zeile, die der PC aufgenommen hat, liegt am Ende auch auf dem Server.
	# saw_pending_wait ist nur Beobachtung: seit das Pack nicht mehr die Leitung belegt, sind die
	# PC-Aufnahmen meist schon oben, bevor das Spiel weiterläuft.
	var local_missing: Array = hook._uploaded_local.keys().filter(func(i): return not local_takes.has(hook.order[i]) if i < hook.order.size() else false)
	_check("4 PC vor dem Server", not local_takes.is_empty() and local_missing.is_empty() and str(dv.get("phase", "")) == "results",
		"PC-Aufnahmen am Server: %s, fehlen: %s, musste warten: %s" % [local_takes, local_missing, saw_pending_wait])
	_check("9 Knöpfe", enabled_after_web.size() >= 2, "Anhören und Mikrofon frei in PC-Zeilen %s" % [enabled_after_web.keys()])
	var inst4 = dm.performance_array[3]
	var broken: Array = hook._take_fail.keys()
	_check("19 kaputte Aufnahme", inst4.member_audio == inst4.shared_omniclip.clip_audio and not broken.is_empty(),
		"Zeile 4 mit Originalton, Fehlversuche %s" % [hook._take_fail])
	_check("14 Anschauen wartet aufs Spiel", saw_wait_game, "Browser durfte erst nach dem Spiel anschauen (siehe Handy-Protokoll)")

	# Gemeinsam anschauen, Export (Befund 23: erster Download geht absichtlich schief)
	hook.request_watch()
	await _wait(4.5)
	await d._shot("anschauen")
	# Zuerst auf diesem PC (ffmpeg), der Server soll dafür gar nichts tun
	hook.request_export()
	t = 0.0
	while hook._export_state != "done" and hook._export_state != "error" and t < 180.0:
		await _wait(1.0)
		t += 1.0
	var own_file: String = hook._export_file
	var own_size := FileAccess.open(own_file, FileAccess.READ).get_length() if FileAccess.file_exists(own_file) else 0
	var srv = hook._dub().get("export")
	var srv_status := str(srv.get("status", "")) if srv is Dictionary else ""
	var by_host: bool = bool(srv.get("byHost", false)) if srv is Dictionary else false
	_check("24 Export auf diesem PC", hook._export_state == "done" and own_size > 100000 and (by_host or srv_status != "done"),
		"%s, %d Bytes, Server: %s" % [own_file.get_file(), own_size,
		"wartet auf uns" if by_host else (srv_status if srv_status != "" else "nichts zu tun")])

	# Dann der Weg über den Server (Befund 23: erster Download geht absichtlich schief)
	DubHook.test_no_local = true
	hook.test_export_fail = true
	hook.request_export()
	t = 0.0
	while hook._export_state != "error" and hook._export_state != "done" and t < 120.0:
		await _wait(1.0)
		t += 1.0
	var bad_file: String = hook._export_file
	# Das Video von diesem PC (Prüfung 24) heißt genauso und darf bleiben: kaputt wäre nur eine
	# angefangene Datei oder eine mit anderer Größe.
	var still_good := true
	if FileAccess.file_exists(bad_file):
		still_good = FileAccess.open(bad_file, FileAccess.READ).get_length() == own_size
	_check("23 Export-Fehler", hook._export_state == "error" and still_good and not FileAccess.file_exists(bad_file + ".part"),
		"kein kaputtes Video in %s" % bad_file.get_base_dir())
	hook.request_export()
	t = 0.0
	while hook._export_state != "done" and hook._export_state != "error" and t < 120.0:
		await _wait(1.0)
		t += 1.0
	var size := FileAccess.open(hook._export_file, FileAccess.READ).get_length() if FileAccess.file_exists(hook._export_file) else 0
	d._note("Export: %s, %s, %d Bytes" % [hook._export_state, hook._export_file.get_file(), size])
	await d._shot("export")

	hook._leave_hub()
	await _wait(4.0)
	_check("21 Solo-Sitzung", FileAccess.file_exists(TEMP_SESSION + "/voicigame_test_marker.txt") and not FileAccess.file_exists(TEMP_SESSION + "/" + DubHook.ROUND_MARK),
		"nach der Runde wieder da, Rundenordner weg")

	# Befund 3: zweite Runde im selben Raum, gleiches Pack
	dm = await _enter_dub(vg)
	hook = vg.dub_hook
	t = 0.0
	while not _pack_delivered(hook) and t < 60.0:
		await _wait(0.5)
		t += 0.5
	dv = hook._dub()
	_check("3 zweite Runde", _pack_delivered(hook) and str(dv.get("phase", "")) == "hub",
		"Pack %s nach %.1f s, Server %s" % [hook._upload_state, t, dv.get("phase", "")])
	# Befund 13: „Ich am PC“ doppelt geklickt
	hook._claim_local("Brian", true)
	hook._claim_local("Brian", true)
	await _wait(1.5)
	var brian = hook._dub().get("characters", []).filter(func(c): return c.name == "Brian")
	_check("13 Claim doppelt", not brian.is_empty() and str(brian[0].claimedBy) == "local-1", "Brian = %s" % [brian[0].claimedBy if brian else "?"])
	await _start_when_ready(hook)
	t = 0.0
	var skipped := false
	while t < 150.0:
		await _wait(0.5)
		t += 0.5
		dv = hook._dub()
		var turn = dv.get("turn")
		var clip := str(turn.get("clipId", "")) if turn is Dictionary else ""
		if clip == "3_guya1" and not skipped:
			skipped = true
			hook._skip_line()
			hook._skip_line()
			vg.bridge._send({"type": "dub.skip", "clipId": "3_guya1"})   # wie ein zweiter Klick im Browser
			await _wait(2.0)
			turn = hook._dub().get("turn")
			var after := str(turn.get("clipId", "")) if turn is Dictionary else ""
			_check("13 Überspringen doppelt", after == "4_otoole2", "nach dreimal Überspringen ist Zeile %s dran" % after)
			break
	# Befund 12: mitten in einer Einspielung (Handy-Aufnahme läuft im Mikrofon-Kanal) die Szene verlassen.
	# Das Mikrofon des Spiels läuft dabei weiter (nur stumm), die Aufnahme kommt über einen eigenen Player.
	var ms = d.get_node("/root/MicrophoneService")
	var inj := func() -> bool: return is_instance_valid(hook) and is_instance_valid(hook._inj_player) and hook._inj_player.playing
	t = 0.0
	while t < 60.0 and not (hook._busy and inj.call()):
		await _wait(0.1)
		t += 0.1
	var injected: bool = inj.call()
	var mic_kept: bool = ms.player.stream is AudioStreamMicrophone
	var muted: bool = ms.player.volume_db <= -79.0
	hook._leave_hub()
	await _wait(4.0)
	var ok12: bool = injected and mic_kept and muted and ms.player.stream is AudioStreamMicrophone 		and ms.player.volume_db > -79.0 and not inj.call()
	_check("12 Mikrofon", ok12, "Einspielung %s, Mikro blieb %s, stumm %s, danach %s mit %.0f dB" % [injected, mic_kept, muted,
		ms.player.stream.get_class(), ms.player.volume_db])
	_check("3 Abbruch", str(vg.bridge.state.get("dub", {}).get("phase", "")) == "hub", "Server nach dem Verlassen: %s" % vg.bridge.state.get("dub", {}).get("phase", ""))
	# Aufräumen: Zwischenstände, die das Spiel für das Test-Pack angelegt hat, in den Papierkorb
	var tmp := ProjectSettings.globalize_path(TEMP_SESSION)
	if DirAccess.dir_exists_absolute(tmp):
		OS.move_to_trash(tmp)
		d._note("Zwischenstände des Test-Packs in den Papierkorb")
	DubHook.test_broken_take = ""
	_copy_results()
	d._note("ENDE")


## Plan „dubduo“: Host, dazu ein zweites Spiel als Mitspieler (Plan „dubmitglied“), optional Browser-Handys (DUO_WEB).
func _duo() -> void:
	if not _make_test_pack():
		d._note("FEHLER: Test-Pack nicht kopiert")
		return
	var master: Node = await d._wait_for(func(n): return n.has_method("NewSlide"))
	master.NewSlide("res://scenes/nav_specific/play_flow/select_member_count.tscn", false)
	var menu: Node = await d._wait_for(func(n): return n.scene_file_path.ends_with("select_member_count.tscn"))
	await _wait(1.5)
	var vg = d.get_node("/root/Voicigame")
	vg._open_lobby(menu)
	await _wait(1.0)
	vg._lobby._show_host()
	await _wait(3.0)
	var f := FileAccess.open("user://voicigame_test/room.txt", FileAccess.WRITE)
	f.store_string(vg.bridge.room_code)
	f.close()
	d._note("Raum: %s" % vg.bridge.room_code)
	var web := int(OS.get_environment("DUO_WEB"))   # so viele Browser-Handys kommen zusätzlich
	var t := 0.0
	while t < 120.0 and not (_game_members(vg).size() >= 1 and vg.bridge.web_players().size() >= 1 + web):
		await _wait(0.5)
		t += 0.5
	d._note("Mitspieler: %s" % [vg.bridge.web_players().map(func(p): return "%s%s" % [p.name, " (Spiel)" if p.get("game", false) else ""])])
	if _game_members(vg).is_empty():
		d._note("FEHLER: kein Mitspieler aus einem Spiel")
		return
	vg._start_dub(true)
	await _wait(2.5)
	var dm: Node = await _enter_dub(vg)
	var hook = vg.dub_hook
	hook._claim_local("Brian")
	# Warten, bis der Mitspieler das Pack hat und eine Figur nimmt
	var member_id := str(_game_members(vg)[0].id)
	t = 0.0
	var last := ""
	while t < 240.0:
		await _wait(0.5)
		t += 0.5
		var dv: Dictionary = hook._dub()
		var info = dv.get("players", []).filter(func(p): return str(p.id) == member_id)
		var now := "Host-Pack: %s, gebraucht: %s, Mitspieler bereit: %s, eigenes Pack: %s" % [hook._upload_state, dv.get("packWanted"),
			info[0].get("ready") if info else "?", info[0].get("own") if info else "?"]
		if now != last:
			d._note(now)
			last = now
		if info and info[0].get("ready", false) and dv.get("characters", []).any(func(c): return str(c.get("claimedBy")) == member_id):
			break
	await d._shot("duo_lobby")
	await _start_when_ready(hook)
	var step := 0
	last = ""
	while not (dm.performing_finished and hook._finished) and step < 1200:
		await _wait(0.5)
		step += 1
		var dv: Dictionary = hook._dub()
		var turn = dv.get("turn")
		var now := "Spiel Zeile %d, Server %s %s, Leiste: %s" % [dm.clip_index + 1, dv.get("phase", ""),
			str(turn.get("clipId", "")) if turn is Dictionary else "", hook._banner_text.text.replace("\n", " / ")]
		if now != last:
			d._note(now)
			last = now
		if step % 20 == 0:
			await d._shot("duo_%03d" % step)
	await _wait(2.0)
	await d._shot("duo_ergebnis")
	var dv: Dictionary = hook._dub()
	var from_member: Array = dv.get("takes", []).filter(func(x): return str(x.playerId) == member_id).map(func(x): return x.clipId)
	for i in dm.performance_array.size():
		var inst = dm.performance_array[i]
		var a = inst.member_audio
		d._note("Zeile %d %s: %s %.2f s, Wertung %.0f %%" % [i + 1, inst.shared_omniclip.file_name_agnostic,
			a.get_class() if a else "KEINE", a.get_length() if a else 0.0, clampf(inst.score, 0, 5) * 20.0])
	_check("duo Aufnahmen", not from_member.is_empty() and str(dv.get("phase", "")) == "results",
		"vom Mitspieler am Server: %s, Server %s" % [from_member, dv.get("phase", "")])
	_check("duo Pack", hook._upload_state in ["local", "done"], "Pack beim Host: %s" % hook._upload_state)
	# Nächste Runde vorbereiten (gleiches Pack): der Mitspieler muss seine Szene verlassen und neu betreten
	hook._leave_hub()
	await _wait(5.0)
	dm = await _enter_dub(vg)
	await _wait(20.0)
	await d._shot("duo_zweite_lobby")
	d._note("Zweite Runde, Lobby: %s" % [vg.dub_hook._dub().get("players", []).map(func(p): return "%s bereit=%s eigen=%s" % [p.id, p.get("ready"), p.get("own")])])
	vg.dub_hook._leave_hub()
	await _wait(5.0)
	var tmp := ProjectSettings.globalize_path(TEMP_SESSION)
	if DirAccess.dir_exists_absolute(tmp):
		OS.move_to_trash(tmp)
	_copy_results()
	d._note("ENDE")


func _game_members(vg) -> Array:
	return vg.bridge.web_players().filter(func(p): return p.get("game", false) and p.get("connected", false))


## Plan „dubmitglied“: tritt dem Raum aus DUO_ROOM_FILE bei (Code, den der Host schreibt) und spielt im eigenen Spiel mit.
func _member() -> void:
	var master: Node = await d._wait_for(func(n): return n.has_method("NewSlide"))
	master.NewSlide("res://scenes/nav_specific/play_flow/select_member_count.tscn", false)
	var menu: Node = await d._wait_for(func(n): return n.scene_file_path.ends_with("select_member_count.tscn"))
	await _wait(1.5)
	var vg = d.get_node("/root/Voicigame")
	vg._open_lobby(menu)
	await _wait(1.0)
	vg._lobby._on_join()
	await _wait(1.0)
	var room_file := OS.get_environment("DUO_ROOM_FILE")
	var code := ""
	for i in 240:
		if FileAccess.file_exists(room_file):
			code = FileAccess.get_file_as_string(room_file).strip_edges()
		if code.length() == 4:
			break
		await _wait(0.5)
	d._note("Tritt bei: %s" % code)
	vg._join.join(code, "PC-Freund")
	var t := 0.0
	var last := ""
	while t < 240.0 and not (is_instance_valid(vg.dub_hook) and vg.dub_hook.member):
		await _wait(0.5)
		t += 0.5
		var now := "Beitreten: %s %s %%" % [vg._join._pack_state, vg._join._pack_pct]
		if now != last:
			d._note(now)
			last = now
	var hook = vg.dub_hook
	if not is_instance_valid(hook):
		d._note("FEHLER: nicht in die Dub-Szene gekommen")
		return
	d._note("In der Dub-Szene, Pack: %s" % vg._join._pack_path)
	await _wait(3.0)
	await d._shot("mitglied_lobby")
	hook._claim_local("Sneakers O'Toole")
	# Statt Mikrofon die Originalzeile (wie perfekt nachgesprochen), kurz nach dem Anhören
	hook._test_local = func(i): return hook.dm.performance_array[i].shared_omniclip.clip_audio
	hook.test_local_delay_ms = 1500
	t = 0.0
	last = ""
	while t < 900.0 and not (is_instance_valid(hook) and hook._finished):
		await _wait(0.5)
		t += 0.5
		if not is_instance_valid(hook) or not is_instance_valid(hook.dm):
			break
		var now := "Spiel Zeile %d, Leiste: %s" % [hook.dm.clip_index + 1, hook._banner_text.text.replace("\n", " / ")]
		if now != last:
			d._note(now)
			last = now
	if not is_instance_valid(hook):
		d._note("FEHLER: Dub-Szene vorzeitig verlassen")
		return
	await _wait(3.0)
	await d._shot("mitglied_ergebnis")
	for i in hook.dm.performance_array.size():
		var inst = hook.dm.performance_array[i]
		var a = inst.member_audio
		d._note("Zeile %d %s: %s %.2f s, Wertung %.0f %%" % [i + 1, inst.shared_omniclip.file_name_agnostic,
			a.get_class() if a else "KEINE", a.get_length() if a else 0.0, clampf(inst.score, 0, 5) * 20.0])
	var mine: Array = hook._dub().get("takes", []).filter(func(x): return str(x.playerId) == hook._me).map(func(x): return x.clipId)
	_check("mitglied Aufnahmen", not mine.is_empty(), "eigene Aufnahmen am Server: %s" % [mine])
	# Host bereitet die nächste Runde vor: die Szene muss sich von selbst schließen
	t = 0.0
	while t < 30.0 and is_instance_valid(vg.dub_hook) and vg.dub_hook == hook:
		await _wait(0.5)
		t += 0.5
	_check("mitglied verlässt", not is_instance_valid(hook) or vg.dub_hook != hook, "Szene nach der Runde verlassen nach %.0f s" % t)
	d._note("ENDE")


func _enter_dub(vg) -> Node:
	var res = GameplayResourceDubMode.new(TEST_PACK)
	d._note("Test-Pack: %d Zeilen, Video: %s" % [res.omni_clip_array.data.size(), res.video != null])
	var metro = d.get_node("/root/Metro")
	var m = d.get_node("/root/M")
	m.session_type = m.SESSION_TYPE.VIDEO_DUB
	metro.gameplay_resource_dub_mode = res
	m.world.enter_dub_mode()
	var dm: Node = await d._wait_for(func(n): return n.scene_file_path.ends_with("dub_mode.tscn") and not n.is_queued_for_deletion(), 20.0)
	await _wait(1.5)
	var hook = vg.dub_hook
	# Spieler am PC: statt Mikrofon die Originalzeile (wie perfekt nachgesprochen), kurz nach dem Anhören
	hook._test_local = func(i): return dm.performance_array[i].shared_omniclip.clip_audio
	hook.test_local_delay_ms = 1500
	return dm


func _start_when_ready(hook) -> void:
	var dv: Dictionary = hook._dub()
	var t := 0.0
	while t < 40.0 and not (dv.get("canStart", {}).get("ok", false) and (OS.get_environment("CLAIM") == "" or dv.get("characters", []).any(
			func(c): return c.get("claimedBy") != null and str(c.get("claimedBy")) != "local-1"))):
		await _wait(0.5)
		t += 0.5
		dv = hook._dub()
	d._note("Figuren beim Start: %s" % [dv.get("characters", []).map(func(c): return "%s=%s" % [c.name, c.claimedBy])])
	# Raum aus dem Spiel: der PC leitet, kein Handy hat Leitungsrechte
	_check("Leitung am PC", dv.get("leader") == null, "Spielleitung laut Server: %s" % [dv.get("leader")])
	var sv = hook.dm.get("video_player_static")
	d._note("Rauschen unter der Lobby: %s dB" % [sv.volume_db if sv is VideoStreamPlayer else "?"])
	hook.start_round(true)
