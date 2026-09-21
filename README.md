# voicigame

Play **The Choicer Voicer** with friends who are not sitting at your PC. They join with a room code on their phone or in any browser, and people who have the game can join from their own copy. The game itself still does the judging, the scoring and the videos, so it plays like a normal round.

voicigame is two parts: a small mod that runs inside the game, and a web server ([voicigame.duckdns.org](https://voicigame.duckdns.org) by default) that connects everyone. Only the person hosting needs the mod. Everyone else just opens the link.

## What you can do

- **Gameshow:** everyone imitates the same clips. Phone players hear the clip on their phone, tap **Go** and record. The game plays their take through its own microphone channel, so the jury rates it exactly like a player at the PC. If a take is still on its way, the game waits for it.
- **Dub mode:** pick a dub pack, everyone claims characters and records their lines while the video plays in the browser, like in the game. At the end you watch the result together on every device and export it as a video.
- **Dub without the game:** click **Create your own room** on the website, upload a pack (ZIP or folder) and play the whole dub round online.
- **Join from another PC:** with the mod installed, choose **Join lobby** in the game, type the code and play with your own microphone.
- **Live picture:** players who are not in the same room see the game's screen and hear its sound on their phone (the stage, the jury, the scores). The sound mutes itself while you record.
- **Two looks** for the website: one like the game and a plain one. The choice is remembered.
- **25 languages** on the website and in the mod. It starts in the language of the device and can be switched at the bottom of the page.

## Install the mod

The mod does not change the game files. It is loaded through an `override.cfg` next to the game's exe.

### The easy way: Voicitool

[Voicitool](https://github.com/Jan1653/Voicitool) installs the mod with one click and keeps it up to date:

1. Install and open Voicitool.
2. **Settings** → **Voicigame** → **Install mod**. Voicitool finds the game folder on its own (Steam or any other folder, you can also pick it yourself).
3. Start the game.

Every Voicitool update brings the newest mod version with it. **Remove** in the same place takes it out again.

### By hand

1. Download this repository (**Code** → **Download ZIP**) and unpack it.
2. Copy the folder `mod/voicigame` somewhere it can stay, for example `C:\Games\voicigame`.
3. Open the folder that contains `The Choicer Voicer.exe`.
4. Create a text file `override.cfg` there (or open the existing one) and add:
   ```ini
   [autoload]

   Voicigame="*C:/Games/voicigame/main.gd"
   ```
   Use the real path to `main.gd`, with forward slashes. If the file already has an `[autoload]` section, only add the `Voicigame=` line to it.
5. Start the game. The play menu now has a **Voicigame** tile next to Solo and Local Group.

To remove the mod, delete the `Voicigame=` line (or the whole `override.cfg` if nothing else is in it).

Tested with version 0.5.3 of the game, with and without the Steam multiplayer mod.

## Play

1. In the game: **Play** → **Voicigame**.
2. **Create lobby** shows a room code, a QR code and a link. Friends scan the QR code or open the link and pick a name. The phone asks for the microphone once. Put your own name in **Your name**, so everyone knows who is playing at the PC.
3. **Continue** starts a gameshow with everyone in the lobby as group members. **Dubbing** opens the dub pack list of the game.
4. Players who want to join from their own game choose **Join lobby** instead and type the code.

Headphones help: the phone's microphone then only hears the player.

### Settings

`%APPDATA%\YeahMaybe\ChoicerVoicer\voicigame.cfg`, created on the first start:

```ini
[server]
url="https://voicigame.duckdns.org"

[ui]
lang="en"          ; mod language, empty = Windows language

[join]
name="Alex"        ; your name, set in the lobby (hosting and joining)

[stream]
fps=8              ; live picture: frames per second
width=640          ; width of the picture in pixels
quality=0.6        ; JPEG quality, 0.3 to 0.9
```

The live picture only runs while somebody is watching. At the default settings it needs about 200 KB/s upload from the host per viewer.

## Run your own server

```bash
cd server
npm ci
npm start
```

This starts the server on port 8080. Phones only allow the microphone over https, so for real games the server needs to run behind https. [deploy/README.md](deploy/README.md) shows a setup that runs next to other websites on the same machine and updates itself from GitHub. Then point `url` in `voicigame.cfg` to your address.

ffmpeg is optional. Without it, dub videos only play in some browsers and the video export is not available (players can still download their takes as a ZIP).

## Limits

- The mod runs on Windows, the website on any current phone or browser.
- Rooms only live in the server's memory. Restarting the server ends running rooms.
- The judging is the game's own. For very short clips it sometimes gives low scores even for good takes. That happens without the mod too.
- Recordings on phones can start a little early or late, depending on the phone's audio delay. In dub mode you can drag your take into place on the waveform.

## For developers

- `mod/voicigame/`: the mod. `main.gd` hooks into the menus, `bridge.gd` talks to the server, `show_hook.gd` and `dub_hook.gd` feed web takes into the game, `join_screen.gd` is the join client, `stream.gd` sends the live picture.
- `server/`: Node.js (express, ws, qrcode). `src/room.js` holds rooms and players, `src/dub.js` the dub mode, `src/stream.js` passes the live picture on. The phone page is `public/index.html` with `app.js` and `dub.js`.
- Translations: German is the source in the code. Website texts are in `server/public/lang/`, mod texts in `mod/voicigame/lang.json`. `node tools/build_mod_lang.js --check` lists mod texts without a translation.
- Tests drive the real game: `tools/run_test.ps1 <plan>` with the plans `show`, `join`, `dub` and simulated phones (`tools/fake-phone.js`, `tools/fake-dub-phone.js`) or a simulated host (`tools/fake-host.js`). The game folder comes from `VG_GAME_DIR` or a line in `tools/game_dir.txt` (not in the repository), otherwise the default Steam folder.

## Contributing

Pull requests and forks are welcome. Keep the German source texts in the code and add translations as described above, and run the tests in `tools/` before you send a change that touches the mod.

## License

[GPL-3.0](LICENSE). You can use, change and share it, as long as your version stays open under the same license.

## Made with AI

I built this project with a lot of help from AI (Claude). If that bothers you, that's completely fine, you don't have to use it.
