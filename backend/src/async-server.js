import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { safeUnlink } from './image.js';
import { ensureInboxFolder, uploadToDrive } from './drive.js';
import { enqueuePhotoClassification } from './tasks.js';
import { classifyDrivePhoto } from './processor.js';

const app = express();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Upload-Code', 'X-Task-Code']
}));
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    files: Number(process.env.MAX_FILES_PER_REQUEST || 20),
    fileSize: Number(process.env.MAX_FILE_BYTES || 25 * 1024 * 1024)
  }
});

function equalToken(actual, expected) {
  if (!expected) return true;
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireUploadCode(req, res, next) {
  if (!equalToken(req.get('X-Upload-Code'), process.env.UPLOAD_CODE)) return res.status(401).json({ error: 'INVALID_UPLOAD_CODE' });
  next();
}

function requireTaskCode(req, res, next) {
  const expected = process.env.TASK_CODE || process.env.UPLOAD_CODE;
  if (!equalToken(req.get('X-Task-Code'), expected)) return res.status(401).json({ error: 'INVALID_TASK_CODE' });
  next();
}

function safeName(name) {
  return path.basename(name || 'photo').replace(/[\\/:*?"<>|]+/g, '_');
}

app.get('/health', (req, res) => res.json({ ok: true, asyncClassification: true }));
app.get('/api/config', (req, res) => res.json({
  projectId: sitesConfig.projectId,
  projectName: sitesConfig.projectName,
  radiusMeters: sitesConfig.radiusMeters,
  siteCount: sitesConfig.sites.length,
  imageProcessingMode: process.env.IMAGE_PROCESSING_MODE || 'original',
  asyncClassification: true
}));

app.post('/api/upload', requireUploadCode, upload.array('photos'), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'NO_FILES' });
  const inboxId = await ensureInboxFolder();
  const results = [];

  for (const file of files) {
    try {
      const originalName = safeName(file.originalname);
      const inboxName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${originalName}`;
      const saved = await uploadToDrive({
        filePath: file.path,
        filename: inboxName,
        mimeType: file.mimetype,
        parentId: inboxId,
        appProperties: { originalName: originalName.slice(0, 120), uploadState: 'INBOX', classificationDone: 'false' }
      });
      await enqueuePhotoClassification({ driveFileId: saved.id });
      results.push({ originalName: file.originalname, success: true, uploaded: true, queued: true, driveFileId: saved.id });
    } catch (error) {
      console.error('upload failed', file.originalname, error);
      results.push({ originalName: file.originalname, success: false, error: error.message });
    } finally {
      await safeUnlink(file.path);
    }
  }

  const failed = results.filter(r => !r.success).length;
  res.status(failed === files.length ? 500 : 200).json({ total: files.length, succeeded: files.length - failed, failed, asyncClassification: true, results });
});

app.post('/api/process-photo', requireTaskCode, async (req, res) => {
  const fileId = String(req.body?.driveFileId || '');
  if (!fileId) return res.status(400).json({ error: 'MISSING_DRIVE_FILE_ID' });
  try {
    const result = await classifyDrivePhoto(fileId);
    res.json({ ok: true, driveFileId: fileId, ...result });
  } catch (error) {
    console.error('classification failed', fileId, error);
    res.status(500).json({ error: 'CLASSIFICATION_FAILED', message: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on ${port}`));
