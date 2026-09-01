const cfg = window.APP_CONFIG;
const photos = document.querySelector('#photos');
const pickBtn = document.querySelector('#pickBtn');
const testBtn = document.querySelector('#testBtn');
const uploadCode = document.querySelector('#uploadCode');
const concurrencyEl = document.querySelector('#concurrency');
const fileCount = document.querySelector('#fileCount');
const fileSize = document.querySelector('#fileSize');
const progressBox = document.querySelector('#progressBox');
const progress = document.querySelector('#progress');
const progressText = document.querySelector('#progressText');
const progressPercent = document.querySelector('#progressPercent');
const result = document.querySelector('#result');

pickBtn.addEventListener('click', () => photos.click());
photos.addEventListener('change', renderSelection);
uploadCode.addEventListener('input', updateButton);
testBtn.addEventListener('click', runTest);

function renderSelection() {
  const files = [...photos.files];
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  fileCount.textContent = `${files.length}장`;
  fileSize.textContent = ` · ${formatBytes(bytes)}`;
  result.classList.add('hidden');
  updateButton();
}

function updateButton() {
  testBtn.disabled = photos.files.length === 0 || uploadCode.value.trim().length === 0;
}

function formatBytes(n) {
  if (!n) return '0 MB';
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function getSignedUrl(file) {
  const response = await fetch(`${cfg.API_BASE_URL}/api/gcs-test-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Upload-Code': uploadCode.value.trim()
    },
    body: JSON.stringify({ originalName: file.name, contentType: file.type || 'application/octet-stream' })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `Signed URL HTTP ${response.status}`);
  return body;
}

async function uploadDirect(file) {
  const signedStart = performance.now();
  const signed = await getSignedUrl(file);
  const signedMs = performance.now() - signedStart;

  const uploadStart = performance.now();
  const response = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  const uploadMs = performance.now() - uploadStart;
  if (!response.ok) throw new Error(`GCS upload HTTP ${response.status}`);

  return { name: file.name, size: file.size, signedMs, uploadMs, objectName: signed.objectName };
}

async function runTest() {
  const files = [...photos.files];
  const concurrency = Number(concurrencyEl.value || 3);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const results = new Array(files.length);
  let next = 0;
  let completed = 0;

  testBtn.disabled = true;
  pickBtn.disabled = true;
  progressBox.classList.remove('hidden');
  result.classList.add('hidden');
  progress.value = 0;
  progressPercent.textContent = '0%';
  progressText.textContent = `0 / ${files.length} 완료`;

  const totalStart = performance.now();
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      try {
        results[index] = { ...(await uploadDirect(files[index])), success: true };
      } catch (error) {
        results[index] = { name: files[index].name, size: files[index].size, success: false, error: error.message };
      }
      completed += 1;
      const pct = Math.round(completed / files.length * 100);
      progress.value = pct;
      progressPercent.textContent = `${pct}%`;
      progressText.textContent = `${completed} / ${files.length} 완료`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  const totalMs = performance.now() - totalStart;
  const ok = results.filter(r => r?.success);
  const failed = results.length - ok.length;
  const uploadedBytes = ok.reduce((sum, r) => sum + r.size, 0);
  const mbps = totalMs > 0 ? (uploadedBytes * 8 / 1_000_000) / (totalMs / 1000) : 0;
  const MBps = totalMs > 0 ? (uploadedBytes / 1024 / 1024) / (totalMs / 1000) : 0;
  const avgUploadMs = ok.length ? ok.reduce((sum, r) => sum + r.uploadMs, 0) / ok.length : 0;
  const avgSignedMs = ok.length ? ok.reduce((sum, r) => sum + r.signedMs, 0) / ok.length : 0;

  result.innerHTML = `
    <div class="summary">GCS 속도 테스트 완료</div>
    <div class="item ok">
      선택 ${files.length}장 · 성공 ${ok.length}장${failed ? ` · 실패 ${failed}장` : ''}<br>
      총 용량: <strong>${formatBytes(totalBytes)}</strong><br>
      동시 업로드: <strong>${concurrency}장</strong><br>
      총 소요시간: <strong>${(totalMs / 1000).toFixed(2)}초</strong><br>
      전체 처리량: <strong>${MBps.toFixed(2)} MB/s (${mbps.toFixed(1)} Mbps)</strong><br>
      파일당 GCS PUT 평균: <strong>${(avgUploadMs / 1000).toFixed(2)}초</strong><br>
      Signed URL 발급 평균: <strong>${(avgSignedMs / 1000).toFixed(2)}초</strong>
    </div>
    ${failed ? results.filter(r => !r?.success).map(r => `<div class="item fail">✕ ${escapeHtml(r.name)}<br>${escapeHtml(r.error)}</div>`).join('') : ''}
  `;
  result.classList.remove('hidden');
  testBtn.disabled = false;
  pickBtn.disabled = false;
}

function escapeHtml(v='') {
  return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
