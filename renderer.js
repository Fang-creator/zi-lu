/**
 * ==========================================================================
 * 双端响应式自律打卡 App - RENDERER.JS CORE LOGIC
 * ==========================================================================
 */

// 1. 全局状态 State
const state = {
  habits: [],            // 习惯列表
  checkIns: {},          // 打卡历史 {"YYYY-MM-DD": ["id1", "id2"]}
  diaries: {},           // [NEW] 日记数据 {"YYYY-MM-DD": {title, content, mood, updatedAt}}
  currentDateStr: '',    // 当前打卡日期 YYYY-MM-DD
  currentPage: 'home',   // [NEW] 当前页面 'home' | 'diary'
  selectedCategory: 'all',// 筛选分类
  chartInstance: null,   // Chart.js 实例
  triggeredReminders: {},// 防重复提醒缓存
  syncToken: '',         // 云端同步 Token
  autoSync: true,        // 是否自动云同步
  customBackground: '',  // 自定义背景 Base64
  cardTransmittance: 58, // [NEW] 卡片颜色透过率（0-100%, 默认 58% 对应 0.42 透明度）
  ticketsCount: 0,       // [NEW] 补卡券数量
  rewardedMilestones: [], // [NEW] 已领奖过的连续打卡天数里程碑列表 (防止刷券)
  activeAnalyticsTab: 'heatmap', // [NEW] 当前选中的分析图表 Tab ('heatmap' 或 'dotmatrix')
  uiTheme: 'default',             // [NEW] UI 主题风格 ('default' | 'stardew' | 'spongebob')
  nickname: '自律冒险者',        // [NEW] 社交昵称
  avatar: 'cow',                 // [NEW] 社交头像 ('cow' | 'chick' | 'dog' | 'cat' | 'pig' | 'slime')
  friends: [],                   // [NEW] 好友列表 [{token, nickname, avatar, addedAt}]
  couple: { isBound: false, partnerToken: '', partnerNickname: '', partnerAvatar: '', boundAt: 0 } // [NEW] 情侣绑定信息
};

// 预设及金句配置
const EMOBI_PRESETS = ["🏃‍♂️", "🧘", "💪", "💧", "🍎", "🥛", "📚", "✍️", "💻", "💼", "🌅", "🛌", "⏰", "🧠", "🌱", "🔋", "🔑", "🎯", "🎶", "🧼"];
const MOTIVATIONAL_QUOTES = [
  "自律，是通往自由的唯一阶梯。",
  "每一个不曾起舞的日子，都是对生命的辜负。",
  "日拱一卒无有尽，功不唐捐终入海。",
  "生活会惩罚那些不自律的人，也会奖赏自律的行者。",
  "你的自律，决定你未来的高度。"
];

// KVDB 共享公共免费桶 (使用完全唯一的桶，用于存储打卡同步记录)
const KVDB_ENDPOINT = "https://kvdb.io/Jan72Vj1rWkX6tF5xV14gU/";

// ── 数据加密工具 (AES-GCM via SubtleCrypto, 保护云端隐私) ──
const CRYPTO_PREFIX = 'ENC:';
const CRYPTO_SALT = 'ZL-HABIT-SALT-2024';

function hasCrypto() {
  return typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.encrypt;
}

function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function _base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function _deriveKey(token) {
  const enc = new TextEncoder();
  // 使用 SHA-256 派生密钥，比 PBKDF2 快 100 倍以上，手机上秒级完成
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(CRYPTO_SALT + ':' + token));
  return crypto.subtle.importKey(
    'raw', hash,
    'AES-GCM', false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(token, plaintext) {
  if (!token) return plaintext;

  // 优先使用 CryptoJS 进行高兼容性加密，即使在非安全局域网 HTTP 移动端也能正常处理
  if (typeof CryptoJS !== 'undefined') {
    try {
      const encrypted = CryptoJS.AES.encrypt(plaintext, token).toString();
      return 'ENC_JS:' + encrypted;
    } catch (e) {
      console.warn('CryptoJS 加密失败，尝试 WebCrypto:', e);
    }
  }

  // Fallback to WebCrypto if CryptoJS is missing
  if (hasCrypto()) {
    try {
      const key = await _deriveKey(token);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(plaintext)
      );
      const combined = new Uint8Array(12 + ct.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ct), 12);
      return CRYPTO_PREFIX + _arrayBufferToBase64(combined);
    } catch (e) {
      console.warn('WebCrypto 加密失败，回退明文存储:', e);
    }
  }

  return plaintext;
}

async function decryptData(token, payload) {
  if (typeof payload !== 'string') return payload;
  if (!token) return payload;

  // 1. 处理 CryptoJS 全平台兼容的 ENC_JS: 格式
  if (payload.startsWith('ENC_JS:')) {
    if (typeof CryptoJS !== 'undefined') {
      try {
        const ciphertext = payload.substring('ENC_JS:'.length);
        const bytes = CryptoJS.AES.decrypt(ciphertext, token);
        const decrypted = bytes.toString(CryptoJS.enc.Utf8);
        if (decrypted) return decrypted;
      } catch (e) {
        console.warn('CryptoJS 解密失败:', e);
      }
    }
    return payload;
  }

  // 2. 处理原有的 WebCrypto ENC: 格式
  if (payload.startsWith(CRYPTO_PREFIX)) {
    const ciphertextB64 = payload.substring(CRYPTO_PREFIX.length);
    
    // 如果支持 WebCrypto 优先使用 WebCrypto 解密
    if (hasCrypto()) {
      try {
        const key = await _deriveKey(token);
        const buffer = _base64ToArrayBuffer(ciphertextB64);
        const iv = buffer.slice(0, 12);
        const ct = buffer.slice(12);
        const pt = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: new Uint8Array(iv) },
          key,
          ct
        );
        return new TextDecoder().decode(pt);
      } catch (e) {
        console.warn('WebCrypto 解密失败，尝试 CryptoJS:', e);
      }
    }

    // 如果处于非安全环境且无法解密 WebCrypto 格式
    if (!hasCrypto()) {
      console.warn('处于非安全环境且该数据为旧版 GCM 格式，无法解密。请在主环境或 HTTPS 访问以自动升级格式！');
    }
    return payload;
  }

  return payload; // 兼容旧明文数据
}

