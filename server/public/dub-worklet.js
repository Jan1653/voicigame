// Nimmt das Mikrofon auf und schickt die Samples mit ihrer Position (Frame im AudioContext) an die Seite.
// So lässt sich die Aufnahme genau an den Start des Clips legen.
class DubRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(2048);
    this.fill = 0;
    this.start = 0;
    this.port.onmessage = (e) => {
      this.on = !!e.data.on;
      if (!this.on) this.flush();
    };
  }

  flush() {
    if (!this.fill) return;
    this.port.postMessage({ frame: this.start, data: this.buf.slice(0, this.fill) });
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!this.on || !ch) return true;
    if (!this.fill) this.start = currentFrame;
    if (this.fill + ch.length > this.buf.length) {
      this.flush();
      this.start = currentFrame;
    }
    this.buf.set(ch, this.fill);
    this.fill += ch.length;
    if (this.fill >= 1024) this.flush();
    return true;
  }
}

registerProcessor('dub-recorder', DubRecorder);
