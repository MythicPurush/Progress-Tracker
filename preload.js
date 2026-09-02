const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studyAPI', {
  load:()=>ipcRenderer.invoke('load-data'),
  save:d=>ipcRenderer.invoke('save-data',d),
  backup:()=>ipcRenderer.invoke('backup'),
  restore:()=>ipcRenderer.invoke('restore')
});