// 2. DOM 元素缓存
const DOM = {
  welcomeGreeting: document.getElementById('welcome-greeting'),
  motivationalQuote: document.getElementById('motivational-quote'),
  dateDisplay: document.getElementById('date-display'),
  dayBadge: document.getElementById('day-badge'),
  btnPrevDay: document.getElementById('btn-prev-day'),
  btnNextDay: document.getElementById('btn-next-day'),
  todayPercentage: document.getElementById('today-percentage'),
  todayStatsFraction: document.getElementById('today-stats-fraction'),
  todayRadialFg: document.getElementById('today-radial-fg'),
  currentStreak: document.getElementById('current-streak'),
  bestStreak: document.getElementById('best-streak'),
  totalCount: document.getElementById('total-count'),
  habitListContainer: document.getElementById('habit-list-container'),

  // 手机端统计卡片 DOM
  mobileTodayPct: document.getElementById('mobile-today-pct'),
  mobileTodayFrac: document.getElementById('mobile-today-frac'),
  mobileProgressFill: document.getElementById('mobile-progress-fill'),
  mobileStreak: document.getElementById('mobile-streak'),
  mobileBest: document.getElementById('mobile-best'),
  mobileTotal: document.getElementById('mobile-total'),
  mobileTickets: document.getElementById('mobile-tickets'),
  heatmapGridContainer: document.getElementById('heatmap-grid-container'),
  globalBgContainer: document.getElementById('global-bg-container'),
  
  // 两个添加习惯按钮 (桌面侧边栏 & 手机顶栏)
  btnForceAddSidebar: document.getElementById('btn-add-habit-sidebar'),
  btnForceAddMobile: document.getElementById('btn-add-habit-mobile'),
  
  // 两个设置触发器
  btnOpenSettingsSidebar: document.getElementById('btn-open-settings'),
  btnOpenSettingsMobile: document.getElementById('btn-open-settings-mobile'),
  
  // 物理备份按钮 (Electron环境独享)
  btnExportDb: document.getElementById('btn-export-db'),
  btnImportDb: document.getElementById('btn-import-db'),
  desktopBackupSection: document.getElementById('desktop-backup-section'),

  // 添加习惯 Dialog
  habitFormDialog: document.getElementById('habit-form-dialog'),
  habitForm: document.getElementById('habit-form'),
  modalTitle: document.getElementById('modal-title'),
  habitNameInput: document.getElementById('habit-name-input'),
  editHabitIdValue: document.getElementById('edit-habit-id-value'),
  emojiGridSelector: document.getElementById('emoji-grid-selector'),
  habitReminderEnable: document.getElementById('habit-reminder-enable'),
  habitReminderTime: document.getElementById('habit-reminder-time'),
  timeInputWrapper: document.getElementById('time-input-wrapper'),
  btnCloseDialog: document.getElementById('btn-close-dialog'),
  btnCancelDialog: document.getElementById('btn-cancel-dialog'),

  // 系统设置 Settings Dialog
  settingsDialog: document.getElementById('settings-dialog'),
  syncCodeText: document.getElementById('sync-code-text'),
  btnGenerateSync: document.getElementById('btn-generate-sync'),
  syncCodeInput: document.getElementById('sync-code-input'),
  btnBindSync: document.getElementById('btn-bind-sync'),
  syncAutoToggle: document.getElementById('sync-auto-toggle'),
  btnManualSync: document.getElementById('btn-manual-sync'),
  bgUploadInput: document.getElementById('bg-upload-input'),
  btnResetBg: document.getElementById('btn-reset-bg'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  btnCloseSettingsDialog: document.getElementById('btn-close-settings-dialog'),
  bgTransmittanceSlider: document.getElementById('bg-transmittance-slider'),
  transmittanceValDisplay: document.getElementById('transmittance-val-display'),
  
  // 游戏化补卡券与复活条组件
  ticketCountDisplay: document.getElementById('ticket-count-display'),
  resurrectBannerPane: document.getElementById('resurrect-banner-pane'),
  btnUseTicketResurrect: document.getElementById('btn-use-ticket-resurrect'),

  // 双 Tab 分析与 100天自律点阵
  tabHeatmapBtn: document.getElementById('tab-heatmap-btn'),
  tabDotmatrixBtn: document.getElementById('tab-dotmatrix-btn'),
  heatmapViewPane: document.getElementById('heatmap-view-pane'),
  dotmatrixViewPane: document.getElementById('dotmatrix-view-pane'),
  dotmatrixGridContainer: document.getElementById('dotmatrix-grid-container'),
  dotmatrixStreakSummary: document.getElementById('dotmatrix-streak-summary'),
  analyticsActionHint: document.getElementById('analytics-action-hint'),

  // 自律时光成就报告与常驻复盘面板 DOM
  btnGenerateReport: document.getElementById('btn-generate-report'),
  btnGenerateReportMobile: document.getElementById('btn-generate-report-mobile'),
  reviewDashboardCard: document.getElementById('review-dashboard-card'),
  reviewStarsList: document.getElementById('review-stars-list'),
  reviewFocusBadge: document.getElementById('review-focus-badge'),
  reviewCoachAdviceText: document.getElementById('review-coach-advice-text'),
  reportDialog: document.getElementById('report-dialog'),
  btnCloseReportDialog: document.getElementById('btn-close-report-dialog'),
  btnCloseReportAction: document.getElementById('btn-close-report-action'),
  btnShareReport: document.getElementById('btn-share-report'),
  reportRankTitle: document.getElementById('report-rank-title'),
  reportStatDays: document.getElementById('report-stat-days'),
  reportStatStreak: document.getElementById('report-stat-streak'),
  reportStatRate: document.getElementById('report-stat-rate'),
  reportPreferenceName: document.getElementById('report-preference-name'),
  reportPreferenceDesc: document.getElementById('report-preference-desc'),
  reportPrefIconContainer: document.getElementById('report-pref-icon-container'),
  reportCoachEssay: document.getElementById('report-coach-essay')
};

// 3. 应用入口初始化 App Initialization
window.addEventListener('DOMContentLoaded', async () => {
  setLocalDateStr(new Date());
  initGreeting();
  initEmojiSelectorGrid();
  setupEventListeners();

  await startAppAfterAuth();
});

// 登录/注册成功后启动应用
async function startAppAfterAuth() {
  await loadDatabase();

  if (state.syncToken) {
    DOM.syncCodeText.innerText = state.syncToken;
    DOM.syncCodeInput.value = state.syncToken;
    // 【性能优化】后台异步拉取云端同步，零延迟启动大盘，防止因 kvdb.io 连接缓慢导致首屏阻塞 3-4 秒！
    performCloudSyncPull().then((success) => {
      if (success) {
        refreshUI();
        console.log('Background cloud pull finished and UI refreshed successfully.');
      }
    }).catch(err => {
      console.warn('Background sync pull failed:', err);
    });
  }

  applyCustomBackground();
  applyCardTransmittance();
  applyUITheme(state.uiTheme);
  refreshUI();
  startReminderScheduler();
  startOnlineHeartbeat();
}

// 4. 数据底层持久化 (支持浏览器 localStorage + Electron 本地文件双模式兼容)
function isElectronEnv() {
  return typeof window.electronAPI !== 'undefined';
}

async function loadDatabase() {
  try {
    if (isElectronEnv()) {
      // 1. Electron 桌面端环境：调用 Node 原生文件 IO
      const db = await window.electronAPI.getDB();
      if (db) {
        state.habits = db.habits || [];
        state.checkIns = db.checkIns || {};
        state.diaries = db.diaries || {};
        state.syncToken = db.syncToken || '';
        state.autoSync = db.autoSync !== false;
        state.customBackground = db.customBackground || '';
        state.cardTransmittance = db.cardTransmittance !== undefined ? db.cardTransmittance : 58;
        state.ticketsCount = db.ticketsCount !== undefined ? db.ticketsCount : 0;
        state.rewardedMilestones = db.rewardedMilestones || [];
        state.uiTheme = db.uiTheme || 'default';
        state.nickname = db.nickname || '自律冒险者';
        state.avatar = db.avatar || 'cow';
        state.friends = db.friends || [];
        state.couple = db.couple || { isBound: false, partnerToken: '', partnerNickname: '', partnerAvatar: '', boundAt: 0 };
        state.isOnboarded = db.isOnboarded !== undefined ? db.isOnboarded : true;
      } else {
        initEmptyData();
        await saveDatabase();
      }
    } else {
      // 2. 手机网页 PWA 环境：读写本地 localStorage
      const localData = localStorage.getItem('zi_lu_habits_db');
      if (localData) {
        const db = JSON.parse(localData);
        state.habits = db.habits || [];
        state.checkIns = db.checkIns || {};
        state.diaries = db.diaries || {};
        state.syncToken = db.syncToken || '';
        state.autoSync = db.autoSync !== false;
        state.customBackground = db.customBackground || '';
        state.cardTransmittance = db.cardTransmittance !== undefined ? db.cardTransmittance : 58;
        state.ticketsCount = db.ticketsCount !== undefined ? db.ticketsCount : 0;
        state.rewardedMilestones = db.rewardedMilestones || [];
        state.uiTheme = db.uiTheme || 'default';
        state.nickname = db.nickname || '自律冒险者';
        state.avatar = db.avatar || 'cow';
        state.friends = db.friends || [];
        state.couple = db.couple || { isBound: false, partnerToken: '', partnerNickname: '', partnerAvatar: '', boundAt: 0 };
        state.isOnboarded = db.isOnboarded !== undefined ? db.isOnboarded : true;
      } else {
        initEmptyData();
        saveLocalWebStorage();
      }
    }
  } catch (error) {
    console.error('加载本地数据库失败:', error);
    initEmptyData();
  }
}

async function saveDatabase() {
  try {
    const dataToSave = getDataToSave();

    if (isElectronEnv()) {
      await window.electronAPI.saveDB(dataToSave);
    } else {
      saveLocalWebStorage();
    }

    if (state.syncToken && state.autoSync) {
      performCloudSyncPush();
    }
  } catch (error) {
    console.error('保存数据至本地文件失败:', error);
  }
}

function getDataToSave() {
  return {
    habits: state.habits,
    checkIns: state.checkIns,
    diaries: state.diaries,
    syncToken: state.syncToken,
    autoSync: state.autoSync,
    customBackground: state.customBackground,
    cardTransmittance: state.cardTransmittance,
    ticketsCount: state.ticketsCount,
    rewardedMilestones: state.rewardedMilestones,
    uiTheme: state.uiTheme,
    nickname: state.nickname,
    avatar: state.avatar,
    friends: state.friends,
    couple: state.couple,
    isOnboarded: state.isOnboarded
  };
}

function saveLocalWebStorage() {
  try {
    localStorage.setItem('zi_lu_habits_db', JSON.stringify(getDataToSave()));
  } catch (e) {
    console.warn('localStorage 存储空间不足，尝试清理大体积数据:', e);
    // 如果是配额超限，尝试移除自定义背景图后重试
    if (state.customBackground) {
      state.customBackground = '';
      try {
        localStorage.setItem('zi_lu_habits_db', JSON.stringify(getDataToSave()));
        alert('存储空间不足，已自动清除自定义背景图以释放空间。');
        return;
      } catch (_) {}
    }
    alert('存储空间不足，请导出备份后清理部分数据。');
  }
}

// 5. 空白数据初始化（首次使用）
function initEmptyData() {
  state.habits = [];
  state.checkIns = {};
  state.ticketsCount = 0;
  state.rewardedMilestones = [];
  state.isOnboarded = false;
}

// 6. 云端数据同步引擎 (Cloud Sync Engine)
async function performCloudSyncPush() {
  if (!state.syncToken) return;
  try {
    const dataToSync = {
      habits: state.habits,
      checkIns: state.checkIns,
      diaries: state.diaries || {},
      nickname: state.nickname || '自律冒险者',
      avatar: state.avatar || 'cow',
      friends: state.friends || [],
      couple: state.couple || { isBound: false, partnerToken: '', partnerNickname: '', partnerAvatar: '', boundAt: 0 },
      isOnboarded: state.isOnboarded,
      lastUpdated: new Date().toISOString()
    };

    const plaintext = JSON.stringify(dataToSync);
    const encrypted = await encryptData(state.syncToken, plaintext);
    const payload = JSON.stringify({ v: 2, d: encrypted });

    await fetch(`${KVDB_ENDPOINT}${state.syncToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    console.log('数据已成功自动同步至云端(已加密)。');
  } catch (error) {
    console.warn('云端同步上传失败(请检查网络连接):', error);
  }
}

async function performCloudSyncPull() {
  if (!state.syncToken) return false;
  try {
    const response = await fetch(`${KVDB_ENDPOINT}${state.syncToken}`);
    if (!response.ok) return false;

    const raw = await response.text();
    let cloudData;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.v === 2 && parsed.d) {
        // v2 加密格式
        const decrypted = await decryptData(state.syncToken, parsed.d);
        cloudData = JSON.parse(decrypted);
      } else {
        // v1 旧明文格式，兼容升级前的数据
        cloudData = parsed;
      }
    } catch {
      return false;
    }

    if (cloudData && cloudData.habits && cloudData.checkIns) {
      mergeLocalAndCloudData(cloudData);
      state.nickname = cloudData.nickname || state.nickname || '自律冒险者';
      state.avatar = cloudData.avatar || state.avatar || 'cow';
      state.friends = cloudData.friends || state.friends || [];
      state.couple = cloudData.couple || state.couple || { isBound: false, partnerToken: '', partnerNickname: '', partnerAvatar: '', boundAt: 0 };
      state.diaries = cloudData.diaries || state.diaries || {};
      state.isOnboarded = cloudData.isOnboarded !== undefined ? cloudData.isOnboarded : (state.isOnboarded !== undefined ? state.isOnboarded : true);
      await saveDatabase();
      return true;
    }
  } catch (error) {
    console.warn('同步数据下载失败(请检查网络连接):', error);
  }
  return false;
}

// ── 计算相对在线时间 ──
function formatLastActiveTime(isoString) {
  if (!isoString) return '离线 (未同步)';
  try {
    const lastActive = new Date(isoString);
    const now = new Date();
    const diffMs = now - lastActive;
    
    if (isNaN(diffMs)) return '离线 (未知)';
    
    // 在线判定阈值：5分钟内活跃判定为“在线”
    const diffMin = Math.floor(diffMs / (1000 * 60));
    if (diffMin < 5) {
      return '在线';
    }
    
    if (diffMin < 60) {
      return `${diffMin}分钟前在线`;
    }
    
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) {
      return `${diffHour}小时前在线`;
    }
    
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay < 30) {
      return `${diffDay}天前在线`;
    }
    
    return '很久以前在线';
  } catch (e) {
    return '离线 (未知)';
  }
}

// ── 开启在线状态周期推送心跳 ──
function startOnlineHeartbeat() {
  // 每 2 分钟发起一次后台轻量云端推送更新
  setInterval(async () => {
    if (state.syncToken && state.autoSync) {
      console.log('[Online Status] 用户心跳数据同步中...');
      await performCloudSyncPush();
    }
  }, 120000);
}

// 双向安全合并算法 (保障手机、电脑双端打卡记录求并集，习惯定义去重)
function mergeLocalAndCloudData(cloud) {
  // 1. 合并习惯配置 (以 ID 去重)
  const habitsMap = new Map();
  // 先载入本地习惯
  state.habits.forEach(h => habitsMap.set(h.id, h));
  // 再载入云端习惯 (若有重复，以最新的字段合并覆盖)
  cloud.habits.forEach(h => {
    if (habitsMap.has(h.id)) {
      const localHabit = habitsMap.get(h.id);
      // 以创建时间或归档状态进行合并
      habitsMap.set(h.id, { ...localHabit, ...h });
    } else {
      habitsMap.set(h.id, h);
    }
  });
  state.habits = Array.from(habitsMap.values());

  // 2. 合并打卡历史记录 (求打卡 Habit IDs 的并集)
  const allDates = new Set([
    ...Object.keys(state.checkIns),
    ...Object.keys(cloud.checkIns)
  ]);

  allDates.forEach(dateStr => {
    const localChecked = state.checkIns[dateStr] || [];
    const cloudChecked = cloud.checkIns[dateStr] || [];
    // 求并集
    const unionChecked = Array.from(new Set([...localChecked, ...cloudChecked]));
    state.checkIns[dateStr] = unionChecked;
  });
}

// ── KVDB 加密数据拉取辅助函数 ──
async function fetchAndDecryptKVDB(token) {
  const response = await fetch(`${KVDB_ENDPOINT}${token}`);
  if (!response.ok) return null;
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    if (parsed.v === 2 && parsed.d) {
      const decrypted = await decryptData(token, parsed.d);
      return JSON.parse(decrypted);
    }
    return parsed; // v1 旧明文数据兼容
  } catch {
    return null;
  }
}

// ── KVDB 加密数据上传辅助函数 ──
async function sendEncryptedKVDB(token, data) {
  const plaintext = JSON.stringify(data);
  const encrypted = await encryptData(token, plaintext);
  const payload = JSON.stringify({ v: 2, d: encrypted });
  return fetch(`${KVDB_ENDPOINT}${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });
}

// 7. 自定义背景图片压缩与应用 (Base64 Canvas Compressor)
function applyCustomBackground() {
  if (state.customBackground) {
    DOM.globalBgContainer.style.backgroundImage = `url(${state.customBackground})`;
  } else {
    // 恢复默认极光渐变
    DOM.globalBgContainer.style.backgroundImage = '';
  }
}

// [NEW] 动态计算并应用卡片透过率 (CSS Variable binder)
function applyCardTransmittance() {
  const transmittance = state.cardTransmittance !== undefined ? state.cardTransmittance : 58;
  const alpha = (100 - transmittance) / 100;

  // 仅在默认主题下设置 --card-bg，避免覆盖主题色
  if (!state.uiTheme || state.uiTheme === 'default') {
    document.documentElement.style.setProperty('--card-bg', `rgba(11, 15, 26, ${alpha})`);
  }

  // 同步更新设置面板中的 UI
  if (DOM.bgTransmittanceSlider) {
    DOM.bgTransmittanceSlider.value = transmittance;
  }
  if (DOM.transmittanceValDisplay) {
    DOM.transmittanceValDisplay.innerText = `${transmittance}%`;
  }
}

function handleLocalBackgroundUpload(file) {
  const reader = new FileReader();
  reader.onload = function (event) {
    // 彻底摒弃 canvas 压缩，直接读取并保存 100% 原始、无损、像素级高清的 Base64 图像数据
    state.customBackground = event.target.result;
    
    saveDatabase();
    applyCustomBackground();
    alert('背景墙图片已超清上传并应用！');
  };
  reader.readAsDataURL(file);
}

// 8. 连续打卡计算与日期处理
function setLocalDateStr(date) {
  state.currentDateStr = formatDateToYYYYMMDD(date);
}

function formatDateToYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMobileDateDisplay(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${parseInt(m)}月${parseInt(d)}日`;
}

// [NEW] 判定某天是否达到 50% 核心自律达标线 (>= 50% Active Habits Completed)
function isDayAchieved(dateStr) {
  const activeHabits = getEligibleHabits(dateStr);
  const total = activeHabits.length;
  if (total === 0) return false; // 无任务时不计为达标
  
  const checkedIds = state.checkIns[dateStr] || [];
  const completed = activeHabits.filter(h => checkedIds.includes(h.id)).length;
  
  return (completed / total) >= 0.5;
}

function calculateStreakMetrics() {
  const todayStr = formatDateToYYYYMMDD(new Date());
  const yesterdayStr = formatDateToYYYYMMDD(new Date(Date.now() - 24 * 3600 * 1000));
  
  let currentStreak = 0;
  let checkDate = new Date();
  
  // 核心：逆推算法改为根据每天是否“达标日 isDayAchieved”来计算 Streak 连续打卡
  const hasCheckedToday = isDayAchieved(todayStr);
  const hasCheckedYesterday = isDayAchieved(yesterdayStr);
  
  if (!hasCheckedToday && !hasCheckedYesterday) {
    currentStreak = 0;
  } else {
    if (!hasCheckedToday && hasCheckedYesterday) {
      checkDate.setDate(checkDate.getDate() - 1);
    }
    while (true) {
      const checkStr = formatDateToYYYYMMDD(checkDate);
      if (isDayAchieved(checkStr)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }

  // 计算最高 Streak
  const allAchievedDates = Object.keys(state.checkIns)
    .filter(d => isDayAchieved(d))
    .sort();

  let bestStreak = 0;
  if (allAchievedDates.length > 0) {
    let currentStreakCount = 1;
    bestStreak = 1;
    for (let i = 1; i < allAchievedDates.length; i++) {
      const prevDate = new Date(allAchievedDates[i - 1]);
      const currDate = new Date(allAchievedDates[i]);
      const diffDays = Math.ceil(Math.abs(currDate - prevDate) / (1000 * 60 * 60 * 24));
      
      if (diffDays === 1) currentStreakCount++;
      else if (diffDays > 1) currentStreakCount = 1;
      
      if (currentStreakCount > bestStreak) bestStreak = currentStreakCount;
    }
    if (currentStreak > bestStreak) bestStreak = currentStreak;
  }

  // 累计达标总天数
  const totalAchievedDays = allAchievedDates.length;

  return { current: currentStreak, best: bestStreak, total: totalAchievedDays };
}

// 9. 界面组件设置
function initGreeting() {
  const hours = new Date().getHours();
  const isSpongebob = state.uiTheme === 'spongebob';
  let greet = "你好！";
  if (hours >= 5 && hours < 12) greet = isSpongebob ? "早上好！🍔" : "早上好！🌅";
  else if (hours >= 12 && hours < 14) greet = isSpongebob ? "中午好！🍔" : "中午好！🍚";
  else if (hours >= 14 && hours < 19) greet = isSpongebob ? "下午好！🍔" : "下午好！☕";
  else greet = isSpongebob ? "晚上好！🍔" : "晚上好！🌙";
  
  DOM.welcomeGreeting.innerText = greet;
  const randIndex = Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length);
  DOM.motivationalQuote.innerText = MOTIVATIONAL_QUOTES[randIndex];
}

function initEmojiSelectorGrid() {
  DOM.emojiGridSelector.innerHTML = '';
  EMOBI_PRESETS.forEach((emoji, index) => {
    const label = document.createElement('label');
    label.className = 'emoji-option';
    label.innerHTML = `
      <input type="radio" name="habit-emoji" value="${emoji}" ${index === 0 ? 'checked' : ''}>
      <span class="emoji-box">${emoji}</span>
    `;
    DOM.emojiGridSelector.appendChild(label);
  });
}

// 10. 全量绑定事件监听
function setupEventListeners() {
  // A. 双渠道添加习惯弹窗打开
  const openAddHandler = () => openHabitModal(null);
  DOM.btnForceAddSidebar.addEventListener('click', openAddHandler);
  DOM.btnForceAddMobile.addEventListener('click', openAddHandler);

  DOM.btnCloseDialog.addEventListener('click', () => DOM.habitFormDialog.close());
  DOM.btnCancelDialog.addEventListener('click', () => DOM.habitFormDialog.close());

  DOM.habitReminderEnable.addEventListener('change', (e) => {
    if (e.target.checked) {
      DOM.habitReminderTime.removeAttribute('disabled');
      DOM.timeInputWrapper.classList.remove('disabled');
    } else {
      DOM.habitReminderTime.setAttribute('disabled', 'true');
      DOM.timeInputWrapper.classList.add('disabled');
    }
  });

  DOM.habitForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleFormSubmit();
  });

  // B. 双渠道系统设置弹窗
  const openSettingsHandler = () => {
    DOM.syncCodeInput.value = state.syncToken;
    DOM.syncCodeText.innerText = state.syncToken || '未绑定云同步';
    DOM.syncAutoToggle.checked = state.autoSync;
    DOM.settingsDialog.showModal();
  };
  DOM.btnOpenSettingsSidebar.addEventListener('click', openSettingsHandler);
  DOM.btnOpenSettingsMobile.addEventListener('click', openSettingsHandler);
  DOM.btnCloseSettingsDialog.addEventListener('click', () => DOM.settingsDialog.close());
  DOM.btnSaveSettings.addEventListener('click', () => DOM.settingsDialog.close());



  // E. [NEW] 绑定卡片颜色透过率滑动条事件
  if (DOM.bgTransmittanceSlider) {
    DOM.bgTransmittanceSlider.addEventListener('input', (e) => {
      state.cardTransmittance = parseInt(e.target.value);
      applyCardTransmittance(); // 实时动态重绘渲染，实现零延迟丝滑调解透明度！
    });
    DOM.bgTransmittanceSlider.addEventListener('change', async () => {
      await saveDatabase(); // 释放鼠标时保存配置到本地文件物理持久化
    });
  }

  // F. 云端同步配置与绑定
  DOM.btnGenerateSync.addEventListener('click', async () => {
    const randHex = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const randomCode = "SYNC-" + randHex;
    state.syncToken = randomCode;
    DOM.syncCodeText.innerText = randomCode;
    DOM.syncCodeInput.value = randomCode;
    await saveDatabase();
    
    // 【核心改进】立即上传初始化数据到云端，避免另一半绑定时出现“不存在”错误！
    alert('已成功在本地生成同步码，正在上传云端进行初始化注册，请稍候...');
    try {
      await performCloudSyncPush();
      alert(`🎉 恭喜！云同步码已成功注册并初始化：\n${randomCode}\n\n请复制保存此同步码，并发送给您的另一半进行绑定！✨`);
    } catch (err) {
      alert(`⚠️ 同步码已生成：\n${randomCode}\n\n但上传到云端服务器初始化失败，可能是因为您当前的网络无法稳定连接到同步服务器。\n请确保网络通畅后，在“系统设置”中点击“手动云同步”按钮进行重试！`);
    }
  });

  DOM.btnBindSync.addEventListener('click', async () => {
    const token = DOM.syncCodeInput.value.trim().toUpperCase();
    if (!token.startsWith("SYNC-")) {
      alert('无效的同步码！同步码必须以 SYNC- 开头');
      return;
    }
    state.syncToken = token;
    DOM.syncCodeText.innerText = token;
    
    // 绑定并立刻从云端拉取覆盖本地
    alert('正在从云同步服务器拉取伴侣数据并进行绑定，请稍候...');
    const pulled = await performCloudSyncPull();
    if (pulled) {
      await saveDatabase();
      refreshUI();
      alert('🎉 绑定成功！已成功载入云端伴侣习惯及大盘数据！');
    } else {
      // 云端未找到此 key，作为新 Key 绑定，并立刻推送到云端注册
      alert('云端尚未发现此同步码的数据记录，正在为您尝试在云端初始化注册此同步码，请稍候...');
      try {
        await performCloudSyncPush();
        await saveDatabase();
        alert(`已成功创建并绑定同步码！您现在可以在手机端或另一台设备上直接使用该同步码了。✨`);
      } catch (err) {
        alert('⚠️ 绑定同步码成功，但由于网络连接超时，未能将其在云端初始化。请稍后点击“手动云同步”按钮重试！');
      }
    }
  });

  DOM.syncAutoToggle.addEventListener('change', (e) => {
    state.autoSync = e.target.checked;
    saveDatabase();
  });

  DOM.btnManualSync.addEventListener('click', async () => {
    if (!state.syncToken) {
      alert('请先生成或绑定云同步码！');
      return;
    }
    alert('正在进行云端数据双向合并同步...');
    const pulled = await performCloudSyncPull();
    await performCloudSyncPush();
    await saveDatabase();
    refreshUI();
    alert('手动实时云同步完成！双端数据已对齐。');
  });

  // D. 自定义背景图片更改
  DOM.bgUploadInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleLocalBackgroundUpload(e.target.files[0]);
    }
  });

  DOM.btnResetBg.addEventListener('click', async () => {
    state.customBackground = '';
    await saveDatabase();
    applyCustomBackground();
    alert('已成功清除自定义背景！恢复深色极光效果。');
  });

  // E. 导航条上一天、下一天切换
  DOM.btnPrevDay.addEventListener('click', () => navigateDate(-1));
  DOM.btnNextDay.addEventListener('click', () => navigateDate(1));

  // F. 分类 Tab 过滤
  const tabButtons = document.querySelectorAll('.filter-tabs .tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      tabButtons.forEach(b => b.classList.remove('active'));
      const targetBtn = e.currentTarget;
      targetBtn.classList.add('active');
      
      state.selectedCategory = targetBtn.dataset.category;
      refreshUI();
    });
  });

  // G. 数据备份导出导入 (桌面端用系统对话框，移动端用 Blob/FileReader)
  if (isElectronEnv()) {
    DOM.btnExportDb.addEventListener('click', async () => {
      const dataToExport = getDataToSave();
      try {
        const res = await window.electronAPI.exportDB(dataToExport);
        if (res && res.success) alert(`数据物理备份导出成功！\n文件存放在：${res.path}`);
      } catch (err) {
        alert(`导出失败！错误：${err.message}`);
      }
    });

    DOM.btnImportDb.addEventListener('click', async () => {
      try {
        const res = await window.electronAPI.importDB();
        if (res && res.success && res.data) {
          const db = res.data;
          state.habits = db.habits || [];
          state.checkIns = db.checkIns || {};
          state.diaries = db.diaries || {};
          state.syncToken = db.syncToken || '';
          state.nickname = db.nickname || '自律冒险者';
          state.avatar = db.avatar || 'cow';
          state.friends = db.friends || [];
          state.couple = db.couple || { isBound: false, partnerToken: '', partnerNickname: '', partnerAvatar: '', boundAt: 0 };
          state.uiTheme = db.uiTheme || 'default';
          state.ticketsCount = db.ticketsCount || 0;
          state.rewardedMilestones = db.rewardedMilestones || [];
          state.isOnboarded = db.isOnboarded !== undefined ? db.isOnboarded : true;
          await saveDatabase();
          refreshUI();
          alert(`数据本地备份导入合并成功！自律大盘已更新。`);
        }
      } catch (err) {
        alert(`导入失败！错误：${err.message}`);
      }
    });
  } else {
    // 网页/PWA 环境：用 Blob 下载和 FileReader 上传实现备份
    DOM.btnExportDb.addEventListener('click', () => {
      try {
        const dataToExport = getDataToSave();
        const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `zi-lu-backup-${formatDateToYYYYMMDD(new Date())}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showSocialToast('备份文件已下载到手机 📥');
      } catch (err) {
        alert(`导出失败！错误：${err.message}`);
      }
    });

    DOM.btnImportDb.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.habits || !data.checkIns) {
            alert('无效的备份文件！必须包含 habits 和 checkIns 字段。');
            return;
          }
          state.habits = data.habits;
          state.checkIns = data.checkIns;
          if (data.diaries) state.diaries = data.diaries;
          if (data.syncToken) state.syncToken = data.syncToken;
          if (data.friends) state.friends = data.friends;
          if (data.couple) state.couple = data.couple;
          if (data.nickname) state.nickname = data.nickname;
          if (data.avatar) state.avatar = data.avatar;
          await saveDatabase();
          refreshUI();
          showSocialToast('备份已成功导入合并！✨');
        } catch (err) {
          alert(`导入失败！文件格式错误：${err.message}`);
        }
      };
      input.click();
    });
  }

  // H. [NEW] 补卡券一键复活打卡事件绑定
  if (DOM.btnUseTicketResurrect) {
    DOM.btnUseTicketResurrect.addEventListener('click', async () => {
      await handleUseTicketResurrect();
    });
  }

  // I. [NEW] 双 Tab 切换分析视图事件
  if (DOM.tabHeatmapBtn && DOM.tabDotmatrixBtn) {
    const handleTabChange = (targetTab) => {
      state.activeAnalyticsTab = targetTab;
      
      if (targetTab === 'heatmap') {
        DOM.tabHeatmapBtn.classList.add('active');
        DOM.tabDotmatrixBtn.classList.remove('active');
        DOM.heatmapViewPane.style.display = 'flex';
        DOM.dotmatrixViewPane.style.display = 'none';
        DOM.analyticsActionHint.innerText = '点击格子可时光回退补卡';
        renderHeatmap();
      } else {
        DOM.tabHeatmapBtn.classList.remove('active');
        DOM.tabDotmatrixBtn.classList.add('active');
        DOM.heatmapViewPane.style.display = 'none';
        DOM.dotmatrixViewPane.style.display = 'flex';
        DOM.analyticsActionHint.innerText = '点击发光星点可时光回退补卡';
        renderDotMatrix();
      }
    };
    
    DOM.tabHeatmapBtn.addEventListener('click', () => handleTabChange('heatmap'));
    DOM.tabDotmatrixBtn.addEventListener('click', () => handleTabChange('dotmatrix'));
  }

  // J. [NEW] 自律成就报告弹窗事件绑定
  if (DOM.btnGenerateReport && DOM.btnGenerateReportMobile) {
    const handleOpenReport = () => {
      showAccomplishmentReport();
    };
    DOM.btnGenerateReport.addEventListener('click', handleOpenReport);
    DOM.btnGenerateReportMobile.addEventListener('click', handleOpenReport);
  }

  if (DOM.btnCloseReportDialog && DOM.btnCloseReportAction) {
    DOM.btnCloseReportDialog.addEventListener('click', () => DOM.reportDialog.close());
    DOM.btnCloseReportAction.addEventListener('click', () => DOM.reportDialog.close());
  }

  if (DOM.btnShareReport) {
    DOM.btnShareReport.addEventListener('click', () => {
      handleShareReportText();
    });
  }
}

