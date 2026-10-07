// Mic (or debug file) -> AudioWorklet -> 16 kHz mono PCM16 -> fixed-length WAV segments.
export const SAMPLE_RATE = 16000;

export function encodeWav(int16) {
  const buf = new ArrayBuffer(44 + int16.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + int16.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, int16.length * 2, true);
  new Int16Array(buf, 44).set(int16);
  return new Blob([buf], { type: "audio/wav" });
}
function concat(chunks, total) {
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
}

export async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
}

export class Recorder {
  constructor(opts) {
    this.segmentSeconds = opts.segmentSeconds || 30;
    this.onSegment = opts.onSegment; // ({index,start,duration,wav,silent}) => Promise
    this.onLevel = opts.onLevel || (() => {});
    this.onPartial = opts.onPartial || (() => {});
    this.onEnded = opts.onEnded || (() => {});
    // ({type:"switched"|"lost", label}) when the mic disappears mid-recording.
    this.onDevice = opts.onDevice || (() => {});
    this.deviceId = opts.deviceId || "";
    this.fakeUrl = opts.fakeUrl || null;
    this.silencePeak = opts.silencePeak ?? 0.004;
    this.state = "idle";
  }
  get elapsed() {
    return this.samplesTotal / SAMPLE_RATE;
  }
  get segmentSamples() {
    return this.segmentSeconds * SAMPLE_RATE;
  }

