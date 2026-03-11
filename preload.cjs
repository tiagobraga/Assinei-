const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
    getCertificates: () => ipcRenderer.invoke('get-certificates'),
    signPdf: (payload) => ipcRenderer.invoke('sign-pdf', payload)
});
