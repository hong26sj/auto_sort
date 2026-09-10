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
function failure(event, fields = {}) {
  console.error(JSON.stringify({ type: 'PHOTO_FAILURE', event, ...fields }));
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

function dateStatus(meta) {
  return meta.capturedAt ? 'HAS_CAPTURE_DATE' : 'NO_CAPTURE_DATE';
}

async function analyzeLocalPhoto({ localPath, originalName, traceId }) {
  const exifStart = performance.now();
  const meta = await readPhotoMetadata(localPath);
  const hasGps = meta.latitude != null && meta.longitude != null;
  const captureDateStatus = dateStatus(meta);
  timing('EXIF_READ', {
    traceId,
    elapsedMs: ms(exifStart),
    hasGps,
    hasDate: Boolean(meta.capturedAt),
    dateStatus: captureDateStatus
  });

  const classifyStart = performance.now();
  const classification = classifySite(meta.latitude, meta.longitude, sitesConfig.sites, sitesConfig.radiusMeters);
  const siteName = classification.classified ? classification.site.name : '미분류';
  const date = dayFolder(meta.capturedAt);
  const nearestSite = classification.site?.name || null;
  const roundedDistance = classification.distanceMeters == null ? null : Math.round(classification.distanceMeters);

  timing('SITE_CLASSIFY', {
    traceId,
    elapsedMs: ms(classifyStart),
    siteName,
    classificationReason: classification.reason,
    classified: classification.classified,
    nearestSite,
    distanceMeters: roundedDistance,
    radiusMeters: sitesConfig.radiusMeters,
    dateStatus: captureDateStatus
  });

  if (!classification.classified) {
    timing('PHOTO_UNCLASSIFIED', {
      traceId,
      reason: classification.reason,
      nearestSite,
      distanceMeters: roundedDistance,
      radiusMeters: sitesConfig.radiusMeters,
      dateStatus: captureDateStatus
    });
  }
  if (captureDateStatus === 'NO_CAPTURE_DATE') {
    timing('PHOTO_NO_CAPTURE_DATE', {
      traceId,
      siteName,
      classificationReason: classification.reason
    });
  }

  const imageStart = performance.now();
  const processed = await processImage(localPath, originalName);
  timing('IMAGE_PROCESS', { traceId, elapsedMs: ms(imageStart), processed: processed.processed });

  return { meta, classification, siteName, date, processed, captureDateStatus, nearestSite };
}

function photoMetadata({ originalName, siteName, classification, meta, traceId, sourceSha256, captureDateStatus, nearestSite }) {
  return {
    traceId,
    originalName: originalName.slice(0, 120),
    classifiedSite: siteName.slice(0, 120),
    classificationStatus: classification.classified ? 'CLASSIFIED' : 'UNCLASSIFIED',
    classificationReason: classification.reason,
    nearestSite: nearestSite || '',
    distanceMeters: classification.distanceMeters == null ? '' : String(Math.round(classification.distanceMeters)),
    radiusMeters: String(sitesConfig.radiusMeters),
    capturedAt: meta.capturedAt ? meta.capturedAt.toISOString() : '',
    dateStatus: captureDateStatus,
    hasGps: String(meta.latitude != null && meta.longitude != null),
    sourceSha256,
    uploadState: 'CLASSIFIED',
    classificationDone: 'true'
  };
}

export async function classifyGcsPhoto({ bucketName, objectName, originalName, contentType }, traceId = crypto.randomBytes(6).toString('hex')) {
  let localPath = null;
  let processed = null;
  let stage = 'START';
  let cleanName = safeName(originalName || path.basename(objectName));
  let siteName = null;
  let date = null;
  let sourceSha256 = null;
  let classificationReason = null;
  let captureDateStatus = null;
  const totalStart = performance.now();
  try {
    stage = 'GCS_OBJECT_CHECK';
    const existsStart = performance.now();
    const exists = await gcsObjectExists({ bucketName, objectName });
    timing('GCS_OBJECT_CHECK', { traceId, elapsedMs: ms(existsStart), exists, bucketName, objectName, originalName: cleanName });
    if (!exists) {
      failure('GCS_OBJECT_NOT_FOUND', { traceId, stage, bucketName, objectName, originalName: cleanName, sourcePreserved: false });
      return { skipped: 'GCS_OBJECT_NOT_FOUND' };
    }

    const ext = path.extname(cleanName) || '.img';
    localPath = path.join(os.tmpdir(), `gcs-${crypto.randomBytes(8).toString('hex')}${ext}`);

    stage = 'GCS_DOWNLOAD';
    const downloadStart = performance.now();
    await downloadGcsObject({ bucketName, objectName, destination: localPath });
    timing('GCS_DOWNLOAD', { traceId, elapsedMs: ms(downloadStart), bucketName, objectName, originalName: cleanName });

    stage = 'SOURCE_SHA256';
    const hashStart = performance.now();
    sourceSha256 = await sha256File(localPath);
    timing('SOURCE_SHA256', { traceId, elapsedMs: ms(hashStart), sourceSha256: sourceSha256.slice(0, 12) });

    stage = 'EXIF_CLASSIFY_IMAGE';
    const analyzed = await analyzeLocalPhoto({ localPath, originalName: cleanName, traceId });
    processed = analyzed.processed;
    siteName = analyzed.siteName;
    date = analyzed.date;
    classificationReason = analyzed.classification.reason;
    captureDateStatus = analyzed.captureDateStatus;
    const sourcePath = processed.processed ? processed.path : localPath;
    const objectId = crypto.createHash('sha256').update(objectName).digest('hex').slice(0, 8);
    const targetName = finalName(analyzed.meta, processed.filename || cleanName, objectId);
    const metadata = photoMetadata({
      originalName: cleanName,
      siteName,
      classification: analyzed.classification,
      meta: analyzed.meta,
      traceId,
      sourceSha256,
      captureDateStatus,
      nearestSite: analyzed.nearestSite
    });

    stage = 'APPS_SCRIPT_DRIVE_UPLOAD';
    const relayStart = performance.now();
    const relayResult = await uploadViaAppsScript({
      filePath: sourcePath,
      filename: targetName,
      mimeType: processed.processed ? processed.mimeType : (contentType || 'application/octet-stream'),
      siteName,
      dateFolder: date,
      metadata
    });
    timing('APPS_SCRIPT_DRIVE_UPLOAD', {
      traceId,
      elapsedMs: ms(relayStart),
      duplicate: Boolean(relayResult.duplicate),
      fileId: relayResult.fileId || null,
      filename: relayResult.filename || targetName,
      siteName,
      date,
      classificationReason,
      dateStatus: captureDateStatus,
      bucketName,
      objectName,
      originalName: cleanName
    });
    timing('GCS_TO_DRIVE_UPLOAD', {
      traceId,
      elapsedMs: ms(relayStart),
      transport: 'apps-script',
      duplicate: Boolean(relayResult.duplicate),
      siteName,
      classificationReason,
      dateStatus: captureDateStatus,
      originalName: cleanName,
      bucketName,
      objectName
    });

    stage = 'GCS_DELETE';
    const deleteStart = performance.now();
    await deleteGcsObject({ bucketName, objectName });
    timing('GCS_DELETE', { traceId, elapsedMs: ms(deleteStart), bucketName, objectName, originalName: cleanName });

    stage = 'DONE';
    timing('CLASSIFICATION_TOTAL', {
      traceId,
      elapsedMs: ms(totalStart),
      siteName,
      date,
      classificationReason,
      dateStatus: captureDateStatus,
      source: 'GCS',
      duplicate: Boolean(relayResult.duplicate),
      bucketName,
      objectName,
      originalName: cleanName
    });
    return {
      siteName,
      date,
      classificationReason,
      dateStatus: captureDateStatus,
      source: 'GCS',
      duplicate: Boolean(relayResult.duplicate),
      filename: relayResult.filename || targetName,
      fileId: relayResult.fileId || null
    };
  } catch (error) {
    failure('PHOTO_PROCESSING_FAILED', {
      traceId,
      failedStage: stage,
      elapsedMs: ms(totalStart),
      bucketName,
      objectName,
      originalName: cleanName,
      siteName,
      date,
      classificationReason,
      dateStatus: captureDateStatus,
      sourceSha256: sourceSha256 ? sourceSha256.slice(0, 12) : null,
      sourcePreserved: stage !== 'GCS_DELETE',
      errorName: error?.name || 'Error',
      errorMessage: error?.message || String(error)
    });
    throw error;
  } finally {
    if (processed?.path && processed.path !== localPath) await safeUnlink(processed.path);
    await safeUnlink(localPath);
  }
}
