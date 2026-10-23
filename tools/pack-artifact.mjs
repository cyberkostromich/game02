// Packs dist/ into a single artifact page: inlines the built JS and CSS and
// strips the document skeleton (the artifact host adds its own).
// Usage: node tools/pack-artifact.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: pack-artifact.mjs <out-dir>');
let html = fs.readFileSync('dist/index.html', 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, f) => {
  const js = fs.readFileSync(path.join('dist', f), 'utf8').replace(/<\/script/g, '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/, (_, f) => `<style>${fs.readFileSync(path.join('dist', f), 'utf8')}</style>`);
html = html
  .replace(/<!doctype html>/i, '')
  .replace(/<\/?html[^>]*>/g, '')
  .replace(/<\/?head>/g, '')
  .replace(/<\/?body>/g, '')
  .replace(/<meta charset="UTF-8" \/>/, '')
  .replace(/<meta name="viewport"[^>]*>/, '');
// title first, so the host finds it
const title = html.match(/<title>.*?<\/title>/)[0];
html = title + '\n<meta name="claude:viewport-fit-sides" content="cover">\n' + html.replace(title, '');
fs.mkdirSync(path.join(out, 'maps'), { recursive: true });
fs.writeFileSync(path.join(out, 'zombie-fuckers.html'), html.trim() + '\n');
fs.copyFileSync('dist/maps/midtown.json', path.join(out, 'maps/midtown.json'));
console.log('packed', (html.length / 1024).toFixed(0), 'KiB');
