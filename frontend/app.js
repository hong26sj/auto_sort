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
  updateButton();
}
function updateButton() { uploadBtn.disabled = photos.files.length === 0 || uploadCode.value.trim().length === 0; }
function formatBytes(n) { if (!n) return '0 MB'; return `${(n / 1024 / 1024).toFixed(1)} MB`; }

async function uploadAll() {
  const files = [...photos.files];
  const BATCH = 1;
  uploadBtn.disabled = true;
  pickBtn.disabled = true;
  progressBox.classList.remove('hidden');
  result.classList.add('hidden');
  const all = [];

  try {
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const form = new FormData();
      for (const f of batch) form.append('photos', f, f.name);
      progressText.textContent = `${i + 1}–${Math.min(i + BATCH, files.length)} / ${files.length} 처리 중`;
      const response = await fetch(`${cfg.API_BASE_URL}/api/upload`, {
        method: 'POST',
        headers: { 'X-Upload-Code': uploadCode.value.trim() },
        body: form
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body.results) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      all.push(...(body.results || []));
      const pct = Math.round(Math.min(i + BATCH, files.length) / files.length * 100);
      progress.value = pct; progressPercent.textContent = `${pct}%`;
    }
    renderResults(all);
  } catch (e) {
    result.innerHTML = `<div class="summary fail">업로드 중단: ${escapeHtml(e.message)}</div>`;
    result.classList.remove('hidden');
  } finally {
    uploadBtn.disabled = false;
    pickBtn.disabled = false;
  }
}

function renderResults(items) {
  const ok = items.filter(x => x.success).length;
  const fail = items.length - ok;
  result.innerHTML = `<div class="summary">완료 ${ok}장${fail ? ` · 실패 ${fail}장` : ''}</div>` + items.map(x => x.success
    ? `<div class="item ok">✓ ${escapeHtml(x.originalName)}<br>${escapeHtml(x.siteName)} / ${escapeHtml(x.date)}${x.distanceMeters != null ? ` · ${x.distanceMeters}m` : ''}</div>`
    : `<div class="item fail">✕ ${escapeHtml(x.originalName)}<br>${escapeHtml(x.error || '처리 실패')}</div>`).join('');
  result.classList.remove('hidden');
}
function escapeHtml(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
