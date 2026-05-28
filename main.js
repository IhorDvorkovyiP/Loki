const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const zlib   = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);

let mainWindow = null;
let diffWindow = null;
let watcher    = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 500,
    title: 'Loki',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open log file…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-open-file'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { type: 'separator' },
        {
          label: 'Always on Top',
          type: 'checkbox',
          checked: false,
          click: (item) => mainWindow.setAlwaysOnTop(item.checked),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Інструкції / Features',
          accelerator: 'F1',
          click: () => mainWindow.webContents.send('show-help'),
        },
        { type: 'separator' },
        {
          label: 'Open logs folder',
          click: () => shell.openPath('C:\\Proxima\\preprod\\win64\\server\\log\\server\\primary'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC handlers ───────────────────────────────────────────────────────

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open log file',
    filters: [
      { name: 'Log & archive files', extensions: ['log', 'txt', 'gz', 'zip'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('read-file', async (_event, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gz') {
    const compressed = fs.readFileSync(filePath);
    const decompressed = await gunzip(compressed);
    return decompressed.toString('utf8');
  }
  return fs.readFileSync(filePath, 'utf-8');
});

// ── ZIP support ───────────────────────────────────────────────────────────

ipcMain.handle('list-zip', async (_event, filePath) => {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  return zip.getEntries()
    .filter(e => !e.isDirectory)
    .map(e => e.entryName)
    .filter(name => /\.(log|txt|gz)$/i.test(name) || !/\./.test(path.basename(name)));
});

ipcMain.handle('read-zip-entry', async (_event, filePath, entryName) => {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry(entryName);
  if (!entry) throw new Error(`Entry not found: ${entryName}`);
  let data = entry.getData();
  if (entryName.toLowerCase().endsWith('.gz')) {
    data = await gunzip(data);
  }
  return data.toString('utf8');
});

// ── File watcher helpers ──────────────────────────────────────────────────
// fs.watch is unreliable on Windows when the writer keeps the file handle
// open continuously (e.g. a running server process).
// fs.watchFile uses polling — slower by ~1 s but works in all cases.

let watcherPath = null; // path currently being watched (for fs.unwatchFile)

function stopWatcher() {
  if (watcherPath) {
    try { fs.unwatchFile(watcherPath); } catch {}
    watcherPath = null;
  }
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
}

ipcMain.on('watch-file', (event, filePath) => {
  stopWatcher();
  if (!filePath) return;

  const ext = path.extname(filePath).toLowerCase();
  const isGz = ext === '.gz';

  // ── GZ: full reload on every change (can't do incremental) ──────────────
  if (isGz) {
    let lastSize;
    try { lastSize = fs.statSync(filePath).size; } catch { return; }

    watcherPath = filePath;
    fs.watchFile(filePath, { persistent: true, interval: 800 }, async (curr) => {
      try {
        if (curr.size === lastSize) return;
        lastSize = curr.size;
        const compressed = fs.readFileSync(filePath);
        const content = (await gunzip(compressed)).toString('utf8');
        event.sender.send('file-changed', content);
      } catch {}
    });
    return;
  }

  // ── Plain text: incremental — read only new bytes each poll ──────────────
  let offset = 0;
  let pending = '';
  try { offset = fs.statSync(filePath).size; } catch { return; }

  watcherPath = filePath;
  fs.watchFile(filePath, { persistent: true, interval: 800 }, (curr) => {
    try {
      const size = curr.size;

      // File shrank → rotation/truncate: send full content and reset
      if (size < offset) {
        offset  = 0;
        pending = '';
        const content = fs.readFileSync(filePath, 'utf-8');
        event.sender.send('file-changed', content);
        offset = size;
        return;
      }

      if (size === offset) return; // nothing new

      // Read only the new bytes
      const buf = Buffer.alloc(size - offset);
      const fd  = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;

      // Combine with leftover partial line from previous read
      const chunk = pending + buf.toString('utf-8');

      // Trim incomplete last line (not yet ended with \n)
      const lastNL = chunk.lastIndexOf('\n');
      if (lastNL === -1) {
        pending = chunk;
        return;
      }
      pending = chunk.slice(lastNL + 1);
      const complete = chunk.slice(0, lastNL + 1);

      if (complete.trim()) {
        event.sender.send('file-appended', complete);
      }
    } catch {}
  });
});

ipcMain.on('unwatch-file', () => { stopWatcher(); });

ipcMain.handle('save-file', async (_event, text) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Зберегти логи',
    defaultPath: 'selected_logs.txt',
    filters: [
      { name: 'Text files', extensions: ['txt', 'log'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, text, 'utf-8');
  return true;
});

ipcMain.on('open-diff', (_event, savedData) => {
  if (diffWindow && !diffWindow.isDestroyed()) {
    diffWindow.focus();
    diffWindow.webContents.send('load-saved', savedData);
    return;
  }

  diffWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Loki — JSON Diff',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  diffWindow.loadFile(path.join(__dirname, 'src', 'diff.html'));
  diffWindow.webContents.once('did-finish-load', () => {
    diffWindow.webContents.send('load-saved', savedData);
  });
  diffWindow.on('closed', () => { diffWindow = null; });
});

// ── GitHub sharing helpers ────────────────────────────────────────────────

const SHARE_REPO   = 'IhorDvorkovyiP/Loki';
const SHARE_BRANCH = 'shared-logs';

function getGitHubToken() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      timeout: 3000, encoding: 'utf8',
    });
    const m = out.match(/password=(.+)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function ghRequest(method, path, token, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Loki-app',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const r = d ? JSON.parse(d) : {};
          if (res.statusCode >= 400) reject(new Error(r.message || `HTTP ${res.statusCode}`));
          else resolve(r);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function ensureSharedLogsBranch(token) {
  try {
    await ghRequest('GET', `/repos/${SHARE_REPO}/branches/${SHARE_BRANCH}`, token);
  } catch {
    // Branch doesn't exist — create orphan from main
    const main = await ghRequest('GET', `/repos/${SHARE_REPO}/git/ref/heads/main`, token);
    await ghRequest('POST', `/repos/${SHARE_REPO}/git/refs`, token, {
      ref: `refs/heads/${SHARE_BRANCH}`,
      sha: main.object.sha,
    });
  }
}

// ── Push pharmacy log ─────────────────────────────────────────────────────
ipcMain.handle('push-log', async (_event, { pharmacyId, content }) => {
  const token = getGitHubToken();
  if (!token) throw new Error('NO_TOKEN');

  await ensureSharedLogsBranch(token);

  const filePath = `logs/${pharmacyId}.log`;

  // Get current SHA if file exists (required for update)
  let sha;
  try {
    const existing = await ghRequest('GET',
      `/repos/${SHARE_REPO}/contents/${filePath}?ref=${SHARE_BRANCH}`, token);
    sha = existing.sha;
  } catch { /* new file */ }

  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  const ts      = new Date().toISOString().slice(0, 16).replace('T', ' ');

  await ghRequest('PUT', `/repos/${SHARE_REPO}/contents/${filePath}`, token, {
    message: `log: ${pharmacyId} @ ${ts}`,
    content: encoded,
    branch:  SHARE_BRANCH,
    ...(sha ? { sha } : {}),
  });

  return { pharmacyId };
});

// ── Settings file persistence ─────────────────────────────────────────────
const SETTINGS_PATH = path.join(app.getPath('userData'), 'loki-settings.json');

ipcMain.handle('load-settings', async () => {
  try { return JSON.parse(await fs.promises.readFile(SETTINGS_PATH, 'utf-8')); }
  catch { return null; }
});

ipcMain.handle('save-settings', async (_event, data) => {
  try { await fs.promises.writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8'); }
  catch (e) { console.error('save-settings:', e.message); }
});

app.whenReady().then(() => {
  createWindow();
  // Open file passed as CLI argument: npx electron . /path/to/file.log
  const cliFile = process.argv.slice(2).find(a => !a.startsWith('--') && fs.existsSync(a));
  if (cliFile) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => mainWindow.webContents.send('open-file-path', path.resolve(cliFile)), 300);
    });
  }
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  app.quit();
});
