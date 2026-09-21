extends Node
## Dub-Modus (Synchronisieren) mit Web-Spielern.
##
## Hängt sich an die Dub-Szene des Spiels (Original und Steam-Mod-Fassung) und macht daraus eine
## gemeinsame Runde:
##   Lobby       Pack geht an den Server, Web-Spieler laden es; Figuren claimen, der Reihe nach, Start
##   Zeile am PC normales Spiel: anhören, aufnehmen, weiter; die Aufnahme geht danach an den Server
##   Zeile im Web  Knöpfe gesperrt, bis die Aufnahme vom Handy da ist; dann läuft sie über den
##               Mikrofon-Kanal „Plmic“ durch die Aufnahme des Spiels (Wellenform, Wertung wie am PC)
##   Ende        Ergebnis des Spiels, „Watch“ startet auf allen Geräten gleichzeitig, Video-Export
##
## Zeile mit zwei Figuren von zwei Leuten: jeder nimmt getrennt auf, das Spiel bekommt die Mischung.

const WavUtil = preload("wav_util.gd")
const I18n = preload("i18n.gd")
const LOCAL_ID := "local-1"
const CHUNK := 8 * 1024 * 1024
const BUTTON_SCENE := "res://scene/module/button/button_cv.tscn"
const FONT_BOLD := "res://graphic/font/Waukegan LDO Extended Bold.ttf"
const FONT_TEXT := "res://graphic/font/DuruSans-Regular.ttf"

signal pack_uploaded

var bridge: Node
var dm: Node                     # Dub-Szene des Spiels
var host_plays := true
var order: Array = []            # Zeilen in der Reihenfolge des Spiels (ohne übernommene)
var use_as_is: Array = []
var export_dir := ""             # wohin exportierte Videos kommen

# Hochladen
var _files: Array = []           # [{name, path, size}]
var _up_index := 0
var _up_offset := 0
var _up_total := 0
var _up_done := 0
var _upload_state := ""          # "" | uploading | commit | done | error
var _http: HTTPRequest
var _jobs: Array = []
var _job = null

# Spielablauf
var _started := false
var _game_index := -1
var _busy := false
var _idle_count := 0
var _engage_ref := -1
var _takes := {}                 # "clip|pid|v" -> AudioStreamWAV
var _loading := {}
var _uploaded_local := {}        # Index -> true
var _mix_later := {}             # Index -> true (Web-Aufnahme in die PC-Aufnahme mischen)
var _skipped := {}               # Index -> true
var _finished := false
var _scores_sent := false
var _test_local = null           # nur Tests: statt Mikro diese Aufnahme für den PC-Spieler

# Uhr (für gemeinsames Anschauen)
var _offset_ms := 0.0
var _best_rtt := INF
var _watch_timer: Timer

# Export
var _export_http: HTTPRequest
var _export_file := ""
var _export_state := ""

# Anzeige
var _layer: CanvasLayer
var _hub: Control
var _banner: PanelContainer
var _banner_text: Label
var _banner_btns: VBoxContainer
var _hub_title: Label
var _hub_upload: Label
var _hub_status: Label
var _players_box: VBoxContainer
var _chars_box: VBoxContainer
var _chat_box: VBoxContainer
var _chat_input: LineEdit
var _chrono: CheckBox
var _btn_start: Control
var _btn_force: Control
var _code: Label
var _qr: TextureRect
var _last_sig := ""


## Übersetzbar: deutscher Text ist die Quelle, {} sind Platzhalter (siehe i18n.gd)
static func _t(text: String, args: Array = []) -> String:
	return I18n.t(text, args)


func attach(dub_node: Node, b: Node, plays: bool) -> void:
	dm = dub_node
	bridge = b
	host_plays = plays
	process_mode = Node.PROCESS_MODE_ALWAYS
	export_dir = _default_export_dir()
	_http = HTTPRequest.new()
	_http.timeout = 120.0
	_http.request_completed.connect(_on_http_done)
	add_child(_http)
	_watch_timer = Timer.new()
	_watch_timer.one_shot = true
	_watch_timer.timeout.connect(_watch_now)
	add_child(_watch_timer)
	for inst in dm.performance_array:
		order.append(str(inst.shared_omniclip.file_name_agnostic))
	for inst in dm.unperformance_array:
		use_as_is.append(str(inst.shared_omniclip.file_name_agnostic))
	# Spielablauf übernimmt der Mod: kein „Begin“, keine Frage nach der alten Sitzung (bleibt gespeichert)
	dm.btn_begin.hide()
	if dm.load_last_session_prompt:
		dm.load_last_session_prompt.hide()
	dm.audio_interface_manager.idled.connect(func(): _idle_count += 1)
	_rewire_watch()
	bridge.message_received.connect(_on_message)
	bridge.state_changed.connect(func(_s): _refresh())
	dm.tree_exiting.connect(_on_scene_left)
	_build_ui()
	var local := []
	if host_plays:
		local.append({"slot": 1, "name": _pc_name()})
	bridge._send({"type": "local.set", "players": local})
	_sync_clock()
	_start_upload()
	_refresh()


func _pc_name() -> String:
	var m = get_node_or_null("/root/M")
	var cfg = m.get("config") if m else null
	if cfg and cfg.get("player") is Dictionary:
		var n := str(cfg.player.get("name", "")).strip_edges()
		if n != "":
			return n
	return "PC"


func _default_export_dir() -> String:
	if OS.get_environment("VOICIGAME_TEST") != "":
		return ProjectSettings.globalize_path("user://voicigame_test/")
	return OS.get_system_dir(OS.SYSTEM_DIR_MOVIES).path_join("Voicigame") + "/"


