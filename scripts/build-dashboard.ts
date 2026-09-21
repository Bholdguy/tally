// Bundles the dashboard (dashboard/src -> dashboard/dist/app.js) with esbuild and copies the static files. No secrets are read or embedded:
// scan:secrets runs over dashboard/dist afterwards (SECURITY §2).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dashboard/dist', { recursive: true });
await build({ entryPoints: ['dashboard/src/main.ts'], bundle: true, format: 'iife', target: 'es2022', platform: 'browser', outfile: 'dashboard/dist/app.js', sourcemap: false, minify: false, legalComments: 'none', logLevel: 'warning' });
for (const f of ['index.html', 'style.css']) copyFileSync(`dashboard/public/${f}`, `dashboard/dist/${f}`);
console.log('dashboard built -> dashboard/dist');
