// Tiny WebAudio synth - no audio assets, so it costs nothing at load time.
// The context is created lazily on the first user gesture (mobile autoplay).

export class Sound {
  constructor(muted = false) {
    this.muted = muted;
    this.ctx = null;
  }

  _ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  resume() {
    const ctx = this._ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.32;
  }

  _tone({ freq = 440, to = freq, dur = 0.16, type = 'sine', gain = 0.4, delay = 0 }) {
    const ctx = this._ensure();
    if (!ctx || this.muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  _noise({ dur = 0.3, gain = 0.5, filter = 900 }) {
    const ctx = this._ensure();
    if (!ctx || this.muted) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filter;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  flip()    { this._tone({ freq: 620, to: 880, dur: 0.09, type: 'triangle', gain: 0.16 }); }
  fork()    { this._tone({ freq: 300, to: 520, dur: 0.14, type: 'sine', gain: 0.14 }); }
  orb(i = 0){ this._tone({ freq: 660 * Math.pow(1.0595, Math.min(i, 12)), to: 990, dur: 0.2, type: 'triangle', gain: 0.26 }); }
  gem()     { [523, 659, 784, 1046].forEach((f, i) => this._tone({ freq: f, dur: 0.3, type: 'sine', gain: 0.2, delay: i * 0.05 })); }
  hit()     { this._noise({ dur: 0.34, gain: 0.55, filter: 700 }); this._tone({ freq: 180, to: 60, dur: 0.3, type: 'sawtooth', gain: 0.28 }); }
  die()     { [440, 330, 247, 165].forEach((f, i) => this._tone({ freq: f, to: f * 0.7, dur: 0.4, type: 'sine', gain: 0.22, delay: i * 0.11 })); }
  unlock()  { [523, 784, 1046, 1318].forEach((f, i) => this._tone({ freq: f, dur: 0.35, type: 'triangle', gain: 0.2, delay: i * 0.08 })); }
}