func _dub() -> Dictionary:
	var d = bridge.state.get("dub")
	return d if d is Dictionary else {}


func _player_name(pid: String) -> String:
	for p in bridge.state.get("players", []):
		if str(p.get("id", "")) == pid:
			return str(p.get("name", "?"))
	return "?"


# ------------------------------------------------------------------
# Pack hochladen (in Stücken, damit große Videos nicht im Speicher liegen)
# ------------------------------------------------------------------

func _pack_dir() -> String:
	var res = dm.resource
	return str(res.pack_info.global_folder_path)


func _start_upload() -> void:
	var dir := _pack_dir()
	_files.clear()
	_up_total = 0
	for f in DirAccess.get_files_at(dir):
		if f.begins_with(".") or f.to_lower() in ["desktop.ini", "thumbs.db"] or f.ends_with(".import"):
			continue
		var size := FileAccess.open(dir + f, FileAccess.READ).get_length() if FileAccess.file_exists(dir + f) else 0
		_files.append({"name": f, "path": dir + f, "size": size})
		_up_total += size
	# Kleine Dateien zuerst, das Video zuletzt
	_files.sort_custom(func(a, b): return a["size"] < b["size"])
	var key := "%s|%d|%d" % [dir, _files.size(), _up_total]
	var d := _dub()
	var have_pack = d.get("packStatus", {}).get("status", "") == "ready" if d.get("packStatus") is Dictionary else false
	if bridge.has_meta("dub_pack_key") and bridge.get_meta("dub_pack_key") == key and have_pack:
		_upload_state = "commit"
		_commit(true)
		return
	bridge.set_meta("dub_pack_key", key)
	_upload_state = "uploading"
	_up_index = 0
	_up_offset = 0
	_up_done = 0
	_http_job(HTTPClient.METHOD_POST, "/api/rooms/%s/dub/pack/begin" % bridge.room_code, [], PackedByteArray(), _on_begin_done)


func _on_begin_done(code: int, body: PackedByteArray) -> void:
	if code != 200:
		_upload_failed(code, body)
		return
	_upload_next()


func _upload_next() -> void:
	if _up_index >= _files.size():
		_upload_state = "commit"
		_commit(false)
		return
	var f: Dictionary = _files[_up_index]
	var fa := FileAccess.open(f.path, FileAccess.READ)
	var chunk := PackedByteArray()
	if fa:
		fa.seek(_up_offset)
		chunk = fa.get_buffer(mini(CHUNK, int(f["size"]) - _up_offset))
		fa.close()
	var url := "/api/rooms/%s/dub/pack/file?name=%s&offset=%d" % [bridge.room_code, str(f.name).uri_encode(), _up_offset]
	_http_job(HTTPClient.METHOD_PUT, url, ["Content-Type: application/octet-stream"], chunk, _on_chunk_done.bind(chunk.size(), int(f["size"])))


func _on_chunk_done(code: int, body: PackedByteArray, sent: int, file_size: int) -> void:
	if code != 200:
		_upload_failed(code, body)
		return
	_up_offset += sent
	_up_done += sent
	if _up_offset >= file_size:
		_up_index += 1
		_up_offset = 0
	_refresh()
	_upload_next()


func _commit(reuse: bool) -> void:
	var durations := []
	for inst in dm.performance_array:
		var a = inst.shared_omniclip.clip_audio
		durations.append({"id": str(inst.shared_omniclip.file_name_agnostic), "duration": a.get_length() if a else 0.0})
	var res = dm.resource
	var body := {"order": order + use_as_is, "useAsIs": use_as_is, "title": str(res.pack_info.display_name),
		"folder": str(res.pack_info.folder_name).trim_suffix("/"), "durations": durations, "reuse": reuse}
	_http_job(HTTPClient.METHOD_POST, "/api/rooms/%s/dub/pack/commit" % bridge.room_code, ["Content-Type: application/json"],
		JSON.stringify(body).to_utf8_buffer(), _on_commit_done.bind(reuse))


func _on_commit_done(code: int, resp: PackedByteArray, reuse: bool) -> void:
	if code != 200:
		if reuse:
			# Pack ist doch nicht mehr da: neu hochladen
			bridge.remove_meta("dub_pack_key")
			_start_upload()
			return
		_upload_failed(code, resp)
		return
	_upload_state = "done"
	pack_uploaded.emit()
	_refresh()


func _upload_failed(code: int, body: PackedByteArray) -> void:
	_upload_state = "error"
	var msg := body.get_string_from_utf8()
	var j = JSON.parse_string(msg)
	if j is Dictionary and j.has("error"):
		msg = str(j.error)
	push_warning("Voicigame: Pack-Upload fehlgeschlagen (%d): %s" % [code, msg])
	_hub_upload.text = _t("Hochladen fehlgeschlagen: {}", [_t(msg)])
	bridge.remove_meta("dub_pack_key")


# ------------------------------------------------------------------
# HTTP-Warteschlange (eigene, damit das große Pack die Aufnahmen nicht aufhält)
# ------------------------------------------------------------------

func _http_job(method: int, path: String, headers: Array, body: PackedByteArray, cb: Callable, urgent := false) -> void:
	var h := PackedStringArray(headers)
	h.append("X-Host-Key: " + bridge.host_key)
	var job := {"method": method, "url": bridge.server_url + path, "headers": h, "body": body, "cb": cb}
	if urgent:
		_jobs.push_front(job)
	else:
		_jobs.append(job)
	_next_job()


