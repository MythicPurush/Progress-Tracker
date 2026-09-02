const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function dataPath(){ return path.join(app.getPath('userData'), 'study-data.json'); }
const defaults = { subjects: ['Mathematics','C++','DSA'], sessions: [], tasks: [], levelPoints: 0, version: 1 };
function readData(){ try { return JSON.parse(fs.readFileSync(dataPath(),'utf8')); } catch { return defaults; } }
function writeData(d){ fs.mkdirSync(path.dirname(dataPath()), {recursive:true}); fs.writeFileSync(dataPath(), JSON.stringify(d,null,2)); }

ipcMain.handle('load-data', () => readData());
ipcMain.handle('save-data', (_, d) => { writeData(d); return true; });
ipcMain.handle('backup', async () => {
  const r = await dialog.showSaveDialog({ title:'Backup study data', defaultPath:'ProgressTracker-backup.json', filters:[{name:'JSON',extensions:['json']}] });
  if(r.canceled) return false; fs.copyFileSync(dataPath(), r.filePath); return true;
});
ipcMain.handle('restore', async () => {
  const r = await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
  if(r.canceled || !r.filePaths[0]) return null; const d=JSON.parse(fs.readFileSync(r.filePaths[0],'utf8')); writeData(d); return d;
});

function createWindow(){
  const win = new BrowserWindow({width:1500,height:950,minWidth:1100,minHeight:700,backgroundColor:'#07111b',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  win.loadFile(path.join(__dirname,'index.html'));
}
app.whenReady().then(()=>{ createWindow(); app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();}); });
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