// 11. 日期切换
function navigateDate(daysOffset) {
  const current = new Date(state.currentDateStr);
  current.setDate(current.getDate() + daysOffset);
  
  const todayStr = formatDateToYYYYMMDD(new Date());
  const nextDateStr = formatDateToYYYYMMDD(current);
  if (nextDateStr > todayStr) return;

  state.currentDateStr = nextDateStr;
  refreshUI();
}

// 12. 大盘渲染更新
function refreshUI() {
  DOM.dateDisplay.innerText = getMobileDateDisplay(state.currentDateStr);
  
  const todayStr = formatDateToYYYYMMDD(new Date());
  if (state.currentDateStr === todayStr) {
    DOM.dayBadge.innerText = '今天';
    DOM.dayBadge.className = 'badge badge-today';
    DOM.btnNextDay.style.opacity = '0.25';
    DOM.btnNextDay.style.pointerEvents = 'none';
  } else {
    DOM.dayBadge.innerText = '补卡';
    DOM.dayBadge.className = 'badge badge-past';
    DOM.btnNextDay.style.opacity = '1';
    DOM.btnNextDay.style.pointerEvents = 'auto';
  }

  // A. 本地补卡资产与复活栏渲染
  if (DOM.ticketCountDisplay) {
    DOM.ticketCountDisplay.innerText = `${state.ticketsCount} 张`;
  }

  // 如果当前选定的是非今天日期，且该日期没有达到 50% 达标线，则弹出复活横条！
  const achieved = isDayAchieved(state.currentDateStr);
  if (DOM.resurrectBannerPane) {
    if (state.currentDateStr !== todayStr && !achieved) {
      DOM.resurrectBannerPane.style.display = 'flex';
    } else {
      DOM.resurrectBannerPane.style.display = 'none';
    }
  }

  const activeHabits = getEligibleHabits(state.currentDateStr);
  
  // 渲染极简打卡列表
  renderChecklist(activeHabits);

  const metrics = calculateStreakMetrics();
  DOM.currentStreak.innerText = `${metrics.current} 天`;
  DOM.bestStreak.innerText = `${metrics.best} 天`;
  DOM.totalCount.innerText = `${metrics.total} 天`;

  // 渲染今日环形图
  renderRadialProgress(activeHabits);

  // 同步手机统计卡片 (renderRadialProgress 已同步百分比，此处补齐 streak 等)
  const doneM = (state.checkIns[state.currentDateStr] || []).filter(id => activeHabits.some(h => h.id === id)).length;
  const pctM = activeHabits.length > 0 ? Math.round((doneM / activeHabits.length) * 100) : 0;
  syncMobileStats(pctM, `${doneM}/${activeHabits.length}`, metrics.current, metrics.best, metrics.total);

  // 渲染折线走势图
  renderTrendChart();

  // 渲染热力图与点阵图格子
  renderHeatmap();
  renderDotMatrix();

  // 渲染首页常驻复盘面板
  renderReviewDashboard();
}

function getEligibleHabits(dateStr) {
  return state.habits.filter(habit => {
    const createdDate = formatDateToYYYYMMDD(new Date(habit.createdAt));
    if (createdDate > dateStr) return false;
    if (!habit.archived) return true;
    const dayCheckIns = state.checkIns[dateStr] || [];
    return dayCheckIns.includes(habit.id);
  });
}

// 13. 极紧凑 (44px) 勾选卡片渲染器
function renderChecklist(habits) {
  DOM.habitListContainer.innerHTML = '';

  const filteredHabits = habits.filter(h => {
    if (state.selectedCategory === 'all') return true;
    return h.category === state.selectedCategory;
  });

  if (filteredHabits.length === 0) {
    DOM.habitListContainer.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-seedling"></i>
        <p>此类别下没有习惯任务，点击上方按钮新增一个吧！</p>
      </div>
    `;
    return;
  }

  const checkedIds = state.checkIns[state.currentDateStr] || [];

  filteredHabits.forEach(habit => {
    const isChecked = checkedIds.includes(habit.id);
    
    const card = document.createElement('div');
    card.className = `habit-card glass glass-hover ${isChecked ? 'checked' : ''}`;
    card.id = `habit-card-${habit.id}`;

    let reminderHTML = '';
    if (habit.reminderTime) {
      reminderHTML = `
        <span class="reminder-badge">
          <i class="fa-regular fa-clock"></i>
          <small>${habit.reminderTime}</small>
        </span>
      `;
    }

    card.innerHTML = `
      <div class="habit-card-left">
        <label class="checkbox-container">
          <input type="checkbox" id="check-${habit.id}" ${isChecked ? 'checked' : ''}>
          <span class="checkmark"></span>
        </label>
        <div class="habit-details">
          <div class="habit-icon-circle">${habit.emoji || '✨'}</div>
          <span class="habit-title-text" title="${habit.name}">${habit.name}</span>
          <div class="habit-meta-tags">
            <span class="cat-badge ${habit.category}">${{health:'健康',learning:'学习',work:'工作',mindset:'心智'}[habit.category]}</span>
            ${reminderHTML}
          </div>
        </div>
      </div>
      <div class="habit-card-right">
        <button class="action-btn edit" data-id="${habit.id}" title="编辑"><i class="fa-solid fa-pen"></i></button>
        <button class="action-btn delete" data-id="${habit.id}" title="归档删除"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;

    // 绑定勾选改变
    const checkbox = card.querySelector(`#check-${habit.id}`);
    checkbox.addEventListener('change', (e) => {
      handleCheckinToggle(habit.id, e.target.checked);
    });

    // 编辑
    card.querySelector('.action-btn.edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openHabitModal(habit.id);
    });

    // 删除
    card.querySelector('.action-btn.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteHabit(habit.id);
    });

    DOM.habitListContainer.appendChild(card);
  });
}

// 处理打卡勾选
async function handleCheckinToggle(habitId, isChecked) {
  const currentList = state.checkIns[state.currentDateStr] || [];
  if (isChecked) {
    if (!currentList.includes(habitId)) currentList.push(habitId);
    document.getElementById(`habit-card-${habitId}`).classList.add('checked');
  } else {
    const index = currentList.indexOf(habitId);
    if (index > -1) currentList.splice(index, 1);
    document.getElementById(`habit-card-${habitId}`).classList.remove('checked');
  }

  state.checkIns[state.currentDateStr] = currentList;
  
  // 核心：每次打卡保存后，除了写入本地 DB，还需立刻检测是否达成了连续 7 天倍数连续打卡的奖励条件！
  await saveDatabase();
  await check7DayMilestoneReward();

  const activeHabits = getEligibleHabits(state.currentDateStr);
  renderRadialProgress(activeHabits);
  const metrics = calculateStreakMetrics();
  DOM.currentStreak.innerText = `${metrics.current} 天`;
  DOM.bestStreak.innerText = `${metrics.best} 天`;
  DOM.totalCount.innerText = `${metrics.total} 天`;

  // 同步手机统计卡片
  const checkedIds2 = state.checkIns[state.currentDateStr] || [];
  const done2 = activeHabits.filter(h => checkedIds2.includes(h.id)).length;
  const pct2 = activeHabits.length > 0 ? Math.round((done2 / activeHabits.length) * 100) : 0;
  syncMobileStats(pct2, `${done2}/${activeHabits.length}`, metrics.current, metrics.best, metrics.total);

  renderTrendChart();
  renderHeatmap();
  renderDotMatrix();
  renderReviewDashboard();
}

