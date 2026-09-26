/**
 * End-of-battle splash — the full-screen "you won/lost the sector" moment.
 *
 * The v2 replacement for the small result modal in `screens.ts`. The battle
 * view hands the shell a `BattleOutcome` the instant the sector resolves, and
 * the shell drops this overlay on top of it, so the player never has to hunt
 * for an "abort" button to find out what just happened.
 *
 * Approach:
 *  - `splashHtml` is a pure function of the outcome plus the shell's context
 *    (`SplashView`), written in the house style of `screens.ts`: template
 *    literals, `escapeHtml` on every interpolated string, kebab-case classes,
 *    `<dl>` for key/value rows and `.modal-actions`-style buttons that carry
 *    `data-action` for the shell's one delegated click listener.
 *  - Nothing on screen is invented here: every figure comes from the outcome,
 *    every label from `environmentRules` / `missionLabel` / `baseKindLabel`.
 *    The verdict headline is *derived* (status + whether a side still holds
 *    anything) rather than trusted blindly from `lossReason`, so a victory can
 *    never claim a sector was taken when the clock did the deciding.
 *  - All motion lives in `SPLASH_CSS` under
 *    `@media (prefers-reduced-motion: no-preference)`, and the animated
 *    properties always start from a state the static layout already resolves
 *    to the true value (e.g. an hp bar's base rule already carries the real
 *    width; only the keyframes grow it from zero). Reduced-motion users get
 *    the finished layout immediately, and no decoration is load-bearing.
 *  - Decoration is hand-written inline SVG (bunting, medal, razed marker): the
 *    app is offline-first, so no images, fonts, scripts or timers.
 */

import type { BaseReport, BattleOutcome } from '../core/outcome';
import { getStage } from '../core/progression';
import { FACTION_INFO, type Faction } from '../core/types';
import type { Environment } from '../data/campaignData';
import { environmentRules } from '../game/environment';
import { missionDetail, missionLabel } from '../game/stageInfo';
import { baseKindLabel } from '../game/units';
import { escapeHtml, formatNumber } from './dom';

/**
 * Everything the splash needs that the battle itself does not know: the sector
 * unlocked behind it, the banked bond total, who it was fought against and in
 * what weather. `durationLabel` is preformatted by the shell so the splash
 * never has to own a clock.
 */
export interface SplashView {
  readonly outcome: BattleOutcome;
  readonly nextStage: {
    readonly id: string;
    readonly name: string;
    readonly year: string;
    readonly bossName: string;
  } | null;
  readonly warBonds: number;
  readonly enemyFaction: Faction;
  readonly environment: Environment;
  /** Total wall-clock seconds the sector took, preformatted as e.g. '1m 42s'. */
  readonly durationLabel: string;
}

/** Which side of the breakdown a position belongs to. */
type Side = 'player' | 'enemy';

interface Fate {
  readonly word: string;
  /** Class suffix: `splash-fate--<tone>`. */
  readonly tone: string;
}

