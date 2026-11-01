// Runtime mode and startup checks.
// In production (NODE_ENV=production) Duskmoth never shows invented data: every feature either runs
// against Solana mainnet services or says plainly that it is unavailable.

export const PROD = process.env.NODE_ENV === 'production';
const on = (k) => String(process.env[k] || '').toLowerCase() === 'true';

export const flags = {
  liveSend: on('ENABLE_LIVE_SEND'),
  // the demo wallet and sample data are for local previews only, never on by default in production
  demoWallet: false,
  relayerProxy: process.env.RELAYER_PROXY ? on('RELAYER_PROXY') : true,
  ai: !!process.env.ANTHROPIC_API_KEY,
  scorechain: !!process.env.SCORECHAIN_API_KEY,
  helius: !!process.env.HELIUS_API_KEY,
};

/** Fallback to sample data is only allowed outside production. */
export const allowDemoData = false;

export function preflight() {
  const problems = [];
  const warnings = [];
  if (PROD) {
    if (flags.liveSend && !flags.scorechain) problems.push('Live transfers require SCORECHAIN_API_KEY for sanctions checks.');
    if (flags.liveSend && !flags.helius) problems.push('Live transfers require HELIUS_API_KEY for mainnet RPC.');
    if (flags.liveSend) warnings.push('Wallet-approved mainnet transfers enabled. Scorechain is sanctions-only; verify provider coverage and commercial-use terms separately.');
    if (!process.env.PUBLIC_URL) warnings.push('PUBLIC_URL is empty: link previews on X may not show the image.');
    if (!flags.helius) warnings.push('HELIUS_API_KEY is empty: using the public mainnet RPC (rate limited) and the privacy score is disabled.');
    if (!flags.scorechain) warnings.push('SCORECHAIN_API_KEY is empty: sanctions screening is unavailable.');
    if (!flags.liveSend) warnings.push('Live transfers are disabled; transaction requests will be refused, not simulated.');
    if (!flags.ai) warnings.push('ANTHROPIC_API_KEY is empty: using the built-in English rule parser.');
  }
  return { problems, warnings };
}

export function transferReadiness(settings = flags) {
  if (!settings.liveSend) return { liveSend: false, transferStatus: 'disabled', transferBlockReason: 'Live transfers are turned off by the server operator.' };
  if (!settings.scorechain || !settings.helius) return { liveSend: false, transferStatus: 'unavailable', transferBlockReason: 'Mainnet RPC and sanctions screening must be configured.' };
  return { liveSend: true, transferStatus: 'wallet-approval-required', transferBlockReason: null };
}

export function status() {
  return {
    mode: PROD ? 'production' : 'development',
    network: 'mainnet-beta',
    ai: flags.ai ? 'claude' : 'rules',
    screening: flags.scorechain ? 'scorechain' : 'off',
    screeningScope: 'sanctions-only',
    data: flags.helius ? 'helius' : 'public-rpc',
    ...transferReadiness(),
    demoWallet: flags.demoWallet,
    relayerProxy: flags.relayerProxy,
  };
}
