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

import type { Faction, SaveData } from '../core/types';
import { FACTION_INFO, isUpgradeId } from '../core/types';
import {
  STAGES_PER_CAMPAIGN,
  UPGRADES,
  campaignProgress,
  upgradeCost,
} from '../core/progression';
import { ASSET_MANIFEST } from '../core/assets';
import { CAMPAIGNS, CAMPAIGN_NODES, THEATERS, WEAPONS, weaponsForFaction } from '../data/campaignData';
import { PlaySession } from './Play';
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
  const missionEl = mustFind<HTMLElement>(root, '#mission');
  const armouryEl = mustFind<HTMLElement>(root, '#armoury');
  const upgradesEl = mustFind<HTMLElement>(root, '#upgrades');
  const deployEl = mustFind<HTMLButtonElement>(root, '#deploy');

  let report: AssetLoadReport | null = null;
  let orientationLock: OrientationLockResult | 'idle' = 'idle';
  let session: PlaySession | null = null;
  /** Console handle for diagnostics: `frontline.session.state` etc. */
  const debugApi: Record<string, unknown> = {};

  const surface = createCanvasSurface(stageEl);
  const drawBase = (s: CanvasSurface): void => {
    // The play scene leaves a letterboxed transform behind; restore the
    // surface's device-pixel-ratio transform before drawing the base screen.
    s.ctx.setTransform(s.pixelRatio, 0, 0, s.pixelRatio, 0, 0);
    drawVerification(s, loader.all(), storage.snapshot());
  };
  surface.onDraw = drawBase;

  // ------------------------------------------------------------ run control

  function startRun(): void {
    const save = storage.snapshot();
    if (!save.faction || session) return;
    const stage = campaignProgress(save.faction, save.unlockedStages).next;
    if (!stage) {
      hintEl.textContent = 'campaign complete — no further sector';
      return;
    }

    void unlockAudio();
    surface.onDraw = null;
    document.body.classList.add('playing');
    session = new PlaySession({
      surface,
      loader,
      storage,
      sound,
      faction: save.faction,
      // StageDefinition extends CampaignNode, so it carries the briefing,
      // boss and coordinates the level generator needs.
      node: stage,
      stage,
      onExit: () => endRun(),
    });
    session.start();
    debugApi.session = session;
    hintEl.textContent = 'drag or WASD to steer · R redeploy · ESC back to base';
  }

  function endRun(): void {
    session?.dispose();
    session = null;
    debugApi.session = null;
    document.body.classList.remove('playing');
    surface.onDraw = drawBase;
    renderFaction();
    renderMission();
    renderArmoury();
    renderUpgrades();
    renderStatus();
    surface.requestRedraw();
    hintEl.textContent = 'back at base';
  }

  // ---------------------------------------------------------------- status
  function rows(): readonly StatusRow[] {
    const save = storage.snapshot();
    const progress = save.faction ? campaignProgress(save.faction, save.unlockedStages) : null;
    const upgrades = Object.entries(save.upgrades)
      .filter(([, level]) => level > 0)
      .map(([id, level]) => `${id} ${level}`)
      .join(', ');
    const fallbacks = report ? report.procedural : 0;
    const soundLabel = `${sound.state}${sound.muted ? ' · muted' : ''}`;
    const sw = describeServiceWorker();
    const nextLabel = progress
      ? progress.next
        ? `${progress.next.name} (${progress.next.year})`
        : 'campaign complete'
      : '—';
    return [
      {
        label: 'save',
        value: `${storage.backendId}${storage.persistent ? '' : ' (session only)'}`,
        tone: storage.persistent ? 'ok' : 'warn',
      },
      {
        label: 'campaign',
        value: `faction ${save.faction ?? '—'} · ${progress ? `${progress.unlocked}/${progress.total}` : `0/${STAGES_PER_CAMPAIGN}`} nodes · next ${nextLabel} · bonds ${save.warBonds}${
          upgrades ? ` · ${upgrades}` : ''
        }`,
      },
      {
        label: 'database',
        value: `${WEAPONS.length} weapons · ${CAMPAIGN_NODES.length} campaign nodes · ${THEATERS.length} theatres`,
        tone: 'ok',
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

  /** The next playable node for the chosen faction, straight from the database. */
  function renderMission(): void {
    const save = storage.snapshot();
    const progress = save.faction ? campaignProgress(save.faction, save.unlockedStages) : null;
    const node = progress?.next;
    if (!node) {
      missionEl.innerHTML =
        '<p class="fine">Choose a faction to load its campaign from the database.</p>';
      return;
    }
    missionEl.innerHTML = `
      <div class="mission-title">${escapeHtml(node.name)} <span class="mono">${escapeHtml(
        node.year,
      )}</span></div>
      <div class="row"><span class="key">theatre</span><span class="val">${escapeHtml(
        node.theater,
      )} · x ${node.coords.x}% y ${node.coords.y}%</span></div>
      <div class="row"><span class="key">boss</span><span class="val">${escapeHtml(
        node.bossName,
      )} · ${node.bossHp} hp</span></div>
      <div class="row"><span class="key">node</span><span class="val mono">${escapeHtml(
        node.id,
      )} · tier ${node.tier} · ${node.rewardBonds} bonds</span></div>
      <p class="briefing">${escapeHtml(node.briefing)}</p>`;
  }

  /** The faction's weapon table, with unlock state derived from progress. */
  function renderArmoury(): void {
    const save = storage.snapshot();
    if (!save.faction) {
      armouryEl.innerHTML = '<p class="fine">Weapon stats come from campaignData.ts.</p>';
      return;
    }
    const reached = campaignProgress(save.faction, save.unlockedStages).unlocked;
    armouryEl.innerHTML = weaponsForFaction(save.faction)
      .map((weapon) => {
        const unlocked = weapon.minLevel <= reached;
        const stats = `${weapon.damage} dmg · ${weapon.fireRate}/s · ±${weapon.spread}° · ${weapon.magazineSize} ${
          weapon.magazineSize === 1 ? 'round' : 'rounds'
        }`;
        return `<div class="row"><span class="key${unlocked ? '' : ' locked'}">${escapeHtml(
          weapon.name,
        )}</span><span class="val${unlocked ? ' ok' : ''}">${
          unlocked ? stats : `node ${weapon.minLevel} · ${stats}`
        }</span></div>`;
      })
      .join('');
  }

  // ---------------------------------------------------------------- events
  deployEl.addEventListener('click', () => {
    void unlockAudio();
    startRun();
  });

  upgradesEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-upgrade]');
    const id = target?.dataset.upgrade;
    if (!id || !isUpgradeId(id)) return;
    void unlockAudio();
    const result = storage.purchaseUpgrade(id);
    if (result.ok) {
      sound.play('uiClick');
      hintEl.textContent = `${id} → level ${result.level} (−${result.cost} bonds)`;
    } else {
      sound.play('uiBack');
      hintEl.textContent = `upgrade blocked: ${result.reason}`;
    }
  });

  factionEl.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-faction]');
    const value = target?.dataset.faction;
    if (value !== 'allied' && value !== 'axis') return;
    void unlockAudio();
    sound.play('uiClick');
    storage.setFaction(value as Faction);
    renderFaction();
    renderStatus();
    renderMission();
    renderArmoury();
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
    renderMission();
    renderArmoury();
    surface.requestRedraw();
    hintEl.textContent = 'save wiped';
  });

  storage.subscribe(() => {
    renderStatus();
    renderMission();
    renderArmoury();
    renderUpgrades();
    renderDeploy();
  });

  /** Upgrade tracks, bought with war bonds earned in runs. */
  function renderUpgrades(): void {
    const save = storage.snapshot();
    upgradesEl.innerHTML = UPGRADES.map((upgrade) => {
      const level = save.upgrades[upgrade.id];
      const cost = upgradeCost(upgrade.id, level);
      const affordable = cost !== null && save.warBonds >= cost;
      const value =
        cost === null
          ? '<span class="val">maxed</span>'
          : `<span class="val${affordable ? ' ok' : ''}">${cost} bonds${
              affordable
                ? ` <button type="button" class="chip mini" data-upgrade="${upgrade.id}">buy</button>`
                : ''
            }</span>`;
      return `<div class="row"><span class="key">${escapeHtml(
        upgrade.name,
      )} <span class="mono">L${level}/${upgrade.maxLevel}</span></span>${value}</div>`;
    }).join('');
  }

  /** The deploy button reflects whether there is a sector left to fight. */
  function renderDeploy(): void {
    const save = storage.snapshot();
    const progress = save.faction ? campaignProgress(save.faction, save.unlockedStages) : null;
    const next = progress?.next;
    deployEl.disabled = !next;
    deployEl.textContent = next
      ? `▶ deploy · ${next.name}`
      : save.faction
        ? 'campaign complete'
        : 'choose a faction first';
  }

  // A single window-level listener is enough to satisfy the browser's
  // "audio starts from a user gesture" rule.
  window.addEventListener(
    'pointerdown',
    () => {
      void unlockAudio();
    },
    { once: true },
  );

  // Enter deploys from the base screen (only when no run is active — the play
  // session installs its own key handling while it owns the canvas).
  window.addEventListener('keydown', (event) => {
    if (session) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      startRun();
    }
  });

  // ---------------------------------------------------------------- boot
  renderFaction();
  renderStatus();
  renderMission();
  renderArmoury();
  renderUpgrades();
  renderDeploy();

  report = await loader.load();
  progressEl.textContent = `${report.loaded}/${report.total} assets`;
  renderStatus();
  surface.requestRedraw();

  (globalThis as unknown as { frontline?: unknown }).frontline = Object.assign(debugApi, {
    storage,
    sound,
    loader,
    surface,
  });

  async function unlockAudio(): Promise<void> {
    if (sound.state === 'locked') await sound.unlock();
  }
}

