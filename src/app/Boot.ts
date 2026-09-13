/**
 * Boot — composition root for the web/PWA build.
 *
 * Step 1 deliberately stops here: this screen wires the engine together and
 * proves the foundations work (save file round-trip, audio unlock, asset loads
 * with procedural fallback, canvas sizing). There is **no game loop yet** —
 * it draws one static frame and redraws only when the viewport changes.
 *
 * Native (Capacitor) builds reuse everything below the `startApp` call.
 */

import type { Faction } from '../core/types';
import { FACTION_INFO } from '../core/types';
import { STAGES } from '../core/progression';
import { ASSET_MANIFEST } from '../core/assets';
import type { AssetLoadReport, LoadedSprite, SoundName } from '../engine';
import { PALETTE, createAssetLoader, createGameStorage, SoundManager } from '../engine';
import type { CanvasSurface, OrientationLockResult } from '../platform/Display';
import { createCanvasSurface, isLandscape, requestFullscreen, tryLockLandscape } from '../platform/Display';

interface StatusRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'ok' | 'warn';
}

const SOUND_TESTS: readonly SoundName[] = ['shot', 'hit', 'explosion', 'uiClick', 'reload', 'uiBack'];

export async function startApp(root: HTMLElement): Promise<void> {
  const storage = createGameStorage({
    onError: (error, context) => console.warn(`[storage] ${context}`, error),
  });
  const sound = new SoundManager({
    muted: storage.muted,
    volume: 0.7,
    onMutedChange: (muted) => storage.setMuted(muted),
  });
  const loader = createAssetLoader({
    onProgress: (completed, total) => {
      setText(progressEl, `assets ${completed}/${total}`);
    },
  });

  // ---------------------------------------------------------------- markup
  root.innerHTML = SHELL_HTML;

  const stageEl = mustFind<HTMLElement>(root, '#stage');
  const statusEl = mustFind<HTMLElement>(root, '#status-rows');
  const progressEl = mustFind<HTMLElement>(root, '#progress');
  const factionEl = mustFind<HTMLElement>(root, '#faction');
  const muteEl = mustFind<HTMLButtonElement>(root, '#mute');
  const soundEl = mustFind<HTMLElement>(root, '#sound-buttons');
  const immersiveEl = mustFind<HTMLButtonElement>(root, '#immersive');
  const resetEl = mustFind<HTMLButtonElement>(root, '#reset');
  const hintEl = mustFind<HTMLElement>(root, '#hint');

  let report: AssetLoadReport | null = null;
  let orientationLock: OrientationLockResult | 'idle' = 'idle';

  const surface = createCanvasSurface(stageEl);
  surface.onDraw = (s) => drawVerification(s, loader.all());

  // ---------------------------------------------------------------- status
  function rows(): readonly StatusRow[] {
    const save = storage.snapshot();
    const unlocked = save.unlockedStages.length;
    const upgrades = Object.entries(save.upgrades)
      .filter(([, level]) => level > 0)
      .map(([id, level]) => `${id} ${level}`)
      .join(', ');
    const fallbacks = report ? report.procedural : 0;
    const soundLabel = `${sound.state}${sound.muted ? ' · muted' : ''}`;
    const sw = describeServiceWorker();
    return [
      {
        label: 'save',
        value: `${storage.backendId}${storage.persistent ? '' : ' (session only)'}`,
        tone: storage.persistent ? 'ok' : 'warn',
      },
      {
        label: 'campaign',
        value: `faction ${save.faction ?? '—'} · stages ${unlocked}/${STAGES.length} · bonds ${save.warBonds}${
          upgrades ? ` · ${upgrades}` : ''
        }`,
      },
      {
        label: 'audio',
        value: SoundManager.isSupported() ? soundLabel : 'unsupported on this device',
        tone: SoundManager.isSupported() ? 'ok' : 'warn',
      },
      {
        label: 'assets',
        value: report
          ? `${report.loaded}/${report.total} loaded in ${report.durationMs}ms${
              fallbacks ? ` · ${fallbacks} procedural fallback` : ''
            }`
          : 'loading…',
        tone: report && fallbacks > 0 ? 'warn' : 'ok',
      },
      {
        label: 'display',
        value: `${surface.width}×${surface.height} css @${surface.pixelRatio}x · ${
          isLandscape() ? 'landscape' : 'portrait'
        } · orientation lock ${orientationLock}`,
      },
      { label: 'service worker', value: sw },
    ];
  }

  function renderStatus(): void {
    statusEl.innerHTML = rows()
      .map(
        (row) =>
          `<div class="row"><span class="key">${escapeHtml(row.label)}</span><span class="val${
            row.tone ? ` ${row.tone}` : ''
          }">${escapeHtml(row.value)}</span></div>`,
      )
      .join('');
    if (report && report.failures.length > 0) {
      statusEl.insertAdjacentHTML(
        'beforeend',
        `<div class="failures"><strong>procedural fallbacks</strong>${report.failures
          .map(
            (failure) =>
              `<div>· ${escapeHtml(failure.label)} — ${escapeHtml(failure.reason)}</div>`,
          )
          .join('')}</div>`,
      );
    }
    muteEl.textContent = sound.muted ? '🔇 audio off' : '🔊 audio on';
    muteEl.setAttribute('aria-pressed', String(sound.muted));
    muteEl.disabled = !SoundManager.isSupported();
  }

  function renderFaction(): void {
    const active = storage.faction;
    factionEl.innerHTML = FACTION_INFO.map(
      (info) =>
        `<button type="button" class="chip${active === info.id ? ' active' : ''}" data-faction="${
          info.id
        }" title="${escapeHtml(info.blurb)}">${escapeHtml(info.name)}</button>`,
    ).join('');
  }

  // ---------------------------------------------------------------- events
  factionEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-faction]');
    const value = target?.dataset.faction;
    if (value !== 'allied' && value !== 'axis') return;
    void unlockAudio();
    sound.play('uiClick');
    storage.setFaction(value as Faction);
    renderFaction();
    renderStatus();
    surface.requestRedraw();
  });

  muteEl.addEventListener('click', () => {
    void unlockAudio().then(() => {
      sound.toggleMute();
      if (!sound.muted) sound.play('uiClick');
      renderStatus();
    });
  });

  soundEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-sound]');
    const name = target?.dataset.sound as SoundName | undefined;
    if (!name) return;
    void unlockAudio().then(() => {
      sound.play(name);
      renderStatus();
      hintEl.textContent = `played "${name}" (${sound.state})`;
    });
  });

  immersiveEl.addEventListener('click', async () => {
    await requestFullscreen(document.documentElement);
    orientationLock = await tryLockLandscape();
    await unlockAudio();
    sound.play('uiClick');
    hintEl.textContent =
      orientationLock === 'locked'
        ? 'landscape locked'
        : `landscape lock ${orientationLock} — installed PWA/native builds lock instead`;
    renderStatus();
  });

  resetEl.addEventListener('click', () => {
    storage.reset();
    renderFaction();
    renderStatus();
    surface.requestRedraw();
    hintEl.textContent = 'save wiped';
  });

  storage.subscribe(() => renderStatus());

  // A single window-level listener is enough to satisfy the browser's
  // "audio starts from a user gesture" rule.
  window.addEventListener(
    'pointerdown',
    () => {
      void unlockAudio();
    },
    { once: true },
  );

  // ---------------------------------------------------------------- boot
  renderFaction();
  renderStatus();

  report = await loader.load();
  progressEl.textContent = `${report.loaded}/${report.total} assets`;
  renderStatus();
  surface.requestRedraw();

  (globalThis as unknown as { frontline?: unknown }).frontline = { storage, sound, loader, surface };

  async function unlockAudio(): Promise<void> {
    if (sound.state === 'locked') await sound.unlock();
  }
}

