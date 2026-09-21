extends RefCounted
## Nur für Tests: Dub-Pläne für den Testtreiber (Umgebungsvariable VOICIGAME_TEST, beginnt mit "dub").
##   dubshot   Fotos vom Dub-Modus des Spiels (ohne Handy), zum Vergleich mit der Webseite
##   dub       ganze Runde: Lobby, Pack hochladen, PC + zwei Web-Handys, Ergebnis, gemeinsam anschauen, Export
##             Handys: tools/fake-dub-phone.js (run_test.ps1 startet eines, ein zweites startet der Aufrufer)

const SOURCE_PACK := "user://game/packs_voice/Family Guy - Sneakers O'Toole/"
const TEST_PACK := "user://voicigame_test/pack/Voicigame Dub [Test]/"
const TEMP_SESSION := "user://game/.temp/dub_mode/Voicigame Dub [Test]"

var d: Node   # der Testtreiber (Fotos, Protokoll, Suchen)


func run(driver: Node, plan: String) -> void:
	d = driver
	match plan:
		"dubshot":
			await _dubshot()
		"dub":
			await _dub()
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
	var res = GameplayResourceDubMode.new(SOURCE_PACK)
	if res.failed_to_load:
		d._note("FEHLER: Test-Pack nicht lesbar")
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


func _dub() -> void:
	if not _make_test_pack():
		d._note("FEHLER: Test-Pack nicht kopiert")
		return
	# Schein-Solo-Sitzung für das Test-Pack: muss nach der Runde unverändert zurück sein
	DirAccess.make_dir_recursive_absolute(TEMP_SESSION)
	var marker := FileAccess.open(TEMP_SESSION + "/voicigame_test_marker.txt", FileAccess.WRITE)
	marker.store_string("solo")
	marker.close()
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
	await d._shot("lobby")
	if vg.bridge.web_players().is_empty():
		d._note("FEHLER: kein Web-Spieler")
		return

	# „Synchronisieren“ in der Lobby: Dub-Auswahl des Spiels öffnet sich
	vg._start_dub(true)
	await _wait(2.5)
	await d._shot("dub_auswahl")
	# Pack wählen wie in der Dub-Auswahl (ohne Mausklicks)
	var res = GameplayResourceDubMode.new(TEST_PACK)
	d._note("Test-Pack: %d Zeilen, Video: %s" % [res.omni_clip_array.data.size(), res.video != null])
	var metro = d.get_node("/root/Metro")
	var m = d.get_node("/root/M")
	metro.gameplay_resource_dub_mode = res
	m.world.enter_dub_mode()
	var dm: Node = await d._wait_for(func(n): return n.scene_file_path.ends_with("dub_mode.tscn"), 20.0)
	await _wait(1.5)
	var hook = vg.dub_hook
	if hook == null:
		d._note("FEHLER: Dub-Hook nicht angehängt")
		return
	# Spieler am PC: statt Mikrofon die Originalzeile (wie perfekt nachgesprochen)
	hook._test_local = func(i): return dm.performance_array[i].shared_omniclip.clip_audio
	t = 0.0
	while hook._upload_state != "done" and t < 60.0:
		await _wait(0.5)
		t += 0.5
	d._note("Pack hochgeladen: %s nach %.1f s" % [hook._upload_state, t])
	hook._claim_local("Brian")
	await _wait(4.0)
	await d._shot("hub")
	var dv: Dictionary = hook._dub()
	d._note("Figuren: %s" % [dv.get("characters", []).map(func(c): return "%s=%s" % [c.name, c.claimedBy])])
	t = 0.0
	while not dv.get("canStart", {}).get("ok", false) and t < 40.0:
		await _wait(0.5)
		t += 0.5
		dv = hook._dub()
	d._note("Start möglich: %s (%s)" % [dv.get("canStart", {}).get("ok", false), dv.get("canStart", {}).get("reason", "")])
	# Mit CLAIM (Umgebungsvariable, gilt auch fürs Test-Handy) warten, bis das Handy seine Figuren hat
	t = 0.0
	while OS.get_environment("CLAIM") != "" and t < 30.0 and not dv.get("characters", []).any(
			func(c): return c.get("claimedBy") != null and str(c.get("claimedBy")) != "local-1"):
		await _wait(0.5)
		t += 0.5
		dv = hook._dub()
	d._note("Figuren beim Start: %s" % [dv.get("characters", []).map(func(c): return "%s=%s" % [c.name, c.claimedBy])])
	hook.start_round(true)

	# Runde laufen lassen
	var last := ""
	var step := 0
	while not (dm.performing_finished and hook._scores_sent) and step < 600:
		await _wait(0.5)
		step += 1
		dv = hook._dub()
		var turn = dv.get("turn")
		var now := "Spiel Zeile %d, Server %s %s, Leiste: %s" % [dm.clip_index + 1, dv.get("phase", ""),
			str(turn.get("clipId", "")) if turn is Dictionary else "", hook._banner_text.text]
		if now != last:
			d._note(now)
			last = now
		if step % 8 == 0:
			await d._shot("runde_%03d" % step)
	await _wait(2.0)
	await d._shot("ergebnis")
	d._note("Aufnahmen am Server: %d, Wertungen vom Spiel: %s" % [dv.get("takes", []).size(), str(dv.get("gameScores", {}))])
	for i in dm.performance_array.size():
		var inst = dm.performance_array[i]
		var a = inst.member_audio
		d._note("Zeile %d %s: %s %.2f s, Wertung %.0f %%" % [i + 1, inst.shared_omniclip.file_name_agnostic,
			a.get_class() if a else "KEINE", a.get_length() if a else 0.0, clampf(inst.score, 0, 5) * 20.0])

	# Gemeinsam anschauen (startet auch in den Browsern)
	hook.request_watch()
	await _wait(4.5)
	await d._shot("anschauen")
	await _wait(5.0)
	await d._shot("anschauen2")
	# Export
	hook.request_export()
	t = 0.0
	while hook._export_state != "done" and hook._export_state != "error" and t < 120.0:
		await _wait(1.0)
		t += 1.0
	await d._shot("export")
	var size := FileAccess.open(hook._export_file, FileAccess.READ).get_length() if FileAccess.file_exists(hook._export_file) else 0
	d._note("Export: %s, %s, %d Bytes" % [hook._export_state, hook._export_file.get_file(), size])
	d._note("Während der Runde beiseitegelegt: %s" % DirAccess.dir_exists_absolute(TEMP_SESSION + " (vor Voicigame)"))
	# Zurück zur Auswahl: Solo-Sitzung muss wieder da sein
	hook._leave_hub()
	await _wait(4.0)
	await d._shot("zurueck")
	d._note("Solo-Sitzung zurück: %s, Zwischenstände der Runde weg: %s" % [FileAccess.file_exists(TEMP_SESSION + "/voicigame_test_marker.txt"),
		DirAccess.get_files_at(TEMP_SESSION).size() == 1])
	# Aufräumen: Zwischenstände, die das Spiel für das Test-Pack angelegt hat, in den Papierkorb
	var tmp := ProjectSettings.globalize_path(TEMP_SESSION)
	if DirAccess.dir_exists_absolute(tmp):
		OS.move_to_trash(tmp)
		d._note("Zwischenstände des Test-Packs in den Papierkorb")
	_copy_results()
	d._note("ENDE")