/** One static frame — campaign data + asset proof, not a game. */
function drawVerification(
  surface: CanvasSurface,
  sprites: readonly LoadedSprite[],
  save: SaveData,
): void {
  const { ctx, width, height } = surface;
  ctx.save();
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(0, 0, width, height);

  const pad = Math.round(width * 0.022);
  const spriteBand = Math.round(height * 0.17);
  const mapAreaW = Math.round(width * 0.54);
  const mapAreaH = height - spriteBand - pad * 2;

  const map = sprites.find((sprite) => sprite.key === 'map.europe');
  const mapLayer = map ? map.layers[0] : undefined;
  if (map && mapLayer && mapAreaH > 80) {
    const box = fitContain(map.width, map.height, mapAreaW, mapAreaH);
    const bx = pad + box.x;
    const by = pad + box.y;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(mapLayer.image, bx, by, box.w, box.h);
    ctx.globalAlpha = 1;
    // Darken the artwork so the plotted nodes read against pale land and sea.
    ctx.fillStyle = 'rgba(8,11,9,0.55)';
    ctx.fillRect(bx, by, box.w, box.h);
    ctx.strokeStyle = 'rgba(140,160,145,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, box.w - 1, box.h - 1);
    drawCampaignNodes(ctx, save, bx, by, box.w, box.h);
  }

  // ---- data column, right of the map
  const tx = pad * 2 + mapAreaW;
  const titleSize = Math.round(Math.min(width, height) / 17);
  const bodySize = Math.round(titleSize * 0.44);
  let ty = pad;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.fillStyle = '#e6ecdd';
  ctx.font = `700 ${titleSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText('FRONTLINE', tx, ty);
  ty += titleSize * 1.05;
  ctx.fillText('RUNNER', tx, ty);
  ty += titleSize * 1.3;

  ctx.fillStyle = PALETTE.warn;
  ctx.font = `700 ${bodySize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText('STEP 3 · RUNNER ENGINE', tx, ty);
  ty += bodySize * 1.7;

  const lines = [
    `${CAMPAIGN_NODES.length} campaign nodes (30 / faction)`,
    `${WEAPONS.length} weapons with stats and minLevel`,
    `${THEATERS.length} theatres · boss HP 1400-5750`,
    `coords plotted from campaignData.ts`,
    `ring = next mission · dim = locked`,
    `orange outline = procedural asset fallback`,
    `press DEPLOY to play the next sector`,
  ];
  ctx.font = `${bodySize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  for (const [index, line] of lines.entries()) {
    ctx.fillStyle = index === lines.length - 1 ? PALETTE.warn : 'rgba(200,215,200,0.68)';
    ctx.fillText(line, tx, ty);
    ty += bodySize * 1.55;
  }

  // ---- sprite proof row: every manifest sprite from whatever we loaded
  const cell = Math.min((width - pad * 2) / Math.max(1, sprites.length), spriteBand * 0.84);
  const rowY = height - spriteBand;
  ctx.font = `${Math.round(cell * 0.17)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
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
    ctx.fillText(shortLabel(sprite.key), x + box.w / 2, y + box.h + 4);
  });

  ctx.restore();
}

