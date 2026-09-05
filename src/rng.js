// Deterministic RNG utilities. Everything procedural in Overgrowth flows through
// here so a given seed produces an identical track for every player.

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Mulberry32 - small, fast, good enough distribution for level layout.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A stream of numbers unique to (seed, salt) - lets any node in the branch tree
// derive its own properties without walking the tree from the root.
export function streamFor(seed, salt) {
  return mulberry32((hashString(salt) ^ Math.imul(seed, 0x9e3779b1)) >>> 0);
}

export function todaySeedString(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dailySeed(date = new Date()) {
  return hashString('overgrowth/' + todaySeedString(date));
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}