// [NEW] 检测并为连续 7 天/14天/21天等里程碑打卡奖励补卡券
async function check7DayMilestoneReward() {
  const metrics = calculateStreakMetrics();
  const current = metrics.current;
  
  if (current > 0 && current % 7 === 0) {
    // 检查此里程碑是否已经派发过奖励
    if (!state.rewardedMilestones.includes(current)) {
      state.rewardedMilestones.push(current);
      state.ticketsCount += 1; // 奖励 1 张补卡券
      
      // 保存到本地文件
      await saveDatabase();
      
      // 更新 UI 显示
      if (DOM.ticketCountDisplay) {
        DOM.ticketCountDisplay.innerText = `${state.ticketsCount} 张`;
      }
      if (DOM.mobileTickets) {
        DOM.mobileTickets.innerText = `${state.ticketsCount} 张`;
      }
      
      // 触发华丽庆祝弹窗！
      setTimeout(() => {
        alert(`🏆 战功彪炳！您已成功达成连续自律打卡 ${current} 天的丰功伟绩！\n🎁 系统已自动奖励您 1 张 [补卡券]！可在历史未达标日消耗它进行一键打卡复活，守护您的连续自律记录！`);
      }, 350);
    }
  }
}

// [NEW] 消耗补卡券复活打卡函数
async function handleUseTicketResurrect() {
  if (state.ticketsCount <= 0) {
    alert('对不起，您当前的补卡券不足！努力连续打卡 7 天即可免费获赠 1 张！');
    return;
  }

  const activeHabits = getEligibleHabits(state.currentDateStr);
  const total = activeHabits.length;
  if (total === 0) {
    alert('当天没有可活跃打卡的习惯任务，无需进行补卡！');
    return;
  }

  const confirmResurrect = confirm(`确认消耗 1 张补卡券补签 ${getMobileDateDisplay(state.currentDateStr)} 吗？\n(补签后当天将强制升级为“自律达标日”，瞬间为您接通恢复已经中断的连续打卡天数！)`);
  if (!confirmResurrect) return;

  // 1. 扣除券张数
  state.ticketsCount -= 1;

  // 2. 自动勾选未打卡 habits 直至达标线 (>= 50%)
  const checkedIds = state.checkIns[state.currentDateStr] || [];
  const neededCompletions = Math.ceil(total * 0.5); // 需要达标的最少勾选数
  let currentlyCompleted = activeHabits.filter(h => checkedIds.includes(h.id)).length;
  
  if (currentlyCompleted < neededCompletions) {
    // 遍历习惯，自动补充缺少的习惯 ID 到今日打卡表中
    for (let i = 0; i < activeHabits.length; i++) {
      const habit = activeHabits[i];
      if (!checkedIds.includes(habit.id)) {
        checkedIds.push(habit.id);
        currentlyCompleted++;
      }
      if (currentlyCompleted >= neededCompletions) {
        break; // 刚好勾选至 50% 达标线，立刻跳出
      }
    }
  }

  state.checkIns[state.currentDateStr] = checkedIds;
  
  // 3. 物理保存数据库，并自动触发云端推送
  await saveDatabase();

  // 4. 重绘并重新对齐整个系统看板
  refreshUI();
  
  alert(`🎉 复活大成功！已成功消耗 1 张补卡券！\n已将 ${getMobileDateDisplay(state.currentDateStr)} 的打卡完成率自动提升至达标水准。您的连续自律打卡 Streak 已重振旗鼓、完美接通！`);
}

function syncMobileStats(pct, frac, streak, best, total) {
  if (DOM.mobileTodayPct) DOM.mobileTodayPct.innerText = `${pct}%`;
  if (DOM.mobileTodayFrac) DOM.mobileTodayFrac.innerText = frac;
  if (DOM.mobileProgressFill) DOM.mobileProgressFill.style.width = `${pct}%`;
  if (DOM.mobileStreak) DOM.mobileStreak.innerText = `${streak} 天`;
  if (DOM.mobileBest) DOM.mobileBest.innerText = `${best} 天`;
  if (DOM.mobileTotal) DOM.mobileTotal.innerText = `${total} 天`;
  if (DOM.mobileTickets) DOM.mobileTickets.innerText = `${state.ticketsCount} 张`;
}

function renderRadialProgress(habits) {
  // 今日完成度环形图永远基于【全部非归档习惯】，不受分类过滤器影响
  const allActive = habits; // habits 本身已是非归档列表（调用方已过滤）

  const total = allActive.length;
  if (total === 0) {
    DOM.todayPercentage.innerText = '0%';
    DOM.todayStatsFraction.innerText = '0 / 0';
    DOM.todayRadialFg.style.strokeDashoffset = '301.6';
    if (DOM.mobileTodayPct) DOM.mobileTodayPct.innerText = '0%';
    if (DOM.mobileTodayFrac) DOM.mobileTodayFrac.innerText = '0 / 0';
    if (DOM.mobileProgressFill) DOM.mobileProgressFill.style.width = '0%';
    return;
  }

  const checkedIds = state.checkIns[state.currentDateStr] || [];
  const completed = allActive.filter(h => checkedIds.includes(h.id)).length;
  const percentage = Math.round((completed / total) * 100);

  DOM.todayPercentage.innerText = `${percentage}%`;
  DOM.todayStatsFraction.innerText = `${completed}/${total}`;

  const perimeter = 2 * Math.PI * 48;
  const offset = perimeter - (completed / total) * perimeter;
  DOM.todayRadialFg.style.strokeDashoffset = offset;

  if (DOM.mobileTodayPct) DOM.mobileTodayPct.innerText = `${percentage}%`;
  if (DOM.mobileTodayFrac) DOM.mobileTodayFrac.innerText = `${completed}/${total}`;
  if (DOM.mobileProgressFill) DOM.mobileProgressFill.style.width = `${percentage}%`;
}

// 14. CRUD Form Modals
function openHabitModal(habitId = null) {
  DOM.habitForm.reset();
  
  if (habitId) {
    DOM.modalTitle.innerText = '编辑习惯记录';
    const habit = state.habits.find(h => h.id === habitId);
    if (!habit) return;

    DOM.editHabitIdValue.value = habit.id;
    DOM.habitNameInput.value = habit.name;

    const radio = DOM.habitForm.querySelector(`input[name="habit-category"][value="${habit.category}"]`);
    if (radio) radio.checked = true;

    const emojiRadio = DOM.habitForm.querySelector(`input[name="habit-emoji"][value="${habit.emoji}"]`);
    if (emojiRadio) emojiRadio.checked = true;

    if (habit.reminderTime) {
      DOM.habitReminderEnable.checked = true;
      DOM.habitReminderTime.removeAttribute('disabled');
      DOM.habitReminderTime.value = habit.reminderTime;
      DOM.timeInputWrapper.classList.remove('disabled');
    } else {
      DOM.habitReminderEnable.checked = false;
      DOM.habitReminderTime.setAttribute('disabled', 'true');
      DOM.habitReminderTime.value = '08:00';
      DOM.timeInputWrapper.classList.add('disabled');
    }
  } else {
    DOM.modalTitle.innerText = '添加新习惯';
    DOM.editHabitIdValue.value = '';
    DOM.habitReminderEnable.checked = false;
    DOM.habitReminderTime.setAttribute('disabled', 'true');
    DOM.habitReminderTime.value = '08:00';
    DOM.timeInputWrapper.classList.add('disabled');
    
    const firstEmoji = DOM.emojiGridSelector.querySelector('input[type="radio"]');
    if (firstEmoji) firstEmoji.checked = true;
  }

  DOM.habitFormDialog.showModal();
}

