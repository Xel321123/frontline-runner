/**
 * Historical campaign and weapon database.
 *
 * PURE DATA: this module imports nothing but a type from `core/types` — no DOM,
 * no platform adapter, no balance logic. It is the single source of truth for
 * the sixty campaign nodes and fourteen weapons; `core/progression.ts` layers
 * game balance (reward bonds, enemy tiers, unlock rules) on top of it.
 *
 * Conventions
 * -----------
 * - `coords` are percentages of the theatre map (0–100, origin top-left) and
 *   line up with `public/assets/maps/europe_blank_laea.svg`.
 * - `year` is a string so multi-year actions ("1942-43") survive intact.
 * - `briefing` is exactly two sentences of military history, told neutrally
 *   from the operational point of view of the force being played.
 * - `bossHp` escalates uniformly by 150 per node (1400 → 5750) and both
 *   campaigns share the curve, so a node number means the same difficulty
 *   regardless of side.
 * - `fireRate` is shots per second and `spread` is the ± aim deviation in
 *   degrees. Rates are anchored to real cyclic rates where one exists (MG 42
 *   ≈ 1200 rpm, MP 40 ≈ 500 rpm) and otherwise tuned for play.
 * - `minLevel` is the 1-based campaign node at which the weapon becomes
 *   available to that faction.
 */
import type { Faction } from '../core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Named theatre of operations. */
export type Theater =
  | 'Norway'
  | 'Britain'
  | 'Poland'
  | 'Balkans'
  | 'Mediterranean'
  | 'Crimea'
  | 'North Africa'
  | 'Italy'
  | 'Western Europe'
  | 'Eastern Front'
  | 'Germany';

export const THEATERS: readonly Theater[] = [
  'Norway',
  'Britain',
  'Poland',
  'Balkans',
  'Mediterranean',
  'Crimea',
  'North Africa',
  'Italy',
  'Western Europe',
  'Eastern Front',
  'Germany',
];

/** Position on the theatre map, as a percentage of its width and height. */
export interface CampaignCoords {
  readonly x: number;
  readonly y: number;
}

export interface CampaignNode {
  readonly id: string;
  readonly name: string;
  readonly year: string;
  readonly theater: Theater;
  readonly coords: CampaignCoords;
  readonly bossName: string;
  readonly bossHp: number;
  /** Two sentences of history, from the played faction's point of view. */
  readonly briefing: string;
}

