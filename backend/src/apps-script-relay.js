import fs from 'node:fs/promises';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function uploadViaAppsScript({
  filePath,
  filename,
  mimeType,
  siteName,
  dateFolder,
  metadata = {}
}) {
  const webAppUrl = requiredEnv('APPS_SCRIPT_WEB_APP_URL');
  const relayKey = requiredEnv('APPS_SCRIPT_RELAY_KEY');
  const timeoutMs = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 120000);
  const maxEncodedBytes = Number(process.env.APPS_SCRIPT_MAX_ENCODED_BYTES || 40 * 1024 * 1024);

  const fileBuffer = await fs.readFile(filePath);
  const fileBase64 = fileBuffer.toString('base64');
  const encodedBytes = Buffer.byteLength(fileBase64, 'utf8');
  if (encodedBytes > maxEncodedBytes) {
    throw new Error(`Processed photo exceeds Apps Script relay limit (${encodedBytes} > ${maxEncodedBytes}).`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webAppUrl, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        relayKey,
        filename,
        mimeType: mimeType || 'application/octet-stream',
        siteName,
        dateFolder,
        metadata,
        fileBase64
      }),
      signal: controller.signal
    });

    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      throw new Error(`Apps Script relay HTTP ${response.status}: ${body?.error || text.slice(0, 300)}`);
    }
    if (!body?.ok) {
      throw new Error(`Apps Script relay failed: ${body?.error || 'UNKNOWN_RELAY_ERROR'}`);
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Apps Script relay timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
