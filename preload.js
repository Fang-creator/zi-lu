const { contextBridge, ipcRenderer } = require('electron');

// 安全地暴露系统级别的 API 到网页环境 (Renderer 进程)
contextBridge.exposeInMainWorld('electronAPI', {
  // 获取本地数据库
  getDB: () => ipcRenderer.invoke('get-db'),
  
  // 保存到本地数据库
  saveDB: (data) => ipcRenderer.invoke('save-db', data),
  
  // 导出备份数据
  exportDB: (data) => ipcRenderer.invoke('export-db', data),
  
  // 导入备份数据
  importDB: () => ipcRenderer.invoke('import-db'),
  
  // 显示原生通知
  showNotification: (title, body) => ipcRenderer.send('show-notification', { title, body })
});