async function handleFormSubmit() {
  const id = DOM.editHabitIdValue.value;
  const name = DOM.habitNameInput.value.trim();
  const categoryEl = DOM.habitForm.querySelector('input[name="habit-category"]:checked');
  const emojiEl = DOM.habitForm.querySelector('input[name="habit-emoji"]:checked');
  if (!categoryEl || !emojiEl) return;
  const category = categoryEl.value;
  const emoji = emojiEl.value;
  const enableReminder = DOM.habitReminderEnable.checked;
  const reminderTime = enableReminder ? DOM.habitReminderTime.value : null;

  if (id) {
    const index = state.habits.findIndex(h => h.id === id);
    if (index > -1) {
      state.habits[index] = { ...state.habits[index], name, category, emoji, reminderTime };
    }
  } else {
    const newHabit = {
      id: `habit-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name,
      category,
      emoji,
      reminderTime,
      archived: false,
      createdAt: new Date().toISOString()
    };
    state.habits.push(newHabit);
  }

  await saveDatabase();
  DOM.habitFormDialog.close();
  refreshUI();
}

async function handleDeleteHabit(habitId) {
  const habit = state.habits.find(h => h.id === habitId);
  if (!habit) return;

  const confirmDelete = confirm(`确认删除习惯“${habit.name}”吗？\n(删除后今日任务列表不再显示，但历史自律轨迹图表不受影响！)`);
  if (!confirmDelete) return;

  habit.archived = true;
  await saveDatabase();
  refreshUI();
}

// 15. 置顶发光折线图绘制 (Chart.js Curves)
function renderTrendChart() {
  const ctx = document.getElementById('habit-trend-chart').getContext('2d');
  
  const labels = [];
  const completionsData = [];
  const today = new Date();

  // 倒推 7 天
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const dateStr = formatDateToYYYYMMDD(d);
    
    // 日期标题
    const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    labels.push(label);

    const activeHabits = getEligibleHabits(dateStr).filter(h => {
      if (state.selectedCategory === 'all') return true;
      return h.category === state.selectedCategory;
    });

    const checkedIds = state.checkIns[dateStr] || [];
    const completedCount = activeHabits.filter(h => checkedIds.includes(h.id)).length;
    completionsData.push(completedCount);
  }

  // 动态主题配色
  const isStardew = state.uiTheme === 'stardew';
  const isSpongebob = state.uiTheme === 'spongebob';
  const lineColor = isSpongebob ? '#ff69b4' : (isStardew ? '#b85c1c' : '#a78bfa');
  const pointColor = isSpongebob ? '#ffd54f' : (isStardew ? '#e8ab56' : '#c084fc');
  const tickColor = isSpongebob ? '#0077b6' : (isStardew ? '#5c2807' : '#94a3b8');
  const gridColor = isSpongebob ? 'rgba(0, 119, 182, 0.08)' : (isStardew ? 'rgba(60, 31, 15, 0.08)' : 'rgba(255, 255, 255, 0.03)');
  const tooltipBg = isSpongebob ? 'rgba(255, 249, 196, 0.98)' : (isStardew ? 'rgba(247, 225, 181, 0.98)' : 'rgba(15, 23, 42, 0.95)');
  const tooltipBorder = isSpongebob ? '#ff8fa3' : (isStardew ? '#3c1f0f' : 'rgba(255, 255, 255, 0.08)');
  const tooltipText = isSpongebob ? '#0077b6' : (isStardew ? '#4a2107' : '#ffffff');

  const fillGradient = ctx.createLinearGradient(0, 0, 0, 160);
  if (isSpongebob) {
    fillGradient.addColorStop(0, 'rgba(255, 143, 163, 0.4)');
    fillGradient.addColorStop(1, 'rgba(255, 143, 163, 0)');
  } else if (isStardew) {
    fillGradient.addColorStop(0, 'rgba(232, 171, 86, 0.45)');
    fillGradient.addColorStop(1, 'rgba(232, 171, 86, 0)');
  } else {
    fillGradient.addColorStop(0, 'rgba(138, 92, 246, 0.4)');
    fillGradient.addColorStop(1, 'rgba(138, 92, 246, 0)');
  }

  if (state.chartInstance) {
    state.chartInstance.destroy();
  }

  state.chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '习惯完成数',
        data: completionsData,
        borderColor: lineColor,
        borderWidth: 2.5,
        pointBackgroundColor: pointColor,
        pointBorderColor: isSpongebob ? '#ff8fa3' : (isStardew ? '#3c1f0f' : 'rgba(255,255,255,0.7)'),
        pointHoverBackgroundColor: isSpongebob ? '#ff8fa3' : (isStardew ? '#ffd83b' : '#fff'),
        pointHoverBorderColor: isSpongebob ? '#ffd54f' : (isStardew ? '#3c1f0f' : '#8b5cf6'),
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: true,
        backgroundColor: fillGradient,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: tooltipBg,
          titleColor: tooltipText,
          bodyColor: tooltipText,
          titleFont: { family: isStardew ? 'Press Start 2P' : 'Outfit', size: isStardew ? 9 : 11 },
          bodyFont: { family: 'Inter', size: 11 },
          borderColor: tooltipBorder,
          borderWidth: isStardew ? 2 : 1,
          padding: 8,
          displayColors: false,
          callbacks: {
            title: (items) => `日期: ${items[0].label}`,
            label: (item) => `打卡完成: ${item.raw} 个`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: tickColor, font: { family: 'Inter', size: 10 } }
        },
        y: {
          grid: { color: gridColor, lineWidth: 1 },
          min: 0,
          ticks: { color: tickColor, stepSize: 1, font: { family: 'Inter', size: 10 } }
        }
      }
    }
  });
}

// 16. 热力图双行 30 格绘制 (Heatmap Grid Renderer)
function renderHeatmap() {
  DOM.heatmapGridContainer.innerHTML = '';
  const today = new Date();

  // 手机端为 2 行 15 列排列的 30 格
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const dateStr = formatDateToYYYYMMDD(d);
    
    const activeHabits = getEligibleHabits(dateStr).filter(h => {
      if (state.selectedCategory === 'all') return true;
      return h.category === state.selectedCategory;
    });

    const checkedIds = state.checkIns[dateStr] || [];
    const completed = activeHabits.filter(h => checkedIds.includes(h.id)).length;
    const total = activeHabits.length;
    
    let ratio = 0;
    if (total > 0) ratio = completed / total;

    let level = 0;
    if (total === 0 || completed === 0) level = 0;
    else if (ratio <= 0.25) level = 1;
    else if (ratio <= 0.5) level = 2;
    else if (ratio <= 0.75) level = 3;
    else level = 4;

    const cell = document.createElement('div');
    cell.className = `heatmap-cell level-${level}`;
    
    const displayDate = `${d.getMonth() + 1}月${d.getDate()}日`;
    cell.setAttribute('data-tooltip', `${displayDate}: 完成 ${completed}/${total} (${Math.round(ratio*100)}%)`);
    
    // 点击小方格可时光回退补打卡！
    cell.addEventListener('click', () => {
      state.currentDateStr = dateStr;
      refreshUI();
    });

    DOM.heatmapGridContainer.appendChild(cell);
  }
}

// 16.2 100天自律挑战点阵图绘制 (100-Day Challenge Dot Matrix Renderer)
function renderDotMatrix() {
  if (!DOM.dotmatrixGridContainer) return;
  DOM.dotmatrixGridContainer.innerHTML = '';
  const today = new Date();
  
  let achievedDaysCount = 0;
  let totalValidDaysCount = 0;

  // 10x10 的完美 100 格点阵 (过去 99 天到今天)
  for (let i = 99; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const dateStr = formatDateToYYYYMMDD(d);

    const activeHabits = getEligibleHabits(dateStr).filter(h => {
      if (state.selectedCategory === 'all') return true;
      return h.category === state.selectedCategory;
    });

    const checkedIds = state.checkIns[dateStr] || [];
    const completed = activeHabits.filter(h => checkedIds.includes(h.id)).length;
    const total = activeHabits.length;

    let ratio = 0;
    if (total > 0) ratio = completed / total;

    let levelClass = 'level-empty'; // level-empty (无任务), level-missed (<50%), level-achieved (>=50% 且 <100%), level-perfect (100%)
    
    if (total === 0) {
      levelClass = 'level-empty';
    } else {
      totalValidDaysCount++;
      if (completed === 0 || ratio < 0.5) {
        levelClass = 'level-missed';
      } else if (ratio < 1.0) {
        levelClass = 'level-achieved';
        achievedDaysCount++;
      } else {
        levelClass = 'level-perfect';
        achievedDaysCount++;
      }
    }

    const cell = document.createElement('div');
    cell.className = `dotmatrix-cell ${levelClass}`;
    
    // 如果是当前选中的日期，添加一个高亮的外边框/呼吸阴影
    if (dateStr === state.currentDateStr) {
      cell.style.outline = '1px solid #38bdf8';
      cell.style.outlineOffset = '2px';
    }

    const displayDate = `${d.getMonth() + 1}月${d.getDate()}日`;
    let tooltipText = '';
    if (total === 0) {
      tooltipText = `${displayDate}: 未安排自律任务`;
    } else {
      const pct = Math.round(ratio * 100);
      let statusStr = '未达标';
      if (ratio >= 1.0) statusStr = '完美完成';
      else if (ratio >= 0.5) statusStr = '达标';
      tooltipText = `${displayDate}: ${statusStr} (已完成 ${completed}/${total}, ${pct}%)`;
    }
    
    cell.setAttribute('data-tooltip', tooltipText);

    // 点击发光星星进行时光旅行跳转！
    cell.addEventListener('click', () => {
      state.currentDateStr = dateStr;
      refreshUI();
    });

    DOM.dotmatrixGridContainer.appendChild(cell);
  }

  // 计算100天达标率
  if (DOM.dotmatrixStreakSummary) {
    if (totalValidDaysCount === 0) {
      DOM.dotmatrixStreakSummary.innerText = '100天自律达标率: --%';
    } else {
      const percentage = Math.round((achievedDaysCount / totalValidDaysCount) * 100);
      DOM.dotmatrixStreakSummary.innerText = `100天自律达标率: ${percentage}%`;
    }
  }
}

// 17. 提醒调度计时器 (支持桌面端 + 移动端，包括后台恢复)
let _lastReminderCheckTime = Date.now();

function startReminderScheduler() {
  setInterval(checkReminders, 60000);
  checkReminders();

  // 手机切回 App 时立即补检错过的提醒
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      const gapMin = (Date.now() - _lastReminderCheckTime) / 60000;
      // 超过 2 分钟没检查，可能错过了提醒窗口
      if (gapMin > 2) {
        checkReminders();
        // 如果离线太久，顺手同步一次
        if (state.syncToken && state.autoSync) {
          performCloudSyncPull().catch(() => {});
        }
      }
    }
  });
}

function checkReminders() {
  _lastReminderCheckTime = Date.now();
  const now = new Date();
  const todayStr = formatDateToYYYYMMDD(now);
  const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const activeHabits = getEligibleHabits(todayStr);
  const checkedIds = state.checkIns[todayStr] || [];

  activeHabits.forEach(habit => {
    if (habit.reminderTime && habit.reminderTime === currentTimeStr && !checkedIds.includes(habit.id)) {
      const reminderKey = `${todayStr}-${habit.id}`;

      if (!state.triggeredReminders[reminderKey]) {
        state.triggeredReminders[reminderKey] = true;

        const title = `自律打卡提醒: ${habit.emoji} ${habit.name}`;
        const body = `提醒时间到了 (${habit.reminderTime})！今天这个习惯还没勾选打卡哦，快来加油完成吧！`;

        if (isElectronEnv()) {
          window.electronAPI.showNotification(title, body);
        } else {
          // 手机网页/PWA 环境：先尝试浏览器通知，失败则用页内 Toast
          let notified = false;
          if ("Notification" in window) {
            if (Notification.permission === "granted") {
              new Notification(title, { body: body, icon: 'https://cdn-icons-png.flaticon.com/512/10008/10008892.png' });
              notified = true;
            } else if (Notification.permission !== "denied") {
              Notification.requestPermission().then(permission => {
                if (permission === "granted") {
                  new Notification(title, { body: body });
                }
              }).catch(() => {});
            }
          }
          // 页内 Toast 兜底：即使通知权限未授予，用户也能看到提醒
          if (!notified) {
            showSocialToast(`${habit.emoji} ${habit.name} — 该打卡啦！⏰`);
          }
        }
      }
    }
  });
}

// 18. 自律时光分析核算引擎 (Self-Discipline Analytics Engine)
function analyzeSelfDiscipline() {
  const today = new Date();
  
  // 1. 计算 100 天达标率与 30 天达标率
  let achieved100 = 0;
  let valid100 = 0;
  let achieved30 = 0;
  let valid30 = 0;

  for (let i = 99; i >= 0; i--) {
    const d = new Date();
    d.setDate(today.getDate() - i);
    const dateStr = formatDateToYYYYMMDD(d);

    const activeHabits = getEligibleHabits(dateStr);
    if (activeHabits.length > 0) {
      const isAchieved = isDayAchieved(dateStr);
      
      valid100++;
      if (isAchieved) achieved100++;
      
      if (i < 30) {
        valid30++;
        if (isAchieved) achieved30++;
      }
    }
  }

  const rate100 = valid100 === 0 ? 0 : achieved100 / valid100;
  const rate30 = valid30 === 0 ? 0 : achieved30 / valid30;

  // 2. 评定段位称号
  let rankTitle = '探索学者';
  if (rate100 >= 0.90) rankTitle = '璀璨自律先锋';
  else if (rate100 >= 0.75) rankTitle = '自律大师';
  else if (rate100 >= 0.50) rankTitle = '秩序行者';
  else if (rate100 >= 0.30) rankTitle = '习惯守望者';

  // 3. 评定 30 天自律星级 (1-5 星)
  let starsCount = 1;
  if (rate30 >= 0.90) starsCount = 5;
  else if (rate30 >= 0.70) starsCount = 4;
  else if (rate30 >= 0.50) starsCount = 3;
  else if (rate30 >= 0.30) starsCount = 2;

  // 4. 统计最强习惯偏爱类型
  const categoryCounts = { health: 0, learning: 0, work: 0, mindset: 0 };

  // 遍历所有有记录的打卡日期
  Object.keys(state.checkIns).forEach(dateStr => {
    const checkedIds = state.checkIns[dateStr] || [];
    checkedIds.forEach(id => {
      const habit = state.habits.find(h => h.id === id);
      if (habit && categoryCounts[habit.category] !== undefined) {
        categoryCounts[habit.category]++;
      }
    });
  });

  let topCategory = 'learning';
  let maxCount = -1;
  Object.keys(categoryCounts).forEach(cat => {
    if (categoryCounts[cat] > maxCount) {
      maxCount = categoryCounts[cat];
      topCategory = cat;
    }
  });

  // 如果总打卡数为 0，则默认“学习”为偏好
  if (maxCount <= 0) {
    topCategory = 'learning';
  }

  const catNames = { health: '健康', learning: '学习', work: '工作', mindset: '心智' };
  const catIcons = { health: 'fa-heart', learning: 'fa-graduation-cap', work: 'fa-briefcase', mindset: 'fa-brain' };
  const catEmojis = { health: '🍎', learning: '📚', work: '💻', mindset: '🧠' };

  // 5. 组装 AI 教练段落评语 (长版 Option A)
  const streakMetrics = calculateStreakMetrics();
  const maxStreak = streakMetrics.best;
  
  let coachEssay = '';
  if (rate100 >= 0.90) {
    coachEssay = `“您的执行力堪称钢铁级先锋！最近 100 天自律达标率高达 ${Math.round(rate100 * 100)}%，最长连续达标打卡记录达到 ${maxStreak} 天。特别是在【${catNames[topCategory]} ${catEmojis[topCategory]}】领域，您展现出了极致的专注。您不再是随波逐流的过客，而是自己人生的绝对掌控者。在追逐卓越的坦途上，您洒下的每一滴汗水都在重塑更强大的灵魂。请继续保持这份高昂的节奏，星光不问赶路人，时代终将为您加冕！”`;
  } else if (rate100 >= 0.75) {
    coachEssay = `“恭喜您荣登『${rankTitle}』的殿堂！100天自律达标率稳在 ${Math.round(rate100 * 100)}%，最高连续达标 ${maxStreak} 天，自律已经深深刻入您的血肉之中。您在【${catNames[topCategory]} ${catEmojis[topCategory]}】习惯的执行中尤为稳健。偶尔的停歇（如未达标的红星）只是您调整呼吸的节点，凭借手里的补卡券和坚韧的自愈力，您总能迅速重回正轨。生活会厚赐像您这样坚守秩序的人，请深呼吸，继续高昂前行！”`;
  } else if (rate100 >= 0.50) {
    coachEssay = `“您已经成功站在了『${rankTitle}』的台阶上。100天自律达标率达到了 ${Math.round(rate100 * 100)}%，最高连续达标记录为 ${maxStreak} 天。数据表明，您在【${catNames[topCategory]} ${catEmojis[topCategory]}】领域的打卡最积极，这是您当前的自律突破核心。在生活中维持 50% 以上的秩序已是一项了不起的成就，它保障了大盘的良性循环。如果偶尔感到疲惫，不妨停下脚步使用补卡券复活，明天太阳照常升起，而您的自律星芒将更加璀璨！”`;
  } else if (rate100 >= 0.30) {
    coachEssay = `“您目前处于『${rankTitle}』段位。100天达标率为 ${Math.round(rate100 * 100)}%，最长连续记录为 ${maxStreak} 天。最近您把精力主要集中在【${catNames[topCategory]} ${catEmojis[topCategory]}】上，这很好，在单一领域取得突破是点燃全身习惯的最佳火种。自律不是苦行僧式的折磨，而是一场温和的自我和解。不要害怕偶尔的松懈或点阵图里的暗红星，用好补卡券，每天勾选 50% 哪怕一小步，都是对庸碌的有力回击！”`;
  } else {
    coachEssay = `“您目前为『${rankTitle}』。虽然 100天达标率仅为 ${Math.round(rate100 * 100)}%，但这恰恰证明您刚刚启程，有着无限的可能性！在习惯培养中，您在【${catNames[topCategory]} ${catEmojis[topCategory]}】方面最为活跃，这是您自律觉醒的最优突破口。改变习惯的第一步往往最艰难，请不要气馁。哪怕今天只点亮一颗绿星、哪怕用补卡券勉强达标，都是对昨天自我的伟大超越。教练在身旁为您守望，明天我们一起加油！”`;
  }

  // 6. 组装 AI 首页简短复盘赠言 (短版 Option B)
  let coachShortAdvice = '';
  if (rate30 >= 0.90) {
    coachShortAdvice = `“30天自律达标 ${Math.round(rate30 * 100)}%！连续达标已 ${streakMetrics.current} 天，您的自律无可挑剔，秩序之光闪耀无瑕！”`;
  } else if (rate30 >= 0.70) {
    coachShortAdvice = `“30天达标率达 ${Math.round(rate30 * 100)}%！意志极其坚定，继续维持 ${catNames[topCategory]} 领域的优势，完美前行！”`;
  } else if (rate30 >= 0.50) {
    coachShortAdvice = `“达标率过半！当前连续 ${streakMetrics.current} 天。身体与灵魂都在路上，用好补卡券，星芒永不熄灭！”`;
  } else if (rate30 >= 0.30) {
    coachShortAdvice = `“达标率 ${Math.round(rate30 * 100)}%，偶有松懈没关系，今天开启 50% 冲刺，用绿色点亮星空吧！”`;
  } else {
    coachShortAdvice = `“启程的微光虽然微弱，但足以穿透黑夜。今天勾选 50% 达成首次完美达标，加油！”`;
  }

  return {
    rate100: Math.round(rate100 * 100),
    rate30: Math.round(rate30 * 100),
    rankTitle,
    starsCount,
    topCategory,
    topCategoryName: catNames[topCategory],
    topCategoryIcon: catIcons[topCategory],
    topCategoryEmoji: catEmojis[topCategory],
    coachEssay,
    coachShortAdvice,
    totalAchievedDays: achieved100,
    maxStreak
  };
}

// 19. 首页常驻复盘面板绘制 (Resident Review Dashboard Panel Renderer)
function renderReviewDashboard() {
  if (!DOM.reviewDashboardCard) return;
  
  const analysis = analyzeSelfDiscipline();
  
  // 1. 渲染星星
  if (DOM.reviewStarsList) {
    DOM.reviewStarsList.innerHTML = '';
    for (let s = 1; s <= 5; s++) {
      const star = document.createElement('i');
      if (s <= analysis.starsCount) {
        star.className = 'fa-solid fa-star star-active';
      } else {
        star.className = 'fa-regular fa-star';
      }
      DOM.reviewStarsList.appendChild(star);
    }
  }

  // 2. 渲染核心偏好标签
  if (DOM.reviewFocusBadge) {
    DOM.reviewFocusBadge.innerHTML = `🎯 核心突破: ${analysis.topCategoryEmoji} 偏爱${analysis.topCategoryName} (${analysis.rate30}% 达标)`;
  }

  // 3. 渲染教练简评
  if (DOM.reviewCoachAdviceText) {
    DOM.reviewCoachAdviceText.innerText = analysis.coachShortAdvice;
  }
}

// 20. 弹出成就海报报告 (Accomplishment Report Dialog Renderer)
function showAccomplishmentReport() {
  if (!DOM.reportDialog) return;
  
  const analysis = analyzeSelfDiscipline();
  
  // 1. 绘制基本数值
  DOM.reportRankTitle.innerText = analysis.rankTitle;
  DOM.reportStatDays.innerText = `${analysis.totalAchievedDays} 天`;
  DOM.reportStatStreak.innerText = `${analysis.maxStreak} 天`;
  DOM.reportStatRate.innerText = `${analysis.rate100}%`;
  
  // 2. 绘制偏爱卡片
  DOM.reportPreferenceName.innerText = `偏爱${analysis.topCategoryName} (${analysis.topCategoryEmoji})`;
  DOM.reportPrefIconContainer.innerHTML = `<i class="fa-solid ${analysis.topCategoryIcon}"></i>`;
  DOM.reportPreferenceDesc.innerText = `在【${analysis.topCategoryName}】自律习惯的坚持中，您的自制力最为顽强！`;
  
  // 3. 绘制 AI 评语
  DOM.reportCoachEssay.innerText = analysis.coachEssay;
  
  // 4. 弹出模态窗口
  DOM.reportDialog.showModal();
}

// 21. 一键复制报告文字分享
function handleShareReportText() {
  const analysis = analyzeSelfDiscipline();
  const today = new Date();
  const dateDisplay = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  
  // 5 颗星级展示字符
  const starsStr = '★'.repeat(analysis.starsCount) + '☆'.repeat(5 - analysis.starsCount);

  const shareText = `🌌 【自律时光成就报告】
📅 生成日期：${dateDisplay}
🏅 自律称号：${analysis.rankTitle}
⭐ 自律星级：${starsStr} (${analysis.rate30}% 达标)
🔥 最长连续：${analysis.maxStreak} 天
🎯 焦点突破：偏爱${analysis.topCategoryName} ${analysis.topCategoryEmoji}
----------------------------------------
📝 【AI 自律教练评语】
${analysis.coachEssay}
----------------------------------------
✨ 跟我一起开启双端游戏化自律打卡，重塑卓越自我！✨`;

  navigator.clipboard.writeText(shareText).then(() => {
    alert('✨ 自律成就报告已完美复制到您的剪贴板！\n您可以直接去微信/朋友圈粘贴分享，向朋友展示您的自律成果啦！');
  }).catch(err => {
    alert('复制失败！请手动选中文字复制。');
  });
}


/* ==========================================================================
   日记系统 Diary System
   ========================================================================== */

// ── 日记 DOM 元素引用 ──
const DiaryDOM = {
  page:            () => document.getElementById('diary-page'),
  listContainer:   () => document.getElementById('diary-list-container'),
  statTotal:       () => document.querySelector('#diary-stat-total .diary-mood-count'),
  moodEmojis:      () => document.getElementById('diary-mood-emojis'),
  streakText:      () => document.getElementById('diary-streak-text'),
  btnNew:          () => document.getElementById('btn-new-diary'),
  // 弹窗
  dialog:          () => document.getElementById('diary-dialog'),
  modalTitle:      () => document.getElementById('diary-modal-title'),
  editorDate:      () => document.getElementById('diary-editor-date'),
  titleInput:      () => document.getElementById('diary-title-input'),
  contentInput:    () => document.getElementById('diary-content-input'),
  charCount:       () => document.getElementById('diary-char-count'),
  btnSave:         () => document.getElementById('btn-save-diary'),
  btnCancel:       () => document.getElementById('btn-cancel-diary'),
  btnClose:        () => document.getElementById('btn-close-diary-dialog'),
  btnDelete:       () => document.getElementById('btn-delete-diary'),
};

// ── 当前编辑中的日记日期 ──
let diaryEditingDateStr = '';

// ── 日期格式化工具 ──
function formatDiaryDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const day   = d.getDate();
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const week  = weekDays[d.getDay()];
  return `${year}年${String(month).padStart(2,'0')}月${String(day).padStart(2,'0')}日 · 星期${week}`;
}

function isToday(dateStr) {
  return dateStr === formatDateToYYYYMMDD(new Date());
}

// ── 页面切换 ──
function switchPage(page) {
  state.currentPage = page;
  const homeSections = document.querySelectorAll(
    '.top-chart-section, .review-panel-section, .bottom-checklist-section, .bottom-analytics-section'
  );
  const diaryPage = DiaryDOM.page();
  const socialPage = document.getElementById('social-page');

  // 侧边栏导航按钮高亮
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // 手机端导航按钮高亮
  const mobileNavBtns = {
    home: document.getElementById('btn-nav-home-mobile'),
    diary: document.getElementById('btn-nav-diary-mobile'),
    social: document.getElementById('btn-nav-social-mobile')
  };
  Object.entries(mobileNavBtns).forEach(([p, el]) => {
    if (el) el.style.opacity = p === page ? '1' : '0.5';
  });

  const statsCard = document.getElementById('mobile-stats-card');

  if (page === 'diary') {
    homeSections.forEach(el => el.style.display = 'none');
    if (diaryPage) { diaryPage.style.display = 'flex'; }
    if (socialPage) { socialPage.style.display = 'none'; }
    if (statsCard) { statsCard.style.setProperty('display', 'none', 'important'); }
    renderDiaryPage();
  } else if (page === 'social') {
    homeSections.forEach(el => el.style.display = 'none');
    if (diaryPage) { diaryPage.style.display = 'none'; }
    if (socialPage) { socialPage.style.display = 'flex'; }
    if (statsCard) { statsCard.style.setProperty('display', 'none', 'important'); }
    renderSocialPage();
  } else {
    // 离开社交页时停止聊天轮询
    if (chatPollInterval) {
      clearInterval(chatPollInterval);
      chatPollInterval = null;
    }
    homeSections.forEach(el => el.style.display = '');
    if (diaryPage) { diaryPage.style.display = 'none'; }
    if (socialPage) { socialPage.style.display = 'none'; }
    if (statsCard) { statsCard.style.removeProperty('display'); }
  }
}

// ── 渲染日记页面 ──
function renderDiaryPage() {
  const diaries = state.diaries || {};
  const entries = Object.entries(diaries).sort((a, b) => b[0].localeCompare(a[0])); // 按日期倒序

  // 更新统计条
  const totalEl = DiaryDOM.statTotal();
  if (totalEl) totalEl.textContent = entries.length;

  // 情绪分布统计
  const moodMap = {};
  entries.forEach(([, d]) => {
    if (d.mood) moodMap[d.mood] = (moodMap[d.mood] || 0) + 1;
  });
  const moodContainer = DiaryDOM.moodEmojis();
  if (moodContainer) {
    if (Object.keys(moodMap).length === 0) {
      moodContainer.innerHTML = '<span style="font-size:12px;color:var(--text-dim);">暂无情绪记录</span>';
    } else {
      moodContainer.innerHTML = Object.entries(moodMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([emoji, count]) =>
          `<div class="diary-mood-chip">${emoji} <span>${count}</span></div>`
        ).join('');
    }
  }

  // 连续记录天数（从今天往前连续有日记）
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = formatDateToYYYYMMDD(d);
    if (diaries[ds]) streak++;
    else break;
  }
  const streakEl = DiaryDOM.streakText();
  if (streakEl) streakEl.textContent = `连续记录 ${streak} 天`;

  // 渲染日记列表
  const container = DiaryDOM.listContainer();
  if (!container) return;

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="diary-empty-state">
        <div class="empty-icon">📖</div>
        <p>这里还是空白的<br>记录下今天的心情与感悟吧</p>
        <small>每一篇日记都是未来的自己写给现在的信</small>
      </div>`;
    return;
  }

  container.innerHTML = entries.map(([dateStr, diary]) => {
    const title   = diary.title   || '';
    const content = diary.content || '';
    const mood    = diary.mood    || '📝';
    const words   = content.length;
    const preview = content.replace(/\n/g, ' ').trim();
    const todayBadge = isToday(dateStr)
      ? '<span style="font-size:10px;padding:2px 7px;background:rgba(138,92,246,0.2);border:1px solid rgba(138,92,246,0.4);border-radius:10px;color:var(--neon-violet);font-weight:600;margin-left:6px;">今天</span>'
      : '';
    return `
      <div class="diary-card" onclick="openDiaryEditor('${dateStr}')">
        <div class="diary-card-header">
          <div class="diary-card-left">
            <div class="diary-card-mood">${mood}</div>
            <div class="diary-card-meta">
              <div class="diary-card-date">${formatDiaryDateLabel(dateStr)}${todayBadge}</div>
              <div class="diary-card-title ${title ? '' : 'no-title'}">${title || '无标题'}</div>
            </div>
          </div>
        </div>
        ${preview ? `<div class="diary-card-preview">${preview}</div>` : ''}
        <div class="diary-card-footer">
          <span class="diary-card-words">${words > 0 ? `${words} 字` : '空白日记'}</span>
          <span class="diary-card-edit-hint"><i class="fa-solid fa-pen"></i> 点击编辑</span>
        </div>
      </div>`;
  }).join('');
}

// ── 打开日记编辑弹窗 ──
function openDiaryEditor(dateStr) {
  diaryEditingDateStr = dateStr;
  const diary = (state.diaries || {})[dateStr] || {};
  const dialog = DiaryDOM.dialog();
  if (!dialog) return;

  // 填充日期
  const editorDate = DiaryDOM.editorDate();
  if (editorDate) editorDate.textContent = formatDiaryDateLabel(dateStr);

  // 设置弹窗标题
  const modalTitle = DiaryDOM.modalTitle();
  if (modalTitle) modalTitle.textContent = isToday(dateStr) ? '今日日记' : formatDiaryDateLabel(dateStr).split(' ·')[0];

  // 填充内容
  const titleInput = DiaryDOM.titleInput();
  if (titleInput) titleInput.value = diary.title || '';

  const contentInput = DiaryDOM.contentInput();
  if (contentInput) {
    contentInput.value = diary.content || '';
    updateDiaryCharCount();
  }

  // 设置情绪选择
  const savedMood = diary.mood || '😄';
  const moodRadios = document.querySelectorAll('input[name="diary-mood"]');
  moodRadios.forEach(r => { r.checked = (r.value === savedMood); });

  // 显示/隐藏删除按钮
  const btnDelete = DiaryDOM.btnDelete();
  if (btnDelete) btnDelete.style.display = diary.content || diary.title ? 'flex' : 'none';

  dialog.showModal();
}

// ── 新建今日日记 ──
function openNewDiaryForToday() {
  openDiaryEditor(formatDateToYYYYMMDD(new Date()));
}

// ── 更新字数统计 ──
function updateDiaryCharCount() {
  const input = DiaryDOM.contentInput();
  const counter = DiaryDOM.charCount();
  if (input && counter) counter.textContent = input.value.length;
}

// ── 保存日记 ──
async function saveDiary() {
  const title   = (DiaryDOM.titleInput()?.value || '').trim();
  const content = (DiaryDOM.contentInput()?.value || '').trim();
  const moodEl  = document.querySelector('input[name="diary-mood"]:checked');
  const mood    = moodEl ? moodEl.value : '😄';

  if (!content && !title) {
    // 空内容不保存
    closeDiaryDialog();
    return;
  }

  if (!state.diaries) state.diaries = {};
  state.diaries[diaryEditingDateStr] = {
    title,
    content,
    mood,
    updatedAt: new Date().toISOString()
  };

  await saveDatabase();
  closeDiaryDialog();
  renderDiaryPage();

  // 保存成功小提示
  showDiaryToast('日记已保存 ✨');
}

// ── 删除日记 ──
async function deleteDiary() {
  if (!confirm('确定要删除这篇日记吗？此操作不可恢复。')) return;
  if (state.diaries && state.diaries[diaryEditingDateStr]) {
    delete state.diaries[diaryEditingDateStr];
    await saveDatabase();
  }
  closeDiaryDialog();
  renderDiaryPage();
  showDiaryToast('日记已删除');
}

// ── 关闭弹窗 ──
function closeDiaryDialog() {
  const dialog = DiaryDOM.dialog();
  if (dialog && dialog.open) dialog.close();
}

// ── 简单 Toast 提示 ──
function showDiaryToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.cssText = `
    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
    background: rgba(138,92,246,0.92); color: #fff; padding: 10px 22px;
    border-radius: 24px; font-size: 14px; font-weight: 500; z-index: 9999;
    box-shadow: 0 4px 20px rgba(138,92,246,0.5);
    animation: fadeInUp 0.3s ease;
    pointer-events: none;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

// ── 初始化日记事件绑定 ──
function initDiaryEventListeners() {
  // 侧边栏导航
  document.getElementById('nav-btn-home')?.addEventListener('click', () => switchPage('home'));
  document.getElementById('nav-btn-diary')?.addEventListener('click', () => switchPage('diary'));
  document.getElementById('nav-btn-social')?.addEventListener('click', () => switchPage('social'));

  // 移动端导航按钮
  document.getElementById('btn-nav-home-mobile')?.addEventListener('click', () => switchPage('home'));
  document.getElementById('btn-nav-diary-mobile')?.addEventListener('click', () => switchPage('diary'));
  document.getElementById('btn-nav-social-mobile')?.addEventListener('click', () => switchPage('social'));

  // 写今日日记按钮
  document.getElementById('btn-new-diary')?.addEventListener('click', openNewDiaryForToday);

  // 日记弹窗关闭/取消
  document.getElementById('btn-close-diary-dialog')?.addEventListener('click', closeDiaryDialog);
  document.getElementById('btn-cancel-diary')?.addEventListener('click', closeDiaryDialog);

  // 保存日记
  document.getElementById('btn-save-diary')?.addEventListener('click', saveDiary);

  // 删除日记
  document.getElementById('btn-delete-diary')?.addEventListener('click', deleteDiary);

  // 字数实时统计
  document.getElementById('diary-content-input')?.addEventListener('input', updateDiaryCharCount);

  // 点击弹窗外关闭
  document.getElementById('diary-dialog')?.addEventListener('click', function(e) {
    if (e.target === this) closeDiaryDialog();
  });
}

// ── 在 DOMContentLoaded 时初始化日记系统 ──
// （追加到 window.addEventListener('DOMContentLoaded') 结束前）
document.addEventListener('DOMContentLoaded', () => {
  initDiaryEventListeners();
  initThemeSwitcher();
  initSocialSystem(); // [NEW] 初始化社交与情侣系统

  // 网页端注册 PWA Service Worker (Electron 环境下跳过)
  const isElectron = typeof process !== 'undefined' && process.versions && process.versions.electron;
  if (!isElectron && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('PWA Service Worker registered:', reg.scope))
      .catch((err) => console.error('PWA Service Worker failed to register:', err));
  }
});


/* ==========================================================================
   UI 主题切换 Theme Switcher
   ========================================================================== */

function applyUITheme(theme) {
  document.body.classList.remove('theme-stardew', 'theme-spongebob');
  if (theme === 'stardew') {
    document.body.classList.add('theme-stardew');
  } else if (theme === 'spongebob') {
    document.body.classList.add('theme-spongebob');
  }
  // 同步设置弹窗中的 radio 选中状态
  const radio = document.querySelector(`input[name="ui-theme"][value="${theme}"]`);
  if (radio) radio.checked = true;

  // 刷新折线图配色
  if (document.getElementById('habit-trend-chart')) {
    renderTrendChart();
  }
}

function initThemeSwitcher() {
  const radios = document.querySelectorAll('input[name="ui-theme"]');
  radios.forEach(radio => {
    radio.addEventListener('change', async (e) => {
      const theme = e.target.value;
      state.uiTheme = theme;
      applyUITheme(theme);
      await saveDatabase();
    });
  });
}

/* ==========================================================================
   18. 社交圈与情侣空间及实时聊天系统 Social & Couple & Chat System
   ========================================================================== */

// ── 实时聊天刷新定时器与活跃聊天Token ──
let chatPollInterval = null;
let activeChatToken = null;

// 页面关闭/刷新时清理聊天轮询，防止资源泄漏
window.addEventListener('beforeunload', () => {
  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
});

// ── 初始化社交系统事件监听 ──
function initSocialSystem() {
  // 1. 社交页面标签卡 Tab 切换
  document.querySelectorAll('.social-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = btn.dataset.tab;
      // 切换按钮 active 状态
      document.querySelectorAll('.social-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // 切换面板展示
      document.querySelectorAll('.social-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById(`social-panel-${tab}`);
      if (panel) panel.style.display = 'flex';
      
      // 渲染标签卡内容
      renderSocialTab(tab);
    });
  });

  // 2. 我的档案 - 头像点击实时预览
  const avatarRadios = document.querySelectorAll('input[name="my-avatar"]');
  avatarRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const previewBox = document.getElementById('my-avatar-preview-box');
      if (previewBox) previewBox.textContent = getAvatarEmoji(e.target.value);
    });
  });

  // 3. 我的档案 - 保存按钮
  document.getElementById('btn-save-profile')?.addEventListener('click', saveMyProfile);

  // 4. 我的档案 - 复制同步码按钮
  document.getElementById('btn-copy-social-token')?.addEventListener('click', copySocialToken);

  // 5. 好友圈 - 添加好友按钮
  document.getElementById('btn-add-friend-submit')?.addEventListener('click', addFriend);

  // 6. 情侣空间 - 绑定伴侣按钮
  document.getElementById('btn-bind-partner-submit')?.addEventListener('click', bindPartner);

  // 7. 情侣空间 - 解除绑定按钮
  document.getElementById('btn-unbind-partner')?.addEventListener('click', unbindPartner);

  // 8. 情侣空间 - 开启聊天按钮
  document.getElementById('btn-open-couple-chat')?.addEventListener('click', openCoupleChat);

  // 9. 聊天弹窗 - 关闭与取消
  document.getElementById('btn-close-chat-dialog')?.addEventListener('click', closeChat);
  document.getElementById('chat-dialog')?.addEventListener('click', function(e) {
    if (e.target === this) closeChat();
  });

  // 10. 聊天弹窗 - 发送按钮与回车监听
  document.getElementById('btn-send-chat-message')?.addEventListener('click', sendChatMessage);
  document.getElementById('chat-message-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // 11. 海绵宝宝主题专属比奇堡横幅点击交互彩蛋 & 快捷跳转
  document.querySelector('.spongebob-home-banner')?.addEventListener('click', () => {
    triggerSpongebobEasterEgg();
    // 渐进切换到社交圈页面
    setTimeout(() => {
      switchPage('social');
    }, 1800);
  });

  document.querySelector('.spongebob-scene-banner')?.addEventListener('click', triggerSpongebobEasterEgg);

  // 12. 伴侣日记阅读弹窗 - 关闭与背景点击监听
  document.getElementById('btn-close-partner-diary-dialog')?.addEventListener('click', closePartnerDiaryViewer);
  document.getElementById('btn-close-partner-diary')?.addEventListener('click', closePartnerDiaryViewer);
  document.getElementById('partner-diary-dialog')?.addEventListener('click', function(e) {
    if (e.target === this) closePartnerDiaryViewer();
  });
}

// ── 渲染社交页面入口 ──
function renderSocialPage() {
  // 1. 同步码展示与提示
  const tokenText = document.getElementById('my-social-token-text');
  if (tokenText) {
    tokenText.textContent = state.syncToken || '暂无云同步码';
  }

  // 2. 默认激活“我的档案”面板
  document.querySelectorAll('.social-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'profile');
  });
  document.querySelectorAll('.social-panel').forEach(p => {
    p.style.display = p.id === 'social-panel-profile' ? 'flex' : 'none';
  });

  // 渲染我的档案
  renderSocialTab('profile');
}

// ── 根据激活的 Tab 渲染对应数据 ──
function renderSocialTab(tab) {
  if (tab === 'profile') {
    // 填充我的昵称
    const nicknameInput = document.getElementById('profile-nickname-input');
    if (nicknameInput) nicknameInput.value = state.nickname || '自律冒险者';

    // 选中我的头像 Radio
    const savedAvatar = state.avatar || 'cow';
    const avatarRadio = document.querySelector(`input[name="my-avatar"][value="${savedAvatar}"]`);
    if (avatarRadio) avatarRadio.checked = true;

    // 预览框
    const previewBox = document.getElementById('my-avatar-preview-box');
    if (previewBox) previewBox.textContent = getAvatarEmoji(savedAvatar);

  } else if (tab === 'friends') {
    renderFriendsTab();

  } else if (tab === 'couple') {
    renderCoupleTab();
  }
}

// ── 保存我的档案 ──
async function saveMyProfile() {
  const nicknameInput = document.getElementById('profile-nickname-input');
  const nickname = (nicknameInput?.value || '').trim();
  const avatarEl = document.querySelector('input[name="my-avatar"]:checked');
  const avatar = avatarEl ? avatarEl.value : 'cow';

  if (!nickname) {
    showSocialToast('请输入有效的自律昵称 🌸');
    return;
  }

  state.nickname = nickname;
  state.avatar = avatar;
  
  await saveDatabase();
  showSocialToast('个人档案已保存 ✨');

  // 如果绑定了云同步，静默上传云端更新他人可见的昵称和头像
  if (state.syncToken && state.autoSync) {
    performCloudSyncPush();
  }
}

// ── 复制我的同步码 ──
function copySocialToken() {
  if (!state.syncToken) {
    showSocialToast('请先前往系统设置生成云同步码哦！💡');
    return;
  }
  navigator.clipboard.writeText(state.syncToken);
  showSocialToast('同步码已复制到剪贴板，快去发给好友吧 📋');
}

// ── 添加好友 ──
async function addFriend() {
  const tokenInput = document.getElementById('add-friend-token-input');
  const token = (tokenInput?.value || '').trim().toUpperCase();

  if (!token) {
    showSocialToast('请输入好友的云同步码哦 🔍');
    return;
  }

  if (!token.startsWith('SYNC-')) {
    showSocialToast('无效的同步码，必须以 SYNC- 开头 ⚠️');
    return;
  }

  if (token === state.syncToken) {
    showSocialToast('不能添加自己为好友哦 😊');
    return;
  }

  // 查重
  const alreadyFriend = state.friends.some(f => f.token === token);
  if (alreadyFriend) {
    showSocialToast('你们已经是好友啦，无需重复添加 🌿');
    return;
  }

  showSocialToast('正在云端寻觅这位自律的小伙伴... 🛰️');

  try {
    const friendDB = await fetchAndDecryptKVDB(token);
    if (!friendDB) {
      showSocialToast('未找到该伙伴，请确认同步码是否输入正确且对方已开启云同步 🌌');
      return;
    }

    const friendNickname = friendDB.nickname || '神秘自律者';
    const friendAvatar = friendDB.avatar || 'cow';

    state.friends.push({
      token: token,
      nickname: friendNickname,
      avatar: friendAvatar,
      addedAt: Date.now()
    });

    await saveDatabase();
    if (tokenInput) tokenInput.value = '';

    showSocialToast(`成功添加好友「${friendNickname}」！🎉`);
    renderFriendsTab();
  } catch (error) {
    console.error('添加好友失败:', error);
    showSocialToast('网络连接失败，请稍后重试 📡');
  }
}

// ── 删除好友 ──
function deleteFriend(token, nickname) {
  if (!confirm(`确定要删除好友「${nickname}」吗？此操作不会清除聊天记录，但会取消打卡关注。`)) return;

  state.friends = state.friends.filter(f => f.token !== token);
  saveDatabase().then(() => {
    showSocialToast('已解除好友打卡关注 🍂');
    renderFriendsTab();
  });
}

// ── 渲染好友圈标签卡 ──
function renderFriendsTab() {
  const container = document.getElementById('friends-list-container');
  const countText = document.getElementById('friends-count-text');
  if (!container) return;

  const count = state.friends.length;
  if (countText) countText.textContent = `共有 ${count} 位打卡伙伴`;

  if (count === 0) {
    container.innerHTML = `
      <div class="empty-social-state">
        <i class="fa-solid fa-ghost"></i>
        <p>你的成长田野里还没有打卡伙伴哦，快去交换同步码添加他们吧！</p>
      </div>
    `;
    return;
  }

  // 渲染缓存数据生成的卡片
  container.innerHTML = state.friends.map(friend => {
    const safeNickname = escapeHTML(friend.nickname);
    return `
      <div class="friend-card glass" id="friend-card-${friend.token}">
        <div class="friend-card-top">
          <div class="friend-avatar" id="avatar-emoji-${friend.token}">${getAvatarEmoji(friend.avatar)}</div>
          <div class="friend-info">
            <div class="friend-name-row" style="display: flex; align-items: center; gap: 6px; justify-content: flex-start;">
              <div class="friend-name" id="name-${friend.token}" style="margin: 0;">${safeNickname}</div>
              <span class="online-status-dot offline" id="online-dot-${friend.token}"></span>
            </div>
            <div class="friend-token-row" style="display: flex; align-items: center; gap: 8px; margin-top: 2px;">
              <span class="friend-token" style="font-family: monospace; font-size: 10px; opacity: 0.7;">${friend.token}</span>
              <span class="online-status-text" id="online-text-${friend.token}" style="font-size: 10px; color: var(--text-dim);">正在拉取...</span>
            </div>
          </div>
        </div>

        <div class="friend-card-middle">
          <div class="friend-status-row">
            <div class="status-label-group">
              <span>今日打卡进度:</span>
              <span id="progress-text-${friend.token}">正在同步云端... 🔄</span>
            </div>
            <div class="cozy-progress-bar">
              <div class="cozy-progress-fill" id="progress-fill-${friend.token}" style="width: 0%;"></div>
            </div>
            <div class="friend-streak-row" id="streak-text-${friend.token}">
              <!-- 连续打卡天数 -->
            </div>
          </div>
        </div>

        <div class="friend-card-bottom">
          <button class="btn btn-primary btn-small" onclick="openChat('${escapeJS(friend.token)}', '${escapeJS(friend.nickname)}', '${escapeJS(friend.avatar)}')">
            <i class="fa-solid fa-comments"></i> 聊聊天
          </button>
          <button class="btn btn-danger-outline btn-small" onclick="deleteFriend('${escapeJS(friend.token)}', '${escapeJS(friend.nickname)}')">
            <i class="fa-solid fa-user-minus"></i> 移除
          </button>
        </div>
      </div>
    `;
  }).join('');

  // 依次在后台静默发起异步 Fetch 请求，更新打卡进度和连续天数 (并行无阻塞载入！)
  state.friends.forEach(friend => {
    fetchFriendProgress(friend);
  });
}

// ── 异步后台载入单个好友打卡与连续指标 ──
async function fetchFriendProgress(friend) {
  try {
    const db = await fetchAndDecryptKVDB(friend.token);
    if (!db) return;

    const today = formatDateToYYYYMMDD(new Date());
    const habits = db.habits || [];
    const checkIns = db.checkIns || {};
    const todayCheckIns = checkIns[today] || [];

    // 过滤出未归档习惯
    const activeHabits = habits.filter(h => !h.archived);
    const total = activeHabits.length;
    const done = todayCheckIns.filter(id => habits.some(h => h.id === id && !h.archived)).length;

    // 算出今日打卡百分比
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    
    // 计算连续打卡天数
    const streak = calculateAnyCheckInStreak(checkIns);

    // 更新对应的 DOM 元素
    const progressFill = document.getElementById(`progress-fill-${friend.token}`);
    const progressText = document.getElementById(`progress-text-${friend.token}`);
    const streakText = document.getElementById(`streak-text-${friend.token}`);
    const avatarEl = document.getElementById(`avatar-emoji-${friend.token}`);
    const nameEl = document.getElementById(`name-${friend.token}`);

    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = `${done} / ${total} (${pct}%)`;
    if (streakText) {
      if (streak > 0) {
        streakText.innerHTML = `<i class="fa-solid fa-fire-flame-curved"></i> 连续打卡 ${streak} 天`;
        streakText.style.display = 'flex';
      } else {
        streakText.style.display = 'none';
      }
    }
    
    // 动态同步更新头像和昵称缓存
    if (db.nickname && db.nickname !== friend.nickname) {
      friend.nickname = db.nickname;
      if (nameEl) nameEl.textContent = db.nickname;
    }
    if (db.avatar && db.avatar !== friend.avatar) {
      friend.avatar = db.avatar;
      if (avatarEl) avatarEl.textContent = getAvatarEmoji(db.avatar);
    }

    // ── [NEW] 更新在线状态指示灯 ──
    const lastActiveText = formatLastActiveTime(db.lastUpdated);
    const dotEl = document.getElementById(`online-dot-${friend.token}`);
    const textEl = document.getElementById(`online-text-${friend.token}`);
    if (dotEl) {
      if (lastActiveText === '在线') {
        dotEl.className = 'online-status-dot online';
      } else {
        dotEl.className = 'online-status-dot offline';
      }
    }
    if (textEl) {
      textEl.textContent = lastActiveText;
    }
  } catch (err) {
    console.warn(`拉取好友 ${friend.token} 的实时打卡进度失败:`, err);
    const progressText = document.getElementById(`progress-text-${friend.token}`);
    if (progressText) progressText.textContent = '获取失败 (离线)';

    const dotEl = document.getElementById(`online-dot-${friend.token}`);
    const textEl = document.getElementById(`online-text-${friend.token}`);
    if (dotEl) dotEl.className = 'online-status-dot offline';
    if (textEl) textEl.textContent = '离线 (未同步)';
  }
}

// ── 绑定情侣关系 ──
async function bindPartner() {
  const tokenInput = document.getElementById('bind-partner-token-input');
  const token = (tokenInput?.value || '').trim().toUpperCase();

  if (!token) {
    showSocialToast('请输入伴侣的云同步码 💖');
    return;
  }

  if (!token.startsWith('SYNC-')) {
    showSocialToast('无效的同步码，必须以 SYNC- 开头 ⚠️');
    return;
  }

  if (token === state.syncToken) {
    showSocialToast('不能跟自己建立情侣关系哦，去找心仪的另一半吧 🌹');
    return;
  }

  showSocialToast('正在架设你们专属的浪漫星桥... ✨');

  try {
    const partnerDB = await fetchAndDecryptKVDB(token);
    if (!partnerDB) {
      showSocialToast('未能架通，请确认另一半的同步码是否输入正确，且已在系统设置开启同步！🌱');
      return;
    }

    const partnerNickname = partnerDB.nickname || '神秘伴侣';
    const partnerAvatar = partnerDB.avatar || 'dog';

    // 绑定
    state.couple = {
      isBound: true,
      partnerToken: token,
      partnerNickname: partnerNickname,
      partnerAvatar: partnerAvatar,
      boundAt: Date.now()
    };

    await saveDatabase();
    showSocialToast(`恭喜！成功绑定情侣「${partnerNickname}」！专属空间已开启 💖`);
    renderCoupleTab();
  } catch (error) {
    console.error('绑定情侣失败:', error);
    showSocialToast('网络连接失败，请稍后重试 📡');
  }
}

// ── 解除情侣绑定 ──
async function unbindPartner() {
  if (!confirm('你确定要解除情侣绑定关系吗？你们的情侣纪念日和聊天室都将消失。解除后不可恢复。💔')) return;

  state.couple = {
    isBound: false,
    partnerToken: '',
    partnerNickname: '',
    partnerAvatar: '',
    boundAt: 0
  };

  await saveDatabase();
  showSocialToast('已解除绑定关系 🍂');
  renderCoupleTab();
}

// ── 渲染情侣空间 ──
function renderCoupleTab() {
  const unboundView = document.getElementById('couple-unbound-view');
  const boundView = document.getElementById('couple-bound-view');
  if (!unboundView || !boundView) return;

  if (!state.couple || !state.couple.isBound) {
    // 未绑定显示
    unboundView.style.display = 'flex';
    boundView.style.display = 'none';
  } else {
    // 已绑定显示
    unboundView.style.display = 'none';
    boundView.style.display = 'flex';

    // 1. 计算纪念日
    const boundAt = state.couple.boundAt || Date.now();
    const diffTime = Math.max(0, Date.now() - boundAt);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1; // 绑定当天显示第1天
    
    const daysText = document.getElementById('couple-anniversary-days');
    if (daysText) daysText.textContent = `我们已经携手坚持了 ${diffDays} 天`;

    // 2. 渲染我的进度
    const myName = document.getElementById('couple-my-name');
    const myAvatar = document.getElementById('couple-my-avatar');
    if (myName) myName.textContent = state.nickname || '自律冒险者';
    if (myAvatar) myAvatar.textContent = getAvatarEmoji(state.avatar);

    const today = formatDateToYYYYMMDD(new Date());
    const myActiveHabits = state.habits.filter(h => !h.archived);
    const myTotal = myActiveHabits.length;
    const myDone = (state.checkIns[today] || []).filter(id => state.habits.some(h => h.id === id && !h.archived)).length;
    const myPct = myTotal > 0 ? Math.round((myDone / myTotal) * 100) : 0;

    const myProgressFill = document.getElementById('couple-my-progress-fill');
    const myProgressText = document.getElementById('couple-my-progress-text');
    if (myProgressFill) myProgressFill.style.width = `${myPct}%`;
    if (myProgressText) myProgressText.textContent = `${myDone} / ${myTotal} (${myPct}%)`;

    // 3. 渲染伴侣进度 (后台载入)
    const partnerName = document.getElementById('couple-partner-name');
    const partnerAvatar = document.getElementById('couple-partner-avatar');
    if (partnerName) partnerName.textContent = state.couple.partnerNickname || '等待获取...';
    if (partnerAvatar) partnerAvatar.textContent = getAvatarEmoji(state.couple.partnerAvatar);

    const partnerProgressFill = document.getElementById('couple-partner-progress-fill');
    const partnerProgressText = document.getElementById('couple-partner-progress-text');
    if (partnerProgressFill) partnerProgressFill.style.width = '0%';
    if (partnerProgressText) partnerProgressText.textContent = '正在获取...';

    // 异步拉取伴侣数据
    fetchPartnerCoupleProgress();
  }
}

// ── 异步拉取伴侣打卡指标并刷新情侣卡片 ──
async function fetchPartnerCoupleProgress() {
  if (!state.couple || !state.couple.isBound) return;
  const token = state.couple.partnerToken;

  try {
    const db = await fetchAndDecryptKVDB(token);
    if (!db) return;

    const today = formatDateToYYYYMMDD(new Date());
    const habits = db.habits || [];
    const checkIns = db.checkIns || {};
    const todayCheckIns = checkIns[today] || [];

    const activeHabits = habits.filter(h => !h.archived);
    const total = activeHabits.length;
    const done = todayCheckIns.filter(id => habits.some(h => h.id === id && !h.archived)).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const partnerName = document.getElementById('couple-partner-name');
    const partnerAvatar = document.getElementById('couple-partner-avatar');
    const partnerProgressFill = document.getElementById('couple-partner-progress-fill');
    const partnerProgressText = document.getElementById('couple-partner-progress-text');

    if (partnerProgressFill) partnerProgressFill.style.width = `${pct}%`;
    if (partnerProgressText) partnerProgressText.textContent = `${done} / ${total} (${pct}%)`;
    
    // 更新伴侣基本信息缓存
    if (db.nickname && db.nickname !== state.couple.partnerNickname) {
      state.couple.partnerNickname = db.nickname;
      if (partnerName) partnerName.textContent = db.nickname;
      await saveDatabase();
    }
    if (db.avatar && db.avatar !== state.couple.partnerAvatar) {
      state.couple.partnerAvatar = db.avatar;
      if (partnerAvatar) partnerAvatar.textContent = getAvatarEmoji(db.avatar);
      await saveDatabase();
    }

    // [NEW] 抓取并渲染伴侣的只读日记列表
    const partnerDiaries = db.diaries || {};
    renderPartnerDiariesList(partnerDiaries);

    // ── [NEW] 更新伴侣在线状态指示 ──
    const lastActiveText = formatLastActiveTime(db.lastUpdated);
    const partnerDot = document.getElementById('couple-partner-online-dot');
    const partnerText = document.getElementById('couple-partner-online-text');
    if (partnerDot) {
      if (lastActiveText === '在线') {
        partnerDot.className = 'online-status-dot online';
      } else {
        partnerDot.className = 'online-status-dot offline';
      }
    }
    if (partnerText) {
      partnerText.textContent = lastActiveText;
    }
  } catch (err) {
    console.warn('获取伴侣打卡信息失败:', err);
    const partnerProgressText = document.getElementById('couple-partner-progress-text');
    if (partnerProgressText) partnerProgressText.textContent = '伴侣目前离线';

    const partnerDot = document.getElementById('couple-partner-online-dot');
    const partnerText = document.getElementById('couple-partner-online-text');
    if (partnerDot) partnerDot.className = 'online-status-dot offline';
    if (partnerText) partnerText.textContent = '离线 (无法连接)';
  }
}

// ── 开启情侣聊天的快捷方式 ──
function openCoupleChat() {
  if (!state.couple || !state.couple.isBound) return;
  openChat(state.couple.partnerToken, state.couple.partnerNickname, state.couple.partnerAvatar);
}

// ── 开启聊天窗口 ──
function openChat(token, name, avatar) {
  if (!state.syncToken) {
    showSocialToast('请先前往系统设置激活你自己的云同步码，才能给别人发消息哦 💬');
    return;
  }

  activeChatToken = token;

  // 1. 设置头部详情
  const windowAvatar = document.getElementById('chat-window-avatar');
  const windowTitle = document.getElementById('chat-window-title');
  if (windowAvatar) windowAvatar.textContent = getAvatarEmoji(avatar);
  if (windowTitle) windowTitle.textContent = `与「${name}」畅聊中`;

  // 2. 清空并滚动历史
  const container = document.getElementById('chat-messages-container');
  if (container) {
    container.innerHTML = `
      <div class="chat-empty-state">
        <i class="fa-solid fa-spinner fa-spin" style="font-size:24px;margin-bottom:10px;"></i><br>
        正在架设微光云端信道...
      </div>
    `;
  }

  // 3. 展现 Dialog
  const dialog = document.getElementById('chat-dialog');
  if (dialog) dialog.showModal();

  // 4. 载入消息并开启定时轮询 (每 4秒)
  fetchChatMessages();
  chatPollInterval = setInterval(fetchChatMessages, 4000);
}

// ── 关闭聊天窗口 ──
function closeChat() {
  // 清除定时轮询
  if (chatPollInterval) {
    clearInterval(chatPollInterval);
    chatPollInterval = null;
  }
  activeChatToken = null;

  const dialog = document.getElementById('chat-dialog');
  if (dialog) dialog.close();
}

// ── 拼装两个好友的共享 Chat Key ──
function getSharedChatId(tokenA, tokenB) {
  const sorted = [tokenA, tokenB].sort();
  return `CHAT-${sorted[0]}-${sorted[1]}`;
}

// ── 拉取聊天信道消息 ──
async function fetchChatMessages() {
  if (!activeChatToken || !state.syncToken) return;
  const chatId = getSharedChatId(state.syncToken, activeChatToken);

  try {
    const messages = await fetchAndDecryptKVDB(chatId);
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    if (!messages || messages.length === 0) {
      container.innerHTML = `
        <div class="chat-empty-state">说点什么吧，留下一句自律鼓励！💬</div>
      `;
      return;
    }

    // 渲染气泡
    container.innerHTML = messages.map(msg => {
      const isMe = msg.sender === state.syncToken;
      const avatarEmoji = isMe ? getAvatarEmoji(state.avatar) : getAvatarEmoji(msg.senderAvatar || 'dog');
      const senderName = isMe ? (state.nickname || '我') : (msg.senderName || '伙伴');
      const date = new Date(msg.timestamp);
      const timeStr = `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;

      return `
        <div class="chat-bubble ${isMe ? 'me' : 'friend'}">
          <div class="chat-bubble-avatar" title="${senderName}">${avatarEmoji}</div>
          <div class="chat-bubble-wrapper">
            <div class="chat-bubble-text">${escapeHTML(msg.text)}</div>
            <div class="chat-bubble-time">${timeStr}</div>
          </div>
        </div>
      `;
    }).join('');

    // 自动滚动到最底端 (Scroll to bottom)
    container.scrollTop = container.scrollHeight;

  } catch (error) {
    console.warn('拉取云端聊天数据失败:', error);
  }
}

