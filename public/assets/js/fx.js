// Shared visual effects: vines and drifting ornaments, cicada cursor, smooth scroll, menu, toast.
export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const touch = window.matchMedia('(hover: none), (pointer: coarse)').matches;

export const MOTH_SVG = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
  <ellipse cx="32" cy="15" rx="6" ry="3"/>
  <circle cx="24.5" cy="15" r="2.6"/><circle cx="39.5" cy="15" r="2.6"/>
  <path d="M25 18.5h14l2 5H23z"/>
  <ellipse cx="32" cy="28" rx="6.5" ry="5"/>
  <path d="M27.5 32c0 9 2 16 4.5 19 2.5-3 4.5-10 4.5-19"/>
  <path d="M34 21c9-5 22-5 27-1-3 6-15 9-25 6"/>
  <path d="M30 21c-9-5-22-5-27-1 3 6 15 9 25 6"/>
  <path d="M35 27c7 2 15 5 16 10-6 2-13-1-16-6M29 27c-7 2-15 5-16 10 6 2 13-1 16-6"/>
  <circle cx="53" cy="21.5" r="2.6"/><circle cx="11" cy="21.5" r="2.6"/>
  <path d="M40 22.5l14 0M24 22.5l-14 0" stroke-width=".8"/>
  <path d="M30 12.5c-2-4-4-5-6-5M34 12.5c2-4 4-5 6-5" stroke-width="1"/>