export interface WeaponStats {
  readonly id: string;
  readonly name: string;
  readonly faction: Faction;
  /** Hit points removed per projectile. */
  readonly damage: number;
  /** Shots per second. */
  readonly fireRate: number;
  /** ± aim deviation in degrees. */
  readonly spread: number;
  /** Campaign node (1-based) at which the weapon unlocks. */
  readonly minLevel: number;
  readonly caliber: string;
  /** Year the weapon entered service. */
  readonly year: number;
  readonly magazineSize: number;
  /** Seconds for a full magazine change. */
  readonly reloadTime: number;
  readonly automatic: boolean;
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

/**
 * The final unlock slot in the design brief ("M2 Browning/Bazooka" and
 * "Panzerschreck/Flammenwerfer 35") is shipped as two distinct entries each:
 * a belt-fed heavy machine gun and a single-shot anti-tank launcher share
 * nothing but a tier, and a stat block cannot honestly describe both.
 */
export const ALLIED_WEAPONS: readonly WeaponStats[] = [
  {
    id: 'lee-enfield-no4',
    name: 'Lee-Enfield No. 4',
    faction: 'allied',
    damage: 62,
    fireRate: 1.3,
    spread: 1.2,
    minLevel: 1,
    caliber: '.303 British',
    year: 1941,
    magazineSize: 10,
    reloadTime: 3,
    automatic: false,
  },
  {
    id: 'm1-garand',
    name: 'M1 Garand',
    faction: 'allied',
    damage: 58,
    fireRate: 3.6,
    spread: 1.1,
    minLevel: 4,
    caliber: '.30-06 Springfield',
    year: 1936,
    magazineSize: 8,
    reloadTime: 2.6,
    automatic: false,
  },
  {
    id: 'sten-mk2',
    name: 'Sten Mk II',
    faction: 'allied',
    damage: 26,
    fireRate: 9,
    spread: 2.8,
    minLevel: 9,
    caliber: '9×19mm Parabellum',
    year: 1941,
    magazineSize: 32,
    reloadTime: 2.2,
    automatic: true,
  },
  {
    id: 'm1a1-thompson',
    name: 'M1A1 Thompson',
    faction: 'allied',
    damage: 34,
    fireRate: 11.5,
    spread: 2.4,
    minLevel: 14,
    caliber: '.45 ACP',
    year: 1942,
    magazineSize: 30,
    reloadTime: 2.4,
    automatic: true,
  },
  {
    id: 'bren-gun',
    name: 'Bren Gun',
    faction: 'allied',
    damage: 44,
    fireRate: 8.3,
    spread: 1.8,
    minLevel: 20,
    caliber: '.303 British',
    year: 1938,
    magazineSize: 30,
    reloadTime: 3.2,
    automatic: true,
  },
  {
    id: 'm2-browning',
    name: 'M2 Browning',
    faction: 'allied',
    damage: 40,
    fireRate: 8.5,
    spread: 2.2,
    minLevel: 27,
    caliber: '.50 BMG',
    year: 1933,
    magazineSize: 100,
    reloadTime: 5.5,
    automatic: true,
  },
  {
    id: 'bazooka-m1a1',
    name: 'Bazooka M1A1',
    faction: 'allied',
    damage: 185,
    fireRate: 0.7,
    spread: 0.6,
    minLevel: 27,
    caliber: '60 mm HEAT rocket',
    year: 1942,
    magazineSize: 1,
    reloadTime: 6,
    automatic: false,
  },
];

export const AXIS_WEAPONS: readonly WeaponStats[] = [
  {
    id: 'karabiner-98k',
    name: 'Karabiner 98k',
    faction: 'axis',
    damage: 66,
    fireRate: 1.2,
    spread: 1.1,
    minLevel: 1,
    caliber: '7.92×57mm Mauser',
    year: 1935,
    magazineSize: 5,
    reloadTime: 2.8,
    automatic: false,
  },
  {
    id: 'gewehr-43',
    name: 'Gewehr 43',
    faction: 'axis',
    damage: 55,
    fireRate: 3.2,
    spread: 1.3,
    minLevel: 4,
    caliber: '7.92×57mm Mauser',
    year: 1943,
    magazineSize: 10,
    reloadTime: 2.7,
    automatic: false,
  },
  {
    id: 'mp-40',
    name: 'MP 40',
    faction: 'axis',
    damage: 27,
    fireRate: 8.5,
    spread: 2.6,
    minLevel: 9,
    caliber: '9×19mm Parabellum',
    year: 1940,
    magazineSize: 32,
    reloadTime: 2.2,
    automatic: true,
  },
  {
    id: 'stg-44',
    name: 'StG 44',
    faction: 'axis',
    damage: 37,
    fireRate: 8.6,
    spread: 2,
    minLevel: 14,
    caliber: '7.92×33mm Kurz',
    year: 1944,
    magazineSize: 30,
    reloadTime: 2.4,
    automatic: true,
  },
  {
    id: 'mg-42',
    name: 'MG 42',
    faction: 'axis',
    damage: 42,
    fireRate: 20,
    spread: 3.4,
    minLevel: 20,
    caliber: '7.92×57mm Mauser',
    year: 1942,
    magazineSize: 50,
    reloadTime: 5,
    automatic: true,
  },
  {
    id: 'panzerschreck',
    name: 'Panzerschreck',
    faction: 'axis',
    damage: 200,
    fireRate: 0.6,
    spread: 0.7,
    minLevel: 27,
    caliber: '88 mm RPzB rocket',
    year: 1943,
    magazineSize: 1,
    reloadTime: 6.5,
    automatic: false,
  },
  {
    id: 'flammenwerfer-35',
    name: 'Flammenwerfer 35',
    faction: 'axis',
    damage: 14,
    fireRate: 12,
    spread: 6,
    minLevel: 27,
    caliber: 'fuel-oil jet',
    year: 1935,
    magazineSize: 1,
    reloadTime: 5,
    automatic: true,
  },
];

export const WEAPONS: readonly WeaponStats[] = [...ALLIED_WEAPONS, ...AXIS_WEAPONS];

const WEAPON_BY_ID = new Map(WEAPONS.map((weapon) => [weapon.id, weapon]));

export function getWeapon(id: string): WeaponStats | undefined {
  return WEAPON_BY_ID.get(id);
}

export function weaponsForFaction(faction: Faction): readonly WeaponStats[] {
  return faction === 'allied' ? ALLIED_WEAPONS : AXIS_WEAPONS;
}

/** Weapons available at a given 1-based campaign node, in unlock order. */
export function availableWeapons(faction: Faction, stageIndex: number): readonly WeaponStats[] {
  return weaponsForFaction(faction).filter((weapon) => weapon.minLevel <= stageIndex);
}

/** The weapon a faction starts a campaign with. */
export function startingWeapon(faction: Faction): WeaponStats {
  const weapon = weaponsForFaction(faction)[0];
  if (!weapon) throw new Error(`no weapons defined for faction ${faction}`);
  return weapon;
}

// ---------------------------------------------------------------------------
// Allied campaign
// ---------------------------------------------------------------------------

export const ALLIED_CAMPAIGN: readonly CampaignNode[] = [
  {
    id: 'allied-01',
    name: 'Narvik',
    year: '1940',
    theater: 'Norway',
    coords: { x: 52, y: 18 },
    bossName: 'Coastal Battery',
    bossHp: 1400,
    briefing:
      'In April 1940 German forces seized the Norwegian iron ore port of Narvik, and a combined British, French, Polish and Norwegian force landed to take it back. The fighting ended in the first Allied victory of the war, although the troops were withdrawn in June as France collapsed.',
  },
  {
    id: 'allied-02',
    name: 'Dunkirk',
    year: '1940',
    theater: 'Western Europe',
    coords: { x: 38, y: 47 },
    bossName: 'Beach Defense',
    bossHp: 1550,
    briefing:
      'Between 26 May and 4 June 1940, Operation Dynamo lifted some 338,000 Allied soldiers from the beaches and harbour of Dunkirk under constant air attack. The rescue saved the British Expeditionary Force but left its tanks, guns and vehicles on the sand.',
  },
  {
    id: 'allied-03',
    name: 'Battle of Britain',
    year: '1940',
    theater: 'Britain',
    coords: { x: 35, y: 44 },
    bossName: 'Flak Tower',
    bossHp: 1700,
    briefing:
      'From July to October 1940 the Luftwaffe tried to break RAF Fighter Command and win air superiority over southern England. The campaign failed, and the invasion it was meant to enable was postponed indefinitely.',
  },
  {
    id: 'allied-04',
    name: 'Operation Compass',
    year: '1940',
    theater: 'North Africa',
    coords: { x: 58, y: 91 },
    bossName: 'Italian Redoubt',
    bossHp: 1850,
    briefing:
      'Launched in December 1940, Operation Compass began as a five-day raid by the Western Desert Force and turned into a full offensive against the Italian Tenth Army. It took Sidi Barrani, Bardia and Tobruk and captured around 130,000 prisoners.',
  },
  {
    id: 'allied-05',
    name: 'Crete',
    year: '1941',
    theater: 'Mediterranean',
    coords: { x: 62, y: 82 },
    bossName: 'Airhead',
    bossHp: 2000,
    briefing:
      'On 20 May 1941 Germany launched the first large-scale airborne invasion in history against Crete, and captured Maleme airfield on the second day. The Allies evacuated by 1 June after a costly defence that destroyed the German parachute force as a striking arm.',
  },
  {
    id: 'allied-06',
    name: 'Tobruk',
    year: '1941',
    theater: 'North Africa',
    coords: { x: 55, y: 90 },
    bossName: "Rommel's Perimeter",
    bossHp: 2150,
    briefing:
      'Australian, British, Indian and Polish troops held the fortified port of Tobruk against repeated attacks from April to December 1941. The defenders, nicknamed the Rats of Tobruk, tied down a large part of the Axis force until the siege was raised.',
  },
  {
    id: 'allied-07',
    name: 'Moscow',
    year: '1941',
    theater: 'Eastern Front',
    coords: { x: 72, y: 35 },
    bossName: 'Frozen Panzer Column',
    bossHp: 2300,
    briefing:
      'Operation Typhoon drove towards Moscow from October 1941, and German spearheads reached the outskirts of the city in early December. The Soviet counter-offensive of 5 December, fought in temperatures far below freezing, pushed the exhausted armies back.',
  },
  {
    id: 'allied-08',
    name: 'Sevastopol',
    year: '1942',
    theater: 'Crimea',
    coords: { x: 70, y: 61 },
    bossName: 'Fort Maxim Gorky',
    bossHp: 2450,
    briefing:
      'Soviet defenders held the fortress of Sevastopol for 250 days against the heaviest siege artillery in the German inventory. Fort Maxim Gorky, the 30th Coastal Battery, kept its battleship guns in action until the position was overrun in June 1942.',
  },
  {
    id: 'allied-09',
    name: 'Dieppe',
    year: '1942',
    theater: 'Western Europe',
    coords: { x: 37, y: 48 },
    bossName: 'Cliffside Pillbox',
    bossHp: 2600,
    briefing:
      'On 19 August 1942 some 6,000 men, most of them Canadian, raided the French Channel port of Dieppe and were stopped on the beaches by fire from the cliffs. The operation was a costly failure that taught the Allies how much firepower and planning a real invasion would need.',
  },
  {
    id: 'allied-10',
    name: 'El Alamein',
    year: '1942',
    theater: 'North Africa',
    coords: { x: 60, y: 93 },
    bossName: "Devil's Gardens",
    bossHp: 2750,
    briefing:
      'From 23 October to 11 November 1942 the Eighth Army broke through the deep minefields known as the Devil\u2019s Gardens at El Alamein. The victory ended the Axis advance towards Alexandria and began a pursuit west that never lost contact with the retreating force.',
  },
  {
    id: 'allied-11',
    name: 'Stalingrad',
    year: '1942-43',
    theater: 'Eastern Front',
    coords: { x: 79, y: 52 },
    bossName: 'Grain Elevator',
    bossHp: 2900,
    briefing:
      'From August 1942 the German Sixth Army fought street by street through Stalingrad, where a small garrison held the grain elevator for four days against tanks and infantry. Operation Uranus encircled the Sixth Army in November, and organised resistance ended on 2 February 1943.',
  },
  {
    id: 'allied-12',
    name: 'Torch',
    year: '1942',
    theater: 'North Africa',
    coords: { x: 24, y: 86 },
    bossName: 'Coastal Casemate',
    bossHp: 3050,
    briefing:
      'Operation Torch landed American and British troops in Morocco and Algeria on 8 November 1942, the first large Allied amphibious operation of the war. Vichy French forces resisted briefly before an armistice brought North Africa into the Allied camp.',
  },
  {
    id: 'allied-13',
    name: 'Mareth Line',
    year: '1943',
    theater: 'North Africa',
    coords: { x: 44, y: 85 },
    bossName: 'Desert Bunker',
    bossHp: 3200,
    briefing:
      'In March 1943 the Eighth Army attacked the fortified Mareth Line in southern Tunisia, where the Wadi Zigzaou had already stopped frontal assaults. A wide flanking move through the Matmata hills turned the position and opened the road north to Tunis.',
  },
  {
    id: 'allied-14',
    name: 'Kursk',
    year: '1943',
    theater: 'Eastern Front',
    coords: { x: 72, y: 46 },
    bossName: 'Anti-Tank Line',
    bossHp: 3350,
    briefing:
      'Operation Citadel opened on 5 July 1943 with German attacks on the Kursk salient from the north and the south. Eight days of fighting through the deepest defensive belts yet dug stopped the offensive, and the armoured clash at Prokhorovka ended the German ability to attack strategically in the east.',
  },
  {
    id: 'allied-15',
    name: 'Husky',
    year: '1943',
    theater: 'Italy',
    coords: { x: 47, y: 78 },
    bossName: 'Gela Beachhead',
    bossHp: 3500,
    briefing:
      'On 10 July 1943 the Allies invaded Sicily, with the US 1st Infantry Division landing at Gela in the teeth of Italian and German counter-attacks. The island fell in 38 days and the Italian government collapsed two weeks later.',
  },
  {
    id: 'allied-16',
    name: 'Salerno',
    year: '1943',
    theater: 'Italy',
    coords: { x: 48, y: 71 },
    bossName: 'Panzer Counterattack',
    bossHp: 3650,
    briefing:
      'Operation Avalanche put the US Fifth Army ashore at Salerno on 9 September 1943, in the same week that Italy announced its surrender. German counter-attacks came within a few kilometres of the beaches before air power and reinforcements broke them.',
  },
  {
    id: 'allied-17',
    name: 'Dnieper',
    year: '1943',
    theater: 'Eastern Front',
    coords: { x: 66, y: 53 },
    bossName: 'River Wall',
    bossHp: 3800,
    briefing:
      'In the autumn of 1943 Soviet forces crossed the Dnieper along a front of some 300 kilometres, often on improvised rafts and boats. The prepared line on the west bank was broken, Kiev was liberated on 6 November, and the crossing became a test of endurance for both sides.',
  },
  {
    id: 'allied-18',
    name: 'Monte Cassino',
    year: '1944',
    theater: 'Italy',
    coords: { x: 47, y: 69 },
    bossName: 'Monastery Redoubt',
    bossHp: 3950,
    briefing:
      'Four battles were fought between January and May 1944 for the monastery hill of Monte Cassino, the key to the Gustav Line. Polish troops of II Corps finally raised their flag over the ruins on 18 May after a bombardment that had destroyed the abbey.',
  },
  {
    id: 'allied-19',
    name: 'Anzio',
    year: '1944',
    theater: 'Italy',
    coords: { x: 46, y: 68 },
    bossName: 'Railway Gun',
    bossHp: 4100,
    briefing:
      'Operation Shingle landed 36,000 men at Anzio on 22 January 1944 behind the Gustav Line in a bid to unhinge it. The beachhead was contained for four months and shelled by the railway gun known as Anzio Annie until the breakout in May.',
  },
  {
    id: 'allied-20',
    name: 'D-Day Omaha',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 34, y: 51 },
    bossName: 'Widerstandsnest WN62',
    bossHp: 4250,
    briefing:
      'On 6 June 1944 the US 1st and 29th Infantry Divisions landed on Omaha Beach, where the strongpoint WN62 above Colleville swept the sand with enfilade fire. The beach was carried only by climbing the bluffs with bangalore torpedoes and by destroyers firing point blank into the emplacements.',
  },
  {
    id: 'allied-21',
    name: 'Cherbourg',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 33, y: 50 },
    bossName: 'Submarine Pen',
    bossHp: 4400,
    briefing:
      'After the Normandy landings the US VII Corps turned west to take Cherbourg, whose deep-water port the Allies needed for supply. The garrison surrendered on 26 June 1944, but demolitions had wrecked the harbour and the submarine pens had survived the bombing.',
  },
  {
    id: 'allied-22',
    name: 'Bagration',
    year: '1944',
    theater: 'Eastern Front',
    coords: { x: 62, y: 40 },
    bossName: 'Corps HQ',
    bossHp: 4550,
    briefing:
      'Launched on 22 June 1944, Operation Bagration destroyed German Army Group Centre within a fortnight and advanced some 500 kilometres to the Vistula. It was the heaviest defeat inflicted on the German army during the war.',
  },
  {
    id: 'allied-23',
    name: 'Falaise',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 35, y: 52 },
    bossName: 'Escaping Column',
    bossHp: 4700,
    briefing:
      'In August 1944 the Allies closed a pocket around Falaise that trapped most of the German Seventh Army in Normandy. Guns and tanks of the escaping columns were destroyed in the bottleneck that the survivors called the corridor of death.',
  },
  {
    id: 'allied-24',
    name: 'Paris',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 37, y: 52 },
    bossName: 'Kommandantur',
    bossHp: 4850,
    briefing:
      'Paris rose against its garrison on 19 August 1944 as the 2nd Armoured Division advanced from Normandy. The German commander surrendered the city on 25 August, and the Kommandantur on the rue de Rivoli passed into French hands.',
  },
  {
    id: 'allied-25',
    name: 'Market Garden',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 40, y: 45 },
    bossName: 'Arnhem Bridge',
    bossHp: 5000,
    briefing:
      'Operation Market Garden dropped three airborne divisions in the Netherlands on 17 September 1944 to seize a chain of bridges ending at Arnhem. The British 1st Airborne held the north end of the Arnhem bridge for four days but could not be relieved, and the plan failed at the last bridge.',
  },
  {
    id: 'allied-26',
    name: 'Hürtgen Forest',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 41, y: 47 },
    bossName: 'Pillbox Bunker',
    bossHp: 5150,
    briefing:
      'From September 1944 the US First Army fought its way into the Hürtgen Forest, where dense woods, mud and prepared bunkers cancelled the advantage of air support. The six-month battle produced little ground and became a byword for attritional folly.',
  },
  {
    id: 'allied-27',
    name: 'Bastogne',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 40, y: 48 },
    bossName: 'Crossroads Bastion',
    bossHp: 5300,
    briefing:
      'The 101st Airborne Division was encircled at the crossroads town of Bastogne on 20 December 1944 during the Ardennes offensive. Asked to surrender, its commander answered "Nuts", and the town held until the weather cleared and relief armour broke through on 26 December.',
  },
  {
    id: 'allied-28',
    name: 'Remagen',
    year: '1945',
    theater: 'Western Europe',
    coords: { x: 42, y: 47 },
    bossName: 'Ludendorff Bridge',
    bossHp: 5450,
    briefing:
      'On 7 March 1945 a US armoured task force found the Ludendorff railway bridge at Remagen still standing and crossed it under fire. The bridge collapsed ten days later, but five divisions had already passed over the Rhine.',
  },
  {
    id: 'allied-29',
    name: 'Seelow Heights',
    year: '1945',
    theater: 'Germany',
    coords: { x: 49, y: 43 },
    bossName: 'Artillery Battery',
    bossHp: 5600,
    briefing:
      'In April 1945 the Red Army attacked the Seelow Heights, the last prepared line east of Berlin, after the heaviest artillery preparation of the war. The front needed four days to break through a defence dug into the plateau.',
  },
  {
    id: 'allied-30',
    name: 'Berlin',
    year: '1945',
    theater: 'Germany',
    coords: { x: 48, y: 43 },
    bossName: 'Reichstag Stronghold',
    bossHp: 5750,
    briefing:
      'The battle for Berlin opened on 16 April 1945 and closed around the city in a week of street fighting. The Reichstag was taken on 30 April, the same day its head of state killed himself, and the garrison surrendered on 2 May.',
  },
];

