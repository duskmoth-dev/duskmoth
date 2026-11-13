import { initCommon, reduced, touch } from './fx.js';
import * as api from './api.js?mode=real';
import { SPECIES, loadCicada, loadSpecies, variant, speciesLabel } from './cicada.js';

const gsap = window.gsap;
const ST = window.ScrollTrigger;
if (gsap && ST) gsap.registerPlugin(ST);

initCommon('landing');

/* ---------------- liquid hero filter ---------------- */
(function liquid() {
  const n = document.getElementById('liquid-noise');
  if (!n || reduced) return;
  let t = 0;
  (function loop() {
    t += 0.004;
    n.setAttribute('baseFrequency', `${0.008 + Math.sin(t) * 0.002} ${0.02 + Math.cos(t * 0.8) * 0.006}`);
    requestAnimationFrame(loop);
  })();
})();

/* ---------------- hero ---------------- */
function splitChars(el) {
  el.querySelectorAll('.w').forEach((w) => {
    const text = w.textContent;
    w.textContent = '';
    [...text].forEach((c) => { const s = document.createElement('span'); s.className = 'ch'; s.textContent = c; w.appendChild(s); });
  });
  return el.querySelectorAll('.ch');
}
const hero = document.querySelector('[data-hero]');
const chars = hero ? splitChars(hero) : [];
if (gsap && !reduced) {
  // intro: letters arrive blurred and settle perfectly sharp (filter cleared afterwards)
  gsap.fromTo(chars, { yPercent: 70, opacity: 0, filter: 'blur(14px)', rotateX: -70 },
    { yPercent: 0, opacity: 1, filter: 'blur(0px)', rotateX: 0, duration: 1.6, ease: 'expo.out', stagger: 0.06, delay: 0.15, clearProps: 'filter' });
  gsap.from('[data-hero-sub]', { y: 20, opacity: 0, duration: 1.2, ease: 'expo.out', delay: 0.9, stagger: 0.12 });
  gsap.to('.hero-inner', {
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
    yPercent: -30, scale: 0.86, opacity: 0, ease: 'none',
  });
  chars.forEach((c, i) => {
    // scroll-away: sharp at the top, blurs only as the hero leaves (explicit start values, no inherited blur)
    gsap.fromTo(c, { y: 0, rotate: 0, filter: 'blur(0px)' }, {
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
      y: (i % 2 ? -1 : 1) * (40 + i * 6), rotate: (i % 3 - 1) * 8, filter: 'blur(6px)', ease: 'none', immediateRender: false,
    });
  });
}

/* ---------------- specimen flipbook: a new species every instant ---------------- */
(function specimen() {
  const stage = document.querySelector('[data-specimen]');
  if (!stage) return;
  const canvas = stage.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const label = document.querySelector('[data-spec-label]');
  const hint = document.querySelector('[data-spec-hint]');
  let S = 0, idx = 0, seed = 1, caught = false, visible = false, last = 0, t0 = performance.now(), img = null, dprS = 1;
  const imgs = []; // photographed specimens, filled in as they load
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    S = stage.clientWidth;
    dprS = dpr;
    canvas.width = S * dpr; canvas.height = S * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (img) draw(1, false);
  }
  function draw(open = 1, jitter = true) {
    const v = imgs[idx];
    if (!v) return;
    ctx.clearRect(0, 0, S, S);
    const w = S * 0.94;
    const h = (w * v.height) / v.width;
    ctx.save();
    ctx.translate(S / 2, S * 0.5);
    if (jitter) { ctx.rotate((Math.random() - 0.5) * 0.03); const k = 0.97 + Math.random() * 0.05; ctx.scale(k, k); }
    ctx.scale(open, 1); // wings "breathe" by narrowing the spread
    ctx.drawImage(v, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  function setLabel() {
    const l = speciesLabel(idx, seed);
    label.innerHTML = `Nº ${l.no} · <i>${l.latin}</i>`;
  }
  function next() {
    const ready = imgs.map((v, k) => (v ? k : -1)).filter((k) => k >= 0 && k !== idx);
    if (!ready.length) return;
    const n = ready[(Math.random() * ready.length) | 0];
    idx = n; seed = 1 + ((Math.random() * 999) | 0);
    draw(); setLabel();
  }
  function loop(now) {
    requestAnimationFrame(loop);
    if (!visible) return;
    if (caught) {
      const t = (now - t0) / 1000;
      draw(0.9 + 0.1 * Math.abs(Math.sin(t * 2.4)), false); // the caught one breathes its wings
      return;
    }
    if (now - last > 125) { last = now; next(); } // ~8 species per second, like a flipbook
  }
  stage.addEventListener('click', () => {
    caught = !caught;
    stage.classList.toggle('caught', caught);
    hint.textContent = caught ? 'Caught one. Still not you. Tap to release' : 'Tap to catch one';
  });
  resize(); addEventListener('resize', resize);
  SPECIES.forEach((_, k) => loadSpecies(k).then((im) => { imgs[k] = im; if (!img) { img = im; idx = k; draw(1, false); setLabel(); } }).catch(() => {}));
  loadSpecies(15).then(() => {
    if (reduced) { visible = true; caught = true; draw(1, false); setLabel(); return; }
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { threshold: 0.05 }).observe(stage);
    next();
    requestAnimationFrame(loop);
  });
})();

