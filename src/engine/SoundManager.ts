/**
 * SoundManager — procedural Web Audio synth.
 *
 * Every sound is generated at runtime from oscillators, filtered noise bursts
 * and envelopes: no audio files, no network, nothing to cache — which is what
 * an offline-first PWA (and a native Capacitor WebView) wants.
 *
 * Each weapon has its own signature rather than a pitch-shifted copy of one
 * gunshot, because the mix is the only feedback the player gets that the right
 * units are on the line:
 *
 *   rifleShot  sharp transient crack, thin tail        (bolt-action)
 *   smgShot    lighter, brighter, very short           (burp gun)
 *   mgShot     heavier thud with a longer, lower body  (sustained fire)
 *   shellFire  cannon blast + breech clank             (tank main gun)
 *   ricochet   metallic ping with a falling pitch      (bullet on armour)
 *   explosion  long low rumble with debris crackle     (shell / mine blast)
 *
 * Browser reality: an AudioContext may only *start* from a user gesture, so
 * `unlock()` must be called from a real click/keypress handler. Until then
 * every `play()` is a silent no-op — the game never throws or stalls because
 * audio is unavailable.
 */

export type SoundName =
  | 'rifleShot'
  | 'smgShot'
  | 'mgShot'
  | 'shellFire'
  | 'ricochet'
  | 'impact'
  | 'explosion'
  | 'mineBlast'
  | 'deploy'
  | 'upgrade'
  | 'uiClick'
  | 'uiBack';

export type SoundManagerState = 'unsupported' | 'locked' | 'running' | 'suspended';

export interface PlayOptions {
  /** Per-call gain multiplier (0–1). */
  readonly volume?: number;
  /** Pitch multiplier, e.g. 1.2 for a snappier shot. */
  readonly rate?: number;
}

export interface SoundManagerOptions {
  readonly muted?: boolean;
  readonly volume?: number;
  /** Called whenever mute toggles so the caller can persist it. */
  readonly onMutedChange?: (muted: boolean) => void;
}

interface VoiceBudget {
  /** Minimum gap between two plays of this sound, ms. */
  readonly throttleMs: number;
  /** How long a voice of this sound occupies the mixer, ms. */
  readonly lifeMs: number;
  /** Simultaneous voices of this sound. */
  readonly maxVoices: number;
}

/**
 * Mixing budget per sound. Battlefields are loud places: without these, six
 * machine guns firing at once turn into a single clipped rasp.
 */
const BUDGET: Record<SoundName, VoiceBudget> = {
  rifleShot: { throttleMs: 70, lifeMs: 260, maxVoices: 4 },
  smgShot: { throttleMs: 45, lifeMs: 180, maxVoices: 5 },
  mgShot: { throttleMs: 55, lifeMs: 300, maxVoices: 3 },
  shellFire: { throttleMs: 120, lifeMs: 900, maxVoices: 3 },
  ricochet: { throttleMs: 60, lifeMs: 300, maxVoices: 4 },
  impact: { throttleMs: 50, lifeMs: 200, maxVoices: 5 },
  explosion: { throttleMs: 90, lifeMs: 1500, maxVoices: 3 },
  mineBlast: { throttleMs: 120, lifeMs: 1400, maxVoices: 2 },
  deploy: { throttleMs: 140, lifeMs: 500, maxVoices: 2 },
  upgrade: { throttleMs: 120, lifeMs: 500, maxVoices: 2 },
  uiClick: { throttleMs: 40, lifeMs: 120, maxVoices: 2 },
  uiBack: { throttleMs: 40, lifeMs: 220, maxVoices: 2 },
};

const NOISE_SECONDS = 2;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function resolveAudioContext(): AudioContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Filtered noise burst — the raw material of cracks, thuds and rumbles. */
interface NoiseSpec {
  readonly type: BiquadFilterType;
  readonly from: number;
  readonly to: number;
  readonly q: number;
  readonly gain: number;
  readonly attack: number;
  readonly decay: number;
}

