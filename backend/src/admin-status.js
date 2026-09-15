import { google } from 'googleapis';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function todayKstDateString() {
  const kst = new Date(Date.now() + KST_OFFSET_MS);
  return [
    kst.getUTCFullYear(),
    String(kst.getUTCMonth() + 1).padStart(2, '0'),
    String(kst.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function kstDayRange(dateString) {
  const value = String(dateString || todayKstDateString()).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    const error = new Error('date must use YYYY-MM-DD format.');
    error.code = 'INVALID_DATE';
    throw error;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcStartMs = Date.UTC(year, month - 1, day) - KST_OFFSET_MS;
  const normalized = new Date(utcStartMs + KST_OFFSET_MS);
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    const error = new Error('date is not a valid calendar date.');
    error.code = 'INVALID_DATE';
    throw error;
  }

  return {
    date: value,
    since: new Date(utcStartMs).toISOString(),
    until: new Date(utcStartMs + 24 * 60 * 60 * 1000).toISOString()
  };
}

function parsePayload(entry) {
  if (entry.jsonPayload && typeof entry.jsonPayload === 'object') return entry.jsonPayload;
  const text = entry.textPayload;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function kstTimestamp(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(date);
}

async function listAllLogEntries({ logging, projectId, filter }) {
  const entries = [];
  let pageToken = null;

  do {
    const response = await logging.entries.list({
      requestBody: {
        resourceNames: [`projects/${projectId}`],
        filter,
        orderBy: 'timestamp desc',
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {})
      }
    });
    entries.push(...(response.data.entries || []));
    pageToken = response.data.nextPageToken || null;
  } while (pageToken);

  return entries;
}

export async function getAdminStatus({ date } = {}) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'auto-sort-507309';
  const serviceName = process.env.K_SERVICE || 'site-photo-uploader';
  const range = kstDayRange(date);

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const logging = google.logging({ version: 'v2', auth });
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${serviceName}"`,
    `timestamp>="${range.since}"`,
    `timestamp<"${range.until}"`,
    '(textPayload:"PHOTO_TIMING" OR textPayload:"PHOTO_FAILURE" OR jsonPayload.type="PHOTO_TIMING" OR jsonPayload.type="PHOTO_FAILURE")'
  ].join(' AND ');

  const entries = await listAllLogEntries({ logging, projectId, filter });
  const parsed = entries
    .map(entry => ({ timestamp: entry.timestamp, payload: parsePayload(entry) }))
    .filter(item => item.payload && (item.payload.type === 'PHOTO_TIMING' || item.payload.type === 'PHOTO_FAILURE'));

  let uploaded = 0;
  let succeeded = 0;
  let duplicate = 0;
  let unclassified = 0;
  let noCaptureDate = 0;
  let lastProcessedAt = null;
  const siteCounts = {};
  const latestByTrace = new Map();
  const errors = [];

  for (const item of parsed) {
    const p = item.payload;
    if (p.event === 'GCS_COMPLETE_BATCH') uploaded += Number(p.fileCount || 0);
    if (p.event === 'CLASSIFICATION_TOTAL') {
      succeeded += 1;
      if (p.duplicate) duplicate += 1;
      if (p.siteName) siteCounts[p.siteName] = (siteCounts[p.siteName] || 0) + 1;
      if (!lastProcessedAt) lastProcessedAt = item.timestamp || null;
    }
    if (p.event === 'PHOTO_UNCLASSIFIED') unclassified += 1;
    if (p.event === 'PHOTO_NO_CAPTURE_DATE') noCaptureDate += 1;

    if (p.traceId && !latestByTrace.has(p.traceId)) latestByTrace.set(p.traceId, p);

    if (p.type === 'PHOTO_FAILURE' && errors.length < 10) {
      errors.push({
        timestamp: item.timestamp || null,
        timestampKst: kstTimestamp(item.timestamp),
        event: p.event || 'UNKNOWN_FAILURE',
        failedStage: p.failedStage || p.stage || null,
        originalName: p.originalName || null,
        siteName: p.siteName || null,
        errorMessage: p.errorMessage || null,
        traceId: p.traceId || null,
        sourcePreserved: typeof p.sourcePreserved === 'boolean' ? p.sourcePreserved : null
      });
    }
  }

  let failed = 0;
  for (const payload of latestByTrace.values()) {
    if (payload.type === 'PHOTO_FAILURE') failed += 1;
  }

  return {
    ok: true,
    period: 'DAY_KST',
    selectedDate: range.date,
    since: range.since,
    until: range.until,
    logEntryCount: entries.length,
    generatedAt: new Date().toISOString(),
    generatedAtKst: kstTimestamp(new Date().toISOString()),
    summary: { uploaded, succeeded, failed, unclassified, duplicate, noCaptureDate },
    lastProcessedAt,
    lastProcessedAtKst: kstTimestamp(lastProcessedAt),
    siteCounts: Object.entries(siteCounts)
      .map(([siteName, count]) => ({ siteName, count }))
      .sort((a, b) => b.count - a.count),
    recentErrors: errors
  };
}