func _next_job() -> void:
	if _job != null or _jobs.is_empty() or not is_instance_valid(_http):
		return
	_job = _jobs.pop_front()
	var err := _http.request_raw(_job.url, _job.headers, _job.method, _job.body)
	if err != OK:
		var cb: Callable = _job.cb
		_job = null
		cb.call(0, PackedByteArray())
		_next_job()


func _on_http_done(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	var cb: Callable = _job.cb if _job else Callable()
	_job = null
	if cb.is_valid():
		cb.call(code, body)
	_next_job()


# ------------------------------------------------------------------
# Nachrichten vom Server
# ------------------------------------------------------------------

func _on_message(msg: Dictionary) -> void:
	match str(msg.get("type", "")):
		"dub.time":
			var now := Time.get_unix_time_from_system() * 1000.0
			var rtt := now - float(msg.get("t", 0))
			if rtt >= 0.0 and rtt < _best_rtt:
				_best_rtt = rtt
				_offset_ms = float(msg.get("server", 0)) - (float(msg.get("t", 0)) + rtt / 2.0)
		"dub.take":
			_download_take(str(msg.get("clipId", "")), str(msg.get("playerId", "")), 0)
		"dub.watch":
			var at := float(msg.get("at", 0)) - _offset_ms
			var delay := (at - Time.get_unix_time_from_system() * 1000.0) / 1000.0
			_watch_timer.start(maxf(0.01, delay))
		"dub.watch.stop":
			_watch_timer.stop()
			if is_instance_valid(dm) and dm.has_method("stop"):
				dm.stop()


func _sync_clock() -> void:
	_best_rtt = INF
	for i in 5:
		get_tree().create_timer(0.25 * i).timeout.connect(_send_time)


func _send_time() -> void:
	bridge._send({"type": "dub.time", "t": Time.get_unix_time_from_system() * 1000.0})


# ------------------------------------------------------------------
# Aufnahmen vom Handy holen
# ------------------------------------------------------------------

func _take_key(clip_id: String, pid: String) -> String:
	return clip_id + "|" + pid


func _download_take(clip_id: String, pid: String, _v) -> void:
	var k := _take_key(clip_id, pid)
	if _takes.has(k) or _loading.has(k) or pid.begins_with("local-"):
		return
	_loading[k] = true
	var url := "/api/rooms/%s/dub/takes/%s/%s" % [bridge.room_code, clip_id.uri_encode(), pid.uri_encode()]
	_http_job(HTTPClient.METHOD_GET, url, [], PackedByteArray(), _on_take_loaded.bind(k), true)


func _on_take_loaded(code: int, body: PackedByteArray, k: String) -> void:
	_loading.erase(k)
	if code != 200:
		return
	var s := WavUtil.from_wav_bytes(body)
	if s:
		_takes[k] = s


func _fetch_known_takes() -> void:
	for t in _dub().get("takes", []):
		_download_take(str(t.get("clipId", "")), str(t.get("playerId", "")), t.get("v"))


# ------------------------------------------------------------------
# Ablauf
# ------------------------------------------------------------------

func start_round(force := false) -> void:
	bridge._send({"type": "dub.start", "force": force})


## Unfertige Solo-Sitzung des Spiels für dieses Pack: während der Runde beiseitelegen, danach zurück.
## (Das Spiel legt Zwischenstände je Pack ab und würde sie sonst überschreiben.)
func _park_solo_session() -> void:
	var temp: String = dm.resource.get_temp_preserve_path().trim_suffix("/")
	if not DirAccess.dir_exists_absolute(temp) or bridge.has_meta("dub_parked"):
		return
	var parked := temp + " (vor Voicigame)"
	if DirAccess.dir_exists_absolute(parked):
		return   # schon beiseitegelegt, nichts überschreiben
	if DirAccess.rename_absolute(temp, parked) == OK:
		bridge.set_meta("dub_parked", [temp, parked])


## Nach einem Absturz: beiseitegelegte Solo-Sitzungen zurückholen (wird beim Start des Mods aufgerufen).
static func restore_parked() -> void:
	var root := "user://game/.temp/dub_mode/"
	if not DirAccess.dir_exists_absolute(root):
		return
	for dir in DirAccess.get_directories_at(root):
		if dir.ends_with(" (vor Voicigame)"):
			var orig := dir.trim_suffix(" (vor Voicigame)")
			if not DirAccess.dir_exists_absolute(root + orig):
				DirAccess.rename_absolute(root + dir, root + orig)


func _restore_solo_session() -> void:
	if not bridge.has_meta("dub_parked"):
		return
	var p: Array = bridge.get_meta("dub_parked")
	if DirAccess.dir_exists_absolute(p[0]):
		OS.move_to_trash(ProjectSettings.globalize_path(p[0]))
	if DirAccess.rename_absolute(p[1], p[0]) == OK:
		bridge.remove_meta("dub_parked")


func _begin() -> void:
	_park_solo_session()
	_started = true
	_game_index = dm.clip_index
	_engage_ref = _idle_count
	_hub.hide()
	dm._begin_from_idle()
	_refresh()


func _process(_delta: float) -> void:
	if not is_instance_valid(dm):
		return
	var d := _dub()
	if not _started:
		if str(d.get("phase", "")) in ["playing", "paused"] and _upload_state == "done":
			_begin()
		return
	_fetch_known_takes()
	if _busy:
		return
	var i: int = dm.clip_index
	if i != _game_index:
		_on_game_clip_changed(_game_index)
		_game_index = i
		_engage_ref = _idle_count
	if dm.performing_finished:
		_after_finish()
		return
	if i < 0 or i >= order.size():
		return
	var turn := _turn_for(order[i])
	if turn.is_empty():
		_block(true, _t("Warte auf den Server …"))
		return
	var recs: Array = turn.get("recorders", [])
	var web := recs.filter(func(p): return not str(p).begins_with("local-"))
	var local := recs.has(LOCAL_ID)
	if local:
		_block(false, _banner_local(web))
		if _test_local and _idle_count > _engage_ref:
			var s = _test_local.call(i)
			if s:
				_run_inject(s, true)
		return
	# Nur Web-Spieler sprechen diese Zeile
	var names := ", ".join(web.map(func(p): return _player_name(str(p))))
	if not _line_done_on_server(order[i]):
		var pause = d.get("pause")
		if pause is Dictionary:
			_block(true, _t("Pausiert: {} ist nicht verbunden.", [str(pause.get("name", ""))]))
		else:
			_block(true, _t("{} nimmt im Browser auf …", [names]))
		return
	if _idle_count <= _engage_ref:
		_block(true, _t("{} ist fertig, gleich kommt die Aufnahme …", [names]))
		return
	var takes := []
	for p in web:
		var k := _take_key(order[i], str(p))
		if _has_take_on_server(order[i], str(p)):
			if not _takes.has(k):
				_download_take(order[i], str(p), 0)
				_block(true, _t("Aufnahme von {} wird geladen …", [names]))
				return
			takes.append(_takes[k])
	_block(true, _t("Aufnahme von {}", [names]))
	if takes.is_empty():
		_skipped[i] = true
	_run_inject(_mix_to_clip(takes, i), true)


func _turn_for(clip_id: String) -> Dictionary:
	for t in _dub().get("turns", []):
		if str(t.get("clipId", "")) == clip_id:
			return t
	return {}


func _has_take_on_server(clip_id: String, pid: String) -> bool:
	for t in _dub().get("takes", []):
		if str(t.get("clipId", "")) == clip_id and str(t.get("playerId", "")) == pid:
			return true
	return false


## Hat der Server die Zeile abgeschlossen (alle Aufnahmen da oder übersprungen)?
func _line_done_on_server(clip_id: String) -> bool:
	var d := _dub()
	if str(d.get("phase", "")) == "results":
		return true
	var turns: Array = d.get("turns", [])
	var cur = d.get("turn")
	var cur_index := int(cur.get("index", -1)) if cur is Dictionary else turns.size()
	for j in turns.size():
		if str(turns[j].get("clipId", "")) == clip_id:
			return j < cur_index
	return false


func _banner_local(web: Array) -> String:
	var who := _pc_name()
	if web.is_empty():
		return _t("{} ist dran (am PC)", [who])
	return _t("{} spricht diese Zeile am PC, {} im Browser", [who, ", ".join(web.map(func(p): return _player_name(str(p))))])


## Eine Zeile ist fertig (Weiter gedrückt): Aufnahme vom PC hochladen, Web-Aufnahmen evtl. dazumischen.
func _on_game_clip_changed(prev: int) -> void:
	if prev < 0 or prev >= order.size():
		return
	var turn := _turn_for(order[prev])
	var recs: Array = turn.get("recorders", [])
	if not recs.has(LOCAL_ID) or _uploaded_local.has(prev):
		return
	_uploaded_local[prev] = true
	var inst = dm.performance_array[prev]
	var audio = inst.member_audio
	if audio is AudioStreamWAV:
		var url := "/api/rooms/%s/dub/takes/%s?player=%s" % [bridge.room_code, order[prev].uri_encode(), LOCAL_ID]
		_http_job(HTTPClient.METHOD_POST, url, ["Content-Type: audio/wav"], _wav_bytes(audio), _on_local_sent, true)
	if recs.size() > 1:
		_mix_later[prev] = true


func _on_local_sent(code: int, body: PackedByteArray) -> void:
	if code != 200:
		push_warning("Voicigame: PC-Aufnahme nicht angenommen (%d): %s" % [code, body.get_string_from_utf8()])


## Web-Aufnahmen, die zu einer PC-Zeile gehören, in die Aufnahme des Spiels mischen (sobald sie da sind).
func _apply_mix_later() -> void:
	for i in _mix_later.keys():
		var recs: Array = _turn_for(order[i]).get("recorders", [])
		var all := true
		var add := []
		for p in recs:
			if str(p) == LOCAL_ID:
				continue
			if not _line_done_on_server(order[i]):
				all = false
				break
			var k := _take_key(order[i], str(p))
			if _has_take_on_server(order[i], str(p)):
				if not _takes.has(k):
					all = false
					_download_take(order[i], str(p), 0)
					break
				add.append(_takes[k])
		if not all:
			continue
		_mix_later.erase(i)
		var inst = dm.performance_array[i]
		if inst.member_audio is AudioStreamWAV and not add.is_empty():
			var base: AudioStreamWAV = inst.member_audio
			inst.member_audio = _mix([base] + add, base.mix_rate, _samples(base, base.mix_rate).size())


# ------------------------------------------------------------------
# Web-Aufnahme durch die Aufnahme des Spiels schicken
# ------------------------------------------------------------------

## Wie im Spiel: Clip läuft, 0,125 s später beginnt die Aufnahme. Genau dann läuft statt des Mikrofons
## die Handy-Aufnahme in den Kanal „Plmic“. Wellenform, Wertung und Speichern macht das Spiel selbst.
func _run_inject(stream: AudioStream, then_next: bool) -> void:
	_busy = true
	var ms = get_node_or_null("/root/MicrophoneService")
	if ms == null:
		_busy = false
		return
	var player: AudioStreamPlayer = ms.player
	var mic_stream = player.stream
	var on_start := func():
		player.stream = stream
		player.play(0.0)
	ms.recording_started.connect(on_start, CONNECT_ONE_SHOT)
	var aim = dm.audio_interface_manager
	dm._enact()
	await aim.idled
	if ms.recording_started.is_connected(on_start):
		ms.recording_started.disconnect(on_start)
	player.stop()
	player.stream = mic_stream
	player.play()
	await get_tree().process_frame
	await get_tree().process_frame
	if then_next and is_instance_valid(dm) and not dm.performing_finished:
		# Das Spiel schaltet erst nach ein paar Frames weiter: so lange warten, sonst käme dieselbe Zeile noch einmal dran
		var before: int = dm.clip_index
		dm._button_next()
		var waited := 0.0
		while is_instance_valid(dm) and dm.clip_index == before and not dm.performing_finished and waited < 10.0:
			await get_tree().process_frame
			waited += get_process_delta_time()
	_busy = false


func _clip_frames(i: int, rate: int) -> int:
	var a = dm.performance_array[i].shared_omniclip.clip_audio
	return int(ceil((a.get_length() if a else 1.0) * rate))


## Web-Aufnahmen einer Zeile mischen und auf Clip-Länge bringen (Stille, wenn keine da ist).
func _mix_to_clip(takes: Array, i: int) -> AudioStreamWAV:
	return _mix(takes, 44100, _clip_frames(i, 44100))


static func _samples(s: AudioStreamWAV, rate: int) -> PackedFloat32Array:
	var mono := WavUtil.to_samples(s)
	if s.mix_rate == rate or mono.is_empty():
		return mono
	var n := int(mono.size() * float(rate) / float(s.mix_rate))
	var out := PackedFloat32Array()
	out.resize(n)
	var k := float(s.mix_rate) / float(rate)
	for i in n:
		var x := i * k
		var a := int(x)
		var f := x - a
		var v0 := mono[a] if a < mono.size() else 0.0
		var v1 := mono[a + 1] if a + 1 < mono.size() else 0.0
		out[i] = v0 * (1.0 - f) + v1 * f
	return out


static func _mix(streams: Array, rate: int, frames: int) -> AudioStreamWAV:
	var sum := PackedFloat32Array()
	sum.resize(frames)
	for s in streams:
		var p := _samples(s, rate)
		for i in mini(frames, p.size()):
			sum[i] += p[i]
	var data := PackedByteArray()
	data.resize(frames * 2)
	for i in frames:
		data.encode_s16(i * 2, int(clampf(sum[i], -1.0, 1.0) * 32767.0))
	var w := AudioStreamWAV.new()
	w.format = AudioStreamWAV.FORMAT_16_BITS
	w.mix_rate = rate
	w.stereo = false
	w.data = data
	return w


static func _wav_bytes(s: AudioStreamWAV) -> PackedByteArray:
	var data: PackedByteArray = s.data
	if s.format == AudioStreamWAV.FORMAT_8_BITS:
		var d16 := PackedByteArray()
		d16.resize(data.size() * 2)
		for i in data.size():
			d16.encode_s16(i * 2, data.decode_s8(i) * 256)
		data = d16
	elif s.format != AudioStreamWAV.FORMAT_16_BITS:
		return PackedByteArray()
	var ch := 2 if s.stereo else 1
	var h := PackedByteArray()
	h.append_array("RIFF".to_ascii_buffer())
	h.resize(8)
	h.encode_u32(4, 36 + data.size())
	h.append_array("WAVEfmt ".to_ascii_buffer())
	var fmt := PackedByteArray()
	fmt.resize(20)
	fmt.encode_u32(0, 16)
	fmt.encode_u16(4, 1)
	fmt.encode_u16(6, ch)
	fmt.encode_u32(8, s.mix_rate)
	fmt.encode_u32(12, s.mix_rate * ch * 2)
	fmt.encode_u16(16, ch * 2)
	fmt.encode_u16(18, 16)
	h.append_array(fmt)
	h.append_array("data".to_ascii_buffer())
	var n := PackedByteArray()
	n.resize(4)
	n.encode_u32(0, data.size())
	h.append_array(n)
	h.append_array(data)
	return h


# ------------------------------------------------------------------
# Ende: Wertung melden, gemeinsam anschauen, exportieren
# ------------------------------------------------------------------

func _after_finish() -> void:
	_apply_mix_later()
	if not _finished:
		_finished = true
		_block(false, _t("Fertig! „Watch“ startet das Video auf allen Geräten gleichzeitig."))
		_refresh()
	# Übersprungene Zeilen: wie im Steam-Mod mit dem Original-Ton
	for i in _skipped.keys():
		var inst = dm.performance_array[i]
		if inst.shared_omniclip.clip_audio:
			inst.member_audio = inst.shared_omniclip.clip_audio
		_skipped.erase(i)
	if not _scores_sent and dm.results_list.visible:
		_scores_sent = true
		var scores := []
		for inst in dm.performance_array:
			scores.append({"clipId": str(inst.shared_omniclip.file_name_agnostic), "score": clampf(inst.score, 0.0, 5.0) * 20.0})
		bridge._send({"type": "dub.scores", "scores": scores})


## „Watch“ im Spiel startet das Anschauen für alle.
func _rewire_watch() -> void:
	for btn in [dm.btn_watch, dm.get_node_or_null("%TelevisionExpanded/BtnWatch")]:
		if btn == null or not btn.has_signal("button_clicked"):
			continue
		for con in btn.get_signal_connection_list("button_clicked"):
			btn.disconnect("button_clicked", con.callable)
		btn.button_clicked.connect(request_watch)


func request_watch() -> void:
	if str(_dub().get("phase", "")) == "results":
		bridge._send({"type": "dub.watch"})
	else:
		_watch_now()   # Server noch nicht so weit: wenigstens hier abspielen


func _watch_now() -> void:
	if is_instance_valid(dm):
		_apply_mix_later()
		dm.watch()


func request_export() -> void:
	_export_state = ""
	bridge._send({"type": "dub.export"})


func _check_export() -> void:
	var ex = _dub().get("export")
	if not ex is Dictionary or str(ex.get("status", "")) != "done" or _export_state != "":
		return
	_export_state = "loading"
	DirAccess.make_dir_recursive_absolute(export_dir)
	_export_file = export_dir + str(ex.get("name", "dub.mp4")).validate_filename()
	_export_http = HTTPRequest.new()
	_export_http.timeout = 600.0
	_export_http.download_file = _export_file
	add_child(_export_http)
	_export_http.request_completed.connect(_on_export_loaded)
	_export_http.request(bridge.server_url + "/api/rooms/%s/dub/export.mp4?dl=0" % bridge.room_code, ["X-Host-Key: " + bridge.host_key])


func _on_export_loaded(_r: int, code: int, _h: PackedStringArray, _b: PackedByteArray) -> void:
	_export_state = "done" if code == 200 else "error"
	if code == 200:
		print("Voicigame | Video gespeichert: %s" % _export_file)
	_export_http.queue_free()
	_refresh()


func _on_scene_left() -> void:
	_watch_timer.stop()
	_restore_solo_session()
	if is_instance_valid(_layer):
		_layer.queue_free()
	queue_free()


# ------------------------------------------------------------------
# Anzeige: Lobby über der Dub-Szene, Leiste oben während des Spiels
# ------------------------------------------------------------------

func _font(path: String) -> Font:
	return load(path) if ResourceLoader.exists(path) else null


func _label(text: String, size: int, bold := false, color := Color.WHITE) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	l.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.7))
	l.add_theme_constant_override("outline_size", 4)
	var f := _font(FONT_BOLD if bold else FONT_TEXT)
	if f:
		l.add_theme_font_override("font", f)
	return l


