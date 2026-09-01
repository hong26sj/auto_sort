import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { classifySite } from './geo.js';
import { readPhotoMetadata } from './exif.js';
import { processImage, safeUnlink } from './image.js';
import { ensurePhotoFolder, uploadToDrive } from './drive.js';

const app = express();
app.set('trust proxy', true);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Upload-Code']
}));
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    files: Number(process.env.MAX_FILES_PER_REQUEST || 20),
    fileSize: Number(process.env.MAX_FILE_BYTES || 25 * 1024 * 1024)
  },
  fileFilter(req, file, cb) {
    const ok = /^(image\/|application\/octet-stream)/.test(file.mimetype || '');
    cb(ok ? null : new Error(`Unsupported file type: ${file.mimetype}`), ok);
  }
});

function requireUploadCode(req, res, next) {
  const expected = process.env.UPLOAD_CODE;
  if (!expected) return next();
  const actual = req.get('X-Upload-Code') || '';
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'INVALID_UPLOAD_CODE' });
  next();
}

function dateFolder(capturedAt) {
  if (!capturedAt) return '촬영일미확인';
  const y = capturedAt.getFullYear();
  const m = String(capturedAt.getMonth() + 1).padStart(2, '0');
  const d = String(capturedAt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function safeFilename(name) {
  return path.basename(name || 'photo').replace(/[\\/:*?"<>|]+/g, '_');
}

app.get('/health', (req, res) => res.json({ ok: true, project: sitesConfig.projectName }));
app.get('/api/config', (req, res) => res.json({
  projectId: sitesConfig.projectId,
  projectName: sitesConfig.projectName,
  radiusMeters: sitesConfig.radiusMeters,
  siteCount: sitesConfig.sites.length,
  imageProcessingMode: process.env.IMAGE_PROCESSING_MODE || 'original'
}));

app.post('/api/upload', requireUploadCode, upload.array('photos'), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'NO_FILES' });

  const results = [];
  for (const file of files) {
    let processed = null;
    try {
      const meta = await readPhotoMetadata(file.path);
      const classification = classifySite(meta.latitude, meta.longitude, sitesConfig.sites, sitesConfig.radiusMeters);
      const siteName = classification.classified ? classification.site.name : '미분류';
      const day = dateFolder(meta.capturedAt);
      const folderId = await ensurePhotoFolder(siteName, day);

      processed = await processImage(file.path, safeFilename(file.originalname));
      const stamp = meta.capturedAt ? meta.capturedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') : 'unknown-date';
      const unique = crypto.randomBytes(3).toString('hex');
      const ext = path.extname(processed.filename) || path.extname(file.originalname) || '.jpg';
      const finalName = `${stamp}_${unique}${ext.toLowerCase()}`;

      const driveFile = await uploadToDrive({
        filePath: processed.path,
        filename: finalName,
        mimeType: processed.mimeType || file.mimetype,
        parentId: folderId,
        appProperties: {
          originalName: safeFilename(file.originalname).slice(0, 120),
          classifiedSite: siteName.slice(0, 120),
          classificationReason: classification.reason,
          distanceMeters: classification.distanceMeters == null ? '' : String(Math.round(classification.distanceMeters)),
          capturedAt: meta.capturedAt ? meta.capturedAt.toISOString() : '',
          hasGps: String(meta.latitude != null && meta.longitude != null)
        }
      });

      results.push({
        originalName: file.originalname,
        success: true,
        siteName,
        date: day,
        distanceMeters: classification.distanceMeters == null ? null : Math.round(classification.distanceMeters),
        classified: classification.classified,
        reason: classification.reason,
        driveFileId: driveFile.id,
        driveName: driveFile.name,
        driveLink: driveFile.webViewLink || null,
        processed: processed.processed
      });
    } catch (error) {
      console.error('file processing failed', file.originalname, error);
      results.push({ originalName: file.originalname, success: false, error: error.message });
    } finally {
      if (processed?.path && processed.path !== file.path) await safeUnlink(processed.path);
      await safeUnlink(file.path);
    }
  }

  const failed = results.filter(x => !x.success).length;
  res.status(failed === files.length ? 500 : 200).json({
    total: files.length,
    succeeded: files.length - failed,
    failed,
    results
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code, message: err.message });
  res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on ${port}`));
