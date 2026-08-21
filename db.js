// db.js — SQLite-in-browser (sql.js/WASM) with IndexedDB persistence.
// The database lives entirely on-device. We keep a single binary blob of the
// SQLite file in IndexedDB and reload it on every page load.

const IDB_NAME = 'budget-ledger-db';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'main';

const DEFAULT_CATEGORIES = [
  ['Housing (rent / room-share)', 6000, 0],
  ['Transport', 2000, 0],
  ['Food & groceries', 2500, 0],
  ['Insurance / medical aid', 1500, 0],
  ['Utilities, phone, data', 800, 0],
  ['Savings & investing', 5500, 0],
  ['Discretionary / fun', 1700, 0]
];

let SQL = null;
let db = null;

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(bytes) {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function initDb() {
  SQL = await initSqlJs({ locateFile: () => 'sql-wasm.wasm' });
  const saved = await idbGet();
  if (saved) {
    db = new SQL.Database(new Uint8Array(saved));
    migrateSchema();
  } else {
    db = new SQL.Database();
    db.run(`
      CREATE TABLE months (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT UNIQUE NOT NULL,
        income REAL NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        planned REAL NOT NULL DEFAULT 0,
        actual REAL NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (month_id) REFERENCES months(id) ON DELETE CASCADE
      );
    `);
    seedMonth(currentYearMonth(), 20000, DEFAULT_CATEGORIES);
    await persist();
  }
  return db;
}

// Adds the `updated` timestamp columns to databases created before sync
// existed. Existing rows get a current stamp so they win ties against
// legacy CSVs that carry no timestamps at all.
function migrateSchema() {
  const monthCols = query('PRAGMA table_info(months)').map((r) => r.name);
  if (!monthCols.includes('updated')) {
    run('ALTER TABLE months ADD COLUMN updated INTEGER NOT NULL DEFAULT 0');
    run('UPDATE months SET updated = ? WHERE updated = 0', [Date.now()]);
  }
  const catCols = query('PRAGMA table_info(categories)').map((r) => r.name);
  if (!catCols.includes('updated')) {
    run('ALTER TABLE categories ADD COLUMN updated INTEGER NOT NULL DEFAULT 0');
    run('UPDATE categories SET updated = ? WHERE updated = 0', [Date.now()]);
  }
}

function seedMonth(yearMonth, income, categories) {
  const ts = Date.now();
  db.run('INSERT INTO months (year_month, income, updated) VALUES (?, ?, ?)', [yearMonth, income, ts]);
  const monthId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  categories.forEach(([name, planned, actual], i) => {
    db.run(
      'INSERT INTO categories (month_id, name, planned, actual, sort_order, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [monthId, name, planned, actual, i, ts]
    );
  });
  return monthId;
}

async function persist() {
  const bytes = db.export();
  await idbSet(bytes);
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
}

// ---- Public data API -------------------------------------------------

function listMonths() {
  return query('SELECT id, year_month, income FROM months ORDER BY year_month DESC');
}

function getOrCreateMonth(yearMonth) {
  const rows = query('SELECT id, year_month, income FROM months WHERE year_month = ?', [yearMonth]);
  if (rows.length) return rows[0];
  const monthId = seedMonth(yearMonth, 20000, DEFAULT_CATEGORIES);
  return { id: monthId, year_month: yearMonth, income: 20000 };
}

function getMonthData(monthId) {
  const month = query('SELECT id, year_month, income FROM months WHERE id = ?', [monthId])[0];
  const categories = query(
    'SELECT id, name, planned, actual, sort_order FROM categories WHERE month_id = ? ORDER BY sort_order, id',
    [monthId]
  );
  return { month, categories };
}

async function updateIncome(monthId, income) {
  run('UPDATE months SET income = ?, updated = ? WHERE id = ?', [income, Date.now(), monthId]);
  await persist();
}

async function updateCategory(catId, field, value) {
  run(`UPDATE categories SET ${field} = ?, updated = ? WHERE id = ?`, [value, Date.now(), catId]);
  await persist();
}

async function addCategory(monthId, name) {
  const maxRow = query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE month_id = ?', [monthId]);
  const nextOrder = (maxRow[0]?.m ?? -1) + 1;
  run(
    'INSERT INTO categories (month_id, name, planned, actual, sort_order, updated) VALUES (?, ?, 0, 0, ?, ?)',
    [monthId, name, nextOrder, Date.now()]
  );
  await persist();
}

async function deleteCategory(catId) {
  run('DELETE FROM categories WHERE id = ?', [catId]);
  await persist();
}

async function renameCategory(catId, name) {
  run('UPDATE categories SET name = ?, updated = ? WHERE id = ?', [name, Date.now(), catId]);
  await persist();
}

function exportAllAsCsv() {
  const rows = query(`
    SELECT m.year_month AS year_month, m.income AS income, m.updated AS m_updated,
           c.name AS category, c.planned AS planned, c.actual AS actual, c.updated AS c_updated
    FROM months m
    JOIN categories c ON c.month_id = m.id
    ORDER BY m.year_month, c.sort_order, c.id
  `);
  const header = ['year_month', 'income', 'm_updated', 'category', 'planned', 'actual', 'c_updated'];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((h) => escape(r[h])).join(','));
  }
  return lines.join('\n');
}

