import crypto from 'node:crypto';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();

function safeName(name) {
  return path.basename(name || 'photo').replace(/[\\/:*?"<>|]+/g, '_');
}

export async function createSpeedTestUploadUrl({ originalName, contentType }) {
  const bucketName = process.env.GCS_TEST_BUCKET;
  if (!bucketName) throw new Error('GCS_TEST_BUCKET is not configured.');

  const name = safeName(originalName);
  const objectName = `speed-test/${Date.now()}_${crypto.randomBytes(5).toString('hex')}_${name}`;
  const file = storage.bucket(bucketName).file(objectName);
  const expires = Date.now() + 15 * 60 * 1000;
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires,
    contentType: contentType || 'application/octet-stream'
  });

  return { bucketName, objectName, uploadUrl: url, expiresAt: new Date(expires).toISOString() };
}
