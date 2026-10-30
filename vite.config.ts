import { defineConfig } from 'vite';

// Vite hashes the files it bundles, but files in public/ keep their names. Browsers keep icons in a cache that ignores
// Cache-Control, so each build tags the links to those files in index.html with its own version.
const version = Date.now().toString(36);

export default defineConfig({
  server: { host: '127.0.0.1' },
  plugins: [{
    name: 'version-public-files',
    apply: 'build',
    transformIndexHtml: html => html.replace(/(href|content)="([^"]*\/[\w-]+\.(?:ico|svg|png|jpg))"/g, `$1="$2?v=${version}"`),
  }],
});
