import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function processImage(inputPath, originalName) {
  const mode = (process.env.IMAGE_PROCESSING_MODE || 'original').toLowerCase();
  if (mode === 'original') {
    return { path: inputPath, filename: originalName, mimeType: null, processed: false };
  }

  if (mode !== 'jpeg') throw new Error(`Unsupported IMAGE_PROCESSING_MODE: ${mode}`);

  // The prebuilt sharp/libvips image used in Cloud Run cannot decode every HEIC/HEIF variant.
  // EXIF/site classification has already finished before this step, so preserve these files
  // as-is instead of failing the whole task and repeatedly retrying a permanent codec error.
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    return { path: inputPath, filename: originalName, mimeType: null, processed: false };
  }

  // B profile: long edge max 2560 px, JPEG quality 80.
  const maxEdge = Number(process.env.IMAGE_MAX_EDGE || 2560);
  const quality = Number(process.env.IMAGE_JPEG_QUALITY || 80);
  const outputPath = `${inputPath}.processed.jpg`;
  const base = path.parse(originalName).name.replace(/[^a-zA-Z0-9가-힣._-]+/g, '_');

  await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .keepMetadata()
    .toFile(outputPath);

  return { path: outputPath, filename: `${base}.jpg`, mimeType: 'image/jpeg', processed: true };
}

export async function safeUnlink(filePath) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}
