/**
 * Key/value persistence backend.
 *
 * `engine/Storage.ts` depends only on the `KeyValueBackend` interface, so the
 * exact same save logic runs on:
 *   - web / PWA  → `window.localStorage` (this file)
 *   - iOS/Android via Capacitor → swap in `@capacitor/preferences`
 *   - tests / blocked storage (Safari private mode, locked-down WebView)
 *     → the in-memory backend, so the game still runs for the session.
 *
 * No network access, ever.
 */

export interface KeyValueBackend {
  /** Short id for diagnostics, e.g. `localStorage` or `memory`. */
  readonly id: string;
  /** `false` when writes are not durable beyond the current session. */
  readonly persistent: boolean;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function createMemoryBackend(id = 'memory'): KeyValueBackend {
  const map = new Map<string, string>();
  return {
    id,
    persistent: false,
    get: (key) => (map.has(key) ? (map.get(key) as string) : null),
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Probe `localStorage` with a real write/read/delete round-trip. Merely
 * *accessing* `window.localStorage` throws in some privacy modes, and a
 * present-but-quota-zero store throws on `setItem` — both must degrade to
 * the memory backend instead of crashing the boot sequence.
 */
function probeLocalStorage(store: Storage): boolean {
  const probeKey = '__frontline_probe__';
  try {
    store.setItem(probeKey, '1');
    const ok = store.getItem(probeKey) === '1';
    store.removeItem(probeKey);
    return ok;
  } catch {
    return false;
  }
}

export function createLocalStorageBackend(): KeyValueBackend {
  let store: Storage | null = null;
  try {
    store = globalThis.localStorage ?? null;
  } catch {
    store = null;
  }
  if (!store || !probeLocalStorage(store)) return createMemoryBackend('memory (storage unavailable)');

  const local = store;
  return {
    id: 'localStorage',
    persistent: true,
    get: (key) => {
      try {
        return local.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        local.setItem(key, value);
      } catch {
        /* quota exceeded / storage disabled mid-session — keep playing */
      }
    },
    remove: (key) => {
      try {
        local.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Backend used by the app unless one is injected (tests, Capacitor). */
export function createDefaultBackend(): KeyValueBackend {
  return createLocalStorageBackend();
}
