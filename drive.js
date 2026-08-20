// drive.js — backs the CSV export up to the user's own Google Drive.
// Uses Google Identity Services (GIS) for OAuth and the Drive v3 REST API
// directly via fetch — no server, so this works from a static GitHub Pages
// site. Scope is drive.file: the app can only see/write files IT created,
// never the rest of the user's Drive.

const LS_CLIENT_ID = 'budget_drive_client_id';
const LS_FILE_ID = 'budget_drive_file_id';
const LS_LAST_SYNC = 'budget_drive_last_sync';
const DRIVE_FILENAME = 'budget_backup.csv';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;

function getClientId() {
  return localStorage.getItem(LS_CLIENT_ID) || '';
}

function setClientId(id) {
  localStorage.setItem(LS_CLIENT_ID, id.trim());
}

function isConfigured() {
  return !!getClientId();
}

function isConnected() {
  return !!accessToken && Date.now() < tokenExpiry;
}

function lastSync() {
  return localStorage.getItem(LS_LAST_SYNC) || null;
}

function ensureTokenClient() {
  if (tokenClient) return tokenClient;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: getClientId(),
    scope: SCOPE,
    callback: () => {} // overridden per-call below
  });
  return tokenClient;
}

function requestToken({ silent } = {}) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      reject(new Error('No Google Client ID configured yet.'));
      return;
    }
    const client = ensureTokenClient();
    client.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error));
        return;
      }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
      resolve(accessToken);
    };
    client.requestAccessToken({ prompt: silent ? '' : 'consent' });
  });
}

async function connect() {
  return requestToken({ silent: false });
}

function disconnect() {
  accessToken = null;
  tokenExpiry = 0;
  localStorage.removeItem(LS_FILE_ID);
  localStorage.removeItem(LS_LAST_SYNC);
}

async function ensureFreshToken() {
  if (isConnected()) return accessToken;
  return requestToken({ silent: true });
}

async function findExistingFileId(token) {
  const cached = localStorage.getItem(LS_FILE_ID);
  if (cached) return cached;
  const q = encodeURIComponent(`name = '${DRIVE_FILENAME}' and trashed = false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.files && data.files.length) {
    localStorage.setItem(LS_FILE_ID, data.files[0].id);
    return data.files[0].id;
  }
  return null;
}

async function backupCsv(csvText) {
  const token = await ensureFreshToken();
  let fileId = await findExistingFileId(token);

  const metadata = { name: DRIVE_FILENAME, mimeType: 'text/csv' };
  const boundary = '-------budgetledgerboundary';
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/csv\r\n\r\n' +
    csvText + '\r\n' +
    `--${boundary}--`;

  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive upload failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  if (!fileId && json.id) {
    localStorage.setItem(LS_FILE_ID, json.id);
  }
  localStorage.setItem(LS_LAST_SYNC, new Date().toISOString());
  return json;
}

window.DriveBackup = {
  getClientId,
  setClientId,
  isConfigured,
  isConnected,
  lastSync,
  connect,
  disconnect,
  backupCsv
};
