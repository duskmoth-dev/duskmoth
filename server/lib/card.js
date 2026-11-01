/** Shareable privacy score card as SVG (1200x630, OG size). No address is printed on the card. */
export function scoreCardSvg({ score = 0, grade = 'F' }) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const g = String(grade).replace(/[^A-F]/g, '').slice(0, 1) || 'F';
  const r = 150;
  const c = 2 * Math.PI * r;
  const dash = (s / 100) * c;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="eye" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#140806"/><stop offset=".28" stop-color="#140806"/>
      <stop offset=".3" stop-color="#d9381e"/><stop offset=".62" stop-color="#ff7a2f"/>
      <stop offset=".66" stop-color="#e9c46a"/><stop offset="1" stop-color="#6f8f3a"/>
    </radialGradient>
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#b9b9c2"/>
      <stop offset=".55" stop-color="#5d5d66"/><stop offset="1" stop-color="#e9e9ef"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#050505"/>
  <circle cx="380" cy="315" r="${r}" fill="none" stroke="#1d1d1d" stroke-width="22"/>
  <circle cx="380" cy="315" r="${r}" fill="none" stroke="#e9c46a" stroke-width="22" stroke-linecap="round"
    stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 380 315)"/>
  <circle cx="380" cy="315" r="62" fill="url(#eye)"/>
  <circle cx="358" cy="292" r="12" fill="#fff" opacity=".7"/>
  <text x="640" y="250" font-family="Georgia, serif" font-size="96" fill="url(#chrome)" letter-spacing="4">DUSKMOTH</text>
  <text x="644" y="300" font-family="Helvetica, Arial, sans-serif" font-size="22" fill="#a7a7a7" letter-spacing="6">PRIVACY SCORE</text>
  <text x="640" y="430" font-family="Helvetica, Arial, sans-serif" font-size="150" fill="#f4f1ea">${s}<tspan font-size="48" fill="#777">/100</tspan></text>
  <text x="640" y="500" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#e9c46a" letter-spacing="4">GRADE ${g}</text>
  <text x="640" y="570" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#6f6f6f" letter-spacing="3">HOW LOUD IS YOUR WALLET?  DUSKMOTH</text>
</svg>`;
}