// ── 发送聊天消息（含竞态重试，避免双人同时发消息时丢失）──
async function sendChatMessage() {
  const input = document.getElementById('chat-message-input');
  const text = (input?.value || '').trim();

  if (!text || !activeChatToken || !state.syncToken) return;

  if (input) input.value = '';

  const chatId = getSharedChatId(state.syncToken, activeChatToken);

  const newMsg = {
    id: crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    sender: state.syncToken,
    senderName: state.nickname || '自律冒险者',
    senderAvatar: state.avatar || 'cow',
    text: text,
    timestamp: Date.now()
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 1. 拉取当前云端的聊天历史
      let currentMessages = await fetchAndDecryptKVDB(chatId) || [];

      // 2. 去重检查
      if (!currentMessages.some(m => m.id === newMsg.id)) {
        currentMessages.push(newMsg);
      }

      // 3. 裁剪只保留最新 60 条消息，加密上传
      const prunedMessages = currentMessages.slice(-60);
      await sendEncryptedKVDB(chatId, prunedMessages);

      // 4. 验证消息确实写入成功
      const verifyData = await fetchAndDecryptKVDB(chatId);
      if (verifyData && verifyData.some(m => m.id === newMsg.id)) {
        break; // 写入确认成功，退出重试循环
      }
    } catch (error) {
      console.warn(`发送消息第${attempt + 1}次尝试失败:`, error);
    }
  }

  fetchChatMessages();
}