// ---------------------------------------------------------------------------
// Axis campaign
// ---------------------------------------------------------------------------

export const AXIS_CAMPAIGN: readonly CampaignNode[] = [
  {
    id: 'axis-01',
    name: 'Poland',
    year: '1939',
    theater: 'Poland',
    coords: { x: 53, y: 45 },
    bossName: 'Westerplatte Depot',
    bossHp: 1400,
    briefing:
      'Germany invaded Poland on 1 September 1939, opening the war in Europe. The small garrison at the Westerplatte depot in Danzig held out for seven days against naval gunfire, air attack and assault engineers.',
  },
  {
    id: 'axis-02',
    name: 'Warsaw',
    year: '1939',
    theater: 'Poland',
    coords: { x: 55, y: 45 },
    bossName: 'Fortress Ring',
    bossHp: 1550,
    briefing:
      'German forces closed on Warsaw in the second week of September 1939 while the city improvised barricades and anti-tank ditches. The capital capitulated on 28 September after heavy artillery fire and air bombardment.',
  },
  {
    id: 'axis-03',
    name: 'Sedan',
    year: '1940',
    theater: 'Western Europe',
    coords: { x: 39, y: 49 },
    bossName: 'Meuse Blockhouse',
    bossHp: 1700,
    briefing:
      'On 13 May 1940 the XIX Panzer Corps crossed the Meuse at Sedan after a concentrated dive-bomber attack on the blockhouses. The bridgehead broke the French line at its weakest point and began the drive to the Channel.',
  },
  {
    id: 'axis-04',
    name: 'Maginot Line',
    year: '1940',
    theater: 'Western Europe',
    coords: { x: 42, y: 52 },
    bossName: 'Fort Fermont',
    bossHp: 1850,
    briefing:
      'German infantry attacked the Maginot Line frontally in June 1940, after the mobile forces had already passed behind it. Fort Fermont held out until the armistice and fired its 75 mm turret in support of the neighbouring works.',
  },
  {
    id: 'axis-05',
    name: 'Metaxas Line',
    year: '1941',
    theater: 'Balkans',
    coords: { x: 58, y: 75 },
    bossName: 'Roupel Fort',
    bossHp: 2000,
    briefing:
      'The Metaxas Line was attacked on 6 April 1941 with assault engineers, flame throwers and dive-bombers against concrete galleries. Fort Roupel held through repeated bombardment until the Greek capitulation on 9 April.',
  },
  {
    id: 'axis-06',
    name: 'Merkur Crete',
    year: '1941',
    theater: 'Mediterranean',
    coords: { x: 62, y: 82 },
    bossName: 'Maleme Airfield',
    bossHp: 2150,
    briefing:
      'On 20 May 1941 parachute and glider troops landed around Maleme airfield, where the capture of the overlooking heights decided the battle. Air-landed reinforcements turned the airfield into an operational base and forced the British evacuation of Crete.',
  },
  {
    id: 'axis-07',
    name: 'Brest Fortress',
    year: '1941',
    theater: 'Eastern Front',
    coords: { x: 58, y: 44 },
    bossName: 'Brick Bastion',
    bossHp: 2300,
    briefing:
      'The old brick fortress at Brest was caught by surprise when the invasion opened on 22 June 1941. Isolated groups held the central citadel for more than a week, and resistance in the casemates continued into July.',
  },
  {
    id: 'axis-08',
    name: 'Smolensk',
    year: '1941',
    theater: 'Eastern Front',
    coords: { x: 66, y: 38 },
    bossName: 'Counterattack Brigade',
    bossHp: 2450,
    briefing:
      'The battle of Smolensk in July 1941 cost two months of the campaign timetable as Soviet counter-attacks struck the flanks of the advancing panzer groups. The town changed hands more than once in fighting that forced a reconsideration of the pace of the advance.',
  },
  {
    id: 'axis-09',
    name: 'Kiev Pocket',
    year: '1941',
    theater: 'Eastern Front',
    coords: { x: 65, y: 48 },
    bossName: 'Field HQ',
    bossHp: 2600,
    briefing:
      'The encirclement east of Kiev in September 1941 trapped four Soviet armies and ended with more than 600,000 prisoners taken. Kiev fell on 19 September, but the armoured diversion to the south helped delay the drive on Moscow.',
  },
  {
    id: 'axis-10',
    name: 'Leningrad',
    year: '1941',
    theater: 'Eastern Front',
    coords: { x: 63, y: 26 },
    bossName: 'Neva Emplacement',
    bossHp: 2750,
    briefing:
      'The siege of Leningrad began on 8 September 1941 when the last land link was cut at Schlüsselburg. Bridgeheads on the Neva were contested for months at terrible cost to both sides, and the city was never taken by assault.',
  },
  {
    id: 'axis-11',
    name: 'Moscow Drive',
    year: '1941',
    theater: 'Eastern Front',
    coords: { x: 72, y: 35 },
    bossName: 'Anti-Tank Sled',
    bossHp: 2900,
    briefing:
      'Operation Typhoon resumed the advance on Moscow in November 1941 after the autumn mud had halted the tanks. Winter equipment had not been issued, and improvised anti-tank teams fought the new Soviet ski battalions as the temperature fell far below freezing.',
  },
  {
    id: 'axis-12',
    name: 'Rzhev',
    year: '1942',
    theater: 'Eastern Front',
    coords: { x: 68, y: 34 },
    bossName: 'Trench System',
    bossHp: 3050,
    briefing:
      'The Rzhev salient was the scene of repeated Soviet offensives through 1942 against a deep network of trenches and bunkers. The fighting cost enormous casualties on both sides and left the front line barely changed.',
  },
  {
    id: 'axis-13',
    name: 'Gazala',
    year: '1942',
    theater: 'North Africa',
    coords: { x: 54, y: 90 },
    bossName: 'Brigade Box',
    bossHp: 3200,
    briefing:
      'In May 1942 armoured forces attacked the Gazala line, where infantry brigade boxes and thick minefields anchored the desert flank. The battle ended with a break-out at Bir Hakeim and a pursuit that carried the front to the Egyptian frontier.',
  },
  {
    id: 'axis-14',
    name: 'Fall of Tobruk',
    year: '1942',
    theater: 'North Africa',
    coords: { x: 55, y: 90 },
    bossName: 'Port Strongpoint',
    bossHp: 3350,
    briefing:
      'The attack on Tobruk on 20 June 1942 broke into the perimeter within a day, and the garrison of about 33,000 surrendered on 21 June. The port was taken with most of its fuel and supplies intact.',
  },
  {
    id: 'axis-15',
    name: 'Fall Blau',
    year: '1942',
    theater: 'Eastern Front',
    coords: { x: 74, y: 48 },
    bossName: 'Don River Crossing',
    bossHp: 3500,
    briefing:
      'Case Blue opened on 28 June 1942 with attacks towards Voronezh and the Don, the first stage of the drive into the Caucasus. Ground was gained quickly, but the advance stretched the front and left long sectors to allied armies.',
  },
  {
    id: 'axis-16',
    name: 'Stalingrad Factories',
    year: '1942',
    theater: 'Eastern Front',
    coords: { x: 79, y: 52 },
    bossName: 'Barrikady Hall',
    bossHp: 3650,
    briefing:
      'By October 1942 the fighting had moved into the factory halls north of Stalingrad, where the Barrikady and Red October works became fortified ruins. Attacks across open, shell-torn ground repeatedly failed to reach the Volga.',
  },
  {
    id: 'axis-17',
    name: 'Third Kharkov',
    year: '1943',
    theater: 'Eastern Front',
    coords: { x: 69, y: 49 },
    bossName: 'Armor Spearhead',
    bossHp: 3800,
    briefing:
      'After the winter retreats of early 1943, a counter-offensive retook Kharkov on 15 March against an over-extended Soviet advance. The operation restored the front line but consumed armour that would be needed in the summer.',
  },
  {
    id: 'axis-18',
    name: 'Citadel',
    year: '1943',
    theater: 'Eastern Front',
    coords: { x: 72, y: 46 },
    bossName: 'Pak-Front',
    bossHp: 3950,
    briefing:
      'Operation Citadel attacked the Kursk salient from two directions in July 1943 against defences built in depth behind anti-tank fronts. Progress through the minefields and gun lines was measured in kilometres, and the offensive was called off after eight days.',
  },
  {
    id: 'axis-19',
    name: 'Gran Sasso',
    year: '1943',
    theater: 'Italy',
    coords: { x: 47, y: 66 },
    bossName: 'Mountain Station',
    bossHp: 4100,
    briefing:
      'On 12 September 1943 a glider-borne force landed on the Campo Imperatore plateau and seized the mountain hotel where Mussolini was held. The operation lifted him off the mountain in a light aircraft that barely cleared the downhill slope.',
  },
  {
    id: 'axis-20',
    name: 'Kasserine Pass',
    year: '1943',
    theater: 'North Africa',
    coords: { x: 43, y: 84 },
    bossName: 'Armor Defilade',
    bossHp: 4250,
    briefing:
      'The attack through the Kasserine Pass in February 1943 broke into the US II Corps positions within days. The advance was called off when reserves were needed elsewhere, which gave the defenders time to close the pass with artillery.',
  },
  {
    id: 'axis-21',
    name: 'Korsun',
    year: '1944',
    theater: 'Eastern Front',
    coords: { x: 66, y: 50 },
    bossName: 'Ring Defense',
    bossHp: 4400,
    briefing:
      'Two Soviet pincers closed the Korsun pocket in January 1944, trapping six divisions and a large rear area. The breakout in February succeeded through the gap the survivors named Hell\u2019s Gate, but most of the heavy equipment was abandoned.',
  },
  {
    id: 'axis-22',
    name: 'Narva',
    year: '1944',
    theater: 'Eastern Front',
    coords: { x: 61, y: 28 },
    bossName: 'Tannenberg Line',
    bossHp: 4550,
    briefing:
      'The Narva position was held from February 1944 by a mixed force of regulars and foreign volunteers along the Tannenberg Line. The line bent under repeated attacks, but the river was not crossed at Narva until September.',
  },
  {
    id: 'axis-23',
    name: 'Mortain',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 34, y: 52 },
    bossName: 'Hill 314',
    bossHp: 4700,
    briefing:
      'The counter-attack towards Mortain on 7 August 1944 was meant to cut the American breakout at Avranches. A single battalion held Hill 314 for six days, and the attack was stopped short of its objective.',
  },
  {
    id: 'axis-24',
    name: 'Aachen',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 40, y: 46 },
    bossName: 'Westwall Bunker',
    bossHp: 4850,
    briefing:
      'The Westwall positions around Aachen were attacked in October 1944 in the first battle for a German city. The garrison surrendered on 21 October after house-to-house fighting that destroyed much of the old town.',
  },
  {
    id: 'axis-25',
    name: 'Siege of Brest',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 29, y: 51 },
    bossName: 'U-Boat Pen',
    bossHp: 5000,
    briefing:
      'The U-boat pens at Brest were proof against everything the attackers had, and the garrison held them through August 1944. The city fell on 18 September after a month of siege, and the pens were wrecked by their own crews before the surrender.',
  },
  {
    id: 'axis-26',
    name: 'Ardennes',
    year: '1944',
    theater: 'Western Europe',
    coords: { x: 40, y: 48 },
    bossName: 'Fuel Depot',
    bossHp: 5150,
    briefing:
      'The Ardennes offensive opened on 16 December 1944 through fog that grounded Allied aircraft and covered the approach routes. The advance was halted short of the Meuse by stubborn defence and by a shortage of fuel, the very problem the operation had been launched to solve.',
  },
  {
    id: 'axis-27',
    name: 'Nordwind',
    year: '1945',
    theater: 'Western Europe',
    coords: { x: 42, y: 52 },
    bossName: 'Vosges Line',
    bossHp: 5300,
    briefing:
      'Operation Nordwind attacked the Vosges line in Alsace on 1 January 1945 to exploit the Ardennes offensive. The fighting continued into February and ended in a withdrawal rather than a breakthrough.',
  },
  {
    id: 'axis-28',
    name: 'Budapest',
    year: '1945',
    theater: 'Eastern Front',
    coords: { x: 54, y: 58 },
    bossName: 'Bridgehead Fort',
    bossHp: 5450,
    briefing:
      'Budapest was encircled on 26 December 1944 and defended street by street until 13 February 1945. A relief attempt came to within 25 kilometres of the city before it was pushed back, and the Danube bridgehead was lost with the city.',
  },
  {
    id: 'axis-29',
    name: 'Königsberg',
    year: '1945',
    theater: 'Eastern Front',
    coords: { x: 56, y: 39 },
    bossName: 'Fort No. 5',
    bossHp: 5600,
    briefing:
      'The fortress city of Königsberg was stormed from 6 April 1945 after a four-day bombardment by siege artillery and aircraft. Fort No. 5, laid out in the 1870s and thickened with concrete, held until the city surrendered on 9 April.',
  },
  {
    id: 'axis-30',
    name: 'Halbe Pocket',
    year: '1945',
    theater: 'Germany',
    coords: { x: 48, y: 44 },
    bossName: 'Katyusha Line',
    bossHp: 5750,
    briefing:
      'A German army group was encircled south-east of Berlin in April 1945 while the remnants of another army waited to the west. The breakout through the Halbe corridor cost tens of thousands of casualties and ran into rocket-launcher lines on the far side.',
  },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Nodes per faction. */
