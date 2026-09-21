extends Node
## Nur für Tests, wird nicht mit dem Mod ausgeliefert.
## Steuert das Spiel ohne Mausklicks und speichert Bildschirmfotos nach user://voicigame_test/.
## Welche Schritte: Umgebungsvariable VOICIGAME_TEST, z. B. "lobby".

var _shots := 0
var _log := PackedStringArray()
var _beat := 0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var plan := OS.get_environment("VOICIGAME_TEST")
	if plan == "":
		return
	DirAccess.make_dir_recursive_absolute("user://voicigame_test")
	_run(plan)


## Lebenszeichen alle 5 s: bleibt es aus, hängt das ganze Spiel (nicht nur der Testablauf).
func _process(_delta: float) -> void:
	if OS.get_environment("VOICIGAME_TEST") == "":
		return
	var now := Time.get_ticks_msec()
	if now - _beat >= 5000:
		_beat = now
		print("TEST | lebt %d s, time_scale %.2f, paused %s" % [now / 1000, Engine.time_scale, get_tree().paused])


func _note(text: String) -> void:
	print("TEST | " + text)
	_log.append(text)
	var f := FileAccess.open("user://voicigame_test/log.txt", FileAccess.WRITE)
	if f:
		f.store_string("\n".join(_log))
		f.close()


func _shot(name: String) -> void:
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	_shots += 1
	img.save_png("user://voicigame_test/%02d_%s.png" % [_shots, name])
	_note("Foto %s" % name)


func _find(pred: Callable, root: Node = null) -> Node:
	root = root if root else get_tree().root
	if pred.call(root):
		return root
	for c in root.get_children():
		var hit := _find(pred, c)
		if hit:
			return hit
	return null


func _wait_for(pred: Callable, seconds := 20.0) -> Node:
	var t := 0.0
	while t < seconds:
		var n := _find(pred)
		if n:
			return n
		await get_tree().create_timer(0.25).timeout
		t += 0.25
	return null


func _run(plan: String) -> void:
	_note("Plan: " + plan)
	# Erst wenn der Startbildschirm fertig geladen ist, sonst stürzt das Originalspiel beim Überspringen ab
	var opening := await _wait_for(func(n): return n.name == "OpeningScreen" and n.has_method("down") and n.is_node_ready())
	if opening and is_instance_valid(opening) and opening.get("accept_input"):
		opening.down()
		_note("Startbildschirm übersprungen")
	var master := await _wait_for(func(n): return n.has_method("NewSlide"))
	if master == null:
		_note("FEHLER: Menü nicht gefunden")
		return
	await get_tree().create_timer(2.0).timeout
	if plan.begins_with("dub"):
		await preload("test_dub.gd").new().run(self, plan)
		return
	master.NewSlide("res://scenes/nav_specific/play_flow/select_member_count.tscn", false)
	var menu := await _wait_for(func(n): return n.scene_file_path.ends_with("select_member_count.tscn"))
	await get_tree().create_timer(1.5).timeout
	var tile := menu.get_node_or_null("MarginContainer/HBoxContainer/VoicigameTile") if menu else null
	_note("Kachel da: %s, sichtbar: %s" % [tile != null, tile != null and tile.is_visible_in_tree()])
	var vgn := get_node_or_null("/root/Voicigame")
	_note("Mod geladen aus: %s" % (vgn.get_script().resource_path if vgn else "-"))
	await _shot("solo_gruppe")
	if plan == "menu" or tile == null:
		_note("ENDE")
		return
	var vg := get_node_or_null("/root/Voicigame")
	vg._open_lobby(menu)
	await get_tree().create_timer(1.5).timeout
	await _shot("auswahl")
	if plan == "join":
		await _run_join(vg)
		return
	vg._lobby._show_host()
	await get_tree().create_timer(4.0).timeout
	await _shot("lobby")
	_note("Raum: %s, verbunden: %s" % [vg.bridge.room_code, vg.bridge.connected])
	var f := FileAccess.open("user://voicigame_test/room.txt", FileAccess.WRITE)
	f.store_string(vg.bridge.room_code)
	f.close()
	if plan == "lobby":
		_note("ENDE")
		return

	# Auf das simulierte Handy warten
	var t := 0.0
	while vg.bridge.web_players().is_empty() and t < 30.0:
		await get_tree().create_timer(0.5).timeout
		t += 0.5
	_note("Web-Spieler: %s" % [vg.bridge.web_players().map(func(p): return p.name)])
	await _shot("lobby_mit_spieler")
	if vg.bridge.web_players().is_empty():
		_note("FEHLER: kein Web-Spieler")
		return

	# Sitzung starten: PC spielt mit, dazu der Web-Spieler
	vg._start_session(true)
	await get_tree().create_timer(2.0).timeout
	var metro = get_node("/root/Metro")
	_note("Mitspieler: %s" % [metro.current_players.map(func(m): return "%s|%s" % [m.pack_reference_name, m.input_device_name])])

	# Gameshow mit zwei Clips aus dem Tutorial-Pack
	var m = get_node("/root/M")
	m.session_type = m.SESSION_TYPE.STANDARD
	var base := ProjectSettings.globalize_path("user://game/packs_voice/The Choicer Voicer Tutorial Pack/")
	var clips: Array[OmniClip] = []
	for i in [1, 2]:
		var c := OmniClip.new()
		c.generate_from_audio_file_exact(base + "ChoicerVoicerTutorialPack%d.wav" % i)
		clips.append(c)
	metro.gameplay_omniclip_set = clips
	_note("Clips: %d" % clips.size())
	m.world.CreateMatch()

	# Spiel laufen lassen: Moderator weiterklicken, regelmäßig fotografieren, Zustand mitschreiben
	var last := ""
	for step in 400:
		await get_tree().create_timer(0.5).timeout
		var mm := _find(func(n): return n.has_method("GENERIC_RF_RecordContestants"))
		if mm:
			var dyn: Dictionary = mm.dynasteen
			var scores := []
			for c in mm.conte_slots:
				scores.append(c.round_scores)
			var now := "Runde %d, dran %d, Punkte %s" % [dyn.round, dyn.on_contestant, scores]
			if now != last:
				_note(now)
				last = now
			if step % 12 == 0:
				await _shot("match_%03d" % step)
			# Runde bewertet: „Next Round" drücken (ERB.FINISH = 9)
			if scores.size() and scores.all(func(x): return x.size() > dyn.round) and step % 6 == 0:
				mm.match_buttons.button_index.emit(9)
			if scores.size() and scores.all(func(x): return x.size() >= 2):
				_note("Zwei Runden bewertet")
				await _shot("ergebnis")
				_note("ENDE")
				return
		var ev := InputEventAction.new()
		ev.action = "ui_accept"
		ev.pressed = true
		Input.parse_input_event(ev)
		var ev2 := InputEventAction.new()
		ev2.action = "ui_accept"
		ev2.pressed = false
		Input.parse_input_event(ev2)
	_note("FEHLER: Zeit abgelaufen")


