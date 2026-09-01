import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { classifySite } from './geo.js';
import { readPhotoMetadata } from './exif.js';
import { processImage, safeUnlink } from './image.js';
import { ensurePhotoFolder, getDriveFile, downloadDriveFile, moveDriveFile, uploadToDrive, trashDriveFile } from './drive.js';

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

export async function classifyDrivePhoto(fileId) {
  let localPath = null;
  let processed = null;
  try {
    const info = await getDriveFile(fileId);
    if (info.trashed) return { skipped: 'TRASHED' };
    if (info.appProperties?.classificationDone === 'true') return { skipped: 'ALREADY_CLASSIFIED' };

    const originalName = safeName(info.appProperties?.originalName || info.name);
    const ext = path.extname(originalName) || '.img';
    localPath = path.join(os.tmpdir(), `photo-${fileId}-${crypto.randomBytes(3).toString('hex')}${ext}`);
    await downloadDriveFile(fileId, localPath);

    const meta = await readPhotoMetadata(localPath);
    const classification = classifySite(meta.latitude, meta.longitude, sitesConfig.sites, sitesConfig.radiusMeters);
    const siteName = classification.classified ? classification.site.name : '미분류';
    const date = dayFolder(meta.capturedAt);
    const parentId = await ensurePhotoFolder(siteName, date);
    processed = await processImage(localPath, originalName);
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

    if (processed.processed) {
      await uploadToDrive({ filePath: processed.path, filename: targetName, mimeType: processed.mimeType, parentId, appProperties: props });
      await trashDriveFile(fileId);
    } else {
      await moveDriveFile({ fileId, parentId, filename: targetName, appProperties: props });
    }
    return { siteName, date };
  } finally {
    if (processed?.path && processed.path !== localPath) await safeUnlink(processed.path);
    await safeUnlink(localPath);
  }
}