// Merges a remote CSV into the local database without destroying local rows.
// Rows are matched by (year_month, category name). Anything that exists only
// on one side is kept; when both sides have a row, the side with the newer
// `updated` timestamp wins (last-write-wins per row). CSVs from before
// timestamps existed carry no m_updated/c_updated columns — those can only
// contribute brand-new months/categories, never overwrite existing data.
async function mergeRemoteCsv(text) {
  const lines = text.trim().split('\n');
  if (!lines.length || !lines[0].trim()) {
    return { monthsAdded: 0, categoriesAdded: 0, cellsUpdated: 0 };
  }
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const hasTimestamps = idx('m_updated') !== -1 && idx('c_updated') !== -1;
  const stats = { monthsAdded: 0, categoriesAdded: 0, cellsUpdated: 0 };

  const localMonths = new Map();
  query('SELECT id, year_month, income, updated FROM months').forEach((m) => localMonths.set(m.year_month, m));
  const ymById = new Map([...localMonths.values()].map((m) => [m.id, m.year_month]));
  const localCats = new Map();
  query('SELECT id, month_id, name, planned, actual, updated FROM categories').forEach((c) => {
    localCats.set(ymById.get(c.month_id) + '\u0000' + c.name, c);
  });

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const yearMonth = cells[idx('year_month')];
    const income = parseFloat(cells[idx('income')]) || 0;
    const category = cells[idx('category')];
    const planned = parseFloat(cells[idx('planned')]) || 0;
    const actual = parseFloat(cells[idx('actual')]) || 0;
    const mUpdated = hasTimestamps ? parseInt(cells[idx('m_updated')], 10) || 0 : 0;
    const cUpdated = hasTimestamps ? parseInt(cells[idx('c_updated')], 10) || 0 : 0;

    let month = localMonths.get(yearMonth);
    if (!month) {
      run('INSERT INTO months (year_month, income, updated) VALUES (?, ?, ?)', [yearMonth, income, mUpdated]);
      const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      month = { id, year_month: yearMonth, income, updated: mUpdated };
      localMonths.set(yearMonth, month);
      ymById.set(id, yearMonth);
      stats.monthsAdded++;
    } else if (mUpdated > (month.updated || 0)) {
      run('UPDATE months SET income = ?, updated = ? WHERE id = ?', [income, mUpdated, month.id]);
      month.income = income;
      month.updated = mUpdated;
      stats.cellsUpdated++;
    }

    const key = yearMonth + '\u0000' + category;
    const cat = localCats.get(key);
    if (!cat) {
      const ord = query(
        'SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE month_id = ?',
        [month.id]
      )[0].m + 1;
      run(
        'INSERT INTO categories (month_id, name, planned, actual, sort_order, updated) VALUES (?, ?, ?, ?, ?, ?)',
        [month.id, category, planned, actual, ord, cUpdated]
      );
      localCats.set(key, { id: null, month_id: month.id, name: category, planned, actual, updated: cUpdated });
      stats.categoriesAdded++;
    } else if (cUpdated > (cat.updated || 0)) {
      run('UPDATE categories SET planned = ?, actual = ?, updated = ? WHERE id = ?', [planned, actual, cUpdated, cat.id]);
      cat.planned = planned;
      cat.actual = actual;
      cat.updated = cUpdated;
      stats.cellsUpdated++;
    }
  }
  await persist();
  return stats;
}

async function importCsv(text) {
  const lines = text.trim().split('\n');
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  const monthCache = new Map();

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i]);
    const yearMonth = cells[idx('year_month')];
    const income = parseFloat(cells[idx('income')]) || 0;
    const category = cells[idx('category')];
    const planned = parseFloat(cells[idx('planned')]) || 0;
    const actual = parseFloat(cells[idx('actual')]) || 0;

    let monthId = monthCache.get(yearMonth);
    if (monthId === undefined) {
      const existing = query('SELECT id FROM months WHERE year_month = ?', [yearMonth]);
      if (existing.length) {
        monthId = existing[0].id;
        run('UPDATE months SET income = ? WHERE id = ?', [income, monthId]);
      } else {
        run('INSERT INTO months (year_month, income) VALUES (?, ?)', [yearMonth, income]);
        monthId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
      }
      monthCache.set(yearMonth, monthId);
      run('DELETE FROM categories WHERE month_id = ?', [monthId]);
    }
    const cRows = query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE month_id = ?', [monthId]);
    const nextOrder = (cRows[0]?.m ?? -1) + 1;
    run(
      'INSERT INTO categories (month_id, name, planned, actual, sort_order) VALUES (?, ?, ?, ?, ?)',
      [monthId, category, planned, actual, nextOrder]
    );
  }
  await persist();
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

window.BudgetDB = {
  initDb,
  currentYearMonth,
  listMonths,
  getOrCreateMonth,
  getMonthData,
  updateIncome,
  updateCategory,
  addCategory,
  deleteCategory,
  renameCategory,
  exportAllAsCsv,
  importCsv,
  mergeRemoteCsv
};
