/**
 * SoundManager — procedural Web Audio synth.
 *
 * Every sound is generated at runtime from oscillators and a shared noise
 * buffer: no audio files, no network, and nothing to cache, which is exactly
 * what an offline-first PWA (and a native Capacitor WebView) wants.
 *
 * Browser reality: an AudioContext may only *start* from a user gesture, so
 * `unlock()` must be called from a real click/keypress handler. Until then
 * every `play()` is a silent no-op — the game never throws or stalls because
 * audio is unavailable.
 */

export type SoundName =
  | 'shot'
  | 'hit'
  | 'explosion'
  | 'uiClick'
  | 'uiBack'
  | 'reload';

export type SoundManagerState = 'unsupported' | 'locked' | 'running' | 'suspended';

export interface PlayOptions {
  /** Per-call gain multiplier (0–1). */
  readonly volume?: number;
  /** Pitch multiplier, e.g. 1.2 for a snappier pistol. */
  readonly rate?: number;
}

export interface SoundManagerOptions {
  readonly muted?: boolean;
  readonly volume?: number;
  /** Called whenever mute toggles so the caller can persist it. */
  readonly onMutedChange?: (muted: boolean) => void;
}

/** Simultaneous voices before new requests are dropped. */
const MAX_VOICES = 12;
/** Minimum gap between two plays of the *same* sound (anti-machine-gun buzz). */
const MIN_REPEAT_MS = 25;
const NOISE_SECONDS = 1;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function resolveAudioContext(): AudioContextConstructor | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export class SoundManager {
  private ctor: AudioContextConstructor | null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly lastPlayedAt = new Map<SoundName, number>();
  private activeVoices = 0;

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
    if (!this.reserveVoice(name)) return;

    const gain = clamp01(options.volume ?? 1);
    if (gain <= 0) return;
    const rate = clamp(options.rate ?? 1, 0.5, 2);

    try {
      switch (name) {
        case 'shot':
          this.synthShot(ctx, gain, rate);
          break;
        case 'hit':
          this.synthHit(ctx, gain, rate);
          break;
        case 'explosion':
          this.synthExplosion(ctx, gain, rate);
          break;
        case 'uiClick':
          this.synthClick(ctx, gain);
          break;
        case 'uiBack':
          this.synthBack(ctx, gain);
          break;
        case 'reload':
          this.synthReload(ctx, gain, rate);
          break;
      }
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
    // A compressor keeps stacked explosions from clipping the phone speaker.
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

  private reserveVoice(name: SoundName): boolean {
    const now = performance.now();
    const previous = this.lastPlayedAt.get(name) ?? -Infinity;
    if (now - previous < MIN_REPEAT_MS) return false;
    if (this.activeVoices >= MAX_VOICES) return false;
    this.lastPlayedAt.set(name, now);
    this.activeVoices += 1;
    globalThis.setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, 1200);
    return true;
  }

  // -------------------------------------------------------------- synthesis

  /** Looping white-noise source — the basis of every impact sound. */
  private noiseSource(ctx: AudioContext): AudioBufferSourceNode | null {
    if (!this.noise) return null;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    return source;
  }

  private dest(): AudioNode | null {
    return this.master;
  }

  /** Rifle-crack: broadband noise snap + descending 160→48 Hz body thump. */
  private synthShot(ctx: AudioContext, volume: number, rate: number): void {
    const out = this.dest();
    if (!out) return;
    const t = ctx.currentTime;
    const noise = this.noiseSource(ctx);
    if (noise) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 0.8;
      band.frequency.setValueAtTime(1800 * rate, t);
      band.frequency.exponentialRampToValueAtTime(280, t + 0.13);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.85 * volume, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      noise.connect(band);
      band.connect(env);
      env.connect(out);
      noise.start(t);
      noise.stop(t + 0.2);
    }
    const thump = ctx.createOscillator();
    thump.type = 'triangle';
    thump.frequency.setValueAtTime(160 * rate, t);
    thump.frequency.exponentialRampToValueAtTime(48, t + 0.14);
    const thumpEnv = ctx.createGain();
    thumpEnv.gain.setValueAtTime(0.0001, t);
    thumpEnv.gain.exponentialRampToValueAtTime(0.5 * volume, t + 0.005);
    thumpEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    thump.connect(thumpEnv);
    thumpEnv.connect(out);
    thump.start(t);
    thump.stop(t + 0.2);
  }

  /** Bullet impact: tight mid-band noise tick, very short. */
  private synthHit(ctx: AudioContext, volume: number, rate: number): void {
    const out = this.dest();
    if (!out) return;
    const t = ctx.currentTime;
    const noise = this.noiseSource(ctx);
    if (!noise) return;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 2.2;
    band.frequency.setValueAtTime(900 * rate, t);
    band.frequency.exponentialRampToValueAtTime(400 * rate, t + 0.07);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.55 * volume, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    noise.connect(band);
    band.connect(env);
    env.connect(out);
    noise.start(t);
    noise.stop(t + 0.14);
  }

  /** Explosion: long noise sweep through a falling lowpass + 55→28 Hz sub. */
  private synthExplosion(ctx: AudioContext, volume: number, rate: number): void {
    const out = this.dest();
    if (!out) return;
    const t = ctx.currentTime;
    const noise = this.noiseSource(ctx);
    if (noise) {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.Q.value = 1.1;
      lowpass.frequency.setValueAtTime(1500 * rate, t);
      lowpass.frequency.exponentialRampToValueAtTime(70, t + 0.85);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.95 * volume, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      noise.connect(lowpass);
      lowpass.connect(env);
      env.connect(out);
      noise.start(t);
      noise.stop(t + 1.2);
    }
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(55 * rate, t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.8);
    const subEnv = ctx.createGain();
    subEnv.gain.setValueAtTime(0.0001, t);
    subEnv.gain.exponentialRampToValueAtTime(0.6 * volume, t + 0.02);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    sub.connect(subEnv);
    subEnv.connect(out);
    sub.start(t);
    sub.stop(t + 1);
  }

  /** UI click: short square blip, no reverb tail. */
  private synthClick(ctx: AudioContext, volume: number): void {
    const out = this.dest();
    if (!out) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1180, t);
    osc.frequency.exponentialRampToValueAtTime(760, t + 0.035);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.22 * volume, t + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** UI back/cancel: descending two-tone sine. */
  private synthBack(ctx: AudioContext, volume: number): void {
    const out = this.dest();
    if (!out) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.09);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.2 * volume, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  /** Magazine change: two metallic ticks + a low clunk. */
  private synthReload(ctx: AudioContext, volume: number, rate: number): void {
    const out = this.dest();
    if (!out) return;
    const start = ctx.currentTime;
    const offsets = [0, 0.12];
    for (const offset of offsets) {
      const t = start + offset;
      const noise = this.noiseSource(ctx);
      if (!noise) continue;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 5;
      band.frequency.setValueAtTime(2400 * rate, t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.3 * volume, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      noise.connect(band);
      band.connect(env);
      env.connect(out);
      noise.start(t);
      noise.stop(t + 0.08);
    }
    const clunk = ctx.createOscillator();
    clunk.type = 'triangle';
    const t = start + 0.12;
    clunk.frequency.setValueAtTime(220, t);
    clunk.frequency.exponentialRampToValueAtTime(90, t + 0.07);
    const clunkEnv = ctx.createGain();
    clunkEnv.gain.setValueAtTime(0.0001, t);
    clunkEnv.gain.exponentialRampToValueAtTime(0.25 * volume, t + 0.004);
    clunkEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    clunk.connect(clunkEnv);
    clunkEnv.connect(out);
    clunk.start(t);
    clunk.stop(t + 0.1);
  }
}

function createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  // Deterministic LCG: identical noise on every device, no Math.random seeding.
  let state = 0x2f6e2b1;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    channel[i] = (state / 0xffffffff) * 2 - 1;
  }
  return buffer;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