export const CAMPAIGN_LENGTH = 30 as const;

/** Weapons a side has unlocked by the time it reaches `stageIndex`. */
export function weaponsUnlockedAt(faction: Faction, stageIndex: number): readonly WeaponStats[] {
  return availableWeapons(faction, stageIndex);
}

/**
 * The weapon an army carries at a given point in its campaign: the latest one
 * unlocked, and where several share that node (the final slot pairs an HMG with
 * a launcher) the one that keeps a squad in sustained fire.
 */
export function bestWeaponFor(faction: Faction, stageIndex: number): WeaponStats {
  const unlocked = availableWeapons(faction, stageIndex);
  if (unlocked.length === 0) return startingWeapon(faction);
  const burst = (weapon: WeaponStats): number => weapon.damage * weapon.fireRate;
  return unlocked.reduce((best, candidate) => {
    if (candidate.minLevel !== best.minLevel) {
      return candidate.minLevel > best.minLevel ? candidate : best;
    }
    const bestScore = (best.automatic ? 1 : 0) * 1e6 + burst(best);
    const score = (candidate.automatic ? 1 : 0) * 1e6 + burst(candidate);
    return score > bestScore ? candidate : best;
  });
}

export const CAMPAIGNS: Readonly<Record<Faction, readonly CampaignNode[]>> = {
  allied: ALLIED_CAMPAIGN,
  axis: AXIS_CAMPAIGN,
};

