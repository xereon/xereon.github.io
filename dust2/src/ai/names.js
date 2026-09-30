// Bot names: short one-word handles in the spirit of CS bots (invented, not the Valve list).
const NAMES = [
  'Rook', 'Vex', 'Dusk', 'Moth', 'Pike', 'Grit', 'Nox', 'Tarn', 'Kilo', 'Sable',
  'Wren', 'Brisk', 'Cinder', 'Flint', 'Haze', 'Jolt', 'Koda', 'Lumen', 'Mako', 'Orrin',
  'Quill', 'Rune', 'Slate', 'Talon', 'Umber', 'Vale', 'Yarrow', 'Zinc', 'Bramble', 'Cobb',
  'Dace', 'Ember', 'Fitch', 'Gorse', 'Heron', 'Ibis', 'Jasper', 'Knox', 'Loam', 'Mercer',
  'Nash', 'Oakes', 'Pell', 'Quarry', 'Rasp', 'Sorrel', 'Tamsin', 'Ulf', 'Vesper', 'Wick',
];

const used = new Set();

/** Next unused name; falls back to numbered names when the pool runs dry. */
export function pickName(rnd = Math.random) {
  const free = NAMES.filter((n) => !used.has(n));
  let name;
  if (free.length) name = free[Math.floor(rnd() * free.length)];
  else { let i = 2; do name = `${NAMES[Math.floor(rnd() * NAMES.length)]}${i++}`; while (used.has(name)); }
  used.add(name);
  return name;
}

export function releaseName(name) { used.delete(name); }
export function reserveName(name) { if (name) used.add(name); }
