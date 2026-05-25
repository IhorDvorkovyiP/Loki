const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow = null;
let watcher    = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 500,
    title: 'Loki',
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
      { name: 'Log files', extensions: ['log', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('read-file', async (_event, filePath) => {
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.on('watch-file', (event, filePath) => {
  if (watcher) { watcher.close(); watcher = null; }
  let lastSize = fs.statSync(filePath).size;
  watcher = fs.watch(filePath, () => {
    try {
      const size = fs.statSync(filePath).size;
      if (size === lastSize) return;
      lastSize = size;
      const content = fs.readFileSync(filePath, 'utf-8');
      event.sender.send('file-changed', content);
    } catch {}
  });
});

ipcMain.on('unwatch-file', () => {
  if (watcher) { watcher.close(); watcher = null; }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  app.quit();
});