## Plan „join": dieser PC tritt einem Raum bei, den tools/fake-host.js aufmacht, und spielt zwei Runden mit.
func _run_join(vg: Node) -> void:
	vg._lobby._on_join()
	await get_tree().create_timer(1.0, true, false, true).timeout
	await _shot("beitreten")
	var code := ""
	for i in 60:
		if FileAccess.file_exists("user://voicigame_test/host_room.txt"):
			code = FileAccess.get_file_as_string("user://voicigame_test/host_room.txt").strip_edges()
		if code.length() == 4:
			break
		await get_tree().create_timer(0.5, true, false, true).timeout
	_note("Raum vom Test-Host: %s" % code)
	var delay := float(OS.get_environment("VG_JOIN_DELAY")) if OS.get_environment("VG_JOIN_DELAY") != "" else 0.0
	if delay > 0.0:
		_note("warte %d s vor dem Beitreten" % delay)
		await get_tree().create_timer(delay, true, false, true).timeout
	var js: Node = vg._join
	js.join(code, "PC-Test")
	for i in 40:
		if js.client.player_id != "":
			break
		await get_tree().create_timer(0.25, true, false, true).timeout
	_note("Beigetreten als %s" % js.client.player_id)
	await get_tree().create_timer(1.0, true, false, true).timeout
	await _shot("raum")
	var scores_before := "[]"
	var round_id := ""
	for n in 2:
		for i in 120:
			if not js._round.is_empty() and str(js._round.roundId) != round_id and js.client.clip(str(js._round.clipId)) != null and js._phase == "":
				break
			await get_tree().create_timer(0.5, true, false, true).timeout
		round_id = str(js._round.get("roundId", ""))
		_note("Runde %d: %s, Clip geladen: %s" % [n + 1, round_id, js.client.clip(str(js._round.get("clipId", ""))) != null])
		await _shot("runde_%d" % (n + 1))
		js._on_listen()
		await get_tree().create_timer(1.5, true, false, true).timeout
		js._on_go()
		await get_tree().create_timer(4.2, true, false, true).timeout
		await _shot("aufnahme_%d" % (n + 1))
		for i in 60:
			if js._phase in ["sent", "error"]:
				break
			await get_tree().create_timer(0.5, true, false, true).timeout
		_note("Nach dem Senden: %s %s" % [js._phase, js._error])
		await _shot("gesendet_%d" % (n + 1))
		for i in 40:
			if str(js._scores) != scores_before and not js._scores.is_empty():
				break
			await get_tree().create_timer(0.5, true, false, true).timeout
		scores_before = str(js._scores)
		_note("Punkte: %s" % [js._scores])
		await _shot("punkte_%d" % (n + 1))
		await get_tree().create_timer(2.0, true, false, true).timeout
	for i in 40:
		if not js._ranking.is_empty():
			break
		await get_tree().create_timer(0.5, true, false, true).timeout
	await get_tree().create_timer(1.0, true, false, true).timeout
	_note("Rangliste: %s" % [js._ranking])
	await _shot("rangliste")
	_note("ENDE")
