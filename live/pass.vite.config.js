import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
export default defineConfig({
  plugins: [nodePolyfills({ include: ['buffer', 'process', 'events'], globals: { Buffer: true, process: true } })],
  root: import.meta.dirname,
  publicDir: false,
  build: {
    outDir: path.resolve(import.meta.dirname, '../public/assets/js/live'),
    emptyOutDir: false, target: 'es2022',
    lib: { entry: path.resolve(import.meta.dirname, 'src/moth-pass.js'), formats: ['es'], fileName: () => 'moth-pass.js' },
  },
});
