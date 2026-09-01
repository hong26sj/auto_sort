import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { classifySite } from './geo.js';
import { readPhotoMetadata } from './exif.js';
import { processImage, safeUnlink } from './image.js';
import { ensurePhotoFolder, getDriveFile, downloadDriveFile, moveDriveFile, uploadToDrive, trashDriveFile } from './drive.js';

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

function finalName(meta, sourceName, fileId) {
  const stamp = meta.capturedAt
    ? meta.capturedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    : 'unknown-date';
  return `${stamp}_${String(fileId).slice(0, 8)}${(path.extname(sourceName) || '.jpg').toLowerCase()}`;
}

export async function classifyDrivePhoto(fileId, traceId = String(fileId).slice(0, 12)) {
  let localPath = null;
  let processed = null;
  const totalStart = performance.now();
  try {
    const infoStart = performance.now();
    const info = await getDriveFile(fileId);
    timing('DRIVE_METADATA_READ', { traceId, elapsedMs: ms(infoStart) });

    if (info.trashed) return { skipped: 'TRASHED' };
    if (info.appProperties?.classificationDone === 'true') return { skipped: 'ALREADY_CLASSIFIED' };

    const originalName = safeName(info.appProperties?.originalName || info.name);
    const ext = path.extname(originalName) || '.img';
    localPath = path.join(os.tmpdir(), `photo-${fileId}-${crypto.randomBytes(3).toString('hex')}${ext}`);

    const downloadStart = performance.now();
    await downloadDriveFile(fileId, localPath);
    timing('DRIVE_DOWNLOAD', { traceId, elapsedMs: ms(downloadStart) });

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

    const folderStart = performance.now();
    const parentId = await ensurePhotoFolder(siteName, date);
    timing('TARGET_FOLDER_READY', { traceId, elapsedMs: ms(folderStart), siteName, date });

    const imageStart = performance.now();
    processed = await processImage(localPath, originalName);
    timing('IMAGE_PROCESS', { traceId, elapsedMs: ms(imageStart), processed: processed.processed });

    const targetName = finalName(meta, processed.filename || originalName, fileId);
    const props = {
      originalName: originalName.slice(0, 120),
      classifiedSite: siteName.slice(0, 120),
      classificationReason: classification.reason,
      distanceMeters: classification.distanceMeters == null ? '' : String(Math.round(classification.distanceMeters)),
      capturedAt: meta.capturedAt ? meta.capturedAt.toISOString() : '',
      hasGps: String(meta.latitude != null && meta.longitude != null),
      uploadState: 'CLASSIFIED',
      classificationDone: 'true'
    };

    const finalizeStart = performance.now();
    if (processed.processed) {
      await uploadToDrive({ filePath: processed.path, filename: targetName, mimeType: processed.mimeType, parentId, appProperties: props });
      await trashDriveFile(fileId);
      timing('DRIVE_FINALIZE_UPLOAD', { traceId, elapsedMs: ms(finalizeStart) });
    } else {
      await moveDriveFile({ fileId, parentId, filename: targetName, appProperties: props });
      timing('DRIVE_MOVE', { traceId, elapsedMs: ms(finalizeStart) });
    }

    timing('CLASSIFICATION_TOTAL', { traceId, elapsedMs: ms(totalStart), siteName, date });
    return { siteName, date };
  } finally {
    if (processed?.path && processed.path !== localPath) await safeUnlink(processed.path);
    await safeUnlink(localPath);
  }
}
