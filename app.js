// app.js — UI wiring for the Budget Ledger PWA.

let state = {
  monthId: null,
  yearMonth: null
};
let backupTimer = null;

const $ = (sel) => document.querySelector(sel);

function fmtR(n) {
  const v = Number(n) || 0;
  return 'R' + v.toLocaleString('en-ZA', { maximumFractionDigits: 0 });
}

function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function refreshMonthSelector() {
  const months = window.BudgetDB.listMonths();
  const select = $('#monthSelect');
  select.innerHTML = '';
  months.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = monthLabel(m.year_month);
    select.appendChild(opt);
  });
  select.value = state.monthId;
}

function monthLabel(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
}

function shiftYearMonth(yearMonth, delta) {
  const [y, m] = yearMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadMonth(monthId) {
  const { month, categories } = window.BudgetDB.getMonthData(monthId);
  state.monthId = month.id;
  state.yearMonth = month.year_month;
  $('#incomeInput').value = month.income;
  renderCategories(categories);
  recalcSummary(month.income, categories);
  await refreshMonthSelector();
}

function renderCategories(categories) {
  const body = $('#ledgerBody');
  body.innerHTML = '';
  categories.forEach((cat) => {
    const tr = document.createElement('tr');
    tr.dataset.id = cat.id;
    tr.innerHTML = `
      <td class="col-name"><input class="cat-name-input" value="${escapeAttr(cat.name)}" /></td>
      <td class="col-amount"><input class="cat-amount-input" type="number" inputmode="decimal" data-field="planned" value="${cat.planned}" /></td>
      <td class="col-amount"><input class="cat-amount-input" type="number" inputmode="decimal" data-field="actual" value="${cat.actual}" /></td>
      <td class="col-action"><button class="row-delete" aria-label="Delete category">✕</button></td>
    `;
    body.appendChild(tr);
  });
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function recalcSummary(income, categories) {
  const totalPlanned = categories.reduce((s, c) => s + Number(c.planned), 0);
  const totalActual = categories.reduce((s, c) => s + Number(c.actual), 0);
  const remaining = income - totalPlanned;
  const savingsCategory = categories.find((c) => /saving|invest|tfsa/i.test(c.name));
  const savingsRate = income > 0 && savingsCategory ? (Number(savingsCategory.planned) / income) : 0;

  $('#totalPlanned').textContent = fmtR(totalPlanned);
  $('#totalActual').textContent = fmtR(totalActual);
  const remainingEl = $('#remaining');
  remainingEl.textContent = fmtR(remaining);
  remainingEl.parentElement.classList.toggle('negative', remaining < 0);
  $('#savingsRate').textContent = (savingsRate * 100).toFixed(1) + '%';
}

async function currentCategoriesAndIncome() {
  const { month, categories } = window.BudgetDB.getMonthData(state.monthId);
  return { income: month.income, categories };
}

async function afterDataChange() {
  const { income, categories } = await currentCategoriesAndIncome();
  recalcSummary(income, categories);
  scheduleAutoBackup();
}

function scheduleAutoBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(runAutoBackup, 1500);
}

async function runAutoBackup() {
  if (!window.DriveBackup.isConfigured()) {
    setBackupStatus('off', 'Drive backup not connected');
    return;
  }
  try {
    setBackupStatus('syncing', 'Backing up…');
    const csv = window.BudgetDB.exportAllAsCsv();
    await window.DriveBackup.backupCsv(csv);
    setBackupStatus('on', 'Synced ' + new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' }));
  } catch (err) {
    console.error(err);
    setBackupStatus('error', 'Drive sync failed — tap Connect to reconnect');
  }
}

function setBackupStatus(kind, text) {
  const dot = $('#backupDot');
  dot.className = 'dot ' + (kind === 'on' ? 'dot-on' : kind === 'error' ? 'dot-error' : kind === 'syncing' ? 'dot-on' : 'dot-off');
  $('#backupStatusText').textContent = text;
}

function refreshBackupUiIdle() {
  if (!window.DriveBackup.isConfigured()) {
    setBackupStatus('off', 'Drive backup not connected');
  } else {
    const last = window.DriveBackup.lastSync();
    setBackupStatus(
      window.DriveBackup.isConnected() ? 'on' : 'off',
      last ? 'Last synced ' + new Date(last).toLocaleString('en-ZA') : 'Connected — will sync on next change'
    );
  }
}

// ---------------- Event wiring ----------------

function wireEvents() {
  $('#incomeInput').addEventListener('change', async (e) => {
    await window.BudgetDB.updateIncome(state.monthId, parseFloat(e.target.value) || 0);
    afterDataChange();
  });

  $('#ledgerBody').addEventListener('change', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const catId = Number(tr.dataset.id);
    if (e.target.classList.contains('cat-amount-input')) {
      const field = e.target.dataset.field;
      await window.BudgetDB.updateCategory(catId, field, parseFloat(e.target.value) || 0);
      afterDataChange();
    } else if (e.target.classList.contains('cat-name-input')) {
      await window.BudgetDB.renameCategory(catId, e.target.value.trim() || 'Untitled');
      afterDataChange();
    }
  });

  $('#ledgerBody').addEventListener('click', async (e) => {
    if (e.target.classList.contains('row-delete')) {
      const tr = e.target.closest('tr');
      const catId = Number(tr.dataset.id);
      await window.BudgetDB.deleteCategory(catId);
      tr.remove();
      afterDataChange();
    }
  });

  $('#addCategoryBtn').addEventListener('click', async () => {
    await window.BudgetDB.addCategory(state.monthId, 'New category');
    const { categories } = window.BudgetDB.getMonthData(state.monthId);
    renderCategories(categories);
    afterDataChange();
  });

  $('#monthSelect').addEventListener('change', (e) => loadMonth(Number(e.target.value)));

  $('#prevMonth').addEventListener('click', () => switchByDelta(-1));
  $('#nextMonth').addEventListener('click', () => switchByDelta(1));

  $('#newMonthBtn').addEventListener('click', () => {
    const next = shiftYearMonth(state.yearMonth, 1);
    const m = window.BudgetDB.getOrCreateMonth(next);
    loadMonth(m.id);
  });

  $('#downloadCsvBtn').addEventListener('click', () => {
    const csv = window.BudgetDB.exportAllAsCsv();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'budget_backup.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  $('#importCsvInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    await window.BudgetDB.importCsv(text);
    showToast('CSV imported');
    await loadMonth(state.monthId);
    e.target.value = '';
  });

  $('#settingsBtn').addEventListener('click', () => {
    $('#clientIdInput').value = window.DriveBackup.getClientId();
    const last = window.DriveBackup.lastSync();
    $('#lastSyncNote').textContent = last ? 'Last synced: ' + new Date(last).toLocaleString('en-ZA') : 'Never synced yet.';
    $('#settingsModal').classList.remove('hidden');
  });
  $('#closeSettingsBtn').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));

  $('#saveClientIdBtn').addEventListener('click', () => {
    window.DriveBackup.setClientId($('#clientIdInput').value);
    showToast('Client ID saved');
    refreshBackupUiIdle();
  });

  $('#disconnectDriveBtn').addEventListener('click', () => {
    window.DriveBackup.disconnect();
    refreshBackupUiIdle();
    showToast('Disconnected from Drive');
  });

  $('#connectDriveBtn').addEventListener('click', async () => {
    if (!window.DriveBackup.isConfigured()) {
      $('#clientIdInput').value = '';
      $('#settingsModal').classList.remove('hidden');
      showToast('Add your Google Client ID first');
      return;
    }
    try {
      await window.DriveBackup.connect();
      showToast('Connected to Google Drive');
      runAutoBackup();
    } catch (err) {
      console.error(err);
      showToast('Could not connect to Drive');
    }
  });
}

async function switchByDelta(delta) {
  const target = shiftYearMonth(state.yearMonth, delta);
  const m = window.BudgetDB.getOrCreateMonth(target);
  await loadMonth(m.id);
}

// ---------------- Boot ----------------

async function boot() {
  await window.BudgetDB.initDb();
  const ym = window.BudgetDB.currentYearMonth();
  const month = window.BudgetDB.getOrCreateMonth(ym);
  wireEvents();
  await loadMonth(month.id);
  refreshBackupUiIdle();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

boot();
