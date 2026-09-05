// Lifetime stats, cosmetic unlocks, and per-seed bests. Everything lives in
// localStorage - the core loop has no backend dependency.

const KEY = 'overgrowth.v1';

export const BIOMES = [
  { id: 'verdant', name: 'Verdant Hollow', unlockAt: 0,     material: 'bark',
    sky: [0x0c2a1e, 0x03090a], fog: 0x071a14, key: 0xffeecb, rim: 0x5cffc0, risk: 0xffa24a, mote: 0xffe9a8, moteName: 'pollen' },
  { id: 'ember',   name: 'Emberfall',      unlockAt: 1200,  material: 'bark',
    sky: [0x2c1409, 0x0b0403], fog: 0x180804, key: 0xffc98a, rim: 0xff7a3a, risk: 0xff3b6b, mote: 0xff8a3d, moteName: 'embers' },
  { id: 'abyss',   name: 'Abyssal Reach',  unlockAt: 4500,  material: 'scale',
    sky: [0x061c2c, 0x01060c], fog: 0x04121f, key: 0xbfe6ff, rim: 0x36c2ff, risk: 0xff4bd8, mote: 0x9fe8ff, moteName: 'plankton' },
  { id: 'crystal', name: 'Prism Bloom',    unlockAt: 15000, material: 'crystal',
    sky: [0x1a0f33, 0x060310], fog: 0x120a24, key: 0xe8dcff, rim: 0xc48cff, risk: 0xff5ea8, mote: 0xe4c8ff, moteName: 'shards' },
];

export const SKINS = [
  { id: 'moss',    name: 'Mossvine',    unlockAt: 0,     base: 0x3f7d3a, deep: 0x123a1c, glow: 0x9dff6a, sss: 0x74d84a },
  { id: 'thorn',   name: 'Thornwood',   unlockAt: 400,   base: 0x6b4a2a, deep: 0x2a1a0e, glow: 0xffb45e, sss: 0xd08a3c },
  { id: 'coral',   name: 'Coralbloom',  unlockAt: 2000,  base: 0xd44f7a, deep: 0x4a1030, glow: 0xff9ec4, sss: 0xff6a9a },
  { id: 'ghost',   name: 'Palefrond',   unlockAt: 6000,  base: 0xc9d8e6, deep: 0x39485c, glow: 0xeaf6ff, sss: 0x9fc4e8 },
  { id: 'magma',   name: 'Cinderroot',  unlockAt: 20000, base: 0x2a1410, deep: 0x0d0605, glow: 0xff5a1e, sss: 0xff8c3a },
];

const DEFAULT_STATE = {
  lifetime: 0,
  best: 0,
  runs: 0,
  dailyBest: {},   // seedString -> best length
  routes: {},      // seedString -> recorded ghost route
  bestRoute: null, // ghost route of the all-time best run
  skin: 'moss',
  biome: 'verdant',
  seen: [],        // ids already announced as unlocked
  muted: false,
};

export class Progression {
  constructor() {
    this.state = { ...DEFAULT_STATE };
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch (_) {}
    // A cosmetic saved before its unlock threshold (or from an older build)
    // must not leave the player on something they cannot legitimately equip.
    if (!this.isUnlocked(SKINS, this.state.skin)) this.state.skin = 'moss';
    if (!this.isUnlocked(BIOMES, this.state.biome)) this.state.biome = 'verdant';
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch (_) {}
  }

  isUnlocked(list, id) {
    const item = list.find((x) => x.id === id);
    return !!item && this.state.lifetime >= item.unlockAt;
  }

  unlockedOf(list) { return list.filter((x) => this.state.lifetime >= x.unlockAt); }
  nextLocked(list) { return list.find((x) => this.state.lifetime < x.unlockAt) || null; }

  get skin() { return SKINS.find((s) => s.id === this.state.skin) || SKINS[0]; }
  get biome() { return BIOMES.find((b) => b.id === this.state.biome) || BIOMES[0]; }

  setSkin(id) { if (this.isUnlocked(SKINS, id)) { this.state.skin = id; this.save(); } }
  setBiome(id) { if (this.isUnlocked(BIOMES, id)) { this.state.biome = id; this.save(); } }

  bestForSeed(seedString) { return this.state.dailyBest[seedString] || 0; }
  routeForSeed(seedString) { return this.state.routes[seedString] || null; }

  // Returns what changed, so the results screen can celebrate the right things.
  // `credit` is what counts toward lifetime growth. It differs from peakLength
  // after a rewarded revive: the run is banked once when it first ends, and a
  // revived continuation only credits the growth beyond what was already banked.
  recordRun({ peakLength, seedString, route, credit = peakLength, countRun = true }) {
    const before = this.state.lifetime;
    this.state.lifetime = Math.round(before + Math.max(0, credit));
    if (countRun) this.state.runs += 1;

    const newPersonalBest = peakLength > this.state.best;
    if (newPersonalBest) {
      this.state.best = Math.round(peakLength);
      if (route) this.state.bestRoute = route;
    }

    const newSeedBest = peakLength > this.bestForSeed(seedString);
    if (newSeedBest) {
      this.state.dailyBest[seedString] = Math.round(peakLength);
      if (route) this.state.routes[seedString] = route;
    }
    this._pruneRoutes();

    const unlocked = [];
    for (const list of [SKINS, BIOMES]) {
      for (const item of list) {
        if (item.unlockAt > before && item.unlockAt <= this.state.lifetime && !this.state.seen.includes(item.id)) {
          this.state.seen.push(item.id);
          unlocked.push(item);
        }
      }
    }

    this.save();
    return { newPersonalBest, newSeedBest, unlocked };
  }

  // Ghost routes are the only unbounded thing we store; keep the last 12 days.
  _pruneRoutes() {
    const keys = Object.keys(this.state.routes).sort();
    while (keys.length > 12) delete this.state.routes[keys.shift()];
  }
}