/** `unit.allied.t1` → `allied t1`, `map.europe` → `map`. */
function shortLabel(key: string): string {
  if (key.startsWith('unit.')) return key.slice(5).replace('.', ' ');
  return key.split('.')[0] ?? key;
}

/**
 * Plot a faction's campaign nodes on the theatre map using their stored
 * percentage coords, marking what the save has unlocked and ringing the next
 * mission. This is the coordinate data checked against the real map artwork.
 */
function drawCampaignNodes(
  ctx: CanvasRenderingContext2D,
  save: SaveData,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): void {
  const faction: Faction = save.faction ?? 'allied';
  const nodes = CAMPAIGNS[faction];
  const nextNode = nodes.find((node) => save.unlockedStages.includes(node.id));
  const radius = Math.max(2.5, bw * 0.0042);
  const unlockedFill = faction === 'allied' ? '#c9e06a' : '#8fc4ff';

  ctx.save();
  for (const [index, node] of nodes.entries()) {
    const x = bx + (node.coords.x / 100) * bw;
    const y = by + (node.coords.y / 100) * bh;
    const unlocked = save.unlockedStages.includes(node.id);

    // Route line to the following node, so the campaign reads as a path.
    const following = nodes[index + 1];
    if (following) {
      ctx.strokeStyle = 'rgba(210,225,190,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(bx + (following.coords.x / 100) * bw, by + (following.coords.y / 100) * bh);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, unlocked ? radius : radius * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = unlocked ? unlockedFill : 'rgba(225,235,220,0.42)';
    ctx.fill();

    if (node.id === nextNode?.id) {
      ctx.strokeStyle = PALETTE.warn;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, radius * 2.8, 0, Math.PI * 2);
      ctx.stroke();

      const label = `${node.name} · ${node.year} · ${node.bossName}`;
      const fontSize = Math.max(9, Math.round(bw * 0.017));
      ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const rightSide = x < bx + bw * 0.6;
      const offset = radius * 3.6;
      const textX = rightSide ? x + offset : x - offset;
      const textY = y - radius * 3.2;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(8,11,9,0.82)';
      ctx.fillRect(
        (rightSide ? textX : textX - textW) - 4,
        textY - 3,
        textW + 8,
        fontSize + 8,
      );
      ctx.fillStyle = PALETTE.warn;
      ctx.fillText(label, rightSide ? textX : textX - textW, textY);
    }
  }

  const legend = `${faction} campaign · ${nodes.length} nodes plotted`;
  const legendSize = Math.max(9, Math.round(bw * 0.016));
  ctx.font = `${legendSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const legendW = ctx.measureText(legend).width;
  ctx.fillStyle = 'rgba(8,11,9,0.8)';
  ctx.fillRect(bx + 6, by + bh - legendSize - 14, legendW + 12, legendSize + 10);
  ctx.fillStyle = 'rgba(220,232,215,0.75)';
  ctx.fillText(legend, bx + 12, by + bh - 8);
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
        <p class="sub">Step 3 · side-scrolling runner engine — deploy to fight the next sector</p>
      </div>
      <div class="bar-actions">
        <span id="progress" class="mono">assets 0/${ASSET_MANIFEST.length}</span>
        <button id="deploy" type="button" class="chip primary">▶ deploy</button>
        <button id="mute" type="button" class="chip" aria-pressed="false">🔊 audio on</button>
        <button id="immersive" type="button" class="chip">⛶ landscape</button>
        <button id="reset" type="button" class="chip danger">reset save</button>
      </div>
    </header>

    <main class="layout">
      <div id="stage" class="stage-wrap" aria-label="Rendering surface"></div>

      <aside class="panel">
        <section>
          <h2>Faction</h2>
          <div id="faction" class="chips"></div>
          <p class="fine">Persisted to the save file; reload to confirm the round-trip.</p>
        </section>

        <section>
          <h2>Next mission</h2>
          <div id="mission"></div>
        </section>

        <section>
          <h2>Armoury</h2>
          <div id="armoury" class="rows"></div>
          <p class="fine">Unlock node comes from each weapon's <span class="mono">minLevel</span>.</p>
        </section>

        <section>
          <h2>Upgrades</h2>
          <div id="upgrades" class="rows"></div>
          <p class="fine">War bonds are earned by clearing sectors.</p>
        </section>

        <section>
          <h2>Systems</h2>
          <div id="status-rows" class="rows"></div>
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
