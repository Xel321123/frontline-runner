/**
 * Human-readable descriptions of a sector's tactical shape.
 *
 * Shared by the campaign map, the briefing modal, the camp and the result
 * panel, so all four describe a battle the same way — and so the wording can
 * never drift from the data that drives the simulation.
 */

import type {
  BattlefieldFeature,
  MissionType,
} from '../data/campaignData';
import type { StageDefinition } from '../core/progression';
import { environmentRules } from './environment';

export function missionLabel(mission: MissionType): string {
  switch (mission) {
    case 'survive_timer':
      return 'Hold the line';
    case 'assault':
      return 'Assault';
    default:
      return 'Destroy the strongpoint';
  }
}

/** Extra clause explaining what the mission type means in play. */
export function missionDetail(mission: MissionType): string {
  switch (mission) {
    case 'survive_timer':
      return 'survive the clock with your base standing';
    case 'assault':
      return 'a prepared position, reinforced and entrenched';
    default:
      return 'break the strongpoint';
  }
}

export function featureLabel(feature: BattlefieldFeature): string {
  switch (feature) {
    case 'trenches':
      return 'trenches';
    case 'minefield':
      return 'minefield';
    case 'bridge_chokepoint':
      return 'bridge chokepoint';
    default:
      return String(feature);
  }
}

/** One compact line describing a sector: mission, weather, terrain, supply. */
export function stageTagline(stage: StageDefinition): string {
  const rules = environmentRules(stage.environment);
  const parts: string[] = [missionLabel(stage.missionType)];
  parts.push(rules.label);
  if (stage.features.length > 0) {
    parts.push(stage.features.map((feature) => featureLabel(feature)).join(' + '));
  }
  if (Math.abs(stage.supplyRateMultiplier - 1) > 0.001) {
    parts.push(`supplies ×${stage.supplyRateMultiplier}`);
  }
  return parts.join(' · ');
}