export const CAMPAIGN_NODES: readonly CampaignNode[] = [...ALLIED_CAMPAIGN, ...AXIS_CAMPAIGN];

const NODE_BY_ID = new Map(CAMPAIGN_NODES.map((node) => [node.id, node]));
const FACTION_BY_NODE = new Map<string, Faction>(
  (Object.keys(CAMPAIGNS) as Faction[]).flatMap((faction) =>
    CAMPAIGNS[faction].map((node): [string, Faction] => [node.id, faction]),
  ),
);

export function getCampaignNode(id: string): CampaignNode | undefined {
  return NODE_BY_ID.get(id);
}

export function isCampaignNodeId(value: unknown): value is string {
  return typeof value === 'string' && NODE_BY_ID.has(value);
}

export function campaignForFaction(faction: Faction): readonly CampaignNode[] {
  return CAMPAIGNS[faction];
}

/** Which faction's campaign a node belongs to, or `null` if unknown. */
export function factionOfStage(id: string): Faction | null {
  return FACTION_BY_NODE.get(id) ?? null;
}

/** 0-based position of a node inside its own campaign, or `-1`. */
export function stageIndexOf(id: string): number {
  const faction = FACTION_BY_NODE.get(id);
  const node = NODE_BY_ID.get(id);
  if (!faction || !node) return -1;
  return CAMPAIGNS[faction].findIndex((candidate) => candidate.id === node.id);
}

/** Node following `id` inside the same campaign, or `undefined` at the end. */
export function nextCampaignNode(id: string): CampaignNode | undefined {
  const index = stageIndexOf(id);
  const faction = FACTION_BY_NODE.get(id);
  if (index < 0 || !faction) return undefined;
  return CAMPAIGNS[faction][index + 1];
}

/** First node of a faction's campaign. */
export function firstCampaignNode(faction: Faction): CampaignNode {
  const node = CAMPAIGNS[faction][0];
  if (!node) throw new Error(`campaign for ${faction} is empty`);
  return node;
}

/** Stage id for a 1-based node number, e.g. `stageIdFor('axis', 7) === 'axis-07'`. */
export function stageIdFor(faction: Faction, index: number): string | undefined {
  return CAMPAIGNS[faction][index - 1]?.id;
}