/* ---------------- generic reveals ---------------- */
if (gsap && ST && !reduced) {
  document.querySelectorAll('[data-reveal]').forEach((el) => {
    gsap.to(el, { scrollTrigger: { trigger: el, start: 'top 88%' }, opacity: 1, y: 0, duration: 1.2, ease: 'expo.out' });
  });
  document.querySelectorAll('[data-lines]').forEach((el) => {
    gsap.from(el.querySelectorAll('.line > span'), {
      scrollTrigger: { trigger: el, start: 'top 85%' }, yPercent: 110, rotate: 3, duration: 1.3, ease: 'expo.out', stagger: 0.1,
    });
  });
} else {
  document.querySelectorAll('[data-reveal]').forEach((el) => { el.style.opacity = 1; el.style.transform = 'none'; });
}

/* ---------------- swarm burst ---------------- */
(function swarm() {
  const canvas = document.getElementById('swarm');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const card = document.querySelector('[data-swarm-card]');
  const COLORS = [
    ['#ffd36b', '#e98a1c'], ['#ff8aa8', '#c23b62'], ['#c9a2ff', '#6a3dc2'], ['#ff6a4a', '#a9200f'],
    ['#fff3d6', '#d9b98a'], ['#b8f07a', '#4f8a22'], ['#ff9ed2', '#b2368a'], ['#ffe14d', '#c79400'],
  ];
  const sprites = [];
  function sprite(kind, [c1, c2]) {
    const s = document.createElement('canvas'); s.width = s.height = 96;
    const g = s.getContext('2d'); g.translate(48, 48);
    const grad = (x, y, r) => { const gr = g.createRadialGradient(x - r * .3, y - r * .3, r * .1, x, y, r); gr.addColorStop(0, '#fff'); gr.addColorStop(.25, c1); gr.addColorStop(1, c2); return gr; };
    if (kind === 'moth') {
      [[-1, 1], [1, 1]].forEach(([sx]) => {
        g.fillStyle = grad(sx * 18, -10, 26); g.beginPath(); g.ellipse(sx * 18, -10, 22, 16, sx * -0.5, 0, 7); g.fill();
        g.fillStyle = grad(sx * 13, 14, 16); g.beginPath(); g.ellipse(sx * 13, 14, 14, 11, sx * 0.6, 0, 7); g.fill();
        g.fillStyle = '#1a0a05'; g.beginPath(); g.arc(sx * 19, -11, 6, 0, 7); g.fill();
        g.fillStyle = c1; g.beginPath(); g.arc(sx * 19, -11, 3, 0, 7); g.fill();
      });
      g.fillStyle = '#2a1608'; g.beginPath(); g.ellipse(0, 2, 3.5, 16, 0, 0, 7); g.fill();
    } else {
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        g.fillStyle = grad(Math.cos(a) * 16, Math.sin(a) * 16, 18);
        g.beginPath(); g.ellipse(Math.cos(a) * 16, Math.sin(a) * 16, 15, 10, a, 0, 7); g.fill();
      }
      g.fillStyle = '#3b1f05'; g.beginPath(); g.arc(0, 0, 8, 0, 7); g.fill();
      g.fillStyle = '#ffcf3a'; g.beginPath(); g.arc(-2, -2, 3, 0, 7); g.fill();
    }
    return s;
  }
  COLORS.forEach((c) => sprites.push(sprite('bloom', c)));
  // swap in photographic cicada-moths (every species) once the master image is ready
  // photographed sprites: flowers, cicada-moths in flight, and a few pinned specimens
  const SW = new URL('../img/swarm/', import.meta.url).href;
  const FLY = ['fly-1', 'fly-2', 'fly-3', 'fly-4', 'fly-5', 'fly-sheet-1', 'fly-sheet-2'];
  const load = (src) => new Promise((res, rej) => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = rej; im.src = src; });
  for (let i = 0; i < 8; i++) load(`${SW}bloom-${i + 1}.webp`).then((im) => {
    im.big = 1.35;
    parts.forEach((q, k) => { if (k % 3 === 2 && ((k / 3) | 0) % 8 === i) q.sp = im; });
  }).catch(() => {});
  FLY.forEach((name, i) => load(`${SW}${name}.webp`).then((im) => {
    im.big = 2.4; im.fly = true;
    parts.forEach((q, k) => { if (k % 3 !== 2 && k % 4 !== 0 && k % FLY.length === i) q.sp = im; });
  }).catch(() => {}));
  SPECIES.forEach((_, i) => loadSpecies(i, true).then((im) => {
    im.big = 2.0;
    parts.forEach((q, k) => { if (k % 3 !== 2 && k % 4 === 0 && ((k / 4) | 0) % SPECIES.length === i) q.sp = im; });
  }).catch(() => {}));

  const N = window.innerWidth < 760 ? 120 : 240;
  const parts = Array.from({ length: N }, () => ({
    a: Math.random() * Math.PI * 2, d: 0.25 + Math.pow(Math.random(), 0.7) * 1.1, s: 0.25 + Math.random() * 0.9,
    rot: Math.random() * 6, vr: (Math.random() - 0.5) * 2, sp: sprites[(Math.random() * sprites.length) | 0],
    z: Math.random(), wob: Math.random() * 6,
  })).sort((a, b) => a.z - b.z);

  let W, H, p = reduced ? 0.6 : 0, visible = false;
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  function resize() { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  resize(); addEventListener('resize', resize);

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const R = Math.hypot(W, H) * 0.55;
    const burst = Math.min(1, p / 0.55);
    const e = 1 - Math.pow(1 - burst, 3);
    const out = Math.max(0, (p - 0.75) / 0.25);
    for (const q of parts) {
      const dist = (0.04 + e * q.d + out * 0.8 * q.d) * R;
      const x = W / 2 + Math.cos(q.a) * dist + Math.sin(t * 0.8 + q.wob) * 6 * e;
      const y = H / 2 + Math.sin(q.a) * dist * 0.72 + Math.cos(t * 0.7 + q.wob) * 6 * e;
      const size = (14 + q.s * 42) * (0.35 + 0.65 * e) * (0.6 + q.z * 0.7) * (q.sp.big || 1);
      const blur = q.z < 0.18 && e > 0.3;
      ctx.save();
      ctx.globalAlpha = Math.min(1, 0.15 + e * 1.2) * (1 - out * 0.6) * (blur ? 0.55 : 1);
      ctx.translate(x, y);
      if (q.sp.fly) {
        // in flight: stay upright, face outward, wings beating
        ctx.rotate(Math.sin(t * 1.3 + q.wob) * 0.12 + (q.rot - 3) * 0.06);
        ctx.scale(Math.cos(q.a) < 0 ? 1 : -1, 0.86 + 0.14 * Math.abs(Math.sin(t * 9 + q.wob * 3)));
      } else ctx.rotate(q.rot + t * q.vr * 0.2 + e * q.vr);
      if (blur) ctx.filter = 'blur(3px)';
      const sh = (size * q.sp.height) / q.sp.width;
      ctx.drawImage(q.sp, -size / 2, -sh / 2, size, sh);
      ctx.restore();
    }
  }
  let t0 = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    if (!visible && !reduced) return;
    draw(reduced ? 0 : (now - t0) / 1000);
  })(t0);

  if (gsap && ST && !reduced) {
    ST.create({
      trigger: '.swarm', start: 'top top', end: 'bottom bottom', scrub: true,
      onUpdate: (self) => { p = self.progress; },
      onToggle: (self) => { visible = self.isActive; },
    });
    ST.create({ trigger: '.swarm', start: 'top bottom', end: 'bottom top', onToggle: (s) => { visible = s.isActive; } });
    gsap.to(card, { scrollTrigger: { trigger: '.swarm', start: '20% top', end: '45% top', scrub: true }, opacity: 1, y: 0, scale: 1, ease: 'none' });
  } else {
    card.style.opacity = 1; card.style.transform = 'none'; visible = true; draw(0);
  }
})();

