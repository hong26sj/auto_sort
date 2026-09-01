import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();

function safeName(name) {
  return path.basename(name || 'photo').replace(/[\\/:*?"<>|]+/g, '_');
}

export function getUploadBucketName() {
  const bucketName = process.env.GCS_UPLOAD_BUCKET || process.env.GCS_TEST_BUCKET;
  if (!bucketName) throw new Error('GCS_UPLOAD_BUCKET is not configured.');
  return bucketName;
}

export async function createPhotoUploadUrl({ originalName, contentType }) {
  const bucketName = getUploadBucketName();
  const name = safeName(originalName);
  const objectName = `inbox/${Date.now()}_${crypto.randomBytes(6).toString('hex')}_${name}`;
  const file = storage.bucket(bucketName).file(objectName);
  const expires = Date.now() + 15 * 60 * 1000;
  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires,
    contentType: contentType || 'application/octet-stream'
  });
  return { bucketName, objectName, uploadUrl, expiresAt: new Date(expires).toISOString() };
}

export async function downloadGcsObject({ bucketName, objectName, destination }) {
  const source = storage.bucket(bucketName).file(objectName).createReadStream();
  await pipeline(source, fs.createWriteStream(destination));
}

export async function deleteGcsObject({ bucketName, objectName }) {
  await storage.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
}

export async function gcsObjectExists({ bucketName, objectName }) {
  const [exists] = await storage.bucket(bucketName).file(objectName).exists();
  return exists;
}