/** One static frame — asset proof, not a game. */
function drawVerification(surface: CanvasSurface, sprites: readonly LoadedSprite[]): void {
  const { ctx, width, height } = surface;
  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, width, height);

  const map = sprites.find((sprite) => sprite.key === 'map.europe');
  const mapLayer = map ? map.layers[0] : undefined;
  if (map && mapLayer) {
    const box = fitContain(map.width, map.height, width, height * 0.72);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(mapLayer.image, box.x, box.y, box.w, box.h);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(13,18,16,0.62)';
  ctx.fillRect(0, 0, width, height);

  const pad = Math.round(width * 0.03);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e6ecdd';
  ctx.font = `700 ${Math.round(Math.min(width, height) / 12)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText('FRONTLINE RUNNER', pad, pad);

  ctx.fillStyle = PALETTE.warn;
  ctx.font = `${Math.round(Math.min(width, height) / 26)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText('STEP 1 · SYSTEMS CHECK — NO GAMEPLAY LOOP YET', pad, pad * 2.6);

  // Sprite proof row: every manifest sprite drawn from whatever we loaded.
  const cell = Math.min((width - pad * 2) / Math.max(1, sprites.length), height * 0.3);
  const rowY = height * 0.5;
  ctx.font = `${Math.round(cell * 0.15)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  sprites.forEach((sprite, index) => {
    const layer = sprite.layers[0];
    if (!layer) return;
    const box = fitContain(sprite.width, sprite.height, cell * 0.82, cell * 0.82);
    const x = pad + index * cell + (cell - box.w) / 2;
    const y = rowY + (cell - box.h) / 2;
    ctx.drawImage(layer.image, x, y, box.w, box.h);
    if (sprite.status === 'procedural') {
      ctx.strokeStyle = PALETTE.warn;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, box.w + 4, box.h + 4);
    }
    ctx.fillStyle = sprite.status === 'procedural' ? PALETTE.warn : 'rgba(200,215,200,0.6)';
    ctx.fillText(sprite.key.replace('unit.', ''), x + box.w / 2, y + box.h + 6);
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(200,215,200,0.5)';
  ctx.fillText(
    'orange outline = procedural Canvas 2D fallback (asset unavailable)',
    pad,
    rowY + cell + 28,
  );
  ctx.restore();
}

function fitContain(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
): { x: number; y: number; w: number; h: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, w: boxWidth, h: boxHeight };
  }
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  return { x: (boxWidth - w) / 2, y: (boxHeight - h) / 2, w, h };
}

function describeServiceWorker(): string {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  if (import.meta.env.DEV) return 'disabled in dev (build only)';
  const controller = navigator.serviceWorker.controller;
  return controller ? `active · ${controller.scriptURL.split('/').slice(-1)[0] ?? 'sw.js'}` : 'registered, awaiting reload';
}

function mustFind<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Boot markup is missing ${selector}`);
  return element;
}

