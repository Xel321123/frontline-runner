/**
 * Deterministic PRNG.
 *
 * Levels are generated from a seed derived from the campaign node id, so the
 * same node always produces the same layout — required for fair difficulty,
 * for reproducible bug reports, and for headless simulation tests.
 */

export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights must be non-negative and sum > 0. */
  weighted<T>(entries: readonly { readonly value: T; readonly weight: number }[]): T;
}

/** FNV-1a, so a string seed and a number seed behave the same. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, good enough for level layout. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed: number | string): Rng {
  const numeric = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  const next = mulberry32(numeric);

  const range = (min: number, max: number): number => min + next() * (max - min);

  return {
    next,
    range,
    int: (min, max) => Math.floor(range(min, max + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      const index = Math.floor(next() * items.length);
      return items[Math.min(index, items.length - 1)] as (typeof items)[number];
    },
    weighted: (entries) => {
      const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
      if (total <= 0) {
        if (entries.length === 0) throw new Error('weighted() from an empty list');
        return (entries[0] as (typeof entries)[number]).value;
      }
      let roll = next() * total;
      for (const entry of entries) {
        roll -= Math.max(0, entry.weight);
        if (roll <= 0) return entry.value;
      }
      return (entries[entries.length - 1] as (typeof entries)[number]).value;
    },
  };
}
