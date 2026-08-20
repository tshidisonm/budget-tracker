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
  } else {
    db = new SQL.Database();
    db.run(`
      CREATE TABLE months (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year_month TEXT UNIQUE NOT NULL,
        income REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        planned REAL NOT NULL DEFAULT 0,
        actual REAL NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (month_id) REFERENCES months(id) ON DELETE CASCADE
      );
    `);
    seedMonth(currentYearMonth(), 20000, DEFAULT_CATEGORIES);
    await persist();
  }
  return db;
}

function seedMonth(yearMonth, income, categories) {
  db.run('INSERT INTO months (year_month, income) VALUES (?, ?)', [yearMonth, income]);
  const monthId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  categories.forEach(([name, planned, actual], i) => {
    db.run(
      'INSERT INTO categories (month_id, name, planned, actual, sort_order) VALUES (?, ?, ?, ?, ?)',
      [monthId, name, planned, actual, i]
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
  run('UPDATE months SET income = ? WHERE id = ?', [income, monthId]);
  await persist();
}

async function updateCategory(catId, field, value) {
  run(`UPDATE categories SET ${field} = ? WHERE id = ?`, [value, catId]);
  await persist();
}

async function addCategory(monthId, name) {
  const maxRow = query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE month_id = ?', [monthId]);
  const nextOrder = (maxRow[0]?.m ?? -1) + 1;
  run('INSERT INTO categories (month_id, name, planned, actual, sort_order) VALUES (?, ?, 0, 0, ?)', [monthId, name, nextOrder]);
  await persist();
}

async function deleteCategory(catId) {
  run('DELETE FROM categories WHERE id = ?', [catId]);
  await persist();
}

async function renameCategory(catId, name) {
  run('UPDATE categories SET name = ? WHERE id = ?', [name, catId]);
  await persist();
}

function exportAllAsCsv() {
  const rows = query(`
    SELECT m.year_month AS year_month, m.income AS income,
           c.name AS category, c.planned AS planned, c.actual AS actual
    FROM months m
    JOIN categories c ON c.month_id = m.id
    ORDER BY m.year_month, c.sort_order, c.id
  `);
  const header = ['year_month', 'income', 'category', 'planned', 'actual'];
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
  importCsv
};
