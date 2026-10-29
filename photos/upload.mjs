/**
 * upload.mjs — scrape Vancouver iCloud album, upload photos to Cloudflare R2
 *
 * Usage: node upload.mjs [--dry-run] [--limit N]
 *
 * --dry-run   fetch photo list and print what would be uploaded, but don't upload
 * --limit N   only upload the first N photos (useful for testing)
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ── Load .env ─────────────────────────────────────────────────────────────────
const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.env'), 'utf8');
for (const line of env.split('\n')) {
  const [k, ...v] = line.split('=');
  if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
}

const TOKEN  = process.env.ICLOUD_ALBUM_TOKEN;
const BUCKET = process.env.R2_BUCKET;
const CDN    = 'https://vancouver26.monkeybear.us';

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT   = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i+1]) : Infinity; })();

// ── R2 client ─────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// ── iCloud helpers ────────────────────────────────────────────────────────────
const CANDIDATES = [
  'p62-sharedstreams.icloud.com',
  'p57-sharedstreams.icloud.com',
  'p66-sharedstreams.icloud.com',
  'p01-sharedstreams.icloud.com',
  'p06-sharedstreams.icloud.com',
  'p36-sharedstreams.icloud.com',
];

async function icloudPost(url, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function getAlbumPhotos() {
  console.log('Connecting to iCloud album…');
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 90000);

  let host, stream;
  try {
    const first = await Promise.any(
      CANDIDATES.map(async h => {
        const r = await icloudPost(`https://${h}/${TOKEN}/sharedstreams/webstream`, { streamCtag: null });
        if (r.status === 330) {
          const redir = await r.json();
          const rh = redir['X-Apple-MMe-Host'];
          const r2 = await icloudPost(`https://${rh}/${TOKEN}/sharedstreams/webstream`, { streamCtag: null });
          return { host: rh, data: await r2.json() };
        }
        return { host: h, data: await r.json() };
      })
    );
    host = first.host;
    stream = first.data;
  } catch (e) {
    throw new Error('iCloud API unreachable: ' + e.message);
  }

  const photos = stream.photos || [];
  console.log(`  Connected via ${host} — ${photos.length} photos found`);
  return { host, photos };
}

async function getAssetURLs(host, photoGuids) {
  console.log(`  Fetching CDN asset URLs for ${photoGuids.length} photos…`);
  const r = await icloudPost(
    `https://${host}/${TOKEN}/sharedstreams/webasseturls`,
    { photoGuids }
  );
  const data = await r.json();
  return data.items || {};
}

// ── Pick the best derivative (prefer 2048, avoid thumbnail 5003) ──────────────
function bestDerivative(derivatives) {
  const keys = Object.keys(derivatives);
  return keys.find(k => k === '2048' || k === '2049')
      || keys.find(k => k !== '5003' && k !== '342')
      || keys[0];
}

// ── R2 upload helpers ─────────────────────────────────────────────────────────
async function alreadyUploaded(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToR2(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
const { host, photos } = await getAlbumPhotos();

const batch = photos.slice(0, LIMIT);
const guids = batch.map(p => p.photoGuid);
const items = await getAssetURLs(host, guids);

const manifest = [];
let uploaded = 0, skipped = 0, failed = 0;

for (let i = 0; i < batch.length; i++) {
  const photo = batch[i];
  const guid  = photo.photoGuid;
  const derivs = photo.derivatives || {};
  const key_str = bestDerivative(derivs);
  if (!key_str) { console.warn(`  [${i+1}] no derivative for ${guid}`); failed++; continue; }

  const checksum = derivs[key_str]?.checksum;
  const loc      = checksum && items[checksum];
  if (!loc) { console.warn(`  [${i+1}] no CDN location for ${guid}`); failed++; continue; }

  const srcUrl     = `https://${loc.url_location}${loc.url_path}`;
  const ext        = srcUrl.split('?')[0].split('.').pop().toLowerCase() || 'jpg';
  const r2Key      = `photos/${guid}.${ext}`;
  const publicUrl  = `${CDN}/${r2Key}`;
  const caption    = photo.caption || '';
  const width      = parseInt(derivs[key_str]?.width  || 0);
  const height     = parseInt(derivs[key_str]?.height || 0);

  manifest.push({ url: publicUrl, caption, width, height });

  if (DRY_RUN) {
    console.log(`  [${i+1}/${batch.length}] would upload ${r2Key} (${derivs[key_str]?.fileSize} bytes)`);
    continue;
  }

  // Skip if already in R2
  if (await alreadyUploaded(r2Key)) {
    process.stdout.write(`  [${i+1}/${batch.length}] already uploaded — skip\r`);
    skipped++;
    continue;
  }

  // Download from Apple CDN
  let buf;
  try {
    const resp = await fetch(srcUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.warn(`  [${i+1}/${batch.length}] download failed for ${guid}: ${e.message}`);
    failed++;
    continue;
  }

  // Upload to R2
  try {
    const ct = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
             : ext === 'png'  ? 'image/png'
             : ext === 'heic' ? 'image/heic'
             : ext === 'mov'  ? 'video/quicktime'
             : ext === 'mp4'  ? 'video/mp4'
             : 'application/octet-stream';
    await uploadToR2(r2Key, buf, ct);
    console.log(`  [${i+1}/${batch.length}] ✅ ${r2Key} (${(buf.length/1024).toFixed(0)} KB)`);
    uploaded++;
  } catch (e) {
    console.warn(`  [${i+1}/${batch.length}] R2 upload failed for ${guid}: ${e.message}`);
    failed++;
  }
}

// Write manifest
const manifestPath = join(dirname(fileURLToPath(import.meta.url)), 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log('\n── Done ──────────────────────────────────────────────');
if (DRY_RUN) {
  console.log(`Dry run: ${batch.length} photos would be uploaded`);
} else {
  console.log(`Uploaded: ${uploaded}  Skipped: ${skipped}  Failed: ${failed}`);
}
console.log(`Manifest written to manifest.json (${manifest.length} entries)`);
console.log(`CDN base: ${CDN}`);
