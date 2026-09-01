import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function processImage(inputPath, originalName) {
  const mode = (process.env.IMAGE_PROCESSING_MODE || 'original').toLowerCase();
  if (mode === 'original') {
    return { path: inputPath, filename: originalName, mimeType: null, processed: false };
  }

  if (mode !== 'jpeg') throw new Error(`Unsupported IMAGE_PROCESSING_MODE: ${mode}`);

  const maxEdge = Number(process.env.IMAGE_MAX_EDGE || 2560);
  const quality = Number(process.env.IMAGE_JPEG_QUALITY || 82);
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