// ── 计算任意打卡 checkIns 对象的连续记录天数 ──
function calculateAnyCheckInStreak(checkIns) {
  if (!checkIns || Object.keys(checkIns).length === 0) return 0;

  const dates = Object.keys(checkIns).sort().reverse();
  const todayStr = formatDateToYYYYMMDD(new Date());
  const yesterdayStr = formatDateToYYYYMMDD(new Date(Date.now() - 86400000));

  // 如果最近一次打卡比昨天还早，则当前连续天数为0
  const lastCheckIn = dates[0];
  if (lastCheckIn !== todayStr && lastCheckIn !== yesterdayStr) {
    return 0;
  }

  let streak = 0;
  let cursor = new Date();
  
  while (true) {
    const ds = formatDateToYYYYMMDD(cursor);
    const checkedInList = checkIns[ds] || [];
    
    if (checkedInList.length > 0) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      // 若今天是空的，直接看昨天是否连续，否则中断
      if (ds === todayStr) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
  }
  return streak;
}

// ── 头像 key 到 emoji 的对齐 ──
function getAvatarEmoji(avatar) {
  const emojis = {
    cow: '🐮',
    chick: '🐤',
    dog: '🐶',
    cat: '🐱',
    pig: '🐷',
    slime: '💧',
    spongebob: '🧽',
    patrick: '⭐️',
    squidward: '🐙',
    mrkrabs: '🦀'
  };
  return emojis[avatar] || '🐮';
}

