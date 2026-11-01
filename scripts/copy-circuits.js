// Copies runtime assets the live-send module needs into public/:
// - Privacy Cash circuit files (wasm + zkey) for in-browser proof generation
// - Light Protocol Poseidon hasher wasm, resolved next to the bundled module at runtime
import fs from 'node:fs';
import path from 'node:path';

const copy = (src, dstDir) => { fs.mkdirSync(dstDir, { recursive: true }); fs.copyFileSync(src, path.join(dstDir, path.basename(src))); };
for (const f of ['transaction2.wasm', 'transaction2.zkey']) copy(path.resolve('node_modules/privacycash/circuit2', f), path.resolve('public/circuit2'));
for (const f of ['light_wasm_hasher_bg.wasm', 'hasher_wasm_simd_bg.wasm']) copy(path.resolve('node_modules/@lightprotocol/hasher.rs/dist', f), path.resolve('public/assets/js/live'));
console.log('Copied circuits and hasher wasm into public/');
