const cfg = window.APP_CONFIG;
const photos = document.querySelector('#photos');
const pickBtn = document.querySelector('#pickBtn');
const uploadBtn = document.querySelector('#uploadBtn');
const uploadCode = document.querySelector('#uploadCode');
const fileCount = document.querySelector('#fileCount');
const fileSize = document.querySelector('#fileSize');
const progressBox = document.querySelector('#progressBox');
const progress = document.querySelector('#progress');
const progressText = document.querySelector('#progressText');
const progressPercent = document.querySelector('#progressPercent');
const result = document.querySelector('#result');
document.querySelector('#projectName').textContent = cfg.PROJECT_NAME;

const MAX_SELECTION = 100;
const CONCURRENCY = 5;

pickBtn.addEventListener('click', () => photos.click());
photos.addEventListener('change', renderSelection);
uploadCode.addEventListener('input', updateButton);
uploadBtn.addEventListener('click', uploadAll);

function renderSelection() {
  const files = [...photos.files];
  const bytes = files.reduce((s, f) => s + f.size, 0);
  fileCount.textContent = `${files.length}장`;
  fileSize.textContent = ` · ${formatBytes(bytes)}`;
  result.classList.add('hidden');
  if (files.length > MAX_SELECTION) {
    result.innerHTML = `<div class="item fail">한 번에 최대 ${MAX_SELECTION}장까지 선택할 수 있습니다.</div>`;
    result.classList.remove('hidden');
  }
  updateButton();
}

function updateButton() {
  const n = photos.files.length;
  uploadBtn.disabled = n === 0 || n > MAX_SELECTION || uploadCode.value.trim().length === 0;
}

function formatBytes(n) {
  if (!n) return '0 MB';
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function requestUploadUrls(files) {
  const response = await fetch(`${cfg.API_BASE_URL}/api/gcs-upload-urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Upload-Code': uploadCode.value.trim()
    },
    body: JSON.stringify({
      files: files.map(f => ({ originalName: f.name, contentType: f.type || 'application/octet-stream' }))
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(body.items)) {
    throw new Error(body.message || body.error || `Signed URL 발급 실패 (HTTP ${response.status})`);
  }
  return body.items;
}

async function putToGcs(file, signed) {
  const response = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': signed.contentType },
    body: file
  });
  if (!response.ok) throw new Error(`GCS 업로드 실패 (HTTP ${response.status})`);
  return signed;
}

async function notifyUploadComplete(items) {
  const response = await fetch(`${cfg.API_BASE_URL}/api/gcs-upload-complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Upload-Code': uploadCode.value.trim()
    },
    body: JSON.stringify({ items })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !Array.isArray(body.results)) {
    throw new Error(body.message || body.error || `분류 등록 실패 (HTTP ${response.status})`);
  }
  return body.results || [];
}

async function uploadAll() {
  const files = [...photos.files];
  if (!files.length || files.length > MAX_SELECTION) return;

  uploadBtn.disabled = true;
  pickBtn.disabled = true;
  progressBox.classList.remove('hidden');
  result.classList.add('hidden');
  progress.value = 0;
  progressPercent.textContent = '0%';
  progressText.textContent = `업로드 준비 중 · 0 / ${files.length}`;

  let signedItems;
  try {
    signedItems = await requestUploadUrls(files);
  } catch (e) {
    renderResults(files.map(f => ({ originalName: f.name, success: false, error: e.message })));
    uploadBtn.disabled = false;
    pickBtn.disabled = false;
    return;
  }

  let next = 0;
  let completed = 0;
  const putResults = new Array(files.length);

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      try {
        const signed = signedItems[index];
        await putToGcs(files[index], signed);
        putResults[index] = { ...signed, originalName: files[index].name, success: true };
      } catch (e) {
        putResults[index] = { originalName: files[index].name, success: false, error: e.message };
      }
      completed += 1;
      const pct = Math.round(completed / files.length * 100);
      progress.value = pct;
      progressPercent.textContent = `${pct}%`;
      progressText.textContent = `${completed} / ${files.length} GCS 업로드 완료`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));

  const uploaded = putResults.filter(x => x?.success).map(x => ({
    bucketName: x.bucketName,
    objectName: x.objectName,
    originalName: x.originalName,
    contentType: x.contentType,
    traceId: x.traceId
  }));

  let queueResults = [];
  if (uploaded.length) {
    progressText.textContent = `업로드 완료 · 자동 분류 등록 중`;
    try {
      queueResults = await notifyUploadComplete(uploaded);
    } catch (e) {
      queueResults = uploaded.map(x => ({ originalName: x.originalName, success: false, error: e.message }));
    }
  }

  const queueByName = new Map(queueResults.map(x => [x.originalName, x]));
  const finalResults = putResults.map(x => {
    if (!x?.success) return x;
    const queued = queueByName.get(x.originalName);
    if (!queued?.success) return { originalName: x.originalName, success: false, error: queued?.error || '자동 분류 등록 실패' };
    return { originalName: x.originalName, success: true, queued: true };
  });

  renderResults(finalResults);
  uploadBtn.disabled = false;
  pickBtn.disabled = false;
}

function renderResults(items) {
  const ok = items.filter(x => x?.success).length;
  const fail = items.length - ok;
  let html = `<div class="summary">업로드 완료 ${ok}장${fail ? ` · 실패 ${fail}장` : ''}</div>`;
  if (ok) html += `<div class="item ok">✓ Cloud Storage 업로드와 자동 분류 등록이 완료되었습니다.<br><strong>이 페이지를 닫아도 됩니다.</strong></div>`;
  if (fail) html += items.filter(x => !x?.success).map(x => `<div class="item fail">✕ ${escapeHtml(x?.originalName || '사진')}<br>${escapeHtml(x?.error || '업로드 실패')}</div>`).join('');
  result.innerHTML = html;
  result.classList.remove('hidden');
}

function escapeHtml(v='') {
  return String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