</svg>`;

/* ------------------------------------------------------------------ */
/* Organic layer: vines with cicada shells + drifting ornaments        */
/* ------------------------------------------------------------------ */
const IMG = new URL('../img/', import.meta.url).href;
const ORN = {
  vine: `${IMG}ornaments/vine.webp`, eye: `${IMG}ornaments/eye.webp`, amber: `${IMG}ornaments/amber.webp`,
  dew: `${IMG}ornaments/dew.webp`, antenna: `${IMG}ornaments/antenna.webp`,
  bloom1: `${IMG}swarm/bloom-2.webp`, bloom2: `${IMG}swarm/bloom-5.webp`, bloom3: `${IMG}swarm/bloom-8.webp`,
};
const VINE_STEM = 0.54; // x position of the stem where it leaves the image (fraction of width)

/* rot: 0 = hanging straight down from the anchor; positive leans left, PI points up. */
const LAYOUTS = {
  landing: [
    { x: 0.0, y: -0.03, rot: -0.42, h: 0.66, ph: 0.3, flip: 1 },
    { x: 1.0, y: 0.28, rot: 0.5, h: 0.6, ph: 1.7, flip: -1 },
    { x: 0.985, y: 1.04, rot: Math.PI - 0.45, h: 0.7, ph: 3.1, flip: 1 },
    { x: 0.01, y: 1.03, rot: Math.PI + 0.42, h: 0.52, ph: 4.4, flip: -1 },
  ],
  docs: [], // docs stay calm: no vines behind the text
  app: [
    { x: 0.0, y: -0.03, rot: -0.45, h: 0.55, ph: 0.4, flip: 1 },
    { x: 0.985, y: 1.04, rot: Math.PI - 0.45, h: 0.6, ph: 2.2, flip: -1 },
  ],
};

const loaded = {};
function loadOrn(key) {
  if (!loaded[key]) {
    const im = new Image();
    im.decoding = 'async';
    im.src = ORN[key];
    loaded[key] = im;
  }
  return loaded[key];
}
const ready = (im) => im && im.complete && im.naturalWidth > 0;

export function initOrganic(canvas, layoutName = 'landing') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const small = window.innerWidth < 760;
  let defs = LAYOUTS[layoutName] || LAYOUTS.landing;
  if (small) defs = defs.filter((_, i) => i === 0 || i === 2);
  const dpr = Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.5);
  let W = 0, H = 0, unit = 0;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  let scroll = 0, scrollT = 0;

  const vine = loadOrn('vine');
  const KINDS = ['eye', 'amber', 'dew', 'antenna', 'bloom1', 'eye', 'bloom2', 'dew', 'bloom3', 'amber'];
  const bits = Array.from({ length: layoutName === 'docs' ? (small ? 0 : 4) : layoutName === 'app' ? (small ? 0 : 5) : small ? 5 : 9 }, (_, i) => {
    const kind = KINDS[i % KINDS.length];
    return {
      kind, img: loadOrn(kind),
      // keep ornaments in the side margins so they never sit on top of the copy
      x: i % 2 ? (small ? 0.88 : 0.8) + Math.random() * (small ? 0.12 : 0.2) : Math.random() * (small ? 0.12 : 0.2),
      y: Math.random(),
      s: kind === 'antenna' ? (small ? 0.06 : 0.07) + Math.random() * 0.02 : kind.startsWith('bloom') ? 0.028 + Math.random() * 0.018 : 0.03 + Math.random() * 0.026,
      rot: (Math.random() - 0.5) * 1.2, vr: (Math.random() - 0.5) * 0.12,
      vx: 0, vy: (Math.random() < 0.5 ? -1 : 1) * (0.00004 + Math.random() * 0.00008),
      ph: Math.random() * 6, depth: 0.5 + Math.random() * 0.8,
    };
  });

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    unit = Math.min(Math.max(W, H), 1600);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawVine(d, t) {
    if (!ready(vine)) return;
    const h = d.h * Math.max(H, unit * 0.62) * (small ? 0.62 : 1);
    const w = (h * vine.naturalWidth) / vine.naturalHeight;
    const sway = Math.sin(t * 0.45 + d.ph) * 0.035 + Math.sin(t * 1.1 + d.ph * 2) * 0.012;
    const px = mouse.x * 14, py = mouse.y * 10 - scroll * 0.035;
    ctx.save();
    ctx.translate(d.x * W + px, d.y * H + py);
    ctx.rotate(d.rot + sway + mouse.x * 0.02);
    ctx.scale(d.flip, 1);
    ctx.drawImage(vine, -w * VINE_STEM, 0, w, h);
    ctx.restore();
  }

  function bit(b, t) {
    b.x += b.vx; b.y += b.vy;
    if (b.y < -0.08) b.y = 1.08; if (b.y > 1.08) b.y = -0.08;
    if (!ready(b.img)) return;
    const x = b.x * W + mouse.x * 30 * b.depth;
    const y0 = b.y * H + mouse.y * 24 * b.depth - scroll * 0.08 * b.depth;
    const y = ((y0 % H) + H) % H + Math.sin(t * 0.9 + b.ph) * 6;
    const w = b.s * unit, h = (w * b.img.naturalHeight) / b.img.naturalWidth;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(b.rot + t * b.vr + Math.sin(t * 0.7 + b.ph) * 0.08);
    ctx.globalAlpha = b.depth < 0.7 ? 0.75 : 1;
    ctx.drawImage(b.img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  let last = 0, running = true, t0 = performance.now();
  const frameGap = small ? 1000 / 24 : 1000 / 40;
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (now - last < frameGap) return;
    last = now;
    const t = reduced ? 0 : (now - t0) / 1000;
    mouse.x += (mouse.tx - mouse.x) * 0.06; mouse.y += (mouse.ty - mouse.y) * 0.06;
    scroll += (scrollT - scroll) * 0.12;
    ctx.clearRect(0, 0, W, H);
    defs.forEach((d) => drawVine(d, t));
    bits.forEach((b) => bit(b, t));
  }

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (e) => { mouse.tx = e.clientX / W - 0.5; mouse.ty = e.clientY / H - 0.5; }, { passive: true });
  window.addEventListener('scroll', () => { scrollT = window.scrollY; }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(frame);
  });
  if (reduced) {
    // draw once the images arrive, then stay still
    const once = () => { frame(performance.now() + 1000); };
    [vine, ...bits.map((b) => b.img)].forEach((im) => im.addEventListener('load', once, { once: true }));
    frame(performance.now()); running = false;
    return;
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Cursor eye                                                         */
/* ------------------------------------------------------------------ */
export function initEye() {
  if (touch) return;
  const eye = document.createElement('div');
  eye.className = 'eye is-hidden';
  document.body.appendChild(eye);
  document.documentElement.classList.add('has-eye');
  let x = innerWidth / 2, y = innerHeight / 2, tx = x, ty = y;
  addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; eye.classList.remove('is-hidden'); }, { passive: true });
  document.addEventListener('pointerleave', () => eye.classList.add('is-hidden'));
  document.addEventListener('pointerover', (e) => {
    const hit = e.target.closest('a, button, .chip, [data-hover], input, textarea');
    eye.classList.toggle('is-hover', !!hit && !e.target.closest('input, textarea'));
  });
  (function loop() {
    x += (tx - x) * 0.16; y += (ty - y) * 0.16;
    eye.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    requestAnimationFrame(loop);
  })();
}

/* ------------------------------------------------------------------ */
/* Smooth scroll (Lenis) wired into GSAP ScrollTrigger                 */
/* ------------------------------------------------------------------ */
export function initSmoothScroll() {
  if (reduced || !window.Lenis) return null;
  const lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true });
  if (window.gsap && window.ScrollTrigger) {
    lenis.on('scroll', window.ScrollTrigger.update);
    window.gsap.ticker.add((time) => lenis.raf(time * 1000));
    window.gsap.ticker.lagSmoothing(0);
  } else {
    const raf = (time) => { lenis.raf(time); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
  }
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      closeMenu();
      lenis.scrollTo(el, { offset: 0, duration: 1.6 });
    });
  });
  return lenis;
}

/* ------------------------------------------------------------------ */
/* Menu, emblem, toast                                                */
/* ------------------------------------------------------------------ */
let menuEl = null;
function closeMenu() { menuEl?.classList.remove('open'); document.querySelector('[data-menu-open]')?.setAttribute('aria-expanded', 'false'); }
export function initMenu() {
  menuEl = document.querySelector('.menu');
  const open = document.querySelector('[data-menu-open]');
  if (!menuEl || !open) return;
  open.addEventListener('click', () => { menuEl.classList.add('open'); open.setAttribute('aria-expanded', 'true'); menuEl.querySelector('a')?.focus(); });
  menuEl.querySelector('[data-menu-close]')?.addEventListener('click', closeMenu);
  menuEl.querySelectorAll('nav a').forEach((a, i) => { a.style.transitionDelay = `${0.05 + i * 0.05}s`; a.addEventListener('click', closeMenu); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
}

const LOGO_SRC = new URL('../img/brand/logo-mark.webp', import.meta.url).href;
const TOKEN_SRC = new URL('../img/brand/token.webp', import.meta.url).href;
export function mountEmblems() {
  // header/menu: line-art logo mark; footer: the $DMOTH coin
  document.querySelectorAll('[data-emblem]').forEach((el) => {
    const big = el.classList.contains('big-emblem');
    el.innerHTML = `<img src="${big ? TOKEN_SRC : LOGO_SRC}" alt="" draggable="false" decoding="async">`;
  });
}

let toastTimer;
export function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

export function initCommon(layout) {
  if (reduced) document.documentElement.classList.add('reduced');
  mountEmblems();
  initOrganic(document.getElementById('organic'), layout);
  initEye();
  initMenu();
  return initSmoothScroll();
}
