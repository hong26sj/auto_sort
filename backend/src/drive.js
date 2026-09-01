import fs from 'node:fs';
import { google } from 'googleapis';

function getAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth environment variables are not configured.');
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

function driveClient() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

function qEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function findOrCreateFolder(name, parentId) {
  const drive = driveClient();
  const q = [
    `name = '${qEscape(name)}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `'${qEscape(parentId)}' in parents`,
    `trashed = false`
  ].join(' and ');

  const found = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 10 });
  if (found.data.files?.length) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id'
  });
  return created.data.id;
}

export async function ensurePhotoFolder(siteName, dateFolder) {
  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured.');
  const siteFolderId = await findOrCreateFolder(siteName, rootId);
  return findOrCreateFolder(dateFolder, siteFolderId);
}

export async function uploadToDrive({ filePath, filename, mimeType, parentId, appProperties }) {
  const drive = driveClient();
  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentId],
      appProperties
    },
    media: { mimeType: mimeType || 'application/octet-stream', body: fs.createReadStream(filePath) },
    fields: 'id,name,size,webViewLink'
  });
  return response.data;
}
