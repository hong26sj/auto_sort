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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const folderLocks = new Map();

async function listMatchingFolders(drive, name, parentId) {
  const q = [
    `name = '${qEscape(name)}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    `'${qEscape(parentId)}' in parents`,
    `trashed = false`
  ].join(' and ');

  const found = await drive.files.list({
    q,
    fields: 'files(id,name,createdTime)',
    pageSize: 100,
    orderBy: 'createdTime'
  });

  return (found.data.files || []).sort((a, b) => {
    const at = a.createdTime || '';
    const bt = b.createdTime || '';
    if (at !== bt) return at.localeCompare(bt);
    return String(a.id).localeCompare(String(b.id));
  });
}

async function findOrCreateFolderUnlocked(name, parentId) {
  const drive = driveClient();
  const existing = await listMatchingFolders(drive, name, parentId);
  if (existing.length) {
    if (existing.length > 1) {
      console.warn(JSON.stringify({
        type: 'DRIVE_FOLDER_DUPLICATE',
        name,
        parentId,
        canonicalId: existing[0].id,
        duplicateIds: existing.slice(1).map(f => f.id)
      }));
    }
    return existing[0].id;
  }

  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id,name,createdTime'
  });

  // Cloud Run can process several photos concurrently, and different instances can
  // simultaneously observe "folder not found" and create the same date folder.
  // Re-list after creation and deterministically keep the earliest folder.
  // The newly-created losing folder is still empty at this point, so it is safe to trash.
  let canonical = created.data;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sleep(200 * (attempt + 1));
    const all = await listMatchingFolders(drive, name, parentId);
    if (all.length) canonical = all[0];
    if (all.length > 1) {
      console.warn(JSON.stringify({
        type: 'DRIVE_FOLDER_RACE_RESOLVED',
        name,
        parentId,
        canonicalId: canonical.id,
        createdId: created.data.id,
        duplicateIds: all.slice(1).map(f => f.id)
      }));
    }
    if (canonical.id !== created.data.id) {
      await drive.files.update({
        fileId: created.data.id,
        requestBody: { trashed: true }
      }).catch(() => {});
      break;
    }
    if (all.length > 1) break;
  }

  return canonical.id;
}

export async function findOrCreateFolder(name, parentId) {
  const key = `${parentId}\u0000${name}`;
  const previous = folderLocks.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => findOrCreateFolderUnlocked(name, parentId));
  folderLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (folderLocks.get(key) === current) folderLocks.delete(key);
  }
}

function rootFolderId() {
  const rootId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!rootId) throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured.');
  return rootId;
}

export async function ensureInboxFolder() {
  return findOrCreateFolder('00_INBOX', rootFolderId());
}

export async function ensurePhotoFolder(siteName, dateFolder) {
  const siteFolderId = await findOrCreateFolder(siteName, rootFolderId());
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
    fields: 'id,name,size,webViewLink,parents,appProperties,mimeType'
  });
  return response.data;
}

export async function getDriveFile(fileId) {
  const drive = driveClient();
  const response = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,size,parents,appProperties,trashed,webViewLink'
  });
  return response.data;
}

export async function downloadDriveFile(fileId, destinationPath) {
  const drive = driveClient();
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destinationPath);
    response.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    response.data.pipe(out);
  });
  return destinationPath;
}

export async function moveDriveFile({ fileId, parentId, filename, appProperties = {} }) {
  const drive = driveClient();
  const current = await getDriveFile(fileId);
  const removeParents = (current.parents || []).join(',');
  const mergedProperties = { ...(current.appProperties || {}), ...appProperties };

  const response = await drive.files.update({
    fileId,
    addParents: parentId,
    removeParents: removeParents || undefined,
    requestBody: {
      ...(filename ? { name: filename } : {}),
      appProperties: mergedProperties
    },
    fields: 'id,name,size,webViewLink,parents,appProperties'
  });
  return response.data;
}

export async function trashDriveFile(fileId) {
  const drive = driveClient();
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}
