const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// 获取数据库文件路径
function getDbPath() {
  return path.join(app.getPath('userData'), 'db.json');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 800,
    minWidth: 1000,
    minHeight: 700,
    title: "自律打卡 Habit Tracker",
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    backgroundColor: '#0a0d14', // 匹配深色背景防闪烁
    show: false // 先隐藏，等准备好了再显示
  });

  mainWindow.loadFile('index.html');

  // 优雅的显示窗口
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 确保单实例运行
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // 注册 IPC 通道事件监听
    setupIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 设置 IPC 通道通信句柄
function setupIpcHandlers() {
  // 1. 读取数据库
  ipcMain.handle('get-db', async () => {
    try {
      const dbPath = getDbPath();
      if (!fs.existsSync(dbPath)) {
        return null; // 返回 null，由渲染进程初始化默认数据
      }
      const data = fs.readFileSync(dbPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('读取数据库失败:', error);
      throw error;
    }
  });

  // 2. 保存数据库
  ipcMain.handle('save-db', async (event, data) => {
    try {
      const dbPath = getDbPath();
      // 确保父目录存在
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('保存数据库失败:', error);
      throw error;
    }
  });

  // 3. 导出数据库
  ipcMain.handle('export-db', async (event, dataToExport) => {
    try {
      if (!mainWindow) return false;
      const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
        title: '备份/导出打卡数据',
        defaultPath: path.join(app.getPath('downloads'), 'zi-lu-habits-backup.json'),
        filters: [
          { name: 'JSON 数据备份 (*.json)', extensions: ['json'] }
        ]
      });

      if (canceled || !filePath) return false;

      fs.writeFileSync(filePath, JSON.stringify(dataToExport, null, 2), 'utf8');
      return { success: true, path: filePath };
    } catch (error) {
      console.error('导出备份失败:', error);
      throw error;
    }
  });

  // 4. 导入数据库
  ipcMain.handle('import-db', async () => {
    try {
      if (!mainWindow) return null;
      const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
        title: '导入打卡备份数据',
        filters: [
          { name: 'JSON 数据备份 (*.json)', extensions: ['json'] }
        ],
        properties: ['openFile']
      });

      if (canceled || filePaths.length === 0) return null;

      const filePath = filePaths[0];
      const data = fs.readFileSync(filePath, 'utf8');
      
      // 简单验证数据有效性
      const parsedData = JSON.parse(data);
      if (!parsedData.habits || !parsedData.checkIns) {
        throw new Error('无效的备份文件结构！必须包含 habits 和 checkIns。');
      }

      return { data: parsedData, success: true, path: filePath };
    } catch (error) {
      console.error('导入备份失败:', error);
      throw error;
    }
  });

  // 5. 原生系统通知
  ipcMain.on('show-notification', (event, { title, body }) => {
    try {
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: title || '自律打卡提醒',
          body: body || '您设置的时间到了，快来打卡吧！',
          silent: false
        });
        notif.show();

        // 点击通知唤起窗口
        notif.on('click', () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
          }
        });
      }
    } catch (error) {
      console.error('触发通知失败:', error);
    }
  });
}
