const { contextBridge, ipcRenderer } = require('electron');

// Named handler so we can properly remove it on unwatchFile
let _fileChangedCb = null;

contextBridge.exposeInMainWorld('electronAPI', {
  loadSettings:  ()              => ipcRenderer.invoke('load-settings'),
  saveSettings:  (data)          => ipcRenderer.invoke('save-settings', data),
  openFile:      ()              => ipcRenderer.invoke('open-file-dialog'),
  readFile:      (p)             => ipcRenderer.invoke('read-file', p),
  saveFile:      (text)          => ipcRenderer.invoke('save-file', text),
  listZip:       (p)             => ipcRenderer.invoke('list-zip', p),
  readZipEntry:  (p, name)       => ipcRenderer.invoke('read-zip-entry', p, name),
  watchFile: (p, onChanged, onAppended) => {
    if (_fileChangedCb) {
      ipcRenderer.off('file-changed',  _fileChangedCb);
      ipcRenderer.off('file-appended', _fileChangedCb);
      _fileChangedCb = null;
    }
    // file-changed = повне перезавантаження (ротація або gz)
    const changedCb  = (_e, c) => onChanged(c);
    // file-appended = тільки нові рядки
    const appendedCb = (_e, c) => (onAppended || onChanged)(c);
    _fileChangedCb = changedCb; // зберігаємо для cleanup
    ipcRenderer.send('watch-file', p);
    ipcRenderer.on('file-changed',  changedCb);
    ipcRenderer.on('file-appended', appendedCb);
    // зберігаємо обидва для unwatchFile
    _fileChangedCb._appended = appendedCb;
  },
  unwatchFile: () => {
    ipcRenderer.send('unwatch-file');
    if (_fileChangedCb) {
      ipcRenderer.off('file-changed',  _fileChangedCb);
      if (_fileChangedCb._appended) ipcRenderer.off('file-appended', _fileChangedCb._appended);
      _fileChangedCb = null;
    }
  },
  onMenuOpen:      (cb)          => ipcRenderer.on('menu-open-file', cb),
  onOpenFilePath:  (cb)          => ipcRenderer.on('open-file-path', (_e, p) => cb(p)),
  onShowHelp:      (cb)          => ipcRenderer.on('show-help', cb),
  openDiff:      (data)          => ipcRenderer.send('open-diff', data),
  onLoadSaved:   (cb)            => ipcRenderer.on('load-saved', (_e, d) => cb(d)),
  pushLog:       (data)          => ipcRenderer.invoke('push-log', data),
  deleteLog:     (data)          => ipcRenderer.invoke('delete-log', data),
});
