import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import cors from 'cors';
import sitesConfig from '../config/sites.json' with { type: 'json' };
import { enqueuePhotoClassification } from './tasks.js';
import { classifyGcsPhoto } from './processor.js';
import { createSpeedTestUploadUrl } from './gcs-test.js';
import { createPhotoUploadUrl, getUploadBucketName } from './gcs.js';

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
function failure(event, fields = {}) {
  console.error(JSON.stringify({ type: 'PHOTO_FAILURE', event, ...fields }));
}

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

app.get('/health', (req, res) => res.json({
  ok: true,
  asyncClassification: true,
  uploadMode: 'gcs-direct',
  driveTransport: 'apps-script'
}));

app.get('/api/config', (req, res) => res.json({
  projectId: sitesConfig.projectId,
  projectName: sitesConfig.projectName,
  radiusMeters: sitesConfig.radiusMeters,
  siteCount: sitesConfig.sites.length,
  imageProcessingMode: process.env.IMAGE_PROCESSING_MODE || 'original',
  asyncClassification: true,
  uploadMode: 'gcs-direct',
  driveTransport: 'apps-script',
  maxSelection: Number(process.env.MAX_SELECTION_FILES || 100),
  uploadConcurrency: Number(process.env.UPLOAD_CONCURRENCY || 5)
}));

app.post('/api/gcs-upload-urls', requireUploadCode, async (req, res) => {
  const started = performance.now();
  try {
    const maxSelection = Number(process.env.MAX_SELECTION_FILES || 100);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ error: 'NO_FILES' });
    if (files.length > maxSelection) return res.status(400).json({ error: 'TOO_MANY_FILES', maxSelection });

    const items = await Promise.all(files.map(async (item, index) => {
      const originalName = safeName(String(item?.originalName || `photo-${index + 1}`));
      const contentType = String(item?.contentType || 'application/octet-stream');
      const signed = await createPhotoUploadUrl({ originalName, contentType });
      return { index, originalName, contentType, ...signed, traceId: crypto.randomBytes(8).toString('hex') };
    }));
    timing('GCS_SIGN_BATCH', { fileCount: items.length, elapsedMs: ms(started) });
    res.json({ ok: true, items });
  } catch (error) {
    failure('GCS_UPLOAD_URLS_FAILED', { elapsedMs: ms(started), errorName: error?.name || 'Error', errorMessage: error?.message || String(error) });
    res.status(500).json({ error: 'GCS_UPLOAD_URLS_FAILED', message: error.message });
  }
});

app.post('/api/gcs-upload-complete', requireUploadCode, async (req, res) => {
  const started = performance.now();
  try {
    const expectedBucket = getUploadBucketName();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'NO_COMPLETED_FILES' });

    const results = await Promise.all(items.map(async item => {
      const bucketName = String(item?.bucketName || '');
      const objectName = String(item?.objectName || '');
      const originalName = safeName(String(item?.originalName || 'photo'));
      const contentType = String(item?.contentType || 'application/octet-stream');
      const traceId = String(item?.traceId || crypto.randomBytes(8).toString('hex'));
      if (bucketName !== expectedBucket || !objectName.startsWith('inbox/')) {
        failure('INVALID_GCS_OBJECT', { traceId, bucketName, objectName, originalName, sourcePreserved: true });
        return { originalName, success: false, error: 'INVALID_GCS_OBJECT', traceId };
      }
      try {
        await enqueuePhotoClassification({ source: 'gcs', bucketName, objectName, originalName, contentType, traceId });
        timing('CLOUD_TASK_ENQUEUED', { traceId, bucketName, objectName, originalName });
        return { originalName, success: true, queued: true, traceId };
      } catch (error) {
        failure('CLOUD_TASK_ENQUEUE_FAILED', {
          traceId,
          bucketName,
          objectName,
          originalName,
          sourcePreserved: true,
          errorName: error?.name || 'Error',
          errorMessage: error?.message || String(error)
        });
        return { originalName, success: false, error: error.message, traceId };
      }
    }));

    const failed = results.filter(r => !r.success).length;
    timing('GCS_COMPLETE_BATCH', { fileCount: items.length, failed, elapsedMs: ms(started) });
    res.status(failed === results.length ? 500 : 200).json({ total: results.length, succeeded: results.length - failed, failed, results });
  } catch (error) {
    failure('GCS_UPLOAD_COMPLETE_FAILED', { elapsedMs: ms(started), errorName: error?.name || 'Error', errorMessage: error?.message || String(error) });
    res.status(500).json({ error: 'GCS_UPLOAD_COMPLETE_FAILED', message: error.message });
  }
});

app.post('/api/gcs-test-url', requireUploadCode, async (req, res) => {
  try {
    const originalName = String(req.body?.originalName || 'photo');
    const contentType = String(req.body?.contentType || 'application/octet-stream');
    const signed = await createSpeedTestUploadUrl({ originalName, contentType });
    res.json({ ok: true, ...signed });
  } catch (error) {
    failure('GCS_TEST_URL_FAILED', { errorName: error?.name || 'Error', errorMessage: error?.message || String(error) });
    res.status(500).json({ error: 'GCS_TEST_URL_FAILED', message: error.message });
  }
});

app.post('/api/process-photo', requireTaskCode, async (req, res) => {
  const source = String(req.body?.source || 'gcs');
  const traceId = String(req.body?.traceId || crypto.randomBytes(6).toString('hex'));
  const start = performance.now();
  const bucketName = String(req.body?.bucketName || '');
  const objectName = String(req.body?.objectName || '');
  const originalName = safeName(String(req.body?.originalName || 'photo'));
  timing('CLASSIFICATION_REQUEST_START', { traceId, source, bucketName, objectName, originalName });
  try {
    if (source !== 'gcs') return res.status(400).json({ error: 'UNSUPPORTED_SOURCE' });
    if (!bucketName || !objectName) return res.status(400).json({ error: 'MISSING_GCS_OBJECT' });

    const result = await classifyGcsPhoto({
      bucketName,
      objectName,
      originalName,
      contentType: String(req.body?.contentType || 'application/octet-stream')
    }, traceId);

    timing('CLASSIFICATION_REQUEST_DONE', { traceId, source, elapsedMs: ms(start), bucketName, objectName, originalName, ...result });
    res.json({ ok: true, ...result });
  } catch (error) {
    failure('CLASSIFICATION_REQUEST_FAILED', {
      traceId,
      source,
      elapsedMs: ms(start),
      bucketName,
      objectName,
      originalName,
      sourcePreserved: true,
      errorName: error?.name || 'Error',
      errorMessage: error?.message || String(error)
    });
    res.status(500).json({ error: 'CLASSIFICATION_FAILED', message: error.message });
  }
});

app.use((err, req, res, next) => {
  failure('SERVER_ERROR', { method: req.method, path: req.path, errorName: err?.name || 'Error', errorMessage: err?.message || String(err) });
  res.status(500).json({ error: 'SERVER_ERROR', message: err.message });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on ${port}`));