/** Pitched body — the "boom" underneath a blast. */
interface ToneSpec {
  readonly type: OscillatorType;
  readonly from: number;
  readonly to: number;
  readonly gain: number;
  readonly attack: number;
  readonly decay: number;
}

export class SoundManager {
  private ctor: AudioContextConstructor | null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly lastPlayedAt = new Map<SoundName, number>();
  private readonly activeVoices = new Map<SoundName, number>();

  private mutedFlag: boolean;
  private volumeLevel: number;
  private readonly onMutedChange: ((muted: boolean) => void) | undefined;

  constructor(options: SoundManagerOptions = {}) {
    this.ctor = resolveAudioContext();
    this.mutedFlag = options.muted ?? false;
    this.volumeLevel = clamp01(options.volume ?? 0.7);
    this.onMutedChange = options.onMutedChange;
  }

  static isSupported(): boolean {
    return resolveAudioContext() !== null;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  /** Muting silences output but keeps the context alive for instant unmute. */
  set muted(value: boolean) {
    const next = value === true;
    if (next === this.mutedFlag) return;
    this.mutedFlag = next;
    this.applyMasterGain();
    this.onMutedChange?.(next);
  }

  get volume(): number {
    return this.volumeLevel;
  }

  set volume(value: number) {
    this.volumeLevel = clamp01(value);
    this.applyMasterGain();
  }

  get state(): SoundManagerState {
    if (!this.ctor) return 'unsupported';
    if (!this.ctx) return 'locked';
    return this.ctx.state === 'running' ? 'running' : 'suspended';
  }

  toggleMute(): boolean {
    this.muted = !this.mutedFlag;
    return this.mutedFlag;
  }

  /**
   * Create/resume the audio graph. Call from a user-gesture handler.
   * Returns `true` when audio is live.
   */
  async unlock(): Promise<boolean> {
    if (!this.ctor) return false;
    if (!this.ctx) {
      try {
        this.ctx = new this.ctor({ latencyHint: 'interactive' });
      } catch {
        this.ctor = null;
        return false;
      }
      this.buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }
    return this.ctx.state === 'running';
  }

  /** Play a named sound. Silent no-op when locked/unsupported/muted. */
  play(name: SoundName, options: PlayOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || this.mutedFlag || ctx.state !== 'running') return;

    const gain = clamp01(options.volume ?? 1);
    if (gain <= 0) return;
    if (!this.reserveVoice(name)) return;
    const rate = clamp(options.rate ?? 1, 0.5, 2);

    try {
      this.render(ctx, name, gain, rate);
    } catch {
      /* A failed voice must never break the frame loop. */
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    void ctx?.close().catch(() => undefined);
  }

  // ------------------------------------------------------------------ graph

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const master = ctx.createGain();
    // A compressor keeps stacked explosions from clipping a phone speaker.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    this.master = master;
    this.noise = createNoiseBuffer(ctx, NOISE_SECONDS);
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (!this.master || !this.ctx) return;
    const target = this.mutedFlag ? 0 : this.volumeLevel;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
  }

  /** Throttle, then claim one of this sound's voices. */
  private reserveVoice(name: SoundName): boolean {
    const budget = BUDGET[name];
    const now = performance.now();
    const previous = this.lastPlayedAt.get(name) ?? -Infinity;
    if (now - previous < budget.throttleMs) return false;
    if ((this.activeVoices.get(name) ?? 0) >= budget.maxVoices) return false;
    this.lastPlayedAt.set(name, now);
    this.activeVoices.set(name, (this.activeVoices.get(name) ?? 0) + 1);
    globalThis.setTimeout(() => {
      const held = this.activeVoices.get(name) ?? 1;
      this.activeVoices.set(name, Math.max(0, held - 1));
    }, budget.lifeMs);
    return true;
  }