func _cv_button(text: String, cb: Callable, width := 300) -> Control:
	if ResourceLoader.exists(BUTTON_SCENE):
		var b = load(BUTTON_SCENE).instantiate()
		b.custom_minimum_size = Vector2(width, 58)
		b.size_flags_horizontal = Control.SIZE_SHRINK_BEGIN
		b.button_clicked.connect(cb)
		var l := Label.new()
		l.text = text
		l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		l.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		l.set_anchors_preset(Control.PRESET_FULL_RECT)
		l.add_theme_font_size_override("font_size", 24)
		l.add_theme_color_override("font_color", Color.BLACK)
		var f := _font(FONT_TEXT)
		if f:
			l.add_theme_font_override("font", f)
		b.add_child(l)
		return b
	var fb := Button.new()
	fb.text = text
	fb.custom_minimum_size = Vector2(width, 58)
	fb.pressed.connect(cb)
	return fb


func _small_button(text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.add_theme_font_size_override("font_size", 16)
	var f := _font(FONT_TEXT)
	if f:
		b.add_theme_font_override("font", f)
	b.pressed.connect(cb)
	return b


func _build_ui() -> void:
	_layer = CanvasLayer.new()
	_layer.layer = 90
	add_child(_layer)

	# Lobby (Hub)
	_hub = ColorRect.new()
	(_hub as ColorRect).color = Color(0.05, 0.05, 0.06, 0.93)
	_hub.set_anchors_preset(Control.PRESET_FULL_RECT)
	_hub.mouse_filter = Control.MOUSE_FILTER_STOP
	_layer.add_child(_hub)
	var margin := MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 48)
	_hub.add_child(margin)
	var cols := HBoxContainer.new()
	cols.add_theme_constant_override("separation", 48)
	margin.add_child(cols)

	var left := VBoxContainer.new()
	left.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	left.add_theme_constant_override("separation", 12)
	cols.add_child(left)
	left.add_child(_label(_t("SYNCHRONISIEREN"), 28, true, Color(0.44, 0.86, 1.0)))
	_hub_title = _label("", 34, true)
	_hub_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	left.add_child(_hub_title)
	_hub_upload = _label("", 22, false, Color(0.8, 0.85, 0.9))
	_hub_upload.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	left.add_child(_hub_upload)
	var code_row := HBoxContainer.new()
	code_row.add_theme_constant_override("separation", 24)
	left.add_child(code_row)
	_qr = TextureRect.new()
	_qr.custom_minimum_size = Vector2(200, 200)
	_qr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_qr.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT
	code_row.add_child(_qr)
	var code_col := VBoxContainer.new()
	code_row.add_child(code_col)
	code_col.add_child(_label(_t("Raumcode"), 20, false, Color(0.7, 0.75, 0.8)))
	_code = _label(bridge.room_code, 84, true)
	code_col.add_child(_code)
	var link := _label(bridge.join_url.replace("https://", "").replace("http://", ""), 20, false, Color(0.44, 0.86, 1.0))
	code_col.add_child(link)
	_chrono = CheckBox.new()
	_chrono.text = _t("Der Reihe nach (ohne Figuren)")
	_chrono.add_theme_font_size_override("font_size", 22)
	_chrono.toggled.connect(func(on): bridge._send({"type": "dub.settings", "chrono": on}))
	left.add_child(_chrono)
	var btns := HBoxContainer.new()
	btns.add_theme_constant_override("separation", 18)
	left.add_child(btns)
	_btn_start = _cv_button(_t("Runde starten"), func(): start_round(false))
	btns.add_child(_btn_start)
	_btn_force = _cv_button(_t("Trotzdem starten"), func(): start_round(true), 260)
	btns.add_child(_btn_force)
	btns.add_child(_cv_button(_t("Zurück"), _leave_hub, 200))
	_hub_status = _label("", 22, false, Color(1.0, 0.85, 0.45))
	_hub_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	left.add_child(_hub_status)

	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	right.custom_minimum_size.x = 560
	right.add_theme_constant_override("separation", 10)
	cols.add_child(right)
	right.add_child(_label(_t("Mitspieler"), 30, true))
	_players_box = VBoxContainer.new()
	right.add_child(_players_box)
	right.add_child(_label(_t("Figuren"), 30, true))
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	right.add_child(scroll)
	_chars_box = VBoxContainer.new()
	_chars_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_chars_box)
	right.add_child(_label(_t("Chat"), 24, true))
	_chat_box = VBoxContainer.new()
	right.add_child(_chat_box)
	_chat_input = LineEdit.new()
	_chat_input.placeholder_text = _t("Nachricht")
	_chat_input.add_theme_font_size_override("font_size", 20)
	_chat_input.text_submitted.connect(_on_chat)
	right.add_child(_chat_input)

	var qr_http := HTTPRequest.new()
	add_child(qr_http)
	qr_http.request_completed.connect(_on_qr)
	qr_http.request(bridge.qr_url())

	# Leiste oben während des Spiels
	_banner = PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.06, 0.06, 0.07, 0.86)
	sb.set_corner_radius_all(14)
	sb.set_content_margin_all(10)
	sb.border_color = Color(0.44, 0.86, 1.0, 0.8)
	sb.set_border_width_all(2)
	_banner.add_theme_stylebox_override("panel", sb)
	# Links neben dem Fernseher ist im Dub-Modus Platz (rechts sitzt die Fernbedienung des Spiels)
	_banner.offset_left = 12
	_banner.offset_right = 246
	_banner.offset_top = 74
	_banner.mouse_filter = Control.MOUSE_FILTER_PASS
	_layer.add_child(_banner)
	var brow := VBoxContainer.new()
	brow.add_theme_constant_override("separation", 10)
	_banner.add_child(brow)
	brow.add_child(_label("Voicigame", 16, true, Color(0.44, 0.86, 1.0)))
	_banner_text = _label("", 17, false)
	_banner_text.custom_minimum_size.x = 214
	_banner_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	brow.add_child(_banner_text)
	_banner_btns = VBoxContainer.new()
	_banner_btns.add_theme_constant_override("separation", 6)
	brow.add_child(_banner_btns)
	_banner.hide()


