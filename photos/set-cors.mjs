import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const env = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '.env'), 'utf8');
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

await s3.send(new PutBucketCorsCommand({
  Bucket: process.env.R2_BUCKET,
  CORSConfiguration: {
    CORSRules: [{
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      MaxAgeSeconds: 86400,
    }],
  },
}));

console.log('✅ CORS configured on', process.env.R2_BUCKET);