  private dest(): AudioNode | null {
    return this.master;
  }

  // ------------------------------------------------------------- primitives

  /** Filtered noise burst, e.g. a muzzle crack or the body of a rumble. */
  private noiseBurst(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    spec: NoiseSpec,
    volume: number,
    rate: number,
  ): void {
    const source = ctx.createBufferSource();
    if (!this.noise) return;
    source.buffer = this.noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = spec.type;
    filter.Q.value = spec.q;
    filter.frequency.setValueAtTime(clampFreq(spec.from * rate), at);
    filter.frequency.exponentialRampToValueAtTime(clampFreq(spec.to * rate), at + spec.decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, spec.gain * volume), at + spec.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + spec.attack + spec.decay);
    source.connect(filter);
    filter.connect(env);
    env.connect(out);
    source.start(at);
    source.stop(at + spec.attack + spec.decay + 0.05);
  }

  /** Pitched sine/triangle body with a falling pitch. */
  private tone(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    spec: ToneSpec,
    volume: number,
    rate: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(clampFreq(spec.from * rate), at);
    osc.frequency.exponentialRampToValueAtTime(clampFreq(spec.to), at + spec.decay);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, spec.gain * volume), at + spec.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + spec.attack + spec.decay);
    osc.connect(env);
    env.connect(out);
    osc.start(at);
    osc.stop(at + spec.attack + spec.decay + 0.05);
  }

  /** A short metallic ring — used for breeches, magazines and ricochets. */
  private clank(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    frequency: number,
    volume: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(clampFreq(frequency), at);
    osc.frequency.exponentialRampToValueAtTime(clampFreq(frequency * 0.72), at + 0.06);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 3.5;
    filter.frequency.value = clampFreq(frequency * 1.4);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.3 * volume), at + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    osc.connect(filter);
    filter.connect(env);
    env.connect(out);
    osc.start(at);
    osc.stop(at + 0.12);
  }

  // -------------------------------------------------------------- signatures

  private render(ctx: AudioContext, name: SoundName, volume: number, rate: number): void {
    const out = this.dest();
    if (!out) return;
    const t = ctx.currentTime;

    switch (name) {
      // Bolt-action: a hard supersonic snap, very little body, dry tail.
      case 'rifleShot':
        this.noiseBurst(
          ctx, out, t,
          { type: 'bandpass', from: 3200, to: 700, q: 0.7, gain: 0.85, attack: 0.003, decay: 0.1 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'triangle', from: 190, to: 60, gain: 0.34, attack: 0.004, decay: 0.13 }, volume, rate);
        break;

      // SMG: brighter and drier, with a hint of mechanical cycling.
      case 'smgShot':
        this.noiseBurst(
          ctx, out, t,
          { type: 'bandpass', from: 4200, to: 1200, q: 1.1, gain: 0.62, attack: 0.002, decay: 0.055 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'square', from: 240, to: 90, gain: 0.16, attack: 0.002, decay: 0.05 }, volume, rate);
        break;

      // MG: heavier and slower, with real low-end push and a longer tail.
      case 'mgShot':
        this.noiseBurst(
          ctx, out, t,
          { type: 'bandpass', from: 1900, to: 260, q: 0.5, gain: 0.9, attack: 0.004, decay: 0.19 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'triangle', from: 150, to: 44, gain: 0.5, attack: 0.005, decay: 0.22 }, volume, rate);
        this.noiseBurst(
          ctx, out, t + 0.06,
          { type: 'lowpass', from: 400, to: 120, q: 0.6, gain: 0.3, attack: 0.008, decay: 0.24 },
          volume, 1,
        );
        break;

      // Tank main gun: a cannon blast with a breech clank right behind it.
      case 'shellFire':
        this.noiseBurst(
          ctx, out, t,
          { type: 'lowpass', from: 2600, to: 90, q: 1.2, gain: 1, attack: 0.006, decay: 0.6 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'sine', from: 82, to: 26, gain: 0.75, attack: 0.01, decay: 0.7 }, volume, rate);
        this.clank(ctx, out, t + 0.09, 1100, volume * 0.5);
        break;

      // Metallic ricochet: bright ping that falls away with a buzz.
      case 'ricochet':
        this.noiseBurst(
          ctx, out, t,
          { type: 'bandpass', from: 5200, to: 1800, q: 6, gain: 0.5, attack: 0.002, decay: 0.13 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'square', from: 2600, to: 900, gain: 0.2, attack: 0.002, decay: 0.16 }, volume, rate);
        break;

      // Bullet striking dirt or a body: a dull, closed tick.
      case 'impact':
        this.noiseBurst(
          ctx, out, t,
          { type: 'lowpass', from: 1400, to: 300, q: 1.4, gain: 0.55, attack: 0.002, decay: 0.075 },
          volume, rate,
        );
        break;

      // Shell blast: long low rumble with a debris crackle on top.
      case 'explosion':
        this.noiseBurst(
          ctx, out, t,
          { type: 'lowpass', from: 1800, to: 60, q: 1.1, gain: 0.95, attack: 0.012, decay: 1 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'sine', from: 60, to: 24, gain: 0.7, attack: 0.02, decay: 0.9 }, volume, rate);
        this.noiseBurst(
          ctx, out, t + 0.16,
          { type: 'highpass', from: 2200, to: 900, q: 0.8, gain: 0.22, attack: 0.02, decay: 0.5 },
          volume, 1,
        );
        break;

      // Mine: dirtier and more abrupt than a shell, all low-mid.
      case 'mineBlast':
        this.noiseBurst(
          ctx, out, t,
          { type: 'lowpass', from: 1100, to: 50, q: 1.6, gain: 0.9, attack: 0.006, decay: 0.8 },
          volume, rate,
        );
        this.tone(ctx, out, t, { type: 'triangle', from: 90, to: 30, gain: 0.6, attack: 0.008, decay: 0.55 }, volume, rate);
        this.noiseBurst(
          ctx, out, t + 0.12,
          { type: 'highpass', from: 1600, to: 700, q: 1, gain: 0.26, attack: 0.01, decay: 0.45 },
          volume, 1,
        );
        break;

      // Reinforcements arriving: a truck horn over an engine rumble.
      case 'deploy':
        this.tone(ctx, out, t, { type: 'sawtooth', from: 300, to: 280, gain: 0.16, attack: 0.02, decay: 0.3 }, volume, 1);
        this.tone(ctx, out, t + 0.04, { type: 'triangle', from: 420, to: 415, gain: 0.14, attack: 0.02, decay: 0.24 }, volume, 1);
        break;

      // Logistics upgrade: an ascending two-note confirmation.
      case 'upgrade':
        this.tone(ctx, out, t, { type: 'triangle', from: 520, to: 520, gain: 0.22, attack: 0.008, decay: 0.12 }, volume, 1);
        this.tone(ctx, out, t + 0.1, { type: 'triangle', from: 780, to: 780, gain: 0.22, attack: 0.008, decay: 0.18 }, volume, 1);
        break;

      case 'uiClick':
        this.tone(ctx, out, t, { type: 'square', from: 1180, to: 760, gain: 0.2, attack: 0.003, decay: 0.05 }, volume, 1);
        break;

      case 'uiBack':
        this.tone(ctx, out, t, { type: 'sine', from: 520, to: 300, gain: 0.2, attack: 0.004, decay: 0.1 }, volume, 1);
        break;
    }
  }
}

function createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  // Deterministic LCG: identical noise on every device, no seeding surprises.
  let state = 0x2f6e2b1;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    channel[i] = (state / 0xffffffff) * 2 - 1;
  }
  return buffer;
}

/** Biquad/oscillator frequencies must stay inside Nyquist or they throw. */
function clampFreq(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(20000, Math.max(10, value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