function setText(element: HTMLElement, text: string): void {
  element.textContent = text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SHELL_HTML = `
  <div class="app">
    <header class="bar">
      <div>
        <h1>Frontline Runner</h1>
        <p class="sub">Step 1 · PWA scaffold, asset pipeline and engine foundations</p>
      </div>
      <div class="bar-actions">
        <span id="progress" class="mono">assets 0/${ASSET_MANIFEST.length}</span>
        <button id="mute" type="button" class="chip" aria-pressed="false">🔊 audio on</button>
        <button id="immersive" type="button" class="chip">⛶ landscape</button>
        <button id="reset" type="button" class="chip danger">reset save</button>
      </div>
    </header>

    <main class="layout">
      <div id="stage" class="stage-wrap" aria-label="Rendering surface"></div>

      <aside class="panel">
        <section>
          <h2>Systems</h2>
          <div id="status-rows" class="rows"></div>
        </section>

        <section>
          <h2>Faction</h2>
          <div id="faction" class="chips"></div>
          <p class="fine">Persisted to the save file; reload to confirm the round-trip.</p>
        </section>

        <section>
          <h2>Procedural audio</h2>
          <div id="sound-buttons" class="chips">
            ${SOUND_TESTS.map(
              (name) => `<button type="button" class="chip" data-sound="${name}">${name}</button>`,
            ).join('')}
          </div>
          <p class="fine">Web Audio synth — no audio files. Tap once to unlock audio on iOS.</p>
        </section>

        <p id="hint" class="fine mono"></p>
      </aside>
    </main>
  </div>
`;