/* ---------------- dusk field card ---------------- */
(function field() {
  if (!document.getElementById('field')) return;
  if (gsap && ST && !reduced) {
    gsap.fromTo('[data-field]', { yPercent: 18, scale: 0.9, borderRadius: 60 }, { scrollTrigger: { trigger: '.field', start: 'top bottom', end: 'center center', scrub: true }, yPercent: 0, scale: 1, borderRadius: 22, ease: 'none' });
    gsap.to('#field', { scrollTrigger: { trigger: '.field', start: 'top bottom', end: 'bottom top', scrub: true }, scale: 1.15, ease: 'none' });
  }
})();

/* ---------------- services triad + rails ---------------- */
(function triad() {
  const spans = document.querySelectorAll('[data-triad] span');
  if (!spans.length) return;
  let i = 0;
  setInterval(() => { spans.forEach((s, k) => s.classList.toggle('on', k === i)); i = (i + 1) % spans.length; }, 1400);
})();
if (gsap && ST && !reduced) {
  gsap.fromTo('[data-names]', { yPercent: 25 }, { scrollTrigger: { trigger: '.rails', start: 'top bottom', end: 'bottom top', scrub: true }, yPercent: -25, ease: 'none' });
  gsap.utils.toArray('[data-names] p').forEach((p) => {
    gsap.fromTo(p, { opacity: 0.15 }, { scrollTrigger: { trigger: p, start: 'top 80%', end: 'top 45%', scrub: true }, opacity: 1, ease: 'none' });
  });
}

