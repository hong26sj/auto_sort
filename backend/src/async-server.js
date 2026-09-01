import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { safeUnlink } from './image.js';
import { ensureInboxFolder, uploadToDrive } from './drive.js';
import { enqueuePhotoClassification } from './tasks.js';
import { classifyDrivePhoto } from './processor.js';
import { createSpeedTestUploadUrl } from './gcs-test.js';

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

function ms(start) { return Math.round((performance.now() - start) * 10) / 10; }
function timing(event, fields = {}) {
  console.log(JSON.stringify({ type: 'PHOTO_TIMING', event, ...fields }));
}

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

app.post('/api/gcs-test-url', requireUploadCode, async (req, res) => {
  try {
    const originalName = String(req.body?.originalName || 'photo');
    const contentType = String(req.body?.contentType || 'application/octet-stream');
    const signed = await createSpeedTestUploadUrl({ originalName, contentType });
    res.json({ ok: true, ...signed });
  } catch (error) {
    console.error('gcs test url failed', error);
    res.status(500).json({ error: 'GCS_TEST_URL_FAILED', message: error.message });
  }
});

app.use('/api/upload', (req, res, next) => {
  req.uploadRequestStartedAt = performance.now();
  next();
});

app.post('/api/upload', requireUploadCode, upload.array('photos'), async (req, res) => {
  const files = req.files || [];
  const requestTraceId = crypto.randomBytes(6).toString('hex');
  timing('REQUEST_BODY_RECEIVED', {
    traceId: requestTraceId,
    elapsedMs: ms(req.uploadRequestStartedAt),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + (f.size || 0), 0)
  });

  if (!files.length) return res.status(400).json({ error: 'NO_FILES' });

  const inboxStart = performance.now();
  const inboxId = await ensureInboxFolder();
  timing('INBOX_READY', { traceId: requestTraceId, elapsedMs: ms(inboxStart) });
  const results = [];

  for (const file of files) {
    const traceId = `${requestTraceId}-${crypto.randomBytes(2).toString('hex')}`;
    const fileStart = performance.now();
    try {
      const originalName = safeName(file.originalname);
      const inboxName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${originalName}`;

      const driveStart = performance.now();
      const saved = await uploadToDrive({
        filePath: file.path,
        filename: inboxName,
        mimeType: file.mimetype,
        parentId: inboxId,
        appProperties: { originalName: originalName.slice(0, 120), uploadState: 'INBOX', classificationDone: 'false' }
      });
      timing('DRIVE_INBOX_UPLOAD', {
        traceId,
        originalName,
        bytes: file.size || 0,
        elapsedMs: ms(driveStart)
      });

      const taskStart = performance.now();
      await enqueuePhotoClassification({ driveFileId: saved.id, traceId });
      timing('TASK_ENQUEUE', { traceId, elapsedMs: ms(taskStart) });
      timing('UPLOAD_FILE_DONE', { traceId, originalName, elapsedMs: ms(fileStart) });

      results.push({ originalName: file.originalname, success: true, uploaded: true, queued: true, driveFileId: saved.id, traceId });
    } catch (error) {
      console.error('upload failed', file.originalname, error);
      timing('UPLOAD_FILE_FAILED', { traceId, originalName: file.originalname, elapsedMs: ms(fileStart), error: error.message });
      results.push({ originalName: file.originalname, success: false, error: error.message, traceId });
    } finally {
      await safeUnlink(file.path);
    }
  }

  const failed = results.filter(r => !r.success).length;
  timing('UPLOAD_REQUEST_DONE', {
    traceId: requestTraceId,
    elapsedMs: ms(req.uploadRequestStartedAt),
    succeeded: files.length - failed,
    failed
  });
  res.status(failed === files.length ? 500 : 200).json({ total: files.length, succeeded: files.length - failed, failed, asyncClassification: true, results });
});

app.post('/api/process-photo', requireTaskCode, async (req, res) => {
  const fileId = String(req.body?.driveFileId || '');
  const traceId = String(req.body?.traceId || fileId.slice(0, 12) || 'unknown');
  if (!fileId) return res.status(400).json({ error: 'MISSING_DRIVE_FILE_ID' });
  const start = performance.now();
  timing('CLASSIFICATION_REQUEST_START', { traceId, driveFileId: fileId });
  try {
    const result = await classifyDrivePhoto(fileId, traceId);
    timing('CLASSIFICATION_REQUEST_DONE', { traceId, elapsedMs: ms(start), ...result });
    res.json({ ok: true, driveFileId: fileId, ...result });
  } catch (error) {
    console.error('classification failed', fileId, error);
    timing('CLASSIFICATION_REQUEST_FAILED', { traceId, elapsedMs: ms(start), error: error.message });
    res.status(500).json({ error: 'CLASSIFICATION_FAILED', message: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on ${port}`));
