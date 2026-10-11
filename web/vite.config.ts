import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * Subresource Integrity for every script and stylesheet referenced from index.html (PLAN section 11).
 * Runs after the bundle is written and hashes the files on disk, so later chunk rewrites (worker URLs,
 * minification) cannot leave a stale hash behind.
 */
function sri(): Plugin {
  let outDir = 'dist';
  return {
    name: 'brix-sri',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const htmlPath = join(outDir, 'index.html');
      const integrity = (url: string) => {
        const content = readFileSync(join(outDir, url.replace(/^\//, '')));
        return `sha384-${createHash('sha384').update(content).digest('base64')}`;
      };
      const html = readFileSync(htmlPath, 'utf8')
        .replace(
          /<script ([^>]*?)src="([^"]+)"([^>]*)><\/script>/g,
          (_m, a: string, src: string, b: string) =>
            `<script ${a}src="${src}" integrity="${integrity(src)}"${b}></script>`,
        )
        .replace(
          /<link ([^>]*?)href="([^"]+\.(?:css|js))"([^>]*)>/g,
          (_m, a: string, href: string, b: string) =>
            `<link ${a}href="${href}" integrity="${integrity(href)}"${b}>`,
        );
      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), sri()],
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    // Hashed file names keep caching immutable; content-addressed output keeps builds reproducible.
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: { format: 'es' },
});