/* ---------------- postcards ---------------- */
(function postcards() {
  const stack = document.querySelector('[data-stack]');
  if (!stack) return;
  const layout = () => {
    const cards = [...stack.querySelectorAll('.postcard')];
    const n = cards.length;
    cards.forEach((c, i) => {
      const k = n - 1 - i; // 0 = top
      c.style.zIndex = String(10 + i);
      c.style.transition = 'transform .8s cubic-bezier(.2,.7,.1,1)';
      c.style.transform = `translate(${k * 18}px, ${-k * 22}px) rotate(${[-4, 6, -9][k] ?? 0}deg)`;
    });
  };
  layout();
  stack.addEventListener('click', () => {
    const top = stack.lastElementChild;
    top.style.transform += ' translateY(120%) rotate(18deg)';
    setTimeout(() => { stack.prepend(top); layout(); }, 380);
  });
  if (gsap && ST && !reduced) {
    gsap.from(stack, { scrollTrigger: { trigger: '.cards', start: 'top 80%', end: 'center center', scrub: true }, rotate: -14, yPercent: 30, scale: 0.85, ease: 'none' });
  }
})();

/* ---------------- principles carousel ---------------- */
const OBJ_DIR = new URL('../img/principles/', import.meta.url).href;
const VALUES = [
  { key: 'shell', title: 'Non-custodial', script: 'The empty shell', text: 'Duskmoth never holds your keys or your funds. Every move is signed in your own wallet, and we keep nothing behind.' },
  { key: 'slide', title: 'Compliance first', script: 'Under glass', text: 'Both sides of every transfer are screened. Sanctioned and stolen funds are turned away before anything moves.' },
  { key: 'flame', title: 'The AI never signs', script: 'Close, never touching', text: 'The model only translates what you mean into a preview. You read it, you decide, your wallet signs.' },
  { key: 'cocoon', title: 'Zero logs', script: 'Nothing kept', text: 'We do not store who sent what to whom. A privacy tool that keeps records is a leak.' },
  { key: 'wing', title: 'Open rails', script: 'Nothing hidden', text: 'Built on audited, public protocols on Solana, so anyone can see straight through how it works.' },
];
(function orbit() {
  const wrap = document.querySelector('[data-orbit]');
  const dots = document.querySelector('[data-dots]');
  if (!wrap) return;
  const els = VALUES.map((v, i) => {
    const d = document.createElement('div'); d.className = 'obj'; d.innerHTML = `<div class="bob"><img src="${OBJ_DIR}${v.key}.webp" alt="" draggable="false" loading="lazy" decoding="async"></div>`;
    d.style.setProperty('--d', `${i * 0.4}s`); d.querySelector('.bob').style.animationDelay = `${i * -0.7}s`;
    d.addEventListener('click', () => go(i)); wrap.appendChild(d);
    const b = document.createElement('button'); b.setAttribute('role', 'tab'); b.setAttribute('aria-label', v.title); b.addEventListener('click', () => go(i)); dots.appendChild(b);
    return d;
  });
  let cur = 0, timer;
  const title = document.querySelector('[data-value-title]'), script = document.querySelector('[data-value-script]'), text = document.querySelector('[data-value-text]');
  function go(i) {
    cur = (i + VALUES.length) % VALUES.length;
    const gap = Math.min(170, innerWidth / 4.2);
    els.forEach((el, k) => {
      let off = k - cur;
      if (off > 2) off -= VALUES.length; if (off < -2) off += VALUES.length;
      const a = Math.abs(off);
      el.style.transform = `translate(${off * gap}px, ${a * 22}px) scale(${1 - a * 0.18})`;
      el.style.opacity = a > 2 ? 0 : 1 - a * 0.25;
      el.style.filter = a ? `blur(${a * 1.2}px)` : 'none';
      el.style.zIndex = String(10 - a);
    });
    [...dots.children].forEach((b, k) => { b.classList.toggle('on', k === cur); b.setAttribute('aria-selected', k === cur); });
    const v = VALUES[cur];
    title.textContent = v.title; script.textContent = v.script; text.textContent = v.text;
    if (gsap) gsap.fromTo([title, script, text], { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.06, ease: 'expo.out' });
    clearInterval(timer); if (!reduced) timer = setInterval(() => go(cur + 1), 4200);
  }
  let sx = null;
  wrap.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  addEventListener('pointerup', (e) => { if (sx === null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) go(cur + (dx < 0 ? 1 : -1)); });
  addEventListener('resize', () => go(cur));
  go(0);
})();

