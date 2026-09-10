import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { classifySite } from './geo.js';
import { readPhotoMetadata } from './exif.js';
import { processImage, safeUnlink } from './image.js';
import { uploadViaAppsScript } from './apps-script-relay.js';
import { downloadGcsObject, deleteGcsObject, gcsObjectExists } from './gcs.js';

function ms(start) { return Math.round((performance.now() - start) * 10) / 10; }
function timing(event, fields = {}) {
  console.log(JSON.stringify({ type: 'PHOTO_TIMING', event, ...fields }));
}

function dayFolder(date) {
  if (!date) return '촬영일미확인';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function safeName(name) {
  return path.basename(name || 'photo').replace(/[\\/:*?"<>|]+/g, '_');
}

function finalName(meta, sourceName, uniqueId) {
  const stamp = meta.capturedAt
    ? meta.capturedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    : 'unknown-date';
  return `${stamp}_${String(uniqueId).slice(0, 8)}${(path.extname(sourceName) || '.jpg').toLowerCase()}`;
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function analyzeLocalPhoto({ localPath, originalName, traceId }) {
  const exifStart = performance.now();
  const meta = await readPhotoMetadata(localPath);
  timing('EXIF_READ', {
    traceId,
    elapsedMs: ms(exifStart),
    hasGps: meta.latitude != null && meta.longitude != null,
    hasDate: Boolean(meta.capturedAt)
  });

  const classifyStart = performance.now();
  const classification = classifySite(meta.latitude, meta.longitude, sitesConfig.sites, sitesConfig.radiusMeters);
  const siteName = classification.classified ? classification.site.name : '미분류';
  const date = dayFolder(meta.capturedAt);
  timing('SITE_CLASSIFY', {
    traceId,
    elapsedMs: ms(classifyStart),
    siteName,
    distanceMeters: classification.distanceMeters == null ? null : Math.round(classification.distanceMeters)
  });

  const imageStart = performance.now();
  const processed = await processImage(localPath, originalName);
  timing('IMAGE_PROCESS', { traceId, elapsedMs: ms(imageStart), processed: processed.processed });

  return { meta, classification, siteName, date, processed };
}

function photoMetadata({ originalName, siteName, classification, meta, traceId, sourceSha256 }) {
  return {
    traceId,
    originalName: originalName.slice(0, 120),
    classifiedSite: siteName.slice(0, 120),
    classificationReason: classification.reason,
    distanceMeters: classification.distanceMeters == null ? '' : String(Math.round(classification.distanceMeters)),
    capturedAt: meta.capturedAt ? meta.capturedAt.toISOString() : '',
    hasGps: String(meta.latitude != null && meta.longitude != null),
    sourceSha256,
    uploadState: 'CLASSIFIED',
    classificationDone: 'true'
  };
}

export async function classifyGcsPhoto({ bucketName, objectName, originalName, contentType }, traceId = crypto.randomBytes(6).toString('hex')) {
  let localPath = null;
  let processed = null;
  const totalStart = performance.now();
  try {
    const existsStart = performance.now();
    const exists = await gcsObjectExists({ bucketName, objectName });
    timing('GCS_OBJECT_CHECK', { traceId, elapsedMs: ms(existsStart), exists });
    if (!exists) return { skipped: 'GCS_OBJECT_NOT_FOUND' };

    const cleanName = safeName(originalName || path.basename(objectName));
    const ext = path.extname(cleanName) || '.img';
    localPath = path.join(os.tmpdir(), `gcs-${crypto.randomBytes(8).toString('hex')}${ext}`);

    const downloadStart = performance.now();
    await downloadGcsObject({ bucketName, objectName, destination: localPath });
    timing('GCS_DOWNLOAD', { traceId, elapsedMs: ms(downloadStart) });

    const hashStart = performance.now();
    const sourceSha256 = await sha256File(localPath);
    timing('SOURCE_SHA256', { traceId, elapsedMs: ms(hashStart), sourceSha256: sourceSha256.slice(0, 12) });

    const analyzed = await analyzeLocalPhoto({ localPath, originalName: cleanName, traceId });
    processed = analyzed.processed;
    const sourcePath = processed.processed ? processed.path : localPath;
    const objectId = crypto.createHash('sha256').update(objectName).digest('hex').slice(0, 8);
    const targetName = finalName(analyzed.meta, processed.filename || cleanName, objectId);
    const metadata = photoMetadata({
      originalName: cleanName,
      siteName: analyzed.siteName,
      classification: analyzed.classification,
      meta: analyzed.meta,
      traceId,
      sourceSha256
    });

    const relayStart = performance.now();
    const relayResult = await uploadViaAppsScript({
      filePath: sourcePath,
      filename: targetName,
      mimeType: processed.processed ? processed.mimeType : (contentType || 'application/octet-stream'),
      siteName: analyzed.siteName,
      dateFolder: analyzed.date,
      metadata
    });
    timing('APPS_SCRIPT_DRIVE_UPLOAD', {
      traceId,
      elapsedMs: ms(relayStart),
      duplicate: Boolean(relayResult.duplicate),
      fileId: relayResult.fileId || null,
      filename: relayResult.filename || targetName,
      siteName: analyzed.siteName,
      date: analyzed.date
    });
    timing('GCS_TO_DRIVE_UPLOAD', {
      traceId,
      elapsedMs: ms(relayStart),
      transport: 'apps-script',
      duplicate: Boolean(relayResult.duplicate),
      siteName: analyzed.siteName,
      originalName: cleanName
    });

    const deleteStart = performance.now();
    await deleteGcsObject({ bucketName, objectName });
    timing('GCS_DELETE', { traceId, elapsedMs: ms(deleteStart) });

    timing('CLASSIFICATION_TOTAL', { traceId, elapsedMs: ms(totalStart), siteName: analyzed.siteName, date: analyzed.date, source: 'GCS' });
    return {
      siteName: analyzed.siteName,
      date: analyzed.date,
      source: 'GCS',
      duplicate: Boolean(relayResult.duplicate),
      filename: relayResult.filename || targetName,
      fileId: relayResult.fileId || null
    };
  } finally {
    if (processed?.path && processed.path !== localPath) await safeUnlink(processed.path);
    await safeUnlink(localPath);
  }
}
