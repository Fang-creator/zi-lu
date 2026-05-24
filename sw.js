const CACHE_NAME = 'zi-lu-habits-v3';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './renderer.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&family=Press+Start+2P&display=swap'
];

// 安装阶段：缓存核心资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 激活阶段：清理旧版本缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 拦截请求：网络优先，降级到缓存
self.addEventListener('fetch', (e) => {
  // 排除第三方 API、CDN 以及 KV 数据库请求
  if (e.request.url.includes('kvdb.io') || e.request.url.includes('api.')) {
    return;
  }
  
  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // 请求成功，克隆一份存入缓存（除了非 HTTP/HTTPS 协议）
        if (response.status === 200 && e.request.url.startsWith('http')) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // 请求失败（离线），尝试匹配缓存
        return caches.match(e.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // 如果缓存也未匹配，且是页面请求，返回主页
          if (e.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
