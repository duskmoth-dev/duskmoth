import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
import { sdkBrowserPlugin } from './sdk-browser-plugin.js';

export default defineConfig({
  plugins: [sdkBrowserPlugin(), nodePolyfills({ include: ['buffer', 'process', 'crypto', 'stream', 'util', 'events', 'path', 'os', 'fs'], globals: { Buffer: true, process: true } })],
  // The relayer URL is read at runtime: the app sets globalThis.__DM_RELAYER__ to its own /api/relayer proxy.
  define: { 'process.env.NEXT_PUBLIC_RELAYER_API_URL': 'globalThis.__DM_RELAYER__', 'process.env.NEXT_PUBLIC_ALT_ADDRESS': 'undefined' },
  root: import.meta.dirname,
  publicDir: false,
  build: {
    outDir: path.resolve(import.meta.dirname, '../public/assets/js/live'),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: path.resolve(import.meta.dirname, 'src/privacy-cash.js'), formats: ['es'], fileName: () => 'privacy-cash.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
    chunkSizeWarningLimit: 6000,
  },
});
