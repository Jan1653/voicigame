// Live-Bild und Ton vom Host-PC an zuschauende Mitspieler weiterreichen.
// Der Host schickt Binärrahmen, der Server gibt sie unverändert weiter:
//   Byte 0     Art: 1 = Bild (JPEG), 2 = Ton (PCM 16 Bit, mono)
//   Ton:       Byte 1..4 Abtastrate (u32, little endian), danach die Samples
//   Bild:      ab Byte 1 die JPEG-Datei
// Nur wer zuschaut (Nachricht „watch"), bekommt Rahmen. Staut sich bei einem langsamen Handy
// etwas an, werden Bilder ausgelassen statt nachgeschickt, damit es live bleibt.

export const FRAME_IMAGE = 1;
export const FRAME_AUDIO = 2;
const MAX_FRAME = 900 * 1024;
const MAX_BACKLOG = 1.5 * 1024 * 1024;

export function relayFrame(room, data) {
  if (!Buffer.isBuffer(data) || data.length < 2 || data.length > MAX_FRAME) return;
  const kind = data[0];
  if (kind !== FRAME_IMAGE && kind !== FRAME_AUDIO) return;
  for (const p of room.players.values()) {
    const ws = p.ws;
    if (p.kind !== 'phone' || !p.watch || !ws || ws.readyState !== 1) continue;
    // Ton immer (kleine Rahmen, Lücken hört man), Bilder nur ohne Stau
    if (kind === FRAME_IMAGE && ws.bufferedAmount > MAX_BACKLOG) continue;
    ws.send(data, { binary: true });
  }
}

export function watcherCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (p.kind === 'phone' && p.watch && p.connected) n++;
  return n;
}
