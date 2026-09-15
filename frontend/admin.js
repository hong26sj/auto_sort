const API_BASE = String(window.APP_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);

let refreshTimer = null;

function getCode() {
  return sessionStorage.getItem('autoSortAdminCode') || '';
}

function setCode(code) {
  sessionStorage.setItem('autoSortAdminCode', code);
}

function clearCode() {
  sessionStorage.removeItem('autoSortAdminCode');
}

function todayKstDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDays(dateString, days) {
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function selectedDate() {
  return $('datePicker').value || todayKstDateString();
}

function updateDateControls() {
  const today = todayKstDateString();
  const current = selectedDate();
  $('datePicker').max = today;
  $('nextDateBtn').disabled = current >= today;
  $('todayBtn').disabled = current === today;
}

function showLogin(message = '') {
  $('dashboard').classList.add('hidden');
  $('loginPanel').classList.remove('hidden');
  $('loginMessage').textContent = message;
  $('adminCode').value = '';
  $('adminCode').focus();
}

function showDashboard() {
  $('loginPanel').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
}

function renderSiteCounts(items = []) {
  const el = $('siteCounts');
  if (!items.length) {
    el.className = 'site-list empty';
    el.textContent = '처리 내역 없음';
    return;
  }
  el.className = 'site-list';
  el.innerHTML = items.map(item => `
    <div class="site-row">
      <span>${escapeHtml(item.siteName)}</span>
      <strong>${Number(item.count || 0).toLocaleString('ko-KR')}</strong>
    </div>
  `).join('');
}

function renderErrors(items = []) {
  const el = $('errors');
  if (!items.length) {
    el.className = 'error-list empty';
    el.textContent = '오류 없음';
    return;
  }
  el.className = 'error-list';
  el.innerHTML = items.map(item => `
    <div class="error-row">
      <div class="error-top">
        <strong>${escapeHtml(item.failedStage || item.event || '오류')}</strong>
        <span>${escapeHtml(item.timestampKst || '-')}</span>
      </div>
      <div class="error-name">${escapeHtml(item.originalName || '-')}</div>
      <div class="error-msg">${escapeHtml(item.errorMessage || '-')}</div>
      <div class="error-meta">${item.siteName ? `지점: ${escapeHtml(item.siteName)} · ` : ''}trace: ${escapeHtml(item.traceId || '-')}</div>
    </div>
  `).join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadStatus({ silent = false } = {}) {
  const code = getCode();
  if (!code) {
    showLogin();
    return;
  }

  const date = selectedDate();
  if (!silent) $('refreshBtn').disabled = true;
  try {
    const response = await fetch(`${API_BASE}/api/admin/status?date=${encodeURIComponent(date)}`, {
      method: 'GET',
      headers: { 'X-Admin-Code': code },
      cache: 'no-store'
    });

    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      clearCode();
      showLogin('관리자 코드가 올바르지 않습니다.');
      return;
    }
    if (response.status === 503 && data.error === 'ADMIN_NOT_CONFIGURED') {
      showLogin('Cloud Run에 ADMIN_CODE 설정이 필요합니다.');
      return;
    }
    if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);

    showDashboard();
    const s = data.summary || {};
    $('uploaded').textContent = Number(s.uploaded || 0).toLocaleString('ko-KR');
    $('succeeded').textContent = Number(s.succeeded || 0).toLocaleString('ko-KR');
    $('failed').textContent = Number(s.failed || 0).toLocaleString('ko-KR');
    $('unclassified').textContent = Number(s.unclassified || 0).toLocaleString('ko-KR');
    $('duplicate').textContent = Number(s.duplicate || 0).toLocaleString('ko-KR');
    $('noCaptureDate').textContent = Number(s.noCaptureDate || 0).toLocaleString('ko-KR');
    $('selectedDateLabel').textContent = `조회일: ${data.selectedDate || date}`;
    $('generatedAt').textContent = `갱신: ${data.generatedAtKst || '-'}`;
    $('lastProcessed').textContent = `마지막 처리: ${data.lastProcessedAtKst || '-'}`;
    renderSiteCounts(data.siteCounts || []);
    renderErrors(data.recentErrors || []);
  } catch (error) {
    if (!silent) alert(`관리자 현황 조회 실패: ${error.message}`);
  } finally {
    $('refreshBtn').disabled = false;
    updateDateControls();
  }
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('adminCode').value.trim();
  if (!code) return;
  setCode(code);
  await loadStatus();
});

$('refreshBtn').addEventListener('click', () => loadStatus());
$('changeCodeBtn').addEventListener('click', () => {
  clearCode();
  showLogin();
});

$('prevDateBtn').addEventListener('click', async () => {
  $('datePicker').value = addDays(selectedDate(), -1);
  updateDateControls();
  await loadStatus();
});

$('nextDateBtn').addEventListener('click', async () => {
  const next = addDays(selectedDate(), 1);
  const today = todayKstDateString();
  $('datePicker').value = next > today ? today : next;
  updateDateControls();
  await loadStatus();
});

$('todayBtn').addEventListener('click', async () => {
  $('datePicker').value = todayKstDateString();
  updateDateControls();
  await loadStatus();
});

$('datePicker').addEventListener('change', async () => {
  const today = todayKstDateString();
  if (!$('datePicker').value || $('datePicker').value > today) $('datePicker').value = today;
  updateDateControls();
  await loadStatus();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && getCode()) loadStatus({ silent: true });
});

$('datePicker').value = todayKstDateString();
updateDateControls();
loadStatus();
refreshTimer = setInterval(() => {
  if (!document.hidden && getCode()) loadStatus({ silent: true });
}, 60000);
