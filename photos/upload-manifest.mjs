/**
 * upload-manifest.mjs — upload manifest.json to R2 so the trip app can fetch it
 * Run this after upload.mjs finishes.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(dir, '.env'), 'utf8');
for (const line of env.split('\n')) {
  const [k, ...v] = line.split('=');
  if (k?.trim() && v.length) process.env[k.trim()] = v.join('=').trim();
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const manifest = readFileSync(join(dir, 'manifest.json'));

await s3.send(new PutObjectCommand({
  Bucket: process.env.R2_BUCKET,
  Key: 'manifest.json',
  Body: manifest,
  ContentType: 'application/json',
  CacheControl: 'public, max-age=300',
}));

const parsed = JSON.parse(manifest);
console.log(`✅ manifest.json uploaded — ${parsed.length} photos`);
console.log(`   https://vancouver26.monkeybear.us/manifest.json`);
