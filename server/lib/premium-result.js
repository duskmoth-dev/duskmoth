import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
const purpose = 'duskmoth:premium-result:v1';
const key = secret => {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Premium recovery storage is unavailable.');
  return Buffer.from(hkdfSync('sha256', secret, purpose, 'result-encryption', 32));
};
export function encryptResult(payload, secret, hash) {
  const material = key(secret), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', material, iv);
    cipher.setAAD(Buffer.from(`${purpose}:${hash}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
  } finally { material.fill(0); }
}
export function decryptResult(value, secret, hash) {
  const material = key(secret);
  try {
    const row = JSON.parse(value), cipher = createDecipheriv('aes-256-gcm', material, Buffer.from(row.iv, 'base64'));
    cipher.setAAD(Buffer.from(`${purpose}:${hash}`)); cipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch { throw new Error('Saved premium result could not be recovered. Keep your recovery data.'); }
  finally { material.fill(0); }
}
