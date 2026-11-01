import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Small, checked build-time adaptations; never edit installed SDK files or skip records.
export function sdkBrowserPlugin() {
  const runtime = JSON.stringify(fileURLToPath(new URL('./src/runtime.js', import.meta.url)));
  return {
    name: 'duskmoth-sdk-responsive-scan',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].split(path.sep).join('/');
      if (!file.includes('/privacycash/dist/')) return;
      let output = code;
      if (file.endsWith('/models/utxo.js')) {
        const debug = 'console.log(JSON.stringify(utxoData, null, 2));';
        if (!output.includes(debug)) throw new Error('Privacy SDK note-logging contract changed; review the browser adaptation.');
        output = output.replace(debug, '/* Private note data must never be logged in the browser. */');
      }
      const isScan = /\/getUtxos(SPL)?\.js$/.test(file);
      if (isScan) {
        const loop = 'for (const encryptedOutput of encryptedOutputs) {';
        if (!output.includes(loop) || !output.includes('const data = await res.json();') ||
            !/return await (?:isUtxoSpent|areUtxosSpent)\(/.test(output)) {
          throw new Error('Privacy SDK scan contract changed; review the browser adaptation.');
        }
        output = output.replace(loop, `let processed = 0;
    for (const encryptedOutput of encryptedOutputs) {
        if (processed++ % 100 === 0) await scanYield(processed - 1, encryptedOutputs.length);`);
        // The SDK recursively retries spent checks forever on RPC failure.
        output = output.replace(/return await (?:isUtxoSpent|areUtxosSpent)\([^;]+;/g,
          "throw new Error('Private balance verification failed. No further transaction will be prepared. Try reading the balance again.');");
        output = output.replace('const data = await res.json();', 'const data = await res.json(); scanBatch(data);');
        output = `import { scanYield, scanBatch } from ${runtime};\n` + output;
      }
      if (/\bfetch\(/.test(output)) {
        output = `import { sdkFetch } from ${runtime};\n` + output.replace(/\bfetch\(/g, 'sdkFetch(');
      }
      return output === code ? null : { code: output, map: null };
    },
  };
}
