/* Duskmoth's main character: the cicada-moth.
   assets/img/cicada-hero.webp is the master; assets/img/species/<name>.webp are the 16
   photographed specimens (plus <name>-sm.webp for the swarm). */

export const GENUS = 'Cicadamotha';
export const HERO_SRC = new URL('../img/cicada-hero.webp', import.meta.url).href;
export const HEAD_SRC = new URL('../img/cicada-head.png', import.meta.url).href;
export const AVATAR_SRC = new URL('../img/avatar.webp', import.meta.url).href;

/* hue: degrees, sat: saturation multiplier, lum: brightness multiplier */
export const SPECIES = [
  { name: 'vesperis', hue: 0, sat: 1, lum: 1 },
  { name: 'jadeola', hue: 125, sat: 1.05, lum: 1 },
  { name: 'vitrea', hue: 0, sat: 0.12, lum: 1.12 },
  { name: 'rosacea', hue: 315, sat: 1.1, lum: 1.05 },
  { name: 'violacea', hue: 240, sat: 1.15, lum: 0.95 },
  { name: 'ignea', hue: -14, sat: 1.45, lum: 1 },
  { name: 'limonia', hue: 55, sat: 1.2, lum: 1.08 },
  { name: 'eburnea', hue: 0, sat: 0.3, lum: 1.3 },
  { name: 'cyanea', hue: 190, sat: 1.2, lum: 0.78 },
  { name: 'crocea', hue: 16, sat: 1.4, lum: 1.18 },
  { name: 'pavonia', hue: 155, sat: 1.25, lum: 0.92 },
  { name: 'pardalis', hue: 28, sat: 1.05, lum: 1.08 },
  { name: 'cinerea', hue: 0, sat: 0, lum: 0.98 },
  { name: 'aurora', hue: 330, sat: 0.85, lum: 1.18 },
  { name: 'umbra', hue: 0, sat: 0.75, lum: 0.62 },
  { name: 'prasina', hue: 90, sat: 1.1, lum: 1 },
];

const SPECIES_DIR = new URL('../img/species/', import.meta.url).href;
const imgCache = new Map();
function loadImg(src) {
  if (!imgCache.has(src)) {
    imgCache.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    }));
  }
  return imgCache.get(src);
}
/** Photographed specimen for species i. small = swarm-sized version. */
export function loadSpecies(i, small = false) {
  const sp = SPECIES[i % SPECIES.length];
  return loadImg(`${SPECIES_DIR}${sp.name}${small ? '-sm' : ''}.webp`);
}

let heroPromise = null;
/** Loads the master image once. */
export function loadCicada() {
  if (!heroPromise) {
    heroPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = HERO_SRC;
    });
  }
  return heroPromise;
}

/* Colour matrix = brightness * saturate * hueRotate (same maths as CSS filters). */
function matrix({ hue, sat, lum }) {
  const a = (hue * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const h = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const S = [
    0.213 + 0.787 * sat, 0.715 - 0.715 * sat, 0.072 - 0.072 * sat,
    0.213 - 0.213 * sat, 0.715 + 0.285 * sat, 0.072 - 0.072 * sat,
    0.213 - 0.213 * sat, 0.715 - 0.715 * sat, 0.072 + 0.928 * sat,
  ];
  const m = new Array(9);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
    m[r * 3 + k] = lum * (S[r * 3] * h[k] + S[r * 3 + 1] * h[3 + k] + S[r * 3 + 2] * h[6 + k]);
  }
  return m;
}

const cache = new Map();
/**
 * Returns a canvas with species `i` drawn at `width` px wide (height keeps the aspect ratio).
 * Pass { silhouette: 'rgba(...)' } for a flat silhouette instead.
 */
export function variant(img, i, width, opts = {}) {
  const key = `${i}|${width}|${opts.silhouette || ''}`;
  if (cache.has(key)) return cache.get(key);
  const w = Math.max(8, Math.round(width));
  const h = Math.round((w * img.naturalHeight) / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  if (opts.silhouette) {
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = opts.silhouette; g.fillRect(0, 0, w, h);
  } else {
    const sp = SPECIES[i % SPECIES.length];
    if (sp.hue || sp.sat !== 1 || sp.lum !== 1) {
      const m = matrix(sp);
      const d = g.getImageData(0, 0, w, h), p = d.data;
      for (let k = 0; k < p.length; k += 4) {
        if (!p[k + 3]) continue;
        const r = p[k], gg = p[k + 1], b = p[k + 2];
        p[k] = m[0] * r + m[1] * gg + m[2] * b;
        p[k + 1] = m[3] * r + m[4] * gg + m[5] * b;
        p[k + 2] = m[6] * r + m[7] * gg + m[8] * b;
      }
      g.putImageData(d, 0, 0);
    }
  }
  cache.set(key, c);
  return c;
}

export function speciesLabel(i, seed) {
  const sp = SPECIES[i % SPECIES.length];
  return { latin: `${GENUS} ${sp.name}`, no: String(1000 + ((seed * 7919) % 9000)).padStart(4, '0') };
}