interface SplashStat {
  readonly label: string;
  readonly value: string;
  readonly tone: 'plain' | 'good' | 'bad' | 'bonds';
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function factionName(faction: Faction): string {
  return FACTION_INFO.find((info) => info.id === faction)?.name ?? faction;
}

/**
 * What happened to a position, from the *player's* point of view: an enemy
 * position that went down was razed, a friendly one was overrun, and anything
 * still standing held. The word itself carries the meaning, so the chip never
 * depends on its colour.
 */
function fateFor(base: BaseReport, side: Side): Fate {
  if (!base.destroyed) return { word: 'Held', tone: 'held' };
  return side === 'enemy' ? { word: 'Razed', tone: 'razed' } : { word: 'Overrun', tone: 'overrun' };
}

/** Fraction of a position's hit points still standing, clamped for display. */
function fractionOf(base: BaseReport): number {
  if (base.maxHp <= 0) return 0;
  return Math.max(0, Math.min(1, base.hp / base.maxHp));
}

/**
 * Bunting across the top of the hero band. Twelve pennants in the campaign
 * palette, drawn as polys so there is no asset to precache.
 */
function buntingSvg(): string {
  const width = 1000;
  const pennants = 16;
  const step = width / pennants;
  const palette = ['var(--gold)', 'var(--accent)', 'var(--red)', 'var(--blue)'];
  const shapes = Array.from({ length: pennants }, (_, index) => {
    const x = index * step;
    const fill = palette[index % palette.length] ?? 'var(--gold)';
    return `<polygon points="${x.toFixed(1)},5 ${(x + step).toFixed(1)},5 ${(x + step / 2).toFixed(1)},27" fill="${fill}" opacity="0.72" />`;
  }).join('');

  return `
    <svg class="splash-bunting" viewBox="0 0 ${width} 30" preserveAspectRatio="none"
         aria-hidden="true" focusable="false">
      <line x1="0" y1="5" x2="${width}" y2="5" stroke="rgba(230, 236, 221, 0.35)" stroke-width="2" />
      ${shapes}
    </svg>`;
}

/**
 * The hero emblem: a medal for a win, a broken position marker for a loss.
 * Colour follows `currentColor`, so the theme class alone themes it — and the
 * headline words beside it mean the verdict reads without colour at all.
 */
function emblemSvg(won: boolean): string {
  if (won) {
    // Five-point star inside a ring: coordinates are pre-computed around the
    // (48, 48) centre, outer radius 22, inner radius 9.5.
    return `
      <svg class="splash-emblem" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
        <circle cx="48" cy="48" r="31" fill="none" stroke="currentColor" stroke-width="3" opacity="0.5" />
        <path d="M48 26 L53.6 40.3 L68.9 41.2 L57 50.9 L60.9 65.8 L48 57.5 L35.1 65.8 L39 50.9 L27.1 41.2 L42.4 40.3 Z"
              fill="currentColor" />
      </svg>`;
  }
  // A marker with the roof split open — the position is gone.
  return `
    <svg class="splash-emblem" viewBox="0 0 96 96" aria-hidden="true" focusable="false">
      <path d="M16 78 H80" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" />
      <path d="M28 78 V46 L48 28 L68 46 V78" fill="none" stroke="currentColor" stroke-width="5"
            stroke-linejoin="round" />
      <path d="M48 28 L41 46 L54 52 L45 68 L58 78" fill="none" stroke="currentColor" stroke-width="3.5"
            stroke-linejoin="round" opacity="0.85" />
    </svg>`;
}

/**
 * One row of the breakdown: letter, name, kind, an hp bar and the fate.
 * The bar's base width is the real value, so the row is complete before any
 * animation runs; the keyframes only grow it from zero.
 */
function positionRow(base: BaseReport, side: Side, stagger: number): string {
  const fraction = fractionOf(base);
  const percent = Math.round(fraction * 100);
  const fate = fateFor(base, side);

  return `
    <li class="splash-pos splash-pos--${side}${base.destroyed ? ' is-destroyed' : ''}" style="--i:${stagger}">
      <span class="splash-pos-letter">${escapeHtml(base.letter)}</span>
      <span class="splash-pos-main">
        <span class="splash-pos-name">${escapeHtml(base.name)}</span>
        <span class="splash-pos-kind">${escapeHtml(baseKindLabel(base.kind))}</span>
      </span>
      <span class="splash-pos-hp">
        <span class="splash-bar" style="--hp:${percent}%" aria-hidden="true"><i></i></span>
        <span class="splash-hp-pct">${percent}%</span>
        <span class="splash-hp-raw">${formatNumber(Math.round(base.hp))}/${formatNumber(base.maxHp)}</span>
      </span>
      <span class="splash-fate splash-fate--${fate.tone}">${escapeHtml(fate.word)}</span>
    </li>`;
}

function positionList(
  report: readonly BaseReport[],
  side: Side,
  startIndex: number,
): string {
  return report.map((base, index) => positionRow(base, side, startIndex + index)).join('');
}

function statRows(stats: readonly SplashStat[], startIndex: number): string {
  return stats
    .map(
      (stat, index) => `
        <div class="splash-stat splash-stat--${stat.tone}" style="--i:${startIndex + index}">
          <dt>${escapeHtml(stat.label)}</dt>
          <dd>${escapeHtml(stat.value)}</dd>
        </div>`,
    )
    .join('');
}

// ------------------------------------------------------------------- markup

/**
 * The full splash: verdict hero, per-position breakdown, headline numbers,
 * conditions and the three ways out (next/retry sector, camp, map).
 *
 * `outcome` is the battle's own report and the authority for every figure on
 * screen; `view` adds the shell's context. `view.outcome` is expected to be
 * the same object — the explicit parameter exists so a caller never has to
 * build a whole view just to render the numbers.
 */
export function splashHtml(outcome: BattleOutcome, view: SplashView): string {
  const won = outcome.status === 'victory';

  // Derived from the position counts rather than `lossReason`, so the wording
  // and the breakdown can never contradict each other.
  const allEnemyRazed = outcome.enemyBases > 0 && outcome.enemyBasesDestroyed >= outcome.enemyBases;
  const allFriendliesLost = outcome.playerBases > 0 && outcome.playerBasesLost >= outcome.playerBases;

  const verdict = won
    ? allEnemyRazed
      ? 'Sector secured'
      : 'Ground held'
    : allFriendliesLost
      ? 'Position lost'
      : 'Push repulsed';

  const heroNote = won
    ? allEnemyRazed
      ? `All ${plural(outcome.enemyBases, 'enemy position')} razed.`
      : `${outcome.enemyBasesDestroyed} of ${outcome.enemyBases} enemy positions razed before the clock ran out — the ground is yours.`
    : allFriendliesLost
      ? `All ${plural(outcome.playerBases, 'friendly position')} lost and the line broken.`
      : `The clock beat the attack: ${outcome.playerBasesLost} of ${outcome.playerBases} positions lost, ${
          outcome.playerBases - outcome.playerBasesLost
        } still standing.`;

  const rules = environmentRules(view.environment);
  // The mission type is not part of the outcome, so it is looked up from the
  // node the battle was fought for; if the node is unknown the clause is
  // dropped rather than guessed at.
  const stage = getStage(outcome.nodeId);
  const mission = stage
    ? `${missionLabel(stage.missionType)} — ${missionDetail(stage.missionType)}`
    : null;

  const stats: SplashStat[] = [
    {
      label: 'positions destroyed',
      value: `${outcome.enemyBasesDestroyed}/${outcome.enemyBases}`,
      tone: outcome.enemyBasesDestroyed > 0 ? 'good' : 'plain',
    },
    {
      label: 'positions lost',
      value: `${outcome.playerBasesLost}/${outcome.playerBases}`,
      tone: outcome.playerBasesLost > 0 ? 'bad' : 'plain',
    },
    { label: 'units deployed', value: formatNumber(outcome.unitsDeployed), tone: 'plain' },
    {
      label: 'units lost',
      value: formatNumber(outcome.unitsLost),
      tone: outcome.unitsLost > 0 ? 'bad' : 'plain',
    },
    {
      label: 'enemy destroyed',
      value: formatNumber(outcome.enemyDestroyed),
      tone: outcome.enemyDestroyed > 0 ? 'good' : 'plain',
    },
    {
      label: 'war bonds awarded',
      value: won ? `+${formatNumber(outcome.bondsAwarded)}` : '0',
      tone: won ? 'bonds' : 'plain',
    },
    {
      label: 'bonds from the field',
      value: `+${formatNumber(outcome.bondsCollected)}`,
      tone: 'bonds',
    },
    { label: 'logistics upgrades', value: formatNumber(outcome.logisticsBought), tone: 'plain' },
  ];
  // Mine rows only earn their space in a battle that had mines at all.
  if (outcome.minesHit > 0) {
    stats.push({
      label: 'mines tripped by your units',
      value: formatNumber(outcome.minesHit),
      tone: 'bad',
    });
  }
  if (outcome.enemyMinesHit > 0) {
    stats.push({
      label: 'mines tripped by enemy units',
      value: formatNumber(outcome.enemyMinesHit),
      tone: 'good',
    });
  }
  stats.push({ label: 'battle time', value: view.durationLabel, tone: 'plain' });

  const enemyStanding = outcome.enemyBases - outcome.enemyBasesDestroyed;
  const playerStanding = outcome.playerBases - outcome.playerBasesLost;
  // One running counter across the whole page, so the reveal reads top to
  // bottom: conditions, then the friendly column, then the enemy column, then
  // the numbers.
  const enemyStart = 3 + outcome.playerReport.length;
  const statsStart = enemyStart + outcome.enemyReport.length;

  const nextStage = won ? view.nextStage : null;
  const primaryAction = nextStage
    ? `<button type="button" class="btn btn--primary" data-action="deploy-stage" data-stage="${escapeHtml(
        nextStage.id,
      )}"><span aria-hidden="true">▶</span> next sector</button>`
    : `<button type="button" class="btn btn--primary" data-action="deploy-stage" data-stage="${escapeHtml(
        outcome.nodeId,
      )}"><span aria-hidden="true">↻</span> retry sector</button>`;

  const unlockLine = view.nextStage
    ? `<p class="splash-unlock">Next objective: <b>${escapeHtml(view.nextStage.name)}</b> (${escapeHtml(
        view.nextStage.year,
      )}) — ${escapeHtml(view.nextStage.bossName)}</p>`
    : won
      ? '<p class="splash-unlock">That was the last sector in this campaign — the campaign is finished.</p>'
      : '';

  const defeatNote = won
    ? ''
    : `<p class="splash-note">The sector stays open — ${
        outcome.bondsCollected > 0
          ? `the ${formatNumber(
              outcome.bondsCollected,
            )} bonds you collected from the field are banked, so spend them at camp and`
          : 'regroup at camp and'
      } try again.</p>`;

  return `
    <section class="splash splash--${won ? 'win' : 'loss'}" role="dialog" aria-modal="true"
             aria-label="Sector result — ${escapeHtml(outcome.nodeName)}">
      <div class="splash-panel">
        <section class="splash-hero" aria-live="polite">
          ${buntingSvg()}
          ${emblemSvg(won)}
          <p class="splash-kicker">${escapeHtml(outcome.nodeName)} · ${escapeHtml(
            outcome.year,
          )} · ${escapeHtml(outcome.situation)}</p>
          <h2 class="splash-verdict">${escapeHtml(verdict)}</h2>
          <p class="splash-status">
            <span class="splash-status-mark" aria-hidden="true">${won ? '★' : '✖'}</span>
            ${escapeHtml(outcome.status)}
          </p>
          <p class="splash-hero-note">${escapeHtml(heroNote)}</p>
          <span class="splash-rule" aria-hidden="true"></span>
        </section>

        <dl class="splash-conditions">
          <div class="splash-condition" style="--i:0" title="${escapeHtml(rules.summary)}">
            <dt>conditions</dt>
            <dd>${escapeHtml(`${rules.label} — ${rules.hint}`)}</dd>
          </div>
          ${
            mission
              ? `<div class="splash-condition" style="--i:1">
                   <dt>mission</dt>
                   <dd>${escapeHtml(mission)}</dd>
                 </div>`
              : ''
          }
          <div class="splash-condition" style="--i:2">
            <dt>opposition</dt>
            <dd>${escapeHtml(factionName(view.enemyFaction))}</dd>
          </div>
        </dl>

        <section class="splash-block" aria-labelledby="splash-positions-head">
          <h3 class="splash-block-head" id="splash-positions-head">Position by position</h3>
          <div class="splash-breakdown">
            <div class="splash-line">
              <p class="splash-line-head">
                <span>your line</span>
                <span>${playerStanding} of ${outcome.playerBases} standing</span>
              </p>
              <ul class="splash-positions">${positionList(outcome.playerReport, 'player', 3)}</ul>
            </div>
            <div class="splash-line">
              <p class="splash-line-head">
                <span>${escapeHtml(factionName(view.enemyFaction))} line</span>
                <span>${outcome.enemyBasesDestroyed} of ${outcome.enemyBases} razed${
                  enemyStanding > 0 ? ` · ${enemyStanding} holding` : ''
                }</span>
              </p>
              <ul class="splash-positions">${positionList(
                outcome.enemyReport,
                'enemy',
                enemyStart,
              )}</ul>
            </div>
          </div>
        </section>

        <section class="splash-block" aria-labelledby="splash-numbers-head">
          <h3 class="splash-block-head" id="splash-numbers-head">The engagement</h3>
          <dl class="splash-stats">${statRows(stats, statsStart)}</dl>
        </section>

        ${unlockLine}
        ${defeatNote}

        <div class="splash-actions">
          ${primaryAction}
          <button type="button" class="btn" data-action="open-camp"><span aria-hidden="true">⚑</span> camp (${formatNumber(
            view.warBonds,
          )} bonds)</button>
          <button type="button" class="btn btn--ghost" data-action="close-modal">back to map</button>
        </div>
      </div>
    </section>`;
}

// -------------------------------------------------------------------- styles

/**
 * The splash stylesheet, injected once by the shell.
 *
 * Every selector is scoped under `.splash`, so it cannot leak into the map,
 * the camp or the battle HUD. z-index is 10500: above the fullscreen battle
 * view (`#play`, z-index 9999) and above its DOM HUD (`#hud-top` /
 * `#hud-bottom`, both 10000). Mount the splash as a **sibling of
 * `#modal-layer`, never inside it** — `#modal-layer` is z-index 30 and would
 * cap every descendant beneath the canvas regardless of this value.
 */
export const SPLASH_CSS = `
/* ================================================================= splash */

.splash {
  position: fixed;
  inset: 0;
  z-index: 10500;
  display: flex;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right))
    max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
  background:
    radial-gradient(130% 90% at 50% -8%, rgba(201, 224, 106, 0.16), rgba(4, 7, 5, 0.5) 58%),
    rgba(4, 7, 5, 0.93);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}

/* The loss variant swaps the celebratory wash for a blood-red one; the
   headline, emblem and fate chips shift with it. */
.splash--loss {
  background:
    radial-gradient(130% 90% at 50% -8%, rgba(217, 112, 95, 0.2), rgba(4, 7, 5, 0.5) 58%),
    rgba(4, 7, 5, 0.93);
}

/* The panel owns the short-viewport scroll: auto margins centre it while it
   fits and never clip the top when it does not. */
.splash-panel {
  margin: auto;
  width: min(1180px, 100%);
  max-height: 100%;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px clamp(12px, 2.4vw, 26px) 18px;
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.62);
}

/* ---- verdict hero ------------------------------------------------------- */

.splash-hero {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 22px 8px 15px;
  text-align: center;
  border-bottom: 1px solid var(--line);
}

.splash-bunting {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 24px;
  opacity: 0.9;
}

.splash-emblem {
  width: clamp(42px, 6.5vw, 70px);
  height: auto;
  color: var(--accent);
}

.splash--loss .splash-emblem {
  color: var(--red);
}

.splash-kicker {
  margin: 0;
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

.splash-verdict {
  margin: 2px 0 0;
  font-size: clamp(27px, 5.4vw, 54px);
  line-height: 1.02;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text);
}

.splash--win .splash-verdict {
  color: var(--accent);
  text-shadow: 0 0 28px rgba(201, 224, 106, 0.3);
}

.splash--loss .splash-verdict {
  color: var(--red);
  text-shadow: 0 0 28px rgba(217, 112, 95, 0.28);
}

/* The non-colour cue: the word "victory"/"defeat" with a glyph beside it, so
   the verdict survives a greyscale screenshot or a colour-blind player. */
.splash-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: 2px 0 0;
  padding: 3px 12px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.splash--win .splash-status {
  color: var(--green);
}

.splash--loss .splash-status {
  color: var(--red);
}

.splash-hero-note {
  margin: 3px 0 0;
  max-width: 74ch;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  opacity: 0.9;
}

/* Pulsing rule: the looping flourish. Static state is the full-strength rule,
   so reduced-motion users lose nothing but the movement. */
.splash-rule {
  width: min(260px, 60%);
  height: 2px;
  margin-top: 3px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}

/* ---- conditions strip --------------------------------------------------- */

.splash-conditions {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 0;
}

.splash-condition {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 13px;
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.splash-condition dt {
  font-size: 9.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}

.splash-condition dd {
  margin: 0;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
}

/* ---- per-position breakdown --------------------------------------------- */

.splash-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.splash-block-head {
  margin: 0;
  font-size: 10.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--muted);
}

.splash-breakdown {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 18px;
  align-items: start;
}

.splash-line {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.splash-line-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin: 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}

.splash-positions {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.splash-pos {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 9px;
  padding: 5px 9px;
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: 12px;
}

/* A razed position stays legible but visibly finished. */
.splash-pos.is-destroyed {
  opacity: 0.74;
}

.splash-pos-letter {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--panel-2);
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
}

.splash-pos--enemy .splash-pos-letter {
  color: var(--red);
  border-color: rgba(217, 112, 95, 0.5);
}

.splash-pos-main {
  flex: 1 1 120px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.splash-pos-name {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.splash-pos-kind {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

.splash-pos-hp {
  flex: 1 1 118px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* The bar's base rule already carries the true fraction; the animation only
   grows it from zero, so a reduced-motion (or failed) animation still shows a
   correct bar. */
.splash-bar {
  flex: 1 1 auto;
  min-width: 46px;
  height: 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #0a0f0c;
  overflow: hidden;
}

.splash-bar i {
  display: block;
  width: var(--hp, 0%);
  height: 100%;
  border-radius: inherit;
  background: var(--green);
}

.splash-pos--enemy .splash-bar i {
  background: var(--red);
}

/* An emptied track is hatched, so a razed position reads as destroyed rather
   than as a missing bar. */
.splash-pos.is-destroyed .splash-bar {
  background-image: repeating-linear-gradient(
    45deg,
    rgba(217, 112, 95, 0.22) 0 4px,
    rgba(217, 112, 95, 0) 4px 8px
  );
}

.splash-hp-pct {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 700;
}

/* The raw figure travels with the percentage: compact, and never a substitute
   for it. */
.splash-hp-raw {
  flex: 0 0 auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--muted);
}

.splash-fate {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 3px 9px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* Fate colour is the *player's* reading: razing their positions is good,
   overrunning yours is bad, and "held" is coloured by whose position it is. */
.splash-fate--razed {
  color: var(--green);
}

.splash-fate--overrun {
  color: var(--red);
}

.splash-pos--player .splash-fate--held {
  color: var(--green);
}

.splash-pos--enemy .splash-fate--held {
  color: var(--red);
}

/* ---- headline numbers --------------------------------------------------- */

.splash-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 7px;
  margin: 0;
}

.splash-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 11px;
  background: var(--ink-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--line);
  border-radius: 8px;
}

.splash-stat--good {
  border-left-color: var(--green);
}

.splash-stat--bad {
  border-left-color: var(--red);
}

.splash-stat--bonds {
  border-left-color: var(--gold);
}

.splash-stat dt {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}

.splash-stat dd {
  margin: 0;
  font-family: var(--mono);
  font-size: 17px;
  font-weight: 700;
}

/* ---- unlock line and actions -------------------------------------------- */

.splash-unlock {
  margin: 0;
  padding: 8px 13px;
  border-left: 3px solid var(--gold);
  background: rgba(232, 193, 90, 0.08);
  font-size: 13.5px;
}

.splash-unlock b {
  color: var(--gold);
}

.splash-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--muted);
}

/* Sizing only: the global .btn / .btn--primary rules in style.css keep the
   palette, so the splash cannot fight them (and it never uses the font
   shorthand, which would drop .btn--primary's weight). */
.splash-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.splash .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 10px 18px;
  font-size: 13.5px;
}

/* ---- responsiveness ----------------------------------------------------- */

/* Wide landscape gets two breakdown columns; a phone in landscape (or any
   portrait viewport) gets one so the rows stay readable. */
@media (max-width: 899px), (orientation: portrait) {
  .splash-breakdown {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* Short viewports: tighten everything and pin the actions to the bottom of
   the scrolling panel, so the way out is always one tap away. */
@media (orientation: landscape) and (max-height: 560px) {
  .splash {
    padding: 6px;
  }

  .splash-panel {
    gap: 8px;
    padding: 10px 14px 12px;
  }

  .splash-hero {
    padding: 8px 6px 10px;
  }

  .splash-bunting {
    display: none;
  }

  .splash-emblem {
    width: 34px;
  }

  .splash-verdict {
    font-size: clamp(22px, 4.6vw, 36px);
  }

  .splash-pos {
    padding: 4px 8px;
  }

  .splash-actions {
    position: sticky;
    bottom: 0;
    z-index: 1;
    padding: 10px 0;
    background: var(--panel);
  }
}

/* ---- motion ------------------------------------------------------------- */

/* Every animation lives here and nowhere else: without the media query the
   markup above is already the finished, correct layout. */
@media (prefers-reduced-motion: no-preference) {
  /* The overlay wipes down into place. */
  .splash {
    animation: splash-veil 260ms ease-out both;
  }

  .splash-panel {
    animation: splash-panel-in 340ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .splash-emblem {
    animation: splash-stamp 460ms cubic-bezier(0.2, 1.5, 0.4, 1) both;
  }

  .splash-verdict {
    animation: splash-stamp 540ms cubic-bezier(0.2, 1.4, 0.35, 1) 80ms both;
  }

  /* Conditions, position rows and stat rows all stagger off their --i index,
     which runs top to bottom across the whole panel. */
  .splash-condition,
  .splash-pos,
  .splash-stat {
    animation: splash-rise 320ms ease-out both;
    animation-delay: calc(var(--i, 0) * 55ms);
  }

  .splash-bar i {
    animation: splash-grow 640ms cubic-bezier(0.2, 0.9, 0.25, 1) both;
    animation-delay: calc(var(--i, 0) * 55ms + 180ms);
  }

  .splash-rule {
    animation: splash-pulse 2.4s ease-in-out infinite;
  }

  /* A sheen sweep across the hero — the win screen alone gets to celebrate;
     the loss screen keeps the quieter pulsing rule. */
  .splash--win .splash-hero::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 30%;
    pointer-events: none;
    background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.13) 45%, transparent);
    animation: splash-sheen 3.4s ease-in-out 900ms infinite;
  }

  /* The keyframes are declared inside this block too, so that with reduced
     motion the stylesheet holds no animation at all — nothing is merely
     disabled, none of it is ever defined. */

  /* The overlay fades and wipes in; the end state is the base layout. */
  @keyframes splash-veil {
    from {
      opacity: 0;
      clip-path: inset(0 0 14% 0);
    }
    to {
      opacity: 1;
      clip-path: inset(0 0 0 0);
    }
  }

  @keyframes splash-panel-in {
    from {
      opacity: 0;
      transform: translateY(18px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes splash-stamp {
    from {
      opacity: 0;
      transform: translateY(-14px) scale(1.06);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes splash-rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* Grows from empty to the bar's own --hp value; the base rule already holds
     that same width, so this never hides the truth behind an animation. */
  @keyframes splash-grow {
    from {
      width: 0;
    }
    to {
      width: var(--hp, 0%);
    }
  }

  @keyframes splash-sheen {
    0% {
      transform: translateX(-120%);
    }
    60%,
    100% {
      transform: translateX(400%);
    }
  }

  @keyframes splash-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
}
`;
