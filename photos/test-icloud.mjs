import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.env'), 'utf8');
for (const line of env.split('\n')) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const TOKEN = process.env.ICLOUD_ALBUM_TOKEN;
const CANDIDATES = [
  'p62-sharedstreams.icloud.com',
  'p57-sharedstreams.icloud.com',
  'p66-sharedstreams.icloud.com',
  'p01-sharedstreams.icloud.com',
  'p06-sharedstreams.icloud.com',
  'p36-sharedstreams.icloud.com',
];

const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 10000);

let host, stream;
try {
  const first = await Promise.any(
    CANDIDATES.map(async h => {
      const r = await fetch(`https://${h}/${TOKEN}/sharedstreams/webstream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamCtag: null }),
        signal: ctrl.signal,
      });
      if (r.status === 330) {
        const redir = await r.json();
        const rh = redir['X-Apple-MMe-Host'];
        const r2 = await fetch(`https://${rh}/${TOKEN}/sharedstreams/webstream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamCtag: null }),
          signal: ctrl.signal,
        });
        return { host: rh, data: await r2.json() };
      }
      return { host: h, data: await r.json() };
    })
  );
  host = first.host;
  stream = first.data;
} catch (e) {
  console.error('❌ iCloud API failed:', e.message);
  process.exit(1);
}

const photos = stream.photos || [];
console.log(`✅ iCloud connected via ${host}`);
console.log(`   Photos in album: ${photos.length}`);
if (photos.length) {
  console.log(`   First photo guid: ${photos[0].photoGuid}`);
  console.log(`   First caption: ${photos[0].caption || '(none)'}`);
  const derivs = Object.keys(photos[0].derivatives || {});
  console.log(`   Available sizes: ${derivs.join(', ')}`);
}
