import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
export default defineConfig({
  plugins: [nodePolyfills({ include: ['buffer', 'process', 'events', 'crypto', 'stream', 'util'], globals: { Buffer: true, process: true } })],
  root: import.meta.dirname, publicDir: false,
  build: { outDir: path.resolve(import.meta.dirname, '../public/assets/js/live'), emptyOutDir: false, target: 'es2022',
    lib: { entry: path.resolve(import.meta.dirname, 'src/magicblock-engine.js'), formats: ['es'], fileName: () => 'magicblock-engine.js' },
    rollupOptions: { output: { inlineDynamicImports: true } } },
});
