const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:    ()           => ipcRenderer.invoke('open-file-dialog'),
  readFile:    (p)          => ipcRenderer.invoke('read-file', p),
  watchFile:   (p, cb)      => { ipcRenderer.send('watch-file', p); ipcRenderer.on('file-changed', (_e, c) => cb(c)); },
  unwatchFile: ()           => { ipcRenderer.send('unwatch-file'); ipcRenderer.removeAllListeners('file-changed'); },
  onMenuOpen:  (cb)         => ipcRenderer.on('menu-open-file', cb),
});
