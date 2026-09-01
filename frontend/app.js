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

async function uploadOne(file) {
  const form = new FormData();
  form.append('photos', file, file.name);
  const response = await fetch(`${cfg.API_BASE_URL}/api/upload`, {
    method: 'POST',
    headers: { 'X-Upload-Code': uploadCode.value.trim() },
    body: form
  });
  const body = await response.json().catch(() => ({}));
  const item = body.results?.[0];
  if (!response.ok || !item?.success) throw new Error(item?.error || body.message || body.error || `HTTP ${response.status}`);
  return item;
}

async function uploadAll() {
  const files = [...photos.files];
  const CONCURRENCY = 3;
  let next = 0;
  let completed = 0;
  const results = new Array(files.length);

  uploadBtn.disabled = true;
  pickBtn.disabled = true;
  progressBox.classList.remove('hidden');
  result.classList.add('hidden');
  progress.value = 0;
  progressPercent.textContent = '0%';
  progressText.textContent = `0 / ${files.length} 업로드 완료`;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      try {
        results[index] = { ...(await uploadOne(files[index])), success: true };
      } catch (e) {
        results[index] = { originalName: files[index].name, success: false, error: e.message };
      }
      completed += 1;
      const pct = Math.round(completed / files.length * 100);
      progress.value = pct;
      progressPercent.textContent = `${pct}%`;
      progressText.textContent = `${completed} / ${files.length} 업로드 완료`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
  renderResults(results);
  uploadBtn.disabled = false;
  pickBtn.disabled = false;
}

function renderResults(items) {
  const ok = items.filter(x => x?.success).length;
  const fail = items.length - ok;
  let html = `<div class="summary">업로드 완료 ${ok}장${fail ? ` · 실패 ${fail}장` : ''}</div>`;
  if (ok) html += `<div class="item ok">✓ 업로드가 완료된 사진은 서버에서 자동 분류됩니다.<br><strong>이 페이지를 닫아도 됩니다.</strong></div>`;
  if (fail) html += items.filter(x => !x?.success).map(x => `<div class="item fail">✕ ${escapeHtml(x?.originalName || '사진')}<br>${escapeHtml(x?.error || '업로드 실패')}</div>`).join('');
  result.innerHTML = html;
  result.classList.remove('hidden');
}
function escapeHtml(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
