import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env manually
const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.env'), 'utf8');
for (const line of env.split('\n')) {
  const [k, ...v] = line.split('=');
  if (k && v.length) process.env[k.trim()] = v.join('=').trim();
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

try {
  const res = await client.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, MaxKeys: 1 }));
  console.log('✅ R2 connected. Bucket:', process.env.R2_BUCKET, '— objects so far:', res.KeyCount ?? 0);
} catch (e) {
  console.error('❌ R2 connection failed:', e.message);
}
