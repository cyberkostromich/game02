import type { Camera } from './render/camera';

// Procedural sound effects (Web Audio, no files): gunfire, sniper cracks,
// explosions, zombie groans, aircraft, UI blips. Only events on screen play,
// louder when zoomed in, panned by screen position, and rate-limited per kind.

export type SfxKind = 'gun' | 'rifle' | 'sniper' | 'boom' | 'thump' | 'groan' | 'plane' | 'place' | 'click' | 'error';
export interface SfxEvent {
  k: SfxKind;
  x: number;
  y: number;
}

const PER_FRAME: Record<SfxKind, number> = { gun: 3, rifle: 2, sniper: 2, boom: 3, thump: 2, groan: 1, plane: 1, place: 1, click: 1, error: 1 };
const KEY = 'zombie-fuckers-muted';

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
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
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  toggle(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    try {
      localStorage.setItem(KEY, this.muted ? '1' : '0');
    } catch {
      /* storage blocked */
    }
    return this.muted;
  }

  /** Plays this frame's world events and clears the queue. */
  drain(events: SfxEvent[], cam: Camera): void {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') {
      events.length = 0;
      return;
    }
    const used: Partial<Record<SfxKind, number>> = {};
    const loud = Math.max(0.25, Math.min(1, cam.zoom / 1.4));
    for (const e of events) {
      if ((used[e.k] ?? 0) >= PER_FRAME[e.k]) continue;
      const [sx, sy] = cam.toScreen(e.x, e.y);
      const margin = 80;
      if (sx < -margin || sy < -margin || sx > cam.vw + margin || sy > cam.vh + margin) continue;
      used[e.k] = (used[e.k] ?? 0) + 1;
      this.play(e.k, loud, Math.max(-1, Math.min(1, (sx / cam.vw) * 2 - 1)) * 0.7);
    }
    events.length = 0;
  }

  /** Interface sound, not tied to a map position. */
  ui(k: 'place' | 'click' | 'error'): void {
    if (this.ctx && !this.muted) this.play(k, 0.8, 0);
  }

  private out(pan: number, vol: number): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.master!);
    return g;
  }

  private burst(dest: AudioNode, dur: number, type: BiquadFilterType, freq: number, q = 1, vol = 1, delay = 0): void {
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
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private tone(dest: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): OscillatorNode {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private play(k: SfxKind, loud: number, pan: number): void {
    switch (k) {
      case 'gun':
        this.burst(this.out(pan, 0.35 * loud), 0.07, 'bandpass', 1800, 0.8);
        break;
      case 'rifle':
        this.burst(this.out(pan, 0.25 * loud), 0.09, 'bandpass', 1200, 0.7);
        break;
      case 'sniper': {
        const o = this.out(pan, 0.6 * loud);
        this.burst(o, 0.18, 'highpass', 900, 0.5);
        this.tone(o, 'sine', 180, 50, 0.25, 0.8);
        this.burst(o, 0.6, 'lowpass', 500, 0.5, 0.25, 0.08); // echo off the towers
        break;
      }
      case 'boom': {
        const o = this.out(pan, 0.9 * loud);
        this.burst(o, 1.1, 'lowpass', 380, 0.7);
        this.tone(o, 'sine', 90, 30, 0.8, 0.9);
        break;
      }
      case 'thump':
        this.tone(this.out(pan, 0.5 * loud), 'sine', 110, 40, 0.25, 0.9);
        break;
      case 'groan': {
        const ctx = this.ctx!;
        const o = this.out(pan, 0.18 * loud);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 650;
        f.connect(o);
        const osc = this.tone(f, 'sawtooth', 120 + Math.random() * 40, 75, 0.9, 0.7);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5 + Math.random() * 3;
        const depth = ctx.createGain();
        depth.gain.value = 12;
        lfo.connect(depth).connect(osc.frequency);
        lfo.start();
        lfo.stop(ctx.currentTime + 1);
        break;
      }
      case 'plane': {
        const o = this.out(pan, 0.35 * loud);
        this.burst(o, 2.8, 'lowpass', 260, 0.6, 0.9);
        this.tone(o, 'sawtooth', 70, 55, 2.6, 0.15);
        break;
      }
      case 'place': {
        const o = this.out(0, 0.25);
        this.tone(o, 'square', 520, 520, 0.05, 0.4);
        this.tone(o, 'square', 780, 780, 0.07, 0.4, 0.05);
        break;
      }
      case 'click':
        this.tone(this.out(0, 0.15), 'sine', 1300, 1100, 0.03, 0.6);
        break;
      case 'error':
        this.tone(this.out(0, 0.2), 'square', 180, 140, 0.15, 0.4);
        break;
    }
  }
}