// ── 海绵宝宝经典角色语录彩蛋 ──
function triggerSpongebobEasterEgg() {
  const quotes = [
    "🧽 海绵宝宝：“我准备好了！我准备好了！今天也要元气满满地自律打卡哦！🌞”",
    "⭐️ 派大星：“知识代替不了友谊，我宁愿做一个傻子也不愿失去你。今天我们也要一起努力！💖”",
    "🐌 小蜗：“喵～（小蜗爬得很慢，但也一直在默默坚持着陪你哦 🐌）”",
    "🦀 谢老板：“哦我的小钱钱！不过比起闪闪发光的金币，今天你的打卡更加珍贵！🪙”",
    "🐙 章鱼哥：“虽然我很讨厌上班，但我不得不承认，自律坚韧的你确实非常迷人。🎨”",
    "🍔 痞老板：“可恶！今天又没有偷到蟹堡秘方，但你的自律计划进行得无懈可击！🧪”",
    "🪼 水母：“哔哔哔～（水母 fields 传来欢快的电波，祝你打卡成功！🪼）”"
  ];
  const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
  showSocialToast(randomQuote);
}

// ── 极简安全 HTML 转义工具 ──
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── 社交系统专属浮动Toast提示 ──
function showSocialToast(message) {
  // 移除存在的 toast
  const existingToast = document.querySelector('.social-toast');
  if (existingToast) existingToast.remove();

  // 创建 Toast Element
  const toast = document.createElement('div');
  toast.className = 'social-toast';
  toast.innerText = message;

  // 定位与样式 (可在此直接写入，确保不依赖外置CSS类)
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '40px',
    left: '50%',
    transform: 'translateX(-50%) translateY(20px)',
    background: 'rgba(15, 23, 42, 0.95)',
    color: '#ffffff',
    padding: '10px 20px',
    borderRadius: '20px',
    fontSize: '13px',
    fontWeight: 'bold',
    zIndex: '99999',
    boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
    border: '1.5px solid rgba(255,255,255,0.08)',
    opacity: '0',
    transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    pointerEvents: 'none'
  });

  // 如果是星露谷主题，自动适配为羊皮纸像素框提示；如果是海绵宝宝主题，自动适配为可爱气泡框提示
  if (document.body.classList.contains('theme-stardew')) {
    Object.assign(toast.style, {
      background: '#f7e1b5',
      color: '#4a2107',
      borderRadius: '0px',
      border: '3px solid #3c1f0f',
      boxShadow: '0 4px 0 #1a0f07, 0 0 0 3px #b57a3d',
      fontFamily: 'Outfit, sans-serif'
    });
  } else if (document.body.classList.contains('theme-spongebob')) {
    Object.assign(toast.style, {
      background: '#ffd54f',
      color: '#0077b6',
      borderRadius: '24px',
      border: '3px solid #ff8fa3',
      boxShadow: '0 4px 15px rgba(255, 143, 163, 0.4)',
      fontFamily: 'Outfit, sans-serif'
    });
  }

  document.body.appendChild(toast);

  // 触发动画
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  }, 30);

  // 延时关闭
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

// ── [NEW] 情侣专属日记渲染与阅读引擎 (Couple Diary Engine) ──
function renderPartnerDiariesList(diaries) {
  const container = document.getElementById('partner-diaries-list');
  if (!container) return;

  const entries = Object.entries(diaries).sort((a, b) => b[0].localeCompare(a[0])); // 按日期倒序

  // 动态更新日记本大标题
  const label = document.getElementById('partner-diary-title-label');
  if (label) {
    label.textContent = `${state.couple.partnerNickname || 'Ta'} 的自律秘密日记`;
  }

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-social-state" style="grid-column: 1/-1; padding: 20px;">
        <i class="fa-solid fa-book-bookmark" style="font-size: 24px; opacity: 0.3; color: var(--neon-rose);"></i>
        <p style="font-size: 12px; color: var(--text-dim);">另一半还没有写过日记，或者云端尚未完成同步 ✨</p>
      </div>`;
    return;
  }

  container.innerHTML = entries.map(([dateStr, diary]) => {
    const title   = diary.title   || '';
    const content = diary.content || '';
    const mood    = diary.mood    || '📝';
    const words   = content.length;
    const preview = content.replace(/\n/g, ' ').trim();
    const truncatedPreview = preview.length > 55 ? preview.substring(0, 55) + '...' : preview;

    return `
      <div class="diary-card partner-diary-card" onclick="openPartnerDiaryViewer('${dateStr}', '${escapeJS(title)}', '${escapeJS(content)}', '${escapeJS(mood)}')">
        <div class="diary-card-header">
          <div class="diary-card-left">
            <div class="diary-card-mood">${escapeHTML(mood)}</div>
            <div class="diary-card-meta">
              <div class="diary-card-date">${formatDiaryDateLabel(dateStr)}</div>
              <div class="diary-card-title ${title ? '' : 'no-title'}" style="color: var(--text-main); font-weight: bold;">${escapeHTML(title || '无标题')}</div>
            </div>
          </div>
        </div>
        ${preview ? `<div class="diary-card-preview" style="color: var(--text-muted); font-size: 12.5px; line-height: 1.5; margin-top: 6px;">${escapeHTML(truncatedPreview)}</div>` : ''}
        <div class="diary-card-footer" style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-dim); margin-top: 10px;">
          <span class="diary-card-words">${words > 0 ? `${words} 字` : '空白日记'}</span>
          <span style="color: var(--neon-rose);"><i class="fa-solid fa-envelope-open-text"></i> 点击阅读</span>
        </div>
      </div>`;
  }).join('');
}

function openPartnerDiaryViewer(dateStr, title, content, mood) {
  const dialog = document.getElementById('partner-diary-dialog');
  if (!dialog) return;

  // 填充日期
  const dateEl = document.getElementById('partner-diary-view-date');
  if (dateEl) dateEl.textContent = formatDiaryDateLabel(dateStr);

  // 填充心情
  const moodEl = document.getElementById('partner-diary-view-mood');
  if (moodEl) moodEl.textContent = mood || '📝';

  // 填充标题
  const titleEl = document.getElementById('partner-diary-view-title');
  if (titleEl) titleEl.textContent = title || '无标题';

  // 填充正文内容
  const contentEl = document.getElementById('partner-diary-view-content');
  if (contentEl) {
    contentEl.textContent = content || '空空如也，什么都没写呢 ✨';
  }

  // 打开对话框
  dialog.showModal();
}

function closePartnerDiaryViewer() {
  const dialog = document.getElementById('partner-diary-dialog');
  if (dialog) dialog.close();
}

function escapeJS(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}




