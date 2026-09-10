const SITE_FOLDER_IDS = Object.freeze({
  '나주 지석천 지석교': '1eWHqE0kMug3EmfGv6_jJ7xp8IHCLmw9U',
  '곡성 목사동천 술랭교': '1jbP-OglbIXAb8VX5Lx8mHTzWZwZ0WXTg',
  '광주 영산강 덕흥보': '1MCjopx3USQcY651RL-yelD3Gz0viOeVi',
  '광주 광주천 치평교': '1P4QSB-PQ03k9XnEqFdEceSKtnzaC3Wfn',
  '장성 동화천 동화1보': '1vdUArv_RLkeQJ4PvTbfAgw2GJuq7w7Bx',
  '함평 고막원천 사정교': '1IlCOC72cF2ILDEr3mI_xwqyWs_Fhe5SU',
  '보성 보성강 송림교': '1ZmF80dwZ1WgyIGIaSUgVs2y_c2IUzbjW',
  '화순 화순천 지곡교': '1e_mnybh4ZVj2Kgm0PL1V1qa1v58zhlN_',
  '나주 송학천 오계교': '17QbkHr0h0TQqweL7Za1ZGUgxbmZj1Szq',
  '광주 광주천 남광교': '1lUM2jWEH-c5f2mOGhOXlmh1XyMpuupn4',
  '미분류': '1xl-rQ7kItukAMEaMLnN8C4G9dZQFCyqH'
});

function json_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getRelayKey_() {
  return PropertiesService.getScriptProperties().getProperty('RELAY_KEY') || '';
}

function validDateFolder_(value) {
  return value === '촬영일미확인' || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getOrCreateChildFolder_(parent, name) {
  const matches = parent.getFoldersByName(name);
  if (matches.hasNext()) return matches.next();
  return parent.createFolder(name);
}

function findExistingFile_(folder, filename) {
  const files = folder.getFilesByName(filename);
  return files.hasNext() ? files.next() : null;
}

function parseDescription_(description) {
  if (!description) return null;
  try {
    const parsed = JSON.parse(description);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function findDuplicateBySha256_(folder, sourceSha256) {
  if (!sourceSha256) return null;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const metadata = parseDescription_(file.getDescription());
    if (metadata && metadata.sourceSha256 === sourceSha256) return file;
  }
  return null;
}

function duplicateFilename_(folder, filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = `${base}_중복${ext}`;
  let index = 2;
  while (findExistingFile_(folder, candidate)) {
    candidate = `${base}_중복${index}${ext}`;
    index += 1;
  }
  return candidate;
}

function doGet() {
  return json_({ ok: true, service: 'auto-sort-drive-relay' });
}

function doPost(e) {
  const started = Date.now();
  try {
    const request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const relayKey = getRelayKey_();
    if (!relayKey || request.relayKey !== relayKey) {
      return json_({ ok: false, error: 'INVALID_RELAY_KEY' });
    }

    const filename = String(request.filename || '').trim();
    const mimeType = String(request.mimeType || 'application/octet-stream');
    const siteName = String(request.siteName || '').trim();
    const dateFolder = String(request.dateFolder || '').trim();
    const fileBase64 = String(request.fileBase64 || '');
    const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata : {};
    const sourceSha256 = String(metadata.sourceSha256 || '').trim().toLowerCase();

    if (!filename || !fileBase64) return json_({ ok: false, error: 'MISSING_FILE' });
    if (!SITE_FOLDER_IDS[siteName]) return json_({ ok: false, error: 'UNKNOWN_SITE' });
    if (!validDateFolder_(dateFolder)) return json_({ ok: false, error: 'INVALID_DATE_FOLDER' });

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return json_({ ok: false, error: 'LOCK_TIMEOUT' });

    try {
      const siteFolder = DriveApp.getFolderById(SITE_FOLDER_IDS[siteName]);
      const targetFolder = getOrCreateChildFolder_(siteFolder, dateFolder);

      // Idempotency for Cloud Tasks retry of the exact same request.
      const existing = findExistingFile_(targetFolder, filename);
      if (existing) {
        return json_({
          ok: true,
          duplicate: false,
          retry: true,
          fileId: existing.getId(),
          filename: existing.getName(),
          elapsedMs: Date.now() - started
        });
      }

      const duplicateOf = findDuplicateBySha256_(targetFolder, sourceSha256);
      const finalFilename = duplicateOf ? duplicateFilename_(targetFolder, filename) : filename;
      const finalMetadata = Object.assign({}, metadata, {
        duplicate: Boolean(duplicateOf),
        duplicateOfFileId: duplicateOf ? duplicateOf.getId() : '',
        duplicateOfFilename: duplicateOf ? duplicateOf.getName() : ''
      });

      const bytes = Utilities.base64Decode(fileBase64);
      const blob = Utilities.newBlob(bytes, mimeType, finalFilename);
      const file = targetFolder.createFile(blob);
      if (Object.keys(finalMetadata).length) {
        file.setDescription(JSON.stringify(finalMetadata).slice(0, 5000));
      }

      return json_({
        ok: true,
        duplicate: Boolean(duplicateOf),
        retry: false,
        duplicateOfFileId: duplicateOf ? duplicateOf.getId() : null,
        duplicateOfFilename: duplicateOf ? duplicateOf.getName() : null,
        fileId: file.getId(),
        filename: file.getName(),
        elapsedMs: Date.now() - started
      });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return json_({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}
