import type { Camera } from './render/camera';

// Procedural sound (Web Audio, no files). Every shot and blast goes through a
// short "street canyon" reverb; zombies moan through vowel formants; a horde
// drone swells with the number of zombies. Only events on screen play, louder
// when zoomed in, panned by screen position, and rate-limited per kind.

export type SfxKind = 'gun' | 'rifle' | 'sniper' | 'boom' | 'thump' | 'groan' | 'plane' | 'siren' | 'place' | 'click' | 'error';
export interface SfxEvent {
  k: SfxKind;
  x: number;
  y: number;
}

const PER_FRAME: Record<SfxKind, number> = { gun: 3, rifle: 2, sniper: 2, boom: 3, thump: 2, groan: 2, plane: 1, siren: 1, place: 1, click: 1, error: 1 };
const KEY = 'zombie-fuckers-muted';
const VOWELS: [number, number][] = [
  [500, 900], // "o"
  [700, 1200], // "a"
  [350, 700], // "u"
];

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private dry: GainNode | null = null;
  private wet: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private horde: GainNode | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(KEY) === '1';
    } catch {
      /* storage blocked */
    }
  }

  /** Browsers allow audio only after a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // street-canyon reverb: dense early echoes, 1.6 s tail
    const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.6), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const t = i / ctx.sampleRate;
        const echo = Math.sin(t * 40 + ch) > 0.96 ? 2.5 : 1; // slap-back off the facades
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t / 1.6, 3) * echo * 0.6;
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.35;
    this.dry.connect(this.master);
    this.wet.connect(conv).connect(this.master);

    // horde drone: brown-ish noise + detuned low saws, silent until zombies show up
    this.horde = ctx.createGain();
    this.horde.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    this.horde.connect(this.master);
    lp.connect(this.horde);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.25;
    const ng = ctx.createGain();
    ng.gain.value = 0.35;
    src.connect(ng).connect(lp);
    src.start();
    for (const f of [61, 67.5, 73, 89]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const trem = ctx.createOscillator();
      trem.frequency.value = 0.3 + Math.random() * 0.5;
      const tg = ctx.createGain();
      tg.gain.value = 0.05;
      const og = ctx.createGain();
      og.gain.value = 0.06;
      trem.connect(tg).connect(og.gain);
      o.connect(og).connect(lp);
      o.start();
      trem.start();
    }
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    try {
      localStorage.setItem(KEY, this.muted ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    return this.muted;
  }

  /** 0..1: how loud the horde drone should be. */
  setHorde(level: number): void {
    if (!this.ctx || !this.horde) return;
    this.horde.gain.setTargetAtTime(Math.min(1, level) * 0.5, this.ctx.currentTime, 0.8);
  }

  /** Plays this frame's world events and clears the queue. */
  drain(events: SfxEvent[], cam: Camera): void {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') {
      events.length = 0;
      return;
    }
    const used: Partial<Record<SfxKind, number>> = {};
    const loud = Math.max(0.3, Math.min(1, cam.zoom / 1.4));
    for (const e of events) {
      if ((used[e.k] ?? 0) >= PER_FRAME[e.k]) continue;
      const [sx, sy] = cam.toScreen(e.x, e.y);
      const margin = e.k === 'boom' || e.k === 'plane' || e.k === 'siren' ? 600 : 80;
      if (sx < -margin || sy < -margin || sx > cam.vw + margin || sy > cam.vh + margin) continue;
      const off = sx < 0 || sy < 0 || sx > cam.vw || sy > cam.vh ? 0.35 : 1; // distant rumble
      used[e.k] = (used[e.k] ?? 0) + 1;
      this.play(e.k, loud * off, Math.max(-1, Math.min(1, (sx / cam.vw) * 2 - 1)) * 0.7);
    }
    events.length = 0;
  }

  /** Interface sound, not tied to a map position. */
  ui(k: 'place' | 'click' | 'error' | 'siren'): void {
    if (this.ctx && !this.muted) this.play(k, 0.8, 0);
  }

  /** Output for one sound: panned, split into dry and reverb sends. */
  private out(pan: number, vol: number, reverb = 1): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(this.dry!);
    if (reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      p.connect(send).connect(this.wet!);
    }
    return g;
  }

  private burst(dest: AudioNode, dur: number, type: BiquadFilterType, freq: number, q = 1, vol = 1, delay = 0, attack = 0.002): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0, attack = 0.003): OscillatorNode {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private play(k: SfxKind, loud: number, pan: number): void {
    switch (k) {
      case 'gun': {
        // machine gun round: crack + chest thump
        const o = this.out(pan, 0.4 * loud, 0.6);
        this.burst(o, 0.05, 'highpass', 2500, 0.7, 0.9);
        this.burst(o, 0.09, 'bandpass', 900, 1.2, 0.8);
        this.tone(o, 'sine', 160, 55, 0.08, 0.7);
        break;
      }
      case 'rifle': {
        const o = this.out(pan, 0.28 * loud, 0.5);
        this.burst(o, 0.04, 'highpass', 3000, 0.7, 0.8);
        this.burst(o, 0.12, 'bandpass', 1300, 1, 0.6);
        break;
      }
      case 'sniper': {
        // supersonic crack, heavy report, long echo down the avenue
        const o = this.out(pan, 0.7 * loud, 1.4);
        this.burst(o, 0.025, 'highpass', 4000, 0.5, 1);
        this.burst(o, 0.22, 'bandpass', 700, 0.9, 0.9, 0.004);
        this.tone(o, 'sine', 140, 38, 0.35, 1, 0.004);
        break;
      }
      case 'boom': {
        // sub hit + rumble + debris crackle
        const o = this.out(pan, 1 * loud, 1.2);
        this.tone(o, 'sine', 75, 24, 1.3, 1, 0, 0.005);
        this.burst(o, 1.6, 'lowpass', 300, 0.6, 1, 0, 0.01);
        this.burst(o, 0.12, 'highpass', 1500, 0.5, 0.6);
        for (let k2 = 0; k2 < 6; k2++) this.burst(o, 0.05, 'highpass', 2500 + Math.random() * 2000, 0.6, 0.25, 0.15 + Math.random() * 0.7);
        break;
      }
      case 'thump': {
        const o = this.out(pan, 0.55 * loud, 0.8);
        this.tone(o, 'sine', 120, 42, 0.3, 1);
        this.burst(o, 0.15, 'lowpass', 600, 0.7, 0.5);
        break;
      }
      case 'groan': {
        // glottal buzz through two vowel formants, sliding down
        const ctx = this.ctx!;
        const o = this.out(pan, 0.22 * loud, 0.6);
        const [f1, f2] = VOWELS[Math.floor(Math.random() * VOWELS.length)];
        const dur = 0.7 + Math.random() * 0.8;
        const mix = ctx.createGain();
        mix.gain.value = 1;
        for (const [f, q, v] of [[f1, 6, 1], [f2, 8, 0.5]] as const) {
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.setValueAtTime(f, ctx.currentTime);
          bp.frequency.linearRampToValueAtTime(f * 0.8, ctx.currentTime + dur);
          bp.Q.value = q;
          const g = ctx.createGain();
          g.gain.value = v * 3;
          mix.connect(bp).connect(g).connect(o);
        }
        const pitch = 85 + Math.random() * 45;
        const osc = this.tone(mix, 'sawtooth', pitch, pitch * 0.7, dur, 0.9, 0, 0.12);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 4 + Math.random() * 4;
        const depth = ctx.createGain();
        depth.gain.value = 9;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start();
        lfo.stop(ctx.currentTime + dur + 0.1);
        this.burst(o, dur, 'bandpass', 1800, 1, 0.08, 0, 0.1); // breath
        break;
      }
      case 'plane': {
        // jet pass with a doppler sweep
        const o = this.out(pan, 0.45 * loud, 0.9);
        this.burst(o, 3, 'lowpass', 500, 0.6, 0.9, 0, 0.8);
        this.tone(o, 'sawtooth', 110, 60, 3, 0.12, 0, 0.8);
        this.burst(o, 2.6, 'bandpass', 2200, 2, 0.15, 0.2, 0.9);
        break;
      }
      case 'siren': {
        const ctx = this.ctx!;
        const o = this.out(0, 0.12, 1.5);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 700;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.45;
        const depth = ctx.createGain();
        depth.gain.value = 260;
        lfo.connect(depth).connect(osc.frequency);
        const g = ctx.createGain();
        const t = ctx.currentTime;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(1, t + 0.4);
        g.gain.setValueAtTime(1, t + 3.5);
        g.gain.exponentialRampToValueAtTime(0.0005, t + 5);
        osc.connect(g).connect(o);
        osc.start(t);
        lfo.start(t);
        osc.stop(t + 5.1);
        lfo.stop(t + 5.1);
        break;
      }
      case 'place': {
        const o = this.out(0, 0.22, 0.2);
        this.tone(o, 'triangle', 660, 660, 0.06, 0.6);
        this.tone(o, 'triangle', 990, 990, 0.09, 0.6, 0.06);
        break;
      }
      case 'click':
        this.tone(this.out(0, 0.12, 0), 'triangle', 1400, 1100, 0.035, 0.6);
        break;
      case 'error':
        this.tone(this.out(0, 0.18, 0), 'square', 200, 150, 0.16, 0.4);
        break;
    }
  }
}