  async start({ index = 0, offset = 0 } = {}) {
    this.index = index;
    this.samplesTotal = Math.round(offset * SAMPLE_RATE);
    this.segStartSamples = this.samplesTotal;
    this.chunks = [];
    this.count = 0;
    this.segPeak = 0;
    this.ctx = new AudioContext({ latencyHint: "playback" });
    await this.ctx.audioWorklet.addModule("/recorder-worklet.js");
    this.node = new AudioWorkletNode(this.ctx, "pcm-downsampler", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(this.ctx.destination);
    this.flushWaiters = [];
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    if (this.fakeUrl) {
      let audio;
      const res = await fetch(this.fakeUrl);
      if (res.status === 404) {
        audio = this.ctx.createBuffer(1, SAMPLE_RATE * 65, SAMPLE_RATE);
        const ch = audio.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = 0.18 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
      } else if (!res.ok) throw new Error("테스트 오디오를 불러오지 못했어요");
      else audio = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.source = this.ctx.createBufferSource();
      this.source.buffer = audio;
      this._fakeBuffer = audio;
      this.source.onended = () => {
        if (this.state === "recording") this.onEnded();
      };
      this.source.connect(this.node);
      this.source.start();
      this.label = "테스트 오디오";
    } else {
      this.stream = await openMic(this.deviceId);
      this._connectStream();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.state = "recording";
    this.partialTimer = setInterval(() => this._persistPartial(), 5000);
  }

  _connectStream() {
    const track = this.stream.getAudioTracks()[0];
    this.label = track?.label || "마이크";
    const stream = this.stream;
    track?.addEventListener("ended", () => {
      if (this.stream === stream) this._onSourceLost();
    });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
  }
  _dropSource() {
    if (this.source) this.source.onended = null;
    try {
      this.source?.disconnect();
    } catch {}
    try {
      this.source?.stop?.();
    } catch {}
    let stopError;
    this.stream?.getTracks().forEach((t) => {
      try { t.stop(); } catch (error) { stopError ??= error; }
    });
    if (stopError) throw stopError;
    this.source = null;
    this.stream = null;
  }
  // Re-open a mic after the old one vanished. Prefers the chosen device, then the system default.
  async _reacquire() {
    if (this.fakeUrl) {
      if (this._fakeFailReacquire) throw new Error("fake: no mic");
      this.source = this.ctx.createBufferSource();
      this.source.buffer = this._fakeBuffer;
      this.source.onended = () => {
        if (this.state === "recording") this.onEnded();
      };
      this.source.connect(this.node);
      this.source.start(0, Math.min(this.elapsed, Math.max(0, this._fakeBuffer.duration - 1)));
      this.label = "테스트 오디오 (다시 연결)";
      return;
    }
    let lastErr;
    for (const id of [...new Set([this.deviceId, ""])]) {
      try {
        this.stream = await openMic(id);
        this._connectStream();
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("마이크를 열지 못했어요");
  }
  // The mic track ended (unplugged, Bluetooth dropped, permission revoked). Keep recording on another
  // mic if one opens within ~4 s; otherwise flush what we have as a segment and pause.
  async _onSourceLost() {
    if (this._recovering || this.state === "stopped" || this.state === "idle") return;
    this._recovering = true;
    const wasRecording = this.state === "recording";
    const lostLabel = this.label;
    this._dropSource();
    this.needsSource = true;
    try {
      if (wasRecording) {
        for (const wait of [300, 1200, 2500]) {
          await sleep(wait);
          if (this.state !== "recording") break;
          try {
            await this._reacquire();
            this.needsSource = false;
            break;
          } catch {}
        }
      }
      if (!this.needsSource) {
        this.onDevice({ type: "switched", from: lostLabel, label: this.label });
        return;
      }
      if (this.state === "recording") await this.pause();
      this.onDevice({ type: "lost", label: lostLabel });
      this.onEnded("device");
    } finally {
      this._recovering = false;
    }
  }
  // test hook (fake mode): pretend the input device disappeared
  simulateDeviceLoss({ recover = true } = {}) {
    this._fakeFailReacquire = !recover;
    return this._onSourceLost();
  }

  _onMessage(d) {
    if (d.flushed) {
      const w = this.flushWaiters.splice(0);
      w.forEach((f) => f());
      return;
    }
    if (!d.pcm) return;
    this.onLevel(d.rms, d.peak);
    if (this.state !== "recording" && this.state !== "flushing") return;
    let pcm = d.pcm;
    let peak = d.peak;
    while (pcm.length) {
      const room = this.segmentSamples - this.count;
      const take = Math.min(room, pcm.length);
      const part = take === pcm.length ? pcm : pcm.subarray(0, take);
      this.chunks.push(part.slice ? part.slice() : part);
      this.count += take;
      this.samplesTotal += take;
      if (peak > this.segPeak) this.segPeak = peak;
      pcm = pcm.subarray(take);
      if (this.count >= this.segmentSamples) this._emit();
    }
  }
  _emit(minSeconds = 0) {
    if (this.count === 0 || this.count < minSeconds * SAMPLE_RATE) return null;
    const pcm = concat(this.chunks, this.count);
    const seg = {
      index: this.index,
      start: this.segStartSamples / SAMPLE_RATE,
      duration: this.count / SAMPLE_RATE,
      wav: encodeWav(pcm),
      silent: this.segPeak < this.silencePeak,
    };
    this.index += 1;
    this.segStartSamples = this.samplesTotal;
    this.chunks = [];
    this.count = 0;
    this.segPeak = 0;
    const p = Promise.resolve(this.onSegment(seg));
    return p;
  }
  _persistPartial() {
    if (!this.count) return;
    const pcm = concat(this.chunks, this.count);
    this.onPartial({
      index: this.index,
      start: this.segStartSamples / SAMPLE_RATE,
      pcm,
      peak: this.segPeak,
      elapsed: this.elapsed,
    });
  }
  _flushWorklet() {
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.node.port.postMessage({ cmd: "flush" });
      setTimeout(resolve, 800);
    });
  }
  async pause() {
    if (this.state !== "recording") return;
    this.state = "flushing";
    await this._flushWorklet();
    this.node.port.postMessage({ cmd: "run", value: false });
    this.state = "paused";
    if (this.ctx.state === "running") await this.ctx.suspend().catch(() => {});
    await this._emit(0.5);
  }
  async resume() {
    if (this.state !== "paused") return;
    if (this.ctx.state === "suspended") await this.ctx.resume();
    if (this.needsSource) {
      try {
        await this._reacquire();
      } catch (e) {
        if (!this.fakeUrl) await this.ctx.suspend().catch(() => {});
        throw new Error("마이크를 찾지 못했어요. 마이크를 연결한 뒤 다시 눌러주세요.");
      }
      this.needsSource = false;
    }
    this.node.port.postMessage({ cmd: "run", value: true });
    this.state = "recording";
  }
  async stop() {
    if (this.state === "stopped" || this.state === "idle") return;
    clearInterval(this.partialTimer);
    try {
      if (this.state === "recording") {
        this.state = "flushing";
        await this._flushWorklet();
      }
      this.state = "stopped";
      await this._emit(0.5);
    } finally {
      try {
        this._dropSource();
        this.sourceCleanupFailed = false;
      } catch (error) {
        this.sourceCleanupFailed = true;
        throw error;
      } finally {
        await this.ctx?.close().catch(() => {});
      }
    }
  }
}
