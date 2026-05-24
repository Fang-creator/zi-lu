const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// 1. 获取局域网 IP 地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 兼容 IPv4，排除 127.0.0.1
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = 8080;
const IP = getLocalIP();
const URL = `http://${IP}:${PORT}`;

// 2. 简单的静态文件服务器，用于支持手机直接访问
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // 处理请求路径，防止目录遍历安全问题
  let reqPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, decodeURIComponent(reqPath === '/' ? 'index.html' : reqPath));
  
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // 检查文件是否存在
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 
      'Content-Type': contentType,
      'Cache-Control': 'no-cache' // 调试期间禁用缓存
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.clear();
  console.log('\x1b[35m%s\x1b[0m', '=========================================================');
  console.log('\x1b[36m%s\x1b[0m', '   🌟 自律打卡手机端服务已启动 (Mobile Server Active) 🌟   ');
  console.log('\x1b[35m%s\x1b[0m', '=========================================================');
  console.log();
  console.log(` 💻 电脑本地测试: \x1b[32mhttp://localhost:${PORT}\x1b[0m`);
  console.log(` 📱 手机同局域网: \x1b[33m${URL}\x1b[0m`);
  console.log();
  console.log(' 💡 \x1b[35m温馨提示:\x1b[0m 只要你的手机和电脑连接在同一个 Wi-Fi 网络下，');
  console.log('    即可直接扫描下方二维码，或在手机浏览器输入上方地址直接打开！');
  console.log('    (手机打卡数据支持通过“社交圈-云同步”与电脑版完美互通)');
  console.log();
  console.log('\x1b[36m%s\x1b[0m', ' 📡 正在为你生成手机扫码直达二维码，请稍候...');
  console.log();

  // 3. 自动运行 npx qrcode-terminal 生成终端二维码
  exec(`npx qrcode-terminal "${URL}" small`, (error, stdout, stderr) => {
    if (!error && stdout) {
      console.log(stdout);
    } else {
      console.log(` ⚠️  未能直接渲染二维码，请直接在手机浏览器输入上面的网址:`);
      console.log(` 👉 \x1b[33m${URL}\x1b[0m`);
    }
  });
});