/* ---------------- field guide: a book of features and use cases ---------------- */
const IMG_DIR = new URL('../img/', import.meta.url).href;
const spec = (rows) => `<dl class="spec">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
const PAGES = [
  { cls: 'cover', html: `<img class="cover-art" src="${IMG_DIR}cicada-hero.webp" alt="">
      <p class="kicker">Duskmoth</p><h3 class="cover-title">The Field Guide</h3>
      <p class="script">to sending in a whisper</p><p class="hint">Tap to open</p>` },
  { html: `<p class="kicker">Contents</p><h3>What lives inside</h3>
      <ol class="toc">
        <li><span>Private send</span><i>I</i></li><li><span>Use case: paying people</span><i>II</i></li>
        <li><span>Shield now, send later</span><i>III</i></li><li><span>Use case: gifts and rent</span><i>IV</i></li>
        <li><span>Talk in your own words</span><i>V</i></li><li><span>Screened both ways</span><i>VI</i></li>
        <li><span>Your privacy score</span><i>VII</i></li><li><span>Use case: a doxxed wallet</span><i>VIII</i></li>
        <li><span>Share your grade</span><i>IX</i></li><li><span>What we never do</span><i>X</i></li>
      </ol>` },
  { img: 'principles/shell.webp', html: `<p class="kicker">I · Feature</p><h3>Private send</h3>
      <p>Type one sentence, like <q>send 2 SOL to Mira, privately</q>. Duskmoth turns it into a preview you can read before anything moves.</p>
      <p>When you sign, your funds go into a shielded pool, a zero-knowledge proof is made in your browser, and a relayer pays your recipient from the pool. On the explorer, nothing links the two wallets.</p>
      ${spec([['Tokens', 'SOL and USDC'], ['Pool fee', '0.35% on the way out'], ['Relay cost', 'about 0.006 SOL'], ['Limit per send', '5 SOL or 500 USDC']])}` },
  { usecase: true, img: 'swarm/fly-2.webp', html: `<p class="kicker">II · Use case</p><p class="script big-script">Paying people</p>
      <p>Nadia runs a small studio and pays four freelancers every month from her main wallet. Every payment shows them, and everyone else, her whole balance and who else she pays.</p>
      <p>With Duskmoth she types <q>send 300 USDC to Arif</q> for each one. The freelancers get paid on time. Her balance and her client list stay hers.</p>
      <p class="note">Works the same for DAOs paying contributors and teams paying contractors.</p>` },
  { img: 'principles/cocoon.webp', html: `<p class="kicker">III · Feature</p><h3>Shield now, send later</h3>
      <p>Say <q>shield 2 SOL</q> and your funds wait inside your private balance. Send from it hours or days later.</p>
      <p>Time is the strongest disguise: the longer the gap between going in and coming out, the more deposits yours blends into. The preview shows a privacy strength meter so you can see the difference.</p>
      ${spec([['Best practice', 'Round amounts'], ['Even better', 'Wait between steps'], ['Your keys', 'Never leave your wallet']])}` },
  { usecase: true, img: 'swarm/bloom-1.webp', html: `<p class="kicker">IV · Use case</p><p class="script big-script">Gifts and rent</p>
      <p>Budi sends money home every month and pays rent in USDC. Anyone who learns one of his addresses can follow every transfer and work out his salary.</p>
      <p>He shields his pay when it lands, then sends from the private balance: <q>send 100 USDC to Mom later</q>. His family gets the money. His landlord never sees his savings.</p>` },
  { img: 'principles/flame.webp', html: `<p class="kicker">V · Feature</p><h3>Talk in your own words</h3>
      <p>The assistant understands plain English, the way you would text a friend. It reads what you mean and proposes a transaction. It never signs.</p>
      <p>Before you see the preview, the server checks it again: the token, the amount, your limits, and that the recipient address is exactly the one you typed. If anything does not match, it stops.</p>
      ${spec([['The AI can', 'Read, explain, propose'], ['The AI cannot', 'Sign or move funds'], ['Final say', 'Always your wallet']])}` },
  { img: 'principles/slide.webp', html: `<p class="kicker">VI · Feature</p><h3>Screened both ways</h3>
      <p>Privacy for ordinary people only works if it cannot shelter theft. Every transfer checks both the sender and the recipient against a live risk and sanctions database first.</p>
      <p>High-risk addresses are turned away before anything is signed. If the screening service is down, Duskmoth refuses to send rather than guess.</p>
      ${spec([['Checked', 'Sender and recipient'], ['Blocked at', 'Risk 7 of 10 or higher'], ['If screening fails', 'Nothing moves'], ['Logged', 'Nothing about who paid whom']])}` },
  { img: 'ornaments/eye.webp', html: `<p class="kicker">VII · Feature</p><h3>Your privacy score</h3>
      <p>How loud is your wallet? Sign a free message to prove it is yours, and Duskmoth reads what the public chain already says about you.</p>
      <ul class="signals">
        <li><b>−25</b> Funded straight from an exchange</li><li><b>−15</b> Sends to exchange deposit addresses</li>
        <li><b>−15</b> Linked to a .sol name</li><li><b>−10</b> Long, busy public history</li>
        <li><b>−10</b> Large balance anyone can see</li><li><b>+10</b> Has used a privacy pool</li>
      </ul>
      <p class="note">You get a grade from A to F and a plain-language list of fixes. We only score wallets you prove you own.</p>` },
  { usecase: true, img: 'swarm/fly-4.webp', html: `<p class="kicker">VIII · Use case</p><p class="script big-script">A doxxed wallet</p>
      <p>Sara posted her wallet once to receive a bounty. Now strangers can see her full history, and she gets phishing links every week.</p>
      <p>Her score comes back a D: exchange-funded, a public .sol name, a big visible balance. She shields what she holds, starts a fresh wallet from her private balance, and keeps the old one as a small display wallet.</p>` },
  { img: 'brand/token.webp', html: `<p class="kicker">IX · Feature</p><h3>Share your grade</h3>
      <p>Proud of an A? Turn your score into a card for X. It shows your grade and score, never your address or balance.</p>
      <p>Post it, copy it, or download it. Every shared card is a quiet nudge for friends to check how loud their own wallet is.</p>
      ${spec([['Shows', 'Score and grade'], ['Hides', 'Address and balance'], ['Where', 'X, chats, anywhere']])}` },
  { cls: 'end', html: `<p class="kicker">X · The promise</p><h3>What Duskmoth will never do</h3>
      <ul class="never"><li>Hold your keys or your funds</li><li>Sign anything for you</li><li>Keep a record of who paid whom</li><li>Move money for sanctioned or stolen wallets</li></ul>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="pill solid" href="/app">Open the app</a><a class="pill" href="/docs">Read the docs</a></div>` },
];

(function book() {
  const el = document.querySelector('[data-book]');
  if (!el) return;
  const prev = document.querySelector('[data-book-prev]');
  const nextBtn = document.querySelector('[data-book-next]');
  const count = document.querySelector('[data-book-count]');
  const mq = matchMedia('(max-width: 760px)');
  let leaves = [], at = 0, single = mq.matches, swiped = 0;

  const face = (pg, side, n) => {
    if (!pg) return `<div class="face ${side} blank"></div>`;
    const art = pg.img ? `<img class="page-art" src="${IMG_DIR}${pg.img}" alt="" loading="lazy" decoding="async">` : '';
    return `<div class="face ${side} ${pg.cls || ''} ${pg.usecase ? 'usecase' : ''}">
      <div class="page-in">${art}${pg.html}</div>${pg.cls === 'cover' ? '' : `<span class="folio">${n}</span>`}</div>`;
  };

  function build() {
    single = mq.matches;
    el.classList.toggle('single', single);
    const per = single ? 1 : 2;
    const n = Math.ceil(PAGES.length / per);
    el.innerHTML = '';
    leaves = Array.from({ length: n }, (_, i) => {
      const leaf = document.createElement('div');
      leaf.className = 'leaf';
      const fi = i * per, bi = fi + 1;
      leaf.innerHTML = face(PAGES[fi], 'front', fi) + (single ? '' : face(PAGES[bi], 'back', bi));
      leaf.addEventListener('click', (e) => {
        if (e.target.closest('a') || performance.now() - swiped < 400) return;
        go(leaf.classList.contains('flipped') ? i : i + 1);
      });
      el.appendChild(leaf);
      return leaf;
    });
    at = Math.min(at, n);
    render(true);
  }

  function render(instant) {
    const n = leaves.length;
    leaves.forEach((leaf, i) => {
      const flipped = i < at;
      if (instant) leaf.style.transition = 'none';
      leaf.classList.toggle('flipped', flipped);
      leaf.style.zIndex = String(flipped ? i + 1 : n - i + n);
      if (instant) requestAnimationFrame(() => { leaf.style.transition = ''; });
    });
    el.classList.toggle('closed', at === 0);
    el.classList.toggle('ended', at === n);
    prev.disabled = at === 0; nextBtn.disabled = at === n;
    const per = single ? 1 : 2;
    count.textContent = at === 0 ? 'Cover' : at === n && !single ? 'The end' : single ? `Page ${at + 1} of ${PAGES.length}` : `Pages ${at * 2 - 1}–${Math.min(at * 2, PAGES.length - 1)}`;
  }

  function go(to) {
    to = Math.max(0, Math.min(leaves.length, to));
    if (to === at) return;
    const moving = to > at ? leaves[at] : leaves[to];
    moving.style.zIndex = '999'; // the turning page rides on top
    at = to;
    render(false);
    moving.style.zIndex = '999';
    setTimeout(() => render(true), 1150);
  }

  prev.addEventListener('click', () => go(at - 1));
  nextBtn.addEventListener('click', () => go(at + 1));
  el.tabIndex = 0;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(at + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(at - 1); }
  });
  let sx = null;
  el.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  el.addEventListener('pointerup', (e) => {
    if (sx === null) return; const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) > 50) { swiped = performance.now(); go(at + (dx < 0 ? 1 : -1)); }
  });
  mq.addEventListener('change', () => { at = 0; build(); });
  build();
})();

/* ---------------- waitlist ---------------- */
(function waitlist() {
  const form = document.querySelector('[data-waitlist]');
  const msg = document.querySelector('[data-form-msg]');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const btn = form.querySelector('button');
    msg.className = 'form-msg micro';
    if (!input.value.trim()) { msg.textContent = 'Enter your email first.'; msg.classList.add('err'); input.focus(); return; }
    btn.disabled = true; msg.textContent = 'Opening the portal…';
    try {
      const r = await api.waitlist(input.value.trim());
      msg.textContent = r.demo ? 'You are on the list (preview mode: nothing was stored).' : 'You are on the list. We will whisper when it opens.';
      msg.classList.add('ok'); input.value = '';
    } catch (err) {
      msg.textContent = err.message || 'Something went wrong. Try again.'; msg.classList.add('err');
    } finally { btn.disabled = false; }
  });
  form.querySelector('input').addEventListener('input', () => { if (msg.classList.contains('err')) { msg.textContent = ''; msg.className = 'form-msg micro'; } });
})();

if (ST) addEventListener('load', () => ST.refresh());

/* ---------------- $DMOTH contract copy ---------------- */
(function contract() {
  const btn = document.querySelector('[data-ca-copy]');
  const addr = document.querySelector('[data-ca]');
  const status = document.querySelector('[data-ca-status]');
  if (!btn || !addr || !status) return;
  let t;
  const say = (text, ok) => { status.textContent = text; status.className = 'micro ca-status ' + (ok ? 'ok' : 'err'); clearTimeout(t); t = setTimeout(() => { status.textContent = ''; }, 5000); };
  btn.addEventListener('click', async () => {
    const value = addr.textContent.trim();
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(value); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement('textarea'); ta.value = value; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      } catch (e) { ok = false; }
    }
    if (ok) say('Address copied.', true);
    else { const r = document.createRange(); r.selectNodeContents(addr); const s = getSelection(); s.removeAllRanges(); s.addRange(r); say('Copy failed. The address is selected, copy it manually.', false); }
  });
})();
