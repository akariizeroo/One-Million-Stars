// Procedural Web Audio sound design. Every sound is synthesized at runtime:
// filtered noise for card friction, pitched thumps for table impacts, layered
// ambience per environment and an adaptive drone for Chaos Mode.

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.volumes = { master: 0.8, sfx: 0.9, ambience: 0.5, music: 0.45 };
    this.voice = true;
    this.ambienceNodes = [];
    this.chaosNodes = null;
    this.env = null;
  }

  // Must be called from a user gesture (browsers block autoplay).
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain();
    this.comp = c.createDynamicsCompressor();
    this.master.connect(this.comp).connect(c.destination);
    this.sfxBus = c.createGain(); this.sfxBus.connect(this.master);
    this.ambBus = c.createGain(); this.ambBus.connect(this.master);
    this.musicBus = c.createGain(); this.musicBus.connect(this.master);
    // Shared reverb for space.
    this.reverb = c.createConvolver();
    this.reverb.buffer = this._impulse(1.8, 2.5);
    this.reverbGain = c.createGain();
    this.reverbGain.gain.value = 0.18;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.noiseBuf = this._noiseBuffer(2);
    this.applyVolumes();
    if (this.env) this.setAmbience(this.env);
  }

  setVolumes(v) { Object.assign(this.volumes, v); this.applyVolumes(); }
  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.ambBus.gain.setTargetAtTime(this.volumes.ambience * 0.6, t, 0.2);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.5, t, 0.2);
  }

  _noiseBuffer(sec) {
    const c = this.ctx;
    const b = c.createBuffer(1, c.sampleRate * sec, c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _impulse(sec, decay) {
    const c = this.ctx;
    const len = c.sampleRate * sec;
    const b = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  _noise({ dur = 0.2, freq = 2000, q = 1, type = 'bandpass', gain = 0.5, attack = 0.005, when = 0, sweep = null, rev = 0.1 }) {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    if (rev) { const r = c.createGain(); r.gain.value = rev; g.connect(r).connect(this.reverb); }
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  _tone({ freq = 440, dur = 0.2, type = 'sine', gain = 0.3, when = 0, slide = null, attack = 0.005, bus = null, rev = 0.15 }) {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus || this.sfxBus);
    if (rev) { const r = c.createGain(); r.gain.value = rev; g.connect(r).connect(this.reverb); }
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---------------------------------------------------------------- card sounds
  slide(when = 0) { this._noise({ dur: 0.16, freq: 3200, q: 0.8, gain: 0.35, when, sweep: 1400 }); }
  snap(when = 0) {
    this._noise({ dur: 0.05, freq: 5000, q: 2, gain: 0.5, when, type: 'highpass' });
    this._tone({ freq: 150, dur: 0.09, gain: 0.35, when, slide: 70, rev: 0.05 });
  }
  impact(strength = 1, when = 0) {
    this._tone({ freq: 110 * (0.9 + Math.random() * 0.2), dur: 0.14, gain: 0.45 * strength, when, slide: 55 });
    this._noise({ dur: 0.08, freq: 1800, q: 1.2, gain: 0.3 * strength, when });
  }
  play() { this.slide(); this.impact(1, 0.12); }
  draw(when = 0) { this._noise({ dur: 0.12, freq: 2600, q: 1, gain: 0.25, when, sweep: 4200 }); }
  deal(when = 0) { this._noise({ dur: 0.07, freq: 4200, q: 1.4, gain: 0.25, when, sweep: 2500 }); }
  shuffle() {
    for (let i = 0; i < 26; i++) this._noise({ dur: 0.035, freq: 3500 + Math.random() * 1500, q: 2, gain: 0.18, when: 0.15 + i * 0.022 });
    this._noise({ dur: 0.25, freq: 1500, q: 0.6, gain: 0.25, when: 0.75 });
  }
  flip() { this._noise({ dur: 0.1, freq: 2200, q: 1.5, gain: 0.3, sweep: 5000 }); }
  hover() { this._tone({ freq: 1800, dur: 0.04, gain: 0.04, type: 'triangle', rev: 0 }); }
  click() { this._tone({ freq: 900, dur: 0.06, gain: 0.12, type: 'triangle', rev: 0.05 }); }
  error() { this._tone({ freq: 160, dur: 0.18, gain: 0.2, type: 'square', slide: 120, rev: 0 }); }
  tick() { this._tone({ freq: 1400, dur: 0.05, gain: 0.15, type: 'square', rev: 0 }); }
  whoosh() { this._noise({ dur: 0.45, freq: 400, q: 0.7, gain: 0.35, sweep: 3000, attack: 0.15 }); }
  turn() { this._tone({ freq: 660, dur: 0.12, gain: 0.12, type: 'sine' }); this._tone({ freq: 990, dur: 0.18, gain: 0.1, when: 0.08 }); }
  penalty(amount = 2) {
    const n = Math.min(6, 1 + Math.floor(amount / 2));
    for (let i = 0; i < n; i++) this._tone({ freq: 300 - i * 25, dur: 0.12, gain: 0.18, type: 'sawtooth', when: i * 0.07, rev: 0.05 });
  }
  wild() { [523, 659, 784, 1047].forEach((f, i) => this._tone({ freq: f, dur: 0.25, gain: 0.12, type: 'triangle', when: i * 0.06 })); }
  jumpIn() { this.whoosh(); this._tone({ freq: 400, dur: 0.2, slide: 1200, gain: 0.2, type: 'square', when: 0.05 }); }
  swap() { this.whoosh(); this._noise({ dur: 0.6, freq: 800, q: 4, gain: 0.25, sweep: 200, when: 0.1 }); }
  uno() {
    this._tone({ freq: 523, dur: 0.18, gain: 0.25, type: 'square' });
    this._tone({ freq: 784, dur: 0.35, gain: 0.25, type: 'square', when: 0.16 });
    this.say('UNO!');
  }
  caught() { this._tone({ freq: 880, dur: 0.1, gain: 0.25, type: 'square' }); this._tone({ freq: 440, dur: 0.3, gain: 0.25, type: 'square', when: 0.12 }); }
  chaos() {
    this._tone({ freq: 80, dur: 1.4, gain: 0.6, type: 'sawtooth', slide: 30 });
    this._noise({ dur: 1.4, freq: 200, q: 0.5, gain: 0.5, sweep: 6000, attack: 0.02, rev: 0.4 });
    this._tone({ freq: 1200, dur: 0.6, gain: 0.08, type: 'square', slide: 200, when: 0.1 });
  }
  boom() { this._tone({ freq: 60, dur: 0.9, gain: 0.7, slide: 25 }); this._noise({ dur: 0.7, freq: 500, q: 0.4, gain: 0.5, type: 'lowpass', rev: 0.4 }); }
  mercy() { [196, 247, 294].forEach((f, i) => this._tone({ freq: f, dur: 1.6, gain: 0.25, type: 'sine', when: i * 0.02, rev: 0.6 })); }
  win() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this._tone({ freq: f, dur: 0.5, gain: 0.2, type: 'triangle', when: i * 0.11 }));
    [1047, 1319, 1568].forEach((f) => this._tone({ freq: f, dur: 1.4, gain: 0.12, type: 'sine', when: 0.6 }));
  }
  lose() { [392, 349, 311, 262].forEach((f, i) => this._tone({ freq: f, dur: 0.45, gain: 0.18, type: 'triangle', when: i * 0.22 })); }

  // ---------------------------------------------------------------- HERO cards
  heroFanfare() {
    [392, 523, 659, 784].forEach((f, i) => {
      this._tone({ freq: f, dur: 1.4, gain: 0.16, type: 'sawtooth', when: i * 0.09, rev: 0.5 });
      this._tone({ freq: f * 2, dur: 1.2, gain: 0.06, type: 'triangle', when: i * 0.09 + 0.02, rev: 0.5 });
    });
    this._tone({ freq: 98, dur: 2, gain: 0.35, type: 'sine', slide: 65, rev: 0.4 });
  }
  sonic() {
    this._noise({ dur: 0.9, freq: 300, q: 0.6, gain: 0.5, sweep: 6000, attack: 0.3, rev: 0.3 });
    this._tone({ freq: 60, dur: 0.5, gain: 0.6, when: 0.85, slide: 30 });
    this._noise({ dur: 0.5, freq: 900, q: 0.4, gain: 0.6, type: 'lowpass', when: 0.85, rev: 0.5 });
  }
  clang() {
    [1240, 1870, 2650, 3310].forEach((f, i) => this._tone({ freq: f, dur: 1.4 - i * 0.2, gain: 0.12, type: 'sine', rev: 0.6 }));
    this._noise({ dur: 0.08, freq: 4000, q: 2, gain: 0.4 });
  }
  sun() {
    [130.8, 164.8, 196, 261.6, 329.6].forEach((f, i) => this._tone({ freq: f, dur: 2.6, gain: 0.12, type: 'sawtooth', attack: 0.8, when: i * 0.05, rev: 0.8 }));
    this._tone({ freq: 45, dur: 2.2, gain: 0.7, when: 1.0, slide: 25 });
    this._noise({ dur: 2, freq: 400, q: 0.3, gain: 0.6, type: 'lowpass', when: 1.0, rev: 0.7 });
  }
  thunder(when = 0) {
    this._noise({ dur: 0.12, freq: 3000, q: 0.5, gain: 0.7, type: 'highpass', when });
    this._noise({ dur: 1.6, freq: 180, q: 0.4, gain: 0.8, type: 'lowpass', when: when + 0.05, attack: 0.02, rev: 0.6 });
    this._tone({ freq: 50, dur: 1.2, gain: 0.5, when, slide: 28 });
  }
  hero(name) {
    this.heroFanfare();
    if (name === 'superman') setTimeout(() => this.sonic(), 1300);
    if (name === 'cap') setTimeout(() => this.clang(), 1700);
    if (name === 'sentry') setTimeout(() => this.sun(), 1300);
    if (name === 'thor') setTimeout(() => { this.thunder(); this.thunder(0.2); this.thunder(0.4); }, 1400);
  }

  say(text) {
    if (!this.voice || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.15; u.pitch = 1.2; u.volume = Math.min(1, this.volumes.master * this.volumes.sfx);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch { /* speech is optional */ }
  }

  // ---------------------------------------------------------------- ambience
  setAmbience(env) {
    this.env = env;
    if (!this.ctx) return;
    const c = this.ctx;
    for (const n of this.ambienceNodes) { try { n.stop ? n.stop() : n.disconnect(); } catch { /* already stopped */ } }
    this.ambienceNodes = [];
    clearInterval(this._ambTimer);
    const loopNoise = (freq, q, gain, type = 'lowpass') => {
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf; src.loop = true;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(f).connect(g).connect(this.ambBus);
      src.start();
      this.ambienceNodes.push(src);
      return { src, f, g };
    };
    const pad = (freqs, gain, type = 'sine') => {
      for (const fr of freqs) {
        const o = c.createOscillator(); o.type = type; o.frequency.value = fr;
        const lfo = c.createOscillator(); lfo.frequency.value = 0.07 + Math.random() * 0.1;
        const lg = c.createGain(); lg.gain.value = fr * 0.004;
        lfo.connect(lg).connect(o.frequency);
        const g = c.createGain(); g.gain.value = gain;
        o.connect(g).connect(this.musicBus);
        o.start(); lfo.start();
        this.ambienceNodes.push(o, lfo);
      }
    };
    if (env === 'casino') {
      // Crowd murmur + occasional chip clinks.
      const m = loopNoise(450, 0.6, 0.35, 'bandpass');
      const lfo = c.createOscillator(); lfo.frequency.value = 0.3;
      const lg = c.createGain(); lg.gain.value = 120;
      lfo.connect(lg).connect(m.f.frequency); lfo.start(); this.ambienceNodes.push(lfo);
      pad([110, 164.8, 220], 0.025, 'triangle');
      this._ambTimer = setInterval(() => {
        if (Math.random() < 0.5) for (let i = 0; i < 3; i++) this._tone({ freq: 3000 + Math.random() * 2000, dur: 0.05, gain: 0.03, type: 'sine', when: i * 0.06, bus: this.ambBus, rev: 0.3 });
      }, 2600);
    } else if (env === 'living') {
      loopNoise(900, 0.3, 0.08, 'lowpass');
      pad([196, 246.9, 293.7], 0.018, 'sine');
      let tk = 0;
      this._ambTimer = setInterval(() => {
        this._tone({ freq: tk++ % 2 ? 2400 : 2000, dur: 0.03, gain: 0.025, type: 'square', bus: this.ambBus, rev: 0.1 });
      }, 1000);
    } else if (env === 'neon') {
      loopNoise(120, 1, 0.12, 'lowpass');
      pad([55, 82.4, 110, 164.8], 0.03, 'sawtooth');
      let beat = 0;
      this._ambTimer = setInterval(() => {
        this._tone({ freq: 60, dur: 0.25, gain: beat % 4 === 0 ? 0.12 : 0.06, slide: 40, bus: this.ambBus, rev: 0 });
        beat++;
      }, 500);
    }
  }

  // Chaos Mode adaptive layer: intensity 0..1 drives a rising, pulsing drone.
  setChaos(intensity) {
    if (!this.ctx) return;
    const c = this.ctx;
    if (!this.chaosNodes && intensity > 0) {
      const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 55;
      const o2 = c.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 55.6;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300; f.Q.value = 6;
      const g = c.createGain(); g.gain.value = 0;
      const lfo = c.createOscillator(); lfo.frequency.value = 1;
      const lg = c.createGain(); lg.gain.value = 200;
      lfo.connect(lg).connect(f.frequency);
      o1.connect(f); o2.connect(f); f.connect(g).connect(this.musicBus);
      o1.start(); o2.start(); lfo.start();
      this.chaosNodes = { o1, o2, f, g, lfo };
    }
    if (!this.chaosNodes) return;
    const t = c.currentTime;
    const n = this.chaosNodes;
    n.g.gain.setTargetAtTime(intensity * 0.12, t, 0.5);
    n.lfo.frequency.setTargetAtTime(0.8 + intensity * 5, t, 0.5);
    n.f.frequency.setTargetAtTime(250 + intensity * 900, t, 0.5);
    n.o2.frequency.setTargetAtTime(55.6 + intensity * 2, t, 0.5);
  }

  stopChaos() {
    if (!this.chaosNodes) return;
    const n = this.chaosNodes;
    n.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    setTimeout(() => { try { n.o1.stop(); n.o2.stop(); n.lfo.stop(); } catch { /* done */ } }, 1500);
    this.chaosNodes = null;
  }
}
