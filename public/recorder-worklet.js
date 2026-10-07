// Downsamples the input to 16 kHz mono and posts Int16 frames (~100 ms) plus a level value.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = 16000;
    this.ratio = sampleRate / this.target;
    this.acc = 0; // sum of input samples for the current output sample
    this.accN = 0; // weight collected
    this.pos = 0; // fractional position within the current output window
    this.out = new Int16Array(1600);
    this.outN = 0;
    this.peak = 0;
    this.sumSq = 0;
    this.sqN = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === "run") this.running = !!e.data.value;
      if (e.data && e.data.cmd === "flush") this.flush();
    };
  }
  flush() {
    if (this.outN > 0) {
      const chunk = this.out.slice(0, this.outN);
      this.port.postMessage({ pcm: chunk, rms: Math.sqrt(this.sumSq / Math.max(1, this.sqN)), peak: this.peak }, [chunk.buffer]);
      this.outN = 0; this.peak = 0; this.sumSq = 0; this.sqN = 0;
    }
    this.port.postMessage({ flushed: true });
  }
  push(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.outN++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    const a = Math.abs(s);
    if (a > this.peak) this.peak = a;
    this.sumSq += s * s; this.sqN++;
    if (this.outN === this.out.length) {
      const chunk = this.out;
      this.port.postMessage({ pcm: chunk, rms: Math.sqrt(this.sumSq / this.sqN), peak: this.peak }, [chunk.buffer]);
      this.out = new Int16Array(1600);
      this.outN = 0; this.peak = 0; this.sumSq = 0; this.sqN = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !this.running) return true;
    const chs = input.length;
    const n = input[0].length;
    const r = this.ratio;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < chs; c++) v += input[c][i];
      v /= chs;
      if (r <= 1.0001) { this.push(v); continue; }
      // box filter over each output window of width r input samples (handles fractional ratios)
      const room = r - this.pos;
      if (room >= 1) {
        this.acc += v; this.accN += 1; this.pos += 1;
        if (this.pos >= r - 1e-9) { this.push(this.acc / this.accN); this.acc = 0; this.accN = 0; this.pos = 0; }
      } else {
        this.acc += v * room; this.accN += room;
        this.push(this.acc / this.accN);
        const rest = 1 - room;
        this.acc = v * rest; this.accN = rest; this.pos = rest;
      }
    }
    return true;
  }
}
registerProcessor("pcm-downsampler", PcmDownsampler);