func _on_chat(text: String) -> void:
	if text.strip_edges() != "":
		bridge._send({"type": "dub.chat", "text": text, "name": _pc_name()})
	_chat_input.text = ""


func _on_qr(_r: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	if code == 200:
		var img := Image.new()
		if img.load_png_from_buffer(body) == OK:
			_qr.texture = ImageTexture.create_from_image(img)


## Web-Zeile: Knöpfe des Spiels sperren und sagen, worauf gewartet wird.
func _block(on: bool, text: String) -> void:
	if on and is_instance_valid(dm) and not _busy:
		for b in [dm.btn_record, dm.btn_next, dm.btn_hear_again, dm.btn_refresh_mic]:
			if b and b.enabled:
				b.enable(false)
		var rs = dm.get("btn_replay_synced")
		if rs and rs.enabled:
			rs.enable(false)
	_set_banner(text)


func _set_banner(text: String) -> void:
	if _banner_text.text != text:
		_banner_text.text = text
	_banner.visible = _started and text != ""
	_refresh_banner_buttons()


func _refresh_banner_buttons() -> void:
	var d := _dub()
	var sig := "%s|%s|%s|%s" % [_finished, str(d.get("export", {})), _export_state, str(d.get("phase", ""))]
	if sig == _last_sig:
		return
	_last_sig = sig
	for c in _banner_btns.get_children():
		c.queue_free()
	if not _finished:
		_banner_btns.add_child(_small_button(_t("Zeile überspringen"), func(): bridge._send({"type": "dub.skip"})))
		return
	var ex = d.get("export")
	var st := str(ex.get("status", "")) if ex is Dictionary else ""
	if not d.get("ffmpeg", false):
		return
	if _export_state == "done":
		_banner_btns.add_child(_small_button(_t("Ordner öffnen"), func(): OS.shell_show_in_file_manager(_export_file)))
	elif st == "queued" or st == "running" or _export_state == "loading":
		pass
	else:
		_banner_btns.add_child(_small_button(_t("Video exportieren"), request_export))


## Zurück zur Dub-Auswahl des Spiels (anderes Pack). Der Raum bleibt offen.
## Nicht über „Exit“ des Spiels: das würde Zwischenstände des Packs löschen.
func _leave_hub() -> void:
	var vs = get_node_or_null("/root/VolumeService")
	if vs:
		AudioServer.set_bus_mute(vs.BUS_VCLIP, false)
		AudioServer.set_bus_mute(vs.BUS_PLAYBACK, false)
	var m = get_node_or_null("/root/M")
	if m:
		m.world.return_to_dub_selection()


func _claim_local(character: String) -> void:
	bridge._send({"type": "dub.claim", "character": character, "playerId": LOCAL_ID})


func _refresh() -> void:
	if not is_instance_valid(_hub):
		return
	var d := _dub()
	var res = dm.resource if is_instance_valid(dm) else null
	_hub_title.text = str(res.pack_info.display_name) if res else ""
	_code.text = bridge.room_code
	# Hochladen und Video
	var video = d.get("video")
	var vs := str(video.get("status", "")) if video is Dictionary else ""
	match _upload_state:
		"uploading":
			_hub_upload.text = _t("Pack wird für die Browser hochgeladen: {} %", [int(100.0 * _up_done / maxf(1.0, _up_total))])
		"commit":
			_hub_upload.text = _t("Pack wird eingelesen …")
		"done":
			if vs == "converting" or vs == "checking":
				_hub_upload.text = _t("Video wird für die Browser umgewandelt: {} %", [int(float(video.get("pct", 0)) * 100.0)])
			elif vs == "original":
				_hub_upload.text = _t("Das Video läuft nur in manchen Browsern (auf dem Server fehlt ffmpeg).")
			else:
				_hub_upload.text = _t("Pack ist auf dem Server.")
	# Spieler
	for c in _players_box.get_children():
		c.queue_free()
	var infos := {}
	for p in d.get("players", []):
		infos[str(p.get("id", ""))] = p
	for p in bridge.state.get("players", []):
		var pid := str(p.get("id", ""))
		var info: Dictionary = infos.get(pid, {})
		var tag := ""
		var col := Color(0.8, 0.85, 0.9)
		if str(p.get("kind", "")) == "local":
			tag = _t("am PC")
		elif not p.get("connected", false):
			tag = _t("getrennt")
			col = Color(1.0, 0.5, 0.5)
		elif info.get("spectator", false):
			tag = _t("schaut zu")
		elif info.get("ready", false):
			tag = _t("hat das Pack")
			col = Color(0.5, 0.95, 0.5)
		elif info.get("progress") is Dictionary:
			tag = _t("lädt {}/{}", [int(info.progress.get("have", 0)), int(info.progress.get("need", 0))])
		else:
			tag = _t("prüft")
		var row := _label("● %s · %s" % [str(p.get("name", "?")), tag], 22, false, col)
		_players_box.add_child(row)
	# Figuren
	for c in _chars_box.get_children():
		c.queue_free()
	var chrono: bool = d.get("chrono", false)
	if _chrono.button_pressed != chrono:
		_chrono.set_pressed_no_signal(chrono)
	if chrono:
		_chars_box.add_child(_label(_t("Alle Zeilen kommen nacheinander, ihr wechselt euch ab."), 20, false, Color(0.8, 0.85, 0.9)))
	else:
		for c in d.get("characters", []):
			var row := HBoxContainer.new()
			row.add_theme_constant_override("separation", 12)
			var owner = c.get("claimedBy")
			var who := _player_name(str(owner)) if owner else _t("frei")
			var l := _label("%s · %s" % [str(c.get("name", "")), who], 22, false, Color.WHITE if owner else Color(0.7, 0.75, 0.8))
			l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
			l.clip_text = true
			row.add_child(l)
			if host_plays and (owner == null or str(owner) == LOCAL_ID):
				var cname := str(c.get("name", ""))
				row.add_child(_small_button(_t("Freigeben") if owner else _t("Ich am PC"), _claim_local.bind(cname)))
			_chars_box.add_child(row)
	# Chat
	for c in _chat_box.get_children():
		c.queue_free()
	var chat: Array = d.get("chat", [])
	for m in chat.slice(maxi(0, chat.size() - 6)):
		var l := _label("%s: %s" % [str(m.get("name", "")), str(m.get("text", ""))], 18, false, Color(0.85, 0.9, 0.95))
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		_chat_box.add_child(l)
	# Start
	var cs = d.get("canStart")
	var reason := str(cs.get("reason", "")) if cs is Dictionary else ""
	var ok: bool = cs is Dictionary and cs.get("ok", false) and _upload_state == "done"
	if _btn_start.has_method("enable"):
		_btn_start.enable(ok)
	_btn_force.visible = reason == "loading" and _upload_state == "done"
	_hub_status.text = "" if ok else {
		"no_pack": _t("Das Pack wird noch hochgeladen."),
		"no_players": _t("Es spielt noch niemand mit."),
		"loading": _t("Noch nicht alle haben das Pack geladen."),
	}.get(reason, "")
	if str(d.get("phase", "")) == "hub" and _started and not _finished:
		_set_banner(_t("Die Spielleitung ist zurück in der Lobby. Es geht weiter, sobald neu gestartet wird."))
	_check_export()
	if _finished:
		var ex = d.get("export")
		var st := str(ex.get("status", "")) if ex is Dictionary else ""
		var text := _t("Fertig! „Watch“ startet das Video auf allen Geräten gleichzeitig.")
		if st == "queued" or st == "running":
			text = _t("Video wird erstellt: {} %", [int(float(ex.get("pct", 0)) * 100.0)])
		elif _export_state == "loading":
			text = _t("Video wird heruntergeladen …")
		elif _export_state == "done":
			text = _t("Video gespeichert: {}", [_export_file.get_file()])
		elif st == "error" or _export_state == "error":
			text = _t("Der Export ist fehlgeschlagen.")
		elif not d.get("ffmpeg", false):
			text = _t("Fertig! Zum Speichern „Save Dub“ nutzen (auf dem Server fehlt ffmpeg für den Video-Export).")
		_set_banner(text)
	elif _started:
		_refresh_banner_buttons()
