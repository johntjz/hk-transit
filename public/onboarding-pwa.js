// ============================================================================
// public/onboarding-pwa.js
// Settings/About modals, PWA install & silent-update lifecycle, onboarding tutorial (extracted from index.html)
// Classic (non-module) script: shares global scope with hardcode.js, busspeed.js,
// map.js, planner.js and the other app scripts. Load order in index.html:
// hardcode.js → busspeed.js → map.js → planner.js → eta-engine.js → onboarding-pwa.js → app-ui.js
// ============================================================================

function openSettingsModal() {
  triggerHaptic(10);
  syncSettingsModalLabels();
  document.getElementById('settingsModal').style.display = 'flex';
}
function closeSettingsModal() { document.getElementById('settingsModal').style.display = 'none'; }

function openAboutModal() {
  triggerHaptic(10);
  syncSettingsModalLabels();
  const modal = document.getElementById('aboutModal');
  if (modal) modal.style.display = 'flex';
}
function closeAboutModal() {
  const modal = document.getElementById('aboutModal');
  if (modal) modal.style.display = 'none';
}

function resetOnboardingAutoPopupFromAbout() {
  triggerHaptic(10);
  setOnboardingDismissedCookie(false);
  SafeStorage.removeItem(ONBOARDING_SEEN_KEY);
  closeAboutModal();
  openTutorialModal(true);
}

let deferredPwaPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  updatePwaInstallBtnVisibility();
});

function updatePwaInstallBtnVisibility() {
  const row = document.getElementById('pwaInstallRow');
  if (row) row.style.display = 'flex';
  syncSettingsModalLabels();
}

async function triggerPwaInstall() {
  triggerHaptic(12);
  if (deferredPwaPrompt) {
    deferredPwaPrompt.prompt();
    await deferredPwaPrompt.userChoice;
    deferredPwaPrompt = null;
    updatePwaInstallBtnVisibility();
    return;
  }
  showToast(currentLang === 'zh' ? '📲 請點選瀏覽器網址列「安裝」圖示或 Safari「分享 ➔ 加入主畫面」' : '📲 Tap browser address-bar Install icon or Safari Share ➔ Add to Home Screen');
}

function syncSettingsModalLabels() {
  const isZh = (currentLang === 'zh');
  const setV = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  setV('settingsModalTitle', isZh ? '設定' : 'Settings');
  setV('settingsCloseBtn', isZh ? '✕ 關閉' : '✕ Close');

  const hubs = typeof SavedHubsManager !== 'undefined' ? SavedHubsManager.getHubs() : { home: null, work: null };
  setV('settingRowLblHomeHub', isZh ? '🏠 屋企車站 (僅存本機)' : '🏠 Home Stop (On Device)');
  setV('settingValHomeHub', hubs.home
    ? `${isZh ? (hubs.home.nameTc || hubs.home.nameEn) : hubs.home.nameEn} ›`
    : (isZh ? '設定車站 ›' : 'Set Stop ›'));
  setV('settingRowLblWorkHub', isZh ? '💼 公司車站 (僅存本機)' : '💼 Work Stop (On Device)');
  setV('settingValWorkHub', hubs.work
    ? `${isZh ? (hubs.work.nameTc || hubs.work.nameEn) : hubs.work.nameEn} ›`
    : (isZh ? '設定車站 ›' : 'Set Stop ›'));

  const qrEnabled = (typeof SmartReturnManager !== 'undefined' && SmartReturnManager.isEnabled)
    ? SmartReturnManager.isEnabled()
    : false;
  setV('settingRowLblQuickReturn', isZh ? '↩️ 快捷回程建議' : '↩️ Quick Return Suggestions');
  setV('settingRowSubQuickReturn', isZh
    ? '預設關閉 · 僅於已設屋企站或常搭3次以上回程時顯示'
    : 'Off by default · Shown for saved Home or 3+ repeat trips');
  const qrValEl = document.getElementById('settingValQuickReturn');
  if (qrValEl) {
    qrValEl.innerText = qrEnabled ? (isZh ? '開啟' : 'On') : (isZh ? '關閉' : 'Off');
    qrValEl.classList.toggle('on', qrEnabled);
  }
  const qrSwitchEl = document.getElementById('settingSwitchQuickReturn');
  if (qrSwitchEl) qrSwitchEl.classList.toggle('on', qrEnabled);
  const qrRowEl = document.getElementById('quickReturnToggleRow');
  if (qrRowEl) qrRowEl.setAttribute('aria-checked', qrEnabled ? 'true' : 'false');

  setV('settingRowLblTutorial', isZh ? '🖼️ 圖解教學' : '🖼️ Visual Guide');
  setV('settingValTutorial', isZh ? '圖解 ›' : 'View ›');
  setV('settingRowLblInstall', isZh ? '📲 安裝' : '📲 Install');
  setV('settingRowLblLang', isZh ? '🌐 語言 (Language)' : '🌐 Language');
  setV('settingRowLblTheme', isZh ? '🌓 顯示主題' : '🌓 Theme');
  setV('settingRowLblSize', isZh ? '🔠 字體大小' : '🔠 Text Size');
  setV('settingRowLblStatus', isZh ? '⚡ 狀態及時間表監察' : '⚡ Status & Watchdog');
  const driftTotal = (window.__DATA_DRIFT_ALERTS__?.length || 0) + (window.__LIVE_FERRY_DRIFT_ALERTS__?.size || 0);
  setV('settingValStatusOpen', driftTotal > 0 ? (isZh ? `⚠️ ${driftTotal}項提示 ›` : `⚠️ ${driftTotal} Alert ›`) : (isZh ? '開啟 ›' : 'Open ›'));
  setV('settingRowLblAbout', isZh ? 'ℹ️ 關於及香港生態應用' : 'ℹ️ About & HK Apps');
  setV('settingRowSubAbout', isZh ? '著衫天氣、曬衫指數、樓市估值及強積金' : 'HK Layer, HK Sundry, HK Property & HK MPF');
  setV('settingValAboutOpen', isZh ? '開啟 ›' : 'Open ›');

  setV('aboutBackBtn', isZh ? '‹ 返回' : '‹ Back');
  setV('aboutModalTitle', isZh ? 'ℹ️ 關於及香港生態應用' : 'ℹ️ About & HK Apps');
  setV('aboutCloseBtn', isZh ? '✕ 關閉' : '✕ Close');
  setV('aboutAppTitle', isZh ? '香港交通通 (Transit HK)' : 'Transit HK (通)');
  setV('aboutAppDesc', isZh
    ? '整合九巴、城巴、嶼巴、小巴、港鐵、輕鐵及渡輪實時到站及多式聯運轉乘規劃，採用政府開放數據。'
    : 'Real-time Hong Kong Bus, MTR, Light Rail & Ferry ETAs and multi-modal route planner powered by open HKSAR data.');
  setV('aboutAppVersionBadge', `Build ${APP_VERSION}`);
  setV('aboutSecCompanion', isZh ? '同系列香港生態應用' : 'HK Ecosystem Apps');
  setV('settingRowLblLayer', isZh ? 'HK Layer (著衫)' : 'HK Layer (著衫)');
  setV('settingRowSubLayer', isZh ? '香港實時天氣及每日通勤穿搭指南' : 'Daily commute outfit & weather layer guide');
  setV('settingRowLblSundry', isZh ? 'HK Sundry (曬衫)' : 'HK Sundry (曬衫)');
  setV('settingRowSubSundry', isZh ? '今日啱唔啱晾衫？香港天氣晾衫指數' : 'Should I hang laundry outside today?');
  setV('settingRowLblProp', isZh ? 'HK Property (樓)' : 'HK Property (樓)');
  setV('settingRowSubProp', isZh ? '全港各區屋苑估值及歷年成交走勢' : 'Value vs. price across HK districts');
  setV('settingRowLblMpf', isZh ? 'HK MPF (強積金)' : 'HK MPF (強積金)');
  setV('settingRowSubMpf', isZh ? '拆解強積金年報及比較基金收費' : 'Decode MPF letters & compare fund fees');
  setV('statusModalTitle', isZh ? '⚡ 狀態及時間表監察' : '⚡ Status & Watchdog');

  setV('settingValLang', userLangPref === 'auto' ? (isZh ? '自動' : 'Auto') : (userLangPref === 'zh' ? '繁體中文' : 'English'));
  setV('settingValTheme', userThemePref === 'light' ? (isZh ? '淺色 (預設)' : 'Light') : (userThemePref === 'dark' ? (isZh ? '深色' : 'Dark') : (isZh ? '自動 (日出日落)' : 'Auto (Sun)')));
  setV('settingValSize', currentTextSize === 'lg' ? (isZh ? '大 (預設)' : 'Large') : (currentTextSize === 'sm' ? (isZh ? '中' : 'Medium') : (isZh ? '小' : 'Compact')));

  const isStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone;
  setV('settingValInstall', isStandalone ? (isZh ? '已安裝 ✓' : 'Installed ✓') : (deferredPwaPrompt ? (isZh ? '立即安裝 ›' : 'Install ›') : (isZh ? '安裝 ›' : 'Install ›')));

  const buildVer = getAppBuildVersion();
  setV('settingSecAppUpdate', isZh ? '應用程式版本及更新' : 'App Version & Update');
  setV('settingBuildVersionText', isZh ? `版本：${buildVer}` : `Build: ${buildVer}`);
  setV('settingBuildUpdateHint', isZh ? '清除快取並重新載入最新版本' : 'Clears app caches & reloads latest build');
  const forceBtn = document.getElementById('forceUpdateAppBtn');
  if (forceBtn && !forceBtn.disabled) {
    forceBtn.innerText = isZh ? '↻ 強制更新程式' : '↻ Force Update App';
  }
  setV('pwaUpdateToastText', isZh ? '正在更新程式…' : 'Updating app…');
}

function getAppBuildVersion() {
  try {
    const meta = document.querySelector?.('meta[name="app-build-version"]')?.getAttribute?.('content');
    if (meta && meta.trim()) return meta.trim();
  } catch (e) {}
  return (typeof APP_VERSION !== 'undefined' && APP_VERSION) ? String(APP_VERSION) : '';
}

const _SW_USER_RELOAD_KEY = 'sw-user-reload';
const _SW_TOAST_SHOWN_KEY = 'sw-update-toast-shown';
let _pwaSessionMemoryStore = Object.create(null);

function _getPwaSessionStorage() {
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) return sessionStorage;
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch (e) {}
  return null;
}

function _readPwaSessionFlag(key) {
  const ss = _getPwaSessionStorage();
  if (ss) {
    try { return ss.getItem(key); } catch (e) {}
  }
  return Object.prototype.hasOwnProperty.call(_pwaSessionMemoryStore, key) ? _pwaSessionMemoryStore[key] : null;
}

function _writePwaSessionFlag(key, val) {
  const ss = _getPwaSessionStorage();
  if (ss) {
    try { ss.setItem(key, String(val)); return; } catch (e) {}
  }
  _pwaSessionMemoryStore[key] = String(val);
}

function _removePwaSessionFlag(key) {
  const ss = _getPwaSessionStorage();
  if (ss) {
    try { ss.removeItem(key); return; } catch (e) {}
  }
  delete _pwaSessionMemoryStore[key];
}

let _forceUpdateAppInFlight = false;
window.forceUpdateApp = async function forceUpdateApp() {
  if (_forceUpdateAppInFlight) return;
  _forceUpdateAppInFlight = true;
  if (typeof triggerHaptic === 'function') triggerHaptic(12);
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const btn = document.getElementById?.('forceUpdateAppBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerText = isZh ? '更新中…' : 'Updating…';
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all((regs || []).map((reg) => reg.unregister().catch(() => false)));
    }
  } catch (e) {}
  try {
    const cacheApi = (typeof caches !== 'undefined') ? caches : (typeof window !== 'undefined' ? window.caches : null);
    if (cacheApi && typeof cacheApi.keys === 'function') {
      const keys = await cacheApi.keys();
      await Promise.all((keys || []).map((k) => cacheApi.delete(k).catch(() => false)));
    }
  } catch (e) {}
  _removePwaSessionFlag(_SW_TOAST_SHOWN_KEY);
  try {
    window.location.reload();
  } catch (e) {
    _forceUpdateAppInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.innerText = isZh ? '↻ 強制更新程式' : '↻ Force Update App';
    }
  }
};

let _pwaWaitingWorker = null;
let _pwaUpdateReloadRequested = false;
let _pwaUpdateReloaded = false;
let _pwaToastShownInSession = false;
let _pwaDeferredReloadBound = false;

function _isSafeToAutoReloadPwa() {
  try {
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/i.test(String(ae.tagName || ''))) return false;
  } catch (e) {}
  return true;
}

function _performSilentPwaReloadOnce() {
  if (_pwaUpdateReloaded) return;
  if (_isSafeToAutoReloadPwa()) {
    _removePwaSessionFlag(_SW_USER_RELOAD_KEY);
    _pwaUpdateReloaded = true;
    window.location.reload();
    return;
  }
  if (_pwaDeferredReloadBound) return;
  _pwaDeferredReloadBound = true;
  const finish = () => {
    if (_pwaUpdateReloaded) return;
    _removePwaSessionFlag(_SW_USER_RELOAD_KEY);
    _pwaUpdateReloaded = true;
    window.location.reload();
  };
  try {
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae && typeof ae.addEventListener === 'function') {
      ae.addEventListener('blur', finish, { once: true });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') finish();
      }, { once: true });
    }
  } catch (e) {
    finish();
  }
}

window.dismissPwaUpdateToast = function dismissPwaUpdateToast() {
  const toast = document.getElementById?.('pwaUpdateToast');
  if (!toast) return;
  toast.classList?.remove('show');
  toast.setAttribute?.('aria-hidden', 'true');
};

// Silent self-apply: posts SKIP_WAITING automatically without showing a blocking reload/dismiss button prompt.
window.applyPendingPwaUpdate = function applyPendingPwaUpdate(workerOverride = null, opts = {}) {
  const silent = Boolean(opts && opts.silent);
  const targetWorker = workerOverride || _pwaWaitingWorker;
  if (targetWorker) _pwaWaitingWorker = targetWorker;
  const workerSig = String((targetWorker && targetWorker.scriptURL) || 'waiting-sw');
  if (silent) {
    const alreadySig = _readPwaSessionFlag(_SW_TOAST_SHOWN_KEY);
    if (_pwaToastShownInSession && alreadySig === workerSig) return false;
    _pwaToastShownInSession = true;
    _writePwaSessionFlag(_SW_TOAST_SHOWN_KEY, workerSig);
  }
  window.dismissPwaUpdateToast();
  if (!silent && typeof triggerHaptic === 'function') triggerHaptic(12);
  _pwaUpdateReloadRequested = true;
  _writePwaSessionFlag(_SW_USER_RELOAD_KEY, '1');
  if (_pwaWaitingWorker && typeof _pwaWaitingWorker.postMessage === 'function') {
    _pwaWaitingWorker.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }
  if (!silent) {
    _removePwaSessionFlag(_SW_USER_RELOAD_KEY);
    window.location.reload();
  }
  return false;
};

// Retained for backward compatibility: immediately self-applies silently with zero manual button clicks.
window.showPwaUpdateToast = function showPwaUpdateToast(worker, forceShow = false) {
  if (worker) _pwaWaitingWorker = worker;
  const workerSig = String((worker && worker.scriptURL) || (_pwaWaitingWorker && _pwaWaitingWorker.scriptURL) || 'waiting-sw');
  if (!forceShow) {
    const shownSig = _readPwaSessionFlag(_SW_TOAST_SHOWN_KEY);
    if (_pwaToastShownInSession || shownSig === workerSig) return false;
  }
  return window.applyPendingPwaUpdate(_pwaWaitingWorker, { silent: !forceShow });
};

window.initPwaUpdateLifecycle = function initPwaUpdateLifecycle(swContainerOverride) {
  const sw = swContainerOverride || (typeof navigator !== 'undefined' ? navigator.serviceWorker : null);
  if (!sw || typeof sw.register !== 'function') return Promise.resolve(null);

  _pwaUpdateReloaded = false;
  _pwaUpdateReloadRequested = false;
  _pwaWaitingWorker = null;
  _pwaToastShownInSession = false;
  _pwaDeferredReloadBound = false;
  const hadControllerOnInit = Boolean(sw.controller);

  if (!sw._transitControllerChangeBound && typeof sw.addEventListener === 'function') {
    sw._transitControllerChangeBound = true;
    sw.addEventListener('controllerchange', () => {
      if (_pwaUpdateReloaded) return;
      if (!hadControllerOnInit) return;
      // Strict one-time sessionStorage gate prevents unprompted iOS background controller swaps from reload loops
      const hasPendingAutoOrUserFlag = _pwaUpdateReloadRequested || _readPwaSessionFlag(_SW_USER_RELOAD_KEY) === '1';
      if (!hasPendingAutoOrUserFlag) return;
      _performSilentPwaReloadOnce();
    });
  }

  const watchInstallingWorker = (worker) => {
    if (!worker || worker._transitStateBound) return;
    worker._transitStateBound = true;
    const onStateChange = () => {
      if (worker.state === 'installed' && sw.controller) {
        window.applyPendingPwaUpdate(worker, { silent: true });
      }
    };
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('statechange', onStateChange);
    }
    onStateChange();
  };

  return Promise.resolve()
    .then(() => sw.register('sw.js', { updateViaCache: 'none' }))
    .then((reg) => {
      if (!reg) return null;
      if (reg.waiting && sw.controller) {
        window.applyPendingPwaUpdate(reg.waiting, { silent: true });
      }
      if (reg.installing) {
        watchInstallingWorker(reg.installing);
      }
      if (typeof reg.addEventListener === 'function') {
        reg.addEventListener('updatefound', () => {
          watchInstallingWorker(reg.installing);
        });
      }
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && !sw._transitVisUpdateBound) {
        sw._transitVisUpdateBound = true;
        let lastCheckMs = Date.now();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && Date.now() - lastCheckMs > 60000) {
            lastCheckMs = Date.now();
            if (typeof reg.update === 'function') reg.update().catch(() => {});
          }
        });
      }
      return reg;
    })
    .catch(() => null);
};

if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  if (document.readyState === 'complete') {
    window.initPwaUpdateLifecycle();
  } else {
    window.addEventListener('load', () => window.initPwaUpdateLifecycle(), { once: true });
  }
}

function cycleLanguagePreference() {
  triggerHaptic(10);
  if (userLangPref === 'auto') userLangPref = 'zh';
  else if (userLangPref === 'zh') userLangPref = 'en';
  else userLangPref = 'auto';
  currentLang = userLangPref === 'auto' ? detectClientDeviceLang() : userLangPref;
  SafeStorage.setItem('transit_lang_pref_v2', userLangPref);
  if (typeof clearAllActiveBrowseMarkers === 'function') clearAllActiveBrowseMarkers();
  applyLanguage();
}

function cycleThemePreference() {
  triggerHaptic(10);
  if (userThemePref === 'light') userThemePref = 'dark';
  else if (userThemePref === 'dark') userThemePref = 'auto';
  else userThemePref = 'light';
  SafeStorage.setItem('transit_theme_pref_v4', userThemePref);
  applyTheme();
  syncSettingsModalLabels();
  if (currentView === 'detail' && detailRouteGroup) {
    drawRouteOnMap(detailRouteGroup, detailExpandedStopIdx >= 0 ? detailExpandedStopIdx : 0);
  }
}

function cycleTextSize() {
  triggerHaptic(10);
  if (currentTextSize === 'lg') currentTextSize = 'sm';
  else if (currentTextSize === 'sm') currentTextSize = 'xs';
  else currentTextSize = 'lg';
  SafeStorage.setItem('transit_text_size', currentTextSize);
  applyTextSize();
  syncSettingsModalLabels();
}

let activeTutorialStep = 0;
let tutorialOpenedFromSettings = false;
const TUTORIAL_CONTENT_VERSION = '2026-11-24';
const ONBOARDING_SEEN_KEY = 'transit_onboarding_seen_v2';
const ONBOARDING_COOKIE_NAME = 'transit_onboarding_dismissed';
const ONBOARDING_NEVER_SHOW_KEY = 'transit_onboarding_never_show_v1';
const TUTORIAL_SLIDE_COUNT = 7;

function setOnboardingDismissedCookie(enable, ver = TUTORIAL_CONTENT_VERSION) {
  try {
    if (enable) {
      const maxAgeSec = 60 * 60 * 24 * 365 * 10; // 10 years — persists until TUTORIAL_CONTENT_VERSION changes
      document.cookie = `${ONBOARDING_COOKIE_NAME}=${encodeURIComponent(ver)}; max-age=${maxAgeSec}; path=/; SameSite=Lax`;
      SafeStorage.setItem(ONBOARDING_NEVER_SHOW_KEY, ver);
    } else {
      document.cookie = `${ONBOARDING_COOKIE_NAME}=; max-age=0; path=/; SameSite=Lax`;
      SafeStorage.removeItem(ONBOARDING_NEVER_SHOW_KEY);
    }
  } catch (e) {}
}

function hasOnboardingDismissedCookie(ver = TUTORIAL_CONTENT_VERSION) {
  try {
    if (SafeStorage.getItem(ONBOARDING_NEVER_SHOW_KEY) === ver) return true;
    const target = `${ONBOARDING_COOKIE_NAME}=${encodeURIComponent(ver)}`;
    return String(document.cookie || '').split(';').some(c => c.trim() === target);
  } catch (e) {
    return false;
  }
}

function buildTutorialSlideSvg(stepIdx, isZh) {
  const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang HK', sans-serif";
  const badgeCallout = (cx, cy, num, color = '#007AFF') => `
    <circle cx="${cx}" cy="${cy}" r="11.5" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>
    <text x="${cx}" y="${cy + 3.8}" text-anchor="middle" font-family="${font}" font-size="10" font-weight="800" fill="#FFFFFF">${num}</text>`;

  if (stepIdx === 0) {
    // Slide 1 (Picture-First): Nearby Live ETAs — Mode bar, 🎯 GPS & Search, Next Bus/Rail cards
    const busT = isZh ? '巴士' : 'Bus';
    const railT = isZh ? '港鐵' : 'Rail';
    const ferryT = isZh ? '渡輪' : 'Ferry';
    const planT = isZh ? '規劃' : 'Plan';
    const locT = isZh ? '📍 旺角 · 85m' : '📍 Mong Kok · 85m';
    const searchPh = isZh ? '112 / 旺角...' : 'Search stop / route (112)';
    const dest1 = isZh ? '往 尖沙咀碼頭' : 'To Tsim Sha Tsui';
    const dest2 = isZh ? '往 銅鑼灣 (崇光)' : 'To Causeway Bay';
    const dest3 = isZh ? '往 金鐘 (東鐵綫)' : 'To Admiralty (EAL)';
    const seatsLbl = isZh ? '有位' : 'Seats';
    const liveLbl = isZh ? '實時GPS' : 'Live GPS';
    return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${locT}">
      <defs>
        <linearGradient id="obBg0" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#FF3B30" stop-opacity="0.11"/>
          <stop offset="100%" stop-color="#007AFF" stop-opacity="0.09"/>
        </linearGradient>
      </defs>
      <rect width="340" height="276" fill="url(#obBg0)"/>
      <rect x="14" y="10" width="312" height="256" rx="18" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <!-- Top Mode Bar -->
      <rect x="24" y="21" width="56" height="25" rx="12.5" fill="#FF3B30"/>
      <text x="52" y="37" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="800" fill="#FFFFFF">${busT}</text>
      <rect x="85" y="21" width="54" height="25" rx="12.5" fill="var(--bg-surface)"/>
      <text x="112" y="37" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="700" fill="var(--text-sub)">${railT}</text>
      <rect x="144" y="21" width="54" height="25" rx="12.5" fill="var(--bg-surface)"/>
      <text x="171" y="37" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="700" fill="var(--text-sub)">${ferryT}</text>
      <rect x="203" y="21" width="48" height="25" rx="12.5" fill="rgba(0,122,255,0.13)"/>
      <text x="227" y="37" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="800" fill="#007AFF">${planT}</text>
      ${badgeCallout(24, 21, '1', '#FF3B30')}
      <!-- Location & Search Row -->
      <text x="26" y="68" font-family="${font}" font-size="14" font-weight="800" fill="var(--text-main)">${locT}</text>
      <rect x="24" y="77" width="224" height="30" rx="10" fill="var(--bg-surface)"/>
      <text x="36" y="96" font-family="${font}" font-size="10.5" font-weight="500" fill="var(--text-sub)">${searchPh}</text>
      <circle cx="284" cy="92" r="20" fill="#007AFF" opacity="0.18" class="ob-pulse-ring"/>
      <rect x="255" y="77" width="58" height="30" rx="14" fill="#007AFF"/>
      <text x="284" y="96" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="800" fill="#FFFFFF">🎯 GPS</text>
      ${badgeCallout(312, 76, '2', '#007AFF')}
      <!-- Live ETA Card 1 -->
      <rect x="24" y="117" width="292" height="44" rx="12" fill="var(--bg-surface)" stroke="#34C759" stroke-width="1.5"/>
      <rect x="34" y="127" width="40" height="24" rx="7" fill="#E53935"/>
      <text x="54" y="143" text-anchor="middle" font-family="${font}" font-size="11.5" font-weight="800" fill="#FFFFFF">1A</text>
      <text x="82" y="137" font-family="${font}" font-size="12" font-weight="700" fill="var(--text-main)">${dest1}</text>
      <text x="82" y="152" font-family="${font}" font-size="9" font-weight="700" fill="#248A3D">● ${liveLbl} · ${seatsLbl}</text>
      <text x="304" y="145" text-anchor="end" font-family="${font}" font-size="16" font-weight="800" fill="var(--text-main)">3m</text>
      ${badgeCallout(313, 118, '3', '#34C759')}
      <!-- Live ETA Card 2 -->
      <rect x="24" y="167" width="292" height="42" rx="12" fill="var(--bg-surface)"/>
      <rect x="34" y="176" width="40" height="24" rx="7" fill="#E53935"/>
      <text x="54" y="192" text-anchor="middle" font-family="${font}" font-size="11.5" font-weight="800" fill="#FFFFFF">112</text>
      <text x="82" y="192" font-family="${font}" font-size="12" font-weight="700" fill="var(--text-main)">${dest2}</text>
      <text x="304" y="193" text-anchor="end" font-family="${font}" font-size="15" font-weight="800" fill="var(--text-main)">6m</text>
      <!-- Live ETA Card 3 -->
      <rect x="24" y="215" width="292" height="42" rx="12" fill="var(--bg-surface)"/>
      <rect x="34" y="224" width="40" height="24" rx="7" fill="#5EB6E4"/>
      <text x="54" y="240" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="800" fill="#FFFFFF">EAL</text>
      <text x="82" y="240" font-family="${font}" font-size="12" font-weight="700" fill="var(--text-main)">${dest3}</text>
      <text x="304" y="241" text-anchor="end" font-family="${font}" font-size="15" font-weight="800" fill="#007AFF">2m</text>
    </svg>`;
  }

  if (stepIdx === 1) {
    // Slide 2 (Picture-First): Live Directional Road Traffic + TD Camera Snapshot + ETAs & Seats
    const hdr = isZh ? '112 往 銅鑼灣 (崇光)' : '112 To Causeway Bay';
    const stopB = isZh ? '崇光百貨 (銅鑼灣)' : 'SOGO Causeway Bay';
    const trafficBtn = isZh ? '🚦 路況 開' : '🚦 Traffic';
    const yourSideTxt = isZh ? '🟢 前路暢順 68 km/h' : '🟢 Your side 68 km/h';
    const oppSideTxt = isZh ? '🔴 對面線塞車 22 km/h' : '🔴 Opp. jammed 22 km/h';
    const camLbl = isZh ? '📷 路面實拍' : '📷 Road Cam';
    const liveTag = isZh ? '● 實時GPS' : '● Live GPS';
    const seatsTag = isZh ? '有位' : 'Seats';
    const standTag = isZh ? '企位' : 'Standing';
    return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${hdr}">
      <defs>
        <linearGradient id="obBg1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#34C759" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#007AFF" stop-opacity="0.08"/>
        </linearGradient>
      </defs>
      <rect width="340" height="276" fill="url(#obBg1)"/>
      <rect x="14" y="10" width="312" height="256" rx="18" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <!-- Header bar -->
      <rect x="24" y="19" width="42" height="22" rx="7" fill="#E53935"/>
      <text x="45" y="34" text-anchor="middle" font-family="${font}" font-size="11" font-weight="800" fill="#FFFFFF">112</text>
      <text x="74" y="34" font-family="${font}" font-size="11.5" font-weight="800" fill="var(--text-main)">${hdr}</text>
      <!-- Visual Directional Map + Mini Webcam Card -->
      <rect x="24" y="47" width="292" height="84" rx="13" fill="#EAF2F8" stroke="var(--border-color)" stroke-width="1"/>
      <!-- Two carriageways: Smooth Green vs Jammed Red -->
      <path d="M36 96 C95 76, 155 76, 212 90" fill="none" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round"/>
      <path d="M36 96 C95 76, 155 76, 212 90" fill="none" stroke="#16A34A" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M210 105 C150 93, 95 93, 36 112" fill="none" stroke="#FFFFFF" stroke-width="7.5" stroke-linecap="round"/>
      <path d="M210 105 C150 93, 95 93, 36 112" fill="none" stroke="#DC2626" stroke-width="4.2" stroke-linecap="round"/>
      <!-- Direction chevrons -->
      <polygon points="154,75 162,79 154,83" fill="#16A34A"/>
      <polygon points="98,96 90,100 98,104" fill="#DC2626"/>
      <circle cx="122" cy="80" r="6" fill="#007AFF" stroke="#FFFFFF" stroke-width="2"/>
      <!-- Traffic chip top left -->
      <rect x="30" y="53" width="68" height="19" rx="9.5" fill="var(--bg-white)" stroke="#16A34A" stroke-width="1.2"/>
      <text x="64" y="65.5" text-anchor="middle" font-family="${font}" font-size="8.5" font-weight="800" fill="#15803D">${trafficBtn}</text>
      ${badgeCallout(30, 53, '1', '#16A34A')}
      <!-- Embedded Live Webcam Thumbnail right side -->
      <rect x="220" y="54" width="88" height="70" rx="9" fill="#1E293B" stroke="#FFFFFF" stroke-width="1.5"/>
      <path d="M222 106 L252 80 L276 80 L306 106 Z" fill="#475569"/>
      <line x1="264" y1="82" x2="264" y2="104" stroke="#E2E8F0" stroke-width="1.5" stroke-dasharray="3 3"/>
      <rect x="234" y="88" width="12" height="7" rx="2" fill="#EF4444"/>
      <rect x="278" y="92" width="12" height="7" rx="2" fill="#22C55E"/>
      <text x="264" y="68" text-anchor="middle" font-family="${font}" font-size="8" font-weight="700" fill="#F8FAFC">${camLbl}</text>
      ${badgeCallout(306, 54, '2', '#007AFF')}
      <!-- Directional Road Status Strip inside Stop Card -->
      <rect x="24" y="138" width="292" height="36" rx="10" fill="var(--bg-surface)" stroke="var(--border-color)" stroke-width="1"/>
      <rect x="24" y="138" width="4" height="36" rx="2" fill="#16A34A"/>
      <text x="36" y="153" font-family="${font}" font-size="10" font-weight="800" fill="var(--text-main)">${yourSideTxt}</text>
      <text x="36" y="167" font-family="${font}" font-size="9" font-weight="600" fill="var(--text-sub)">${oppSideTxt}</text>
      ${badgeCallout(308, 146, '3', '#DC2626')}
      <!-- Next Departures & Crowding -->
      <rect x="24" y="180" width="292" height="78" rx="12" fill="var(--bg-surface)"/>
      <text x="34" y="196" font-family="${font}" font-size="10.5" font-weight="800" fill="var(--text-main)">13. ${stopB}</text>
      <rect x="34" y="203" width="272" height="23" rx="7" fill="var(--bg-white)"/>
      <text x="44" y="218" font-family="${font}" font-size="11.5" font-weight="800" fill="var(--text-main)">● 3m · 18:42</text>
      <text x="155" y="218" font-family="${font}" font-size="9" font-weight="700" fill="#248A3D">${liveTag}</text>
      <rect x="244" y="207" width="52" height="15" rx="7.5" fill="rgba(52,199,89,0.16)"/>
      <text x="270" y="217.5" text-anchor="middle" font-family="${font}" font-size="8.5" font-weight="700" fill="#248A3D">${seatsTag}</text>
      <rect x="34" y="230" width="272" height="22" rx="7" fill="var(--bg-white)"/>
      <text x="44" y="244.5" font-family="${font}" font-size="11" font-weight="700" fill="var(--text-sub)">11m · 18:50</text>
      <text x="155" y="244.5" font-family="${font}" font-size="9" font-weight="700" fill="#248A3D">${liveTag}</text>
      <rect x="242" y="233.5" width="56" height="15" rx="7.5" fill="rgba(255,149,0,0.18)"/>
      <text x="270" y="244" text-anchor="middle" font-family="${font}" font-size="8.5" font-weight="700" fill="#B25000">${standTag}</text>
    </svg>`;
  }

  if (stepIdx === 2) {
    // Slide 3 (Picture-First): Multi-Modal Planner + Exact MTR Exit + Stops & ETA
    const planT = isZh ? '規劃' : 'Plan';
    const fromT = isZh ? '旺角' : 'Mong Kok';
    const toT = isZh ? '中環 (IFC)' : 'Central (IFC)';
    const bestT = isZh ? '最佳路線' : 'Best';
    const walkTag = isZh ? '金鐘 B出口 · 2分' : 'Walk 2m · Exit B';
    const btnLbl = isZh ? '站點班次 ›' : 'Stops & ETA ›';
    const liveLbl = isZh ? '● 實時 · 🟢 前路暢順' : '● Real-time · 🟢 Clear';
    return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${walkTag}">
      <rect width="340" height="276" fill="var(--bg-surface)"/>
      <rect x="14" y="10" width="312" height="256" rx="18" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <!-- Top Bar + From/To -->
      <rect x="26" y="20" width="54" height="23" rx="11.5" fill="#007AFF"/>
      <text x="53" y="35" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="800" fill="#FFFFFF">${planT}</text>
      ${badgeCallout(22, 20, '1', '#007AFF')}
      <rect x="88" y="18" width="224" height="27" rx="9" fill="var(--bg-surface)"/>
      <circle cx="100" cy="31.5" r="4" fill="#FFFFFF" stroke="#007AFF" stroke-width="2"/>
      <text x="110" y="35" font-family="${font}" font-size="10.5" font-weight="700" fill="var(--text-main)">${fromT} → ${toT}</text>
      <!-- Large Map Frame -->
      <rect x="24" y="52" width="292" height="114" rx="14" fill="#EAF2F8" stroke="var(--border-color)" stroke-width="1"/>
      <path d="M24 110 H316 M130 52 V166 M235 52 V166" stroke="#FFFFFF" stroke-width="4.5" opacity="0.88"/>
      <path d="M58 138 Q112 132 152 108" fill="none" stroke="#007AFF" stroke-width="4" stroke-dasharray="5 4" stroke-linecap="round"/>
      <path d="M152 108 C194 108, 218 82, 276 82" fill="none" stroke="#E2231A" stroke-width="5" stroke-linecap="round"/>
      <circle cx="58" cy="138" r="6.5" fill="#007AFF" stroke="#FFFFFF" stroke-width="2"/>
      <circle cx="152" cy="108" r="7" fill="#1C1C1E" stroke="#FFFFFF" stroke-width="2"/>
      <rect x="92" y="70" width="120" height="22" rx="9" fill="#1C1C1E"/>
      <text x="152" y="84.5" text-anchor="middle" font-family="${font}" font-size="9.5" font-weight="700" fill="#FFFFFF">${walkTag}</text>
      <circle cx="276" cy="82" r="7.5" fill="#FF3B30" stroke="#FFFFFF" stroke-width="2"/>
      ${badgeCallout(220, 70, '2', '#1C1C1E')}
      <!-- Result Card -->
      <rect x="24" y="173" width="292" height="84" rx="13" fill="var(--bg-surface)" stroke="#007AFF" stroke-width="1.6"/>
      <rect x="34" y="181" width="50" height="17" rx="8.5" fill="rgba(0,122,255,0.14)"/>
      <text x="59" y="192.5" text-anchor="middle" font-family="${font}" font-size="9" font-weight="800" fill="#007AFF">${bestT}</text>
      <rect x="90" y="181" width="34" height="17" rx="5" fill="#E2231A"/>
      <text x="107" y="192.5" text-anchor="middle" font-family="${font}" font-size="9" font-weight="800" fill="#FFFFFF">TWL</text>
      <text x="128" y="193" font-family="${font}" font-size="10" fill="var(--text-sub)">→</text>
      <rect x="139" y="181" width="30" height="17" rx="5" fill="#0075C9"/>
      <text x="154" y="192.5" text-anchor="middle" font-family="${font}" font-size="9" font-weight="800" fill="#FFFFFF">ISL</text>
      <text x="304" y="195" text-anchor="end" font-family="${font}" font-size="14" font-weight="800" fill="var(--text-main)">14m · $12.5</text>
      <rect x="34" y="205" width="272" height="44" rx="10" fill="var(--bg-white)"/>
      <text x="44" y="223" font-family="${font}" font-size="11.5" font-weight="700" fill="var(--text-main)">18:40 ${fromT}</text>
      <text x="44" y="240" font-family="${font}" font-size="9.5" font-weight="700" fill="#248A3D">${liveLbl}</text>
      <circle cx="261" cy="227" r="20" fill="#007AFF" opacity="0.16" class="ob-pulse-ring"/>
      <rect x="219" y="214" width="80" height="26" rx="8" fill="var(--bg-surface)" stroke="#007AFF" stroke-width="1.3"/>
      <text x="259" y="230.5" text-anchor="middle" font-family="${font}" font-size="10" font-weight="800" fill="#007AFF">${btnLbl}</text>
      ${badgeCallout(304, 213, '3', '#007AFF')}
    </svg>`;
  }

  if (stepIdx === 3) {
    // Slide 4 (Picture-First): Star Stops & Saved Bookmarks
    const stopLbl = isZh ? '崇光百貨 (銅鑼灣)' : 'SOGO Causeway Bay';
    const favHdr = isZh ? '已收藏車站' : 'Saved Stops';
    const s1 = isZh ? '銅鑼灣 (崇光)' : 'Causeway Bay';
    const s2 = isZh ? '旺角站' : 'Mong Kok Stn';
    const s3 = isZh ? '中環6號碼頭' : 'Central Pier 6';
    return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${favHdr}">
      <defs>
        <linearGradient id="obBg3" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#FF9500" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#007AFF" stop-opacity="0.08"/>
        </linearGradient>
      </defs>
      <rect width="340" height="276" fill="url(#obBg3)"/>
      <rect x="14" y="10" width="312" height="256" rx="18" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <rect x="24" y="21" width="292" height="50" rx="13" fill="rgba(255,149,0,0.12)" stroke="#FF9500" stroke-width="1.6"/>
      <rect x="35" y="34" width="38" height="23" rx="7" fill="#E53935"/>
      <text x="54" y="49.5" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="800" fill="#FFFFFF">112</text>
      <text x="82" y="43" font-family="${font}" font-size="12" font-weight="800" fill="var(--text-main)">${stopLbl}</text>
      <text x="82" y="59" font-family="${font}" font-size="10" font-weight="700" fill="#248A3D">3m · 11m</text>
      <circle cx="288" cy="46" r="19" fill="#FF9500" opacity="0.22" class="ob-pulse-ring"/>
      <circle cx="288" cy="46" r="14" fill="#FF9500"/>
      <text x="288" y="51.5" text-anchor="middle" font-family="${font}" font-size="16" font-weight="700" fill="#FFFFFF">★</text>
      ${badgeCallout(24, 21, '1', '#FF9500')}
      <path d="M170 76 v16 M165 86 l5 6 l5 -6" fill="none" stroke="#007AFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="24" y="97" width="292" height="36" rx="11" fill="var(--bg-surface)"/>
      <text x="38" y="119.5" font-family="${font}" font-size="12" font-weight="800" fill="#007AFF">${favHdr}</text>
      <circle cx="288" cy="115" r="14" fill="#007AFF"/>
      <path d="M292 121 l-4 -3 l-4 3 v-10 a1 1 0 0 1 1 -1 h6 a1 1 0 0 1 1 1 z" fill="#FFFFFF"/>
      ${badgeCallout(310, 99, '2', '#007AFF')}
      <rect x="24" y="139" width="292" height="36" rx="11" fill="var(--bg-surface)"/>
      <text x="36" y="162" font-family="${font}" font-size="13" fill="#FF9500">★</text>
      <rect x="54" y="147" width="36" height="20" rx="6" fill="#E53935"/>
      <text x="72" y="160.5" text-anchor="middle" font-family="${font}" font-size="9.5" font-weight="800" fill="#FFFFFF">112</text>
      <text x="98" y="161" font-family="${font}" font-size="11.5" font-weight="700" fill="var(--text-main)">${s1}</text>
      <text x="268" y="161.5" text-anchor="end" font-family="${font}" font-size="12.5" font-weight="800" fill="#248A3D">3m</text>
      <rect x="278" y="146" width="24" height="22" rx="6" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <text x="290" y="161" text-anchor="middle" font-family="${font}" font-size="11.5" font-weight="800" fill="#007AFF">⇅</text>
      ${badgeCallout(310, 145, '3', '#5856D6')}
      <rect x="24" y="180" width="292" height="36" rx="11" fill="var(--bg-surface)"/>
      <text x="36" y="203" font-family="${font}" font-size="13" fill="#FF9500">★</text>
      <rect x="54" y="188" width="36" height="20" rx="6" fill="#E2231A"/>
      <text x="72" y="201.5" text-anchor="middle" font-family="${font}" font-size="9.5" font-weight="800" fill="#FFFFFF">TWL</text>
      <text x="98" y="202" font-family="${font}" font-size="11.5" font-weight="700" fill="var(--text-main)">${s2}</text>
      <text x="298" y="202.5" text-anchor="end" font-family="${font}" font-size="12.5" font-weight="800" fill="#248A3D">2m</text>
      <rect x="24" y="221" width="292" height="36" rx="11" fill="var(--bg-surface)"/>
      <text x="36" y="244" font-family="${font}" font-size="13" fill="#FF9500">★</text>
      <rect x="54" y="229" width="36" height="20" rx="6" fill="#0090D9"/>
      <text x="72" y="242.5" text-anchor="middle" font-family="${font}" font-size="8.5" font-weight="800" fill="#FFFFFF">FERRY</text>
      <text x="98" y="243" font-family="${font}" font-size="11.5" font-weight="700" fill="var(--text-main)">${s3}</text>
      <text x="298" y="243.5" text-anchor="end" font-family="${font}" font-size="12.5" font-weight="800" fill="#248A3D">8m</text>
    </svg>`;
  }

  if (stepIdx === 4) {
    // Slide 5 (Picture-First): HK Stop Map + Traffic Lines + Hold to Pin From/To
    const mapTitle = isZh ? '地圖 · 尖沙咀' : 'Map · Tsim Sha Tsui';
    const pinCardTitle = isZh ? '尖沙咀天星碼頭' : 'TST Star Ferry Pier';
    const setFrom = isZh ? '起點' : 'From';
    const setTo = isZh ? '終點' : 'Dest';
    const holdHint = isZh ? '長按地圖設起終點' : 'Hold map to pin';
    return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${mapTitle}">
      <rect width="340" height="276" fill="var(--bg-surface)"/>
      <rect x="14" y="10" width="312" height="256" rx="18" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <text x="28" y="34" font-family="${font}" font-size="12" font-weight="800" fill="var(--text-main)">${mapTitle}</text>
      <circle cx="294" cy="30" r="16" fill="#007AFF" opacity="0.2" class="ob-pulse-ring"/>
      <circle cx="294" cy="30" r="12" fill="#007AFF"/>
      <path d="M289 26 l3 -1.2 l4 1.2 l3 -1.2 v8 l-3 1.2 l-4 -1.2 l-3 1.2 z" fill="none" stroke="#FFFFFF" stroke-width="1.4"/>
      ${badgeCallout(270, 30, '1', '#007AFF')}
      <!-- Large Map Canvas -->
      <rect x="24" y="48" width="292" height="208" rx="14" fill="#E8F1F8" stroke="var(--border-color)" stroke-width="1"/>
      <path d="M24 202 Q150 188 316 206 V256 H24 Z" fill="#C4E1F5"/>
      <path d="M24 106 H316 M112 48 V202 M228 48 V202" stroke="#FFFFFF" stroke-width="5" opacity="0.9"/>
      <!-- Live Traffic Road Lines on Map -->
      <line x1="34" y1="104" x2="110" y2="104" stroke="#16A34A" stroke-width="4" stroke-linecap="round"/>
      <line x1="112" y1="54" x2="112" y2="100" stroke="#F59E0B" stroke-width="4" stroke-linecap="round"/>
      <!-- Colored stop pins -->
      <circle cx="72" cy="106" r="7.5" fill="#FF3B30" stroke="#FFFFFF" stroke-width="2"/>
      <circle cx="156" cy="82" r="9" fill="#5856D6" stroke="#FFFFFF" stroke-width="2"/>
      <text x="156" y="85.5" text-anchor="middle" font-family="${font}" font-size="8" font-weight="800" fill="#FFFFFF">M</text>
      <circle cx="112" cy="166" r="9" fill="#0090D9" stroke="#FFFFFF" stroke-width="2.5"/>
      <!-- Stop Popup Card -->
      <rect x="128" y="114" width="176" height="72" rx="12" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <text x="140" y="134" font-family="${font}" font-size="11" font-weight="800" fill="var(--text-main)">${pinCardTitle}</text>
      <text x="140" y="150" font-family="${font}" font-size="9.5" font-weight="700" fill="#248A3D">FERRY 5m · 1A 3m</text>
      <rect x="140" y="158" width="72" height="20" rx="7" fill="rgba(0,122,255,0.13)"/>
      <text x="176" y="171.5" text-anchor="middle" font-family="${font}" font-size="9" font-weight="800" fill="#007AFF">${setFrom}</text>
      <rect x="218" y="158" width="72" height="20" rx="7" fill="rgba(255,59,48,0.13)"/>
      <text x="254" y="171.5" text-anchor="middle" font-family="${font}" font-size="9" font-weight="800" fill="#FF3B30">${setTo}</text>
      ${badgeCallout(118, 144, '2', '#5856D6')}
      <!-- Hold to Pin spot -->
      <circle cx="246" cy="222" r="16" fill="#FF9500" opacity="0.25" class="ob-pulse-ring"/>
      <circle cx="246" cy="222" r="7.5" fill="#FF9500" stroke="#FFFFFF" stroke-width="2"/>
      <rect x="116" y="212" width="114" height="20" rx="10" fill="#1C1C1E"/>
      <text x="173" y="225.5" text-anchor="middle" font-family="${font}" font-size="9" font-weight="700" fill="#FFFFFF">${holdHint}</text>
      ${badgeCallout(266, 222, '3', '#FF9500')}
    </svg>`;
  }

  if (stepIdx === 5) {
    // Slide 6 (Picture-First): Home/Work Shortcuts, Language & Theme
    const settingsT = isZh ? '設定' : 'Settings';
    const homeRow = isZh ? '🏠 屋企車站' : '🏠 Home Stop';
    const homeVal = isZh ? '旺角' : 'Mong Kok';
    const workRow = isZh ? '💼 公司車站' : '💼 Work Stop';
    const workVal = isZh ? '中環' : 'Central';
    const langRow = isZh ? '🌐 語言' : '🌐 Language';
    const themeRow = isZh ? '🌓 外觀主題' : '🌓 Theme';
    const themeVal = isZh ? '淺色 / 深色' : 'Light / Dark';
    return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${langRow}">
      <defs>
        <linearGradient id="obBg5" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5856D6" stop-opacity="0.11"/>
          <stop offset="100%" stop-color="#007AFF" stop-opacity="0.08"/>
        </linearGradient>
      </defs>
      <rect width="340" height="276" fill="url(#obBg5)"/>
      <rect x="14" y="10" width="312" height="256" rx="18" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
      <text x="28" y="35" font-family="${font}" font-size="13" font-weight="800" fill="var(--text-main)">${settingsT}</text>
      <circle cx="294" cy="30" r="13" fill="#007AFF"/>
      <circle cx="294" cy="30" r="3.4" fill="none" stroke="#FFFFFF" stroke-width="1.8"/>
      <path d="M294 22 v2.2 M294 35.8 v2.2 M286 30 h2.2 M299.8 30 h2.2" stroke="#FFFFFF" stroke-width="1.7" stroke-linecap="round"/>
      ${badgeCallout(268, 30, '1', '#007AFF')}
      <rect x="24" y="50" width="292" height="44" rx="11" fill="var(--bg-surface)"/>
      <text x="38" y="76.5" font-family="${font}" font-size="12" font-weight="700" fill="var(--text-main)">${homeRow}</text>
      <rect x="228" y="59" width="76" height="26" rx="13" fill="var(--bg-white)"/>
      <text x="266" y="75.5" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="700" fill="#007AFF">${homeVal}</text>
      <rect x="24" y="100" width="292" height="44" rx="11" fill="var(--bg-surface)"/>
      <text x="38" y="126.5" font-family="${font}" font-size="12" font-weight="700" fill="var(--text-main)">${workRow}</text>
      <rect x="228" y="109" width="76" height="26" rx="13" fill="var(--bg-white)"/>
      <text x="266" y="125.5" text-anchor="middle" font-family="${font}" font-size="10.5" font-weight="700" fill="#007AFF">${workVal}</text>
      ${badgeCallout(24, 51, '2', '#5856D6')}
      <rect x="24" y="152" width="292" height="50" rx="12" fill="var(--bg-surface)" stroke="#007AFF" stroke-width="1.5"/>
      <text x="38" y="181.5" font-family="${font}" font-size="12.5" font-weight="800" fill="var(--text-main)">${langRow}</text>
      <rect x="188" y="164" width="56" height="26" rx="13" fill="${userLangPref === 'zh' ? '#007AFF' : 'var(--bg-white)'}"/>
      <text x="216" y="180.5" text-anchor="middle" font-family="${font}" font-size="10" font-weight="700" fill="${userLangPref === 'zh' ? '#FFFFFF' : 'var(--text-main)'}">繁體中文</text>
      <rect x="250" y="164" width="56" height="26" rx="13" fill="${userLangPref === 'en' ? '#007AFF' : 'var(--bg-white)'}"/>
      <text x="278" y="180.5" text-anchor="middle" font-family="${font}" font-size="10" font-weight="700" fill="${userLangPref === 'en' ? '#FFFFFF' : 'var(--text-main)'}">English</text>
      ${badgeCallout(24, 153, '3', '#007AFF')}
      <rect x="24" y="209" width="292" height="44" rx="11" fill="var(--bg-surface)"/>
      <text x="38" y="235.5" font-family="${font}" font-size="12" font-weight="700" fill="var(--text-main)">${themeRow}</text>
      <rect x="214" y="218" width="90" height="26" rx="13" fill="var(--bg-white)"/>
      <text x="259" y="234.5" text-anchor="middle" font-family="${font}" font-size="10" font-weight="700" fill="#007AFF">${themeVal}</text>
    </svg>`;
  }

  // Slide 7 (Picture-First): Add to Home Screen
  const addLbl = isZh ? '加入主畫面' : 'Add to Home Screen';
  const shareLbl = isZh ? '分享 ↑' : 'Share ↑';
  const appLbl = isZh ? '香港交通通' : 'Transit HK';
  return `<svg viewBox="0 0 340 276" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${addLbl}">
    <defs>
      <linearGradient id="obBg6" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#007AFF" stop-opacity="0.11"/>
        <stop offset="100%" stop-color="#34C759" stop-opacity="0.06"/>
      </linearGradient>
    </defs>
    <rect width="340" height="276" fill="url(#obBg6)"/>
    <rect x="20" y="16" width="300" height="66" rx="15" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
    <rect x="36" y="25" width="268" height="20" rx="10" fill="var(--bg-surface)"/>
    <text x="170" y="38.5" text-anchor="middle" font-family="${font}" font-size="10" font-weight="600" fill="var(--text-sub)">Transit HK · Web App</text>
    <circle cx="170" cy="61" r="18" fill="#007AFF" opacity="0.18" class="ob-pulse-ring"/>
    <circle cx="170" cy="61" r="13" fill="#007AFF"/>
    <path d="M170 54 v10 M166 58 l4 -4 l4 4 M165 61 v4 h10 v-4" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="193" y="65" font-family="${font}" font-size="10.5" font-weight="700" fill="#007AFF">${shareLbl}</text>
    ${badgeCallout(143, 61, '1', '#007AFF')}
    <path d="M170 86 v18 M165 98 l5 6 l5 -6" fill="none" stroke="#007AFF" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="34" y="110" width="272" height="52" rx="15" fill="var(--bg-white)" stroke="#007AFF" stroke-width="1.8"/>
    <rect x="49" y="124" width="24" height="24" rx="7" fill="rgba(0,122,255,0.14)"/>
    <path d="M61 129 v14 M54 136 h14" stroke="#007AFF" stroke-width="2.2" stroke-linecap="round"/>
    <text x="85" y="141" font-family="${font}" font-size="14" font-weight="700" fill="var(--text-main)">${addLbl}</text>
    ${badgeCallout(282, 136, '2', '#007AFF')}
    <path d="M170 166 v18 M165 178 l5 6 l5 -6" fill="none" stroke="#007AFF" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="64" y="190" width="212" height="72" rx="17" fill="var(--bg-white)" stroke="var(--border-color)" stroke-width="1"/>
    <rect x="86" y="204" width="36" height="36" rx="10" fill="var(--bg-surface)" opacity="0.85"/>
    <rect x="148" y="200" width="44" height="44" rx="12" fill="#E53935"/>
    <rect x="158" y="209" width="24" height="19" rx="4.5" fill="#FFFFFF"/>
    <rect x="161" y="212" width="18" height="9" rx="1.5" fill="#E53935"/>
    <circle cx="164" cy="224" r="1.8" fill="#E53935"/>
    <circle cx="176" cy="224" r="1.8" fill="#E53935"/>
    <circle cx="189" cy="203" r="7.5" fill="#34C759"/>
    <path d="M186 203 l2.2 2.2 l4 -4" fill="none" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="170" y="255" text-anchor="middle" font-family="${font}" font-size="10" font-weight="700" fill="var(--text-main)">${appLbl}</text>
    <rect x="218" y="204" width="36" height="36" rx="10" fill="var(--bg-surface)" opacity="0.85"/>
    ${badgeCallout(211, 211, '3', '#34C759')}
  </svg>`;
}

function renderTutorialStep() {
  const isZh = (currentLang === 'zh');
  const setV = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
  setV('tutorialStepCounter', `${activeTutorialStep + 1} / ${TUTORIAL_SLIDE_COUNT}`);
  setV('tutorialCloseBtn', isZh ? '略過' : 'Skip');

  const slides = isZh ? [
    {
      rank: '重點 1',
      title: '即睇附近實時班次',
      cue: '頂部選 Bus / Rail / Ferry · 按 🎯 GPS 即出到站時間'
    },
    {
      rank: '重點 2',
      title: '實時路況・路面鏡頭・座位',
      cue: '紅綠箭嘴區分你條線順唔順，點擊路牌仲睇到運輸署實拍圖'
    },
    {
      rank: '重點 3',
      title: '點對點規劃 ＋ 港鐵出口',
      cue: '輸入起終點即時比對路線、出口行法及實時路況',
      showOpenPlanner: true
    },
    {
      rank: '重點 4',
      title: '收藏常用車站，出門秒睇',
      cue: '點 ☆ 變 ★ 加星，按書籤一次過睇晒返工返學班次'
    },
    {
      rank: '重點 5',
      title: '全港地圖搵站 ＋ 長按定點',
      cue: '地圖即睇附近車站及交通流量，長按可設起終點',
      showOpenMap: true
    },
    {
      rank: '重點 6',
      title: '設定屋企/公司、語言及主題',
      cue: '入 ⚙️ 設定一次，下次打開自動推薦返屋企路線',
      showLangTryBtn: true
    },
    {
      rank: '重點 7',
      title: '加入手機主畫面，像 App 咁開',
      cue: '按「分享 ↑」→「加入主畫面」，全螢幕極速開啟',
      isFinal: true
    }
  ] : [
    {
      rank: 'Tip 1',
      title: 'Nearby Live Arrivals at a Glance',
      cue: 'Pick Bus, Rail or Ferry · Tap 🎯 GPS to snap your stop'
    },
    {
      rank: 'Tip 2',
      title: 'Live Road Speed, Cam & Crowding',
      cue: 'Check your direction vs opposite bound · Tap road segments for TD webcam'
    },
    {
      rank: 'Tip 3',
      title: 'Door-to-Door Plan & MTR Exits',
      cue: 'Compare routes, exact station exits & live traffic speed',
      showOpenPlanner: true
    },
    {
      rank: 'Tip 4',
      title: 'Star Daily Stops for 1-Tap Check',
      cue: 'Tap ☆ beside any stop, then open Bookmarks for all ETAs'
    },
    {
      rank: 'Tip 5',
      title: 'Map Browser & Live Traffic Overlay',
      cue: 'Browse all stops & road flow · Hold map anywhere to plan',
      showOpenMap: true
    },
    {
      rank: 'Tip 6',
      title: 'Home / Work, Language & Dark Mode',
      cue: 'Save Home & Work once in ⚙️ Settings for 1-tap commute',
      showLangTryBtn: true
    },
    {
      rank: 'Tip 7',
      title: 'Add to Home Screen Like an App',
      cue: 'Tap Share ↑ then "Add to Home Screen" — zero download',
      isFinal: true
    }
  ];

  const st = slides[activeTutorialStep] || slides[0];
  const stage = document.getElementById('tutorialVisualStage');
  if (stage) stage.innerHTML = buildTutorialSlideSvg(activeTutorialStep, isZh);

  setV('tutorialRankPill', st.rank || '');
  setV('tutorialSlideTitle', st.title);
  setV('tutorialSlideCue', st.cue);

  const quickRow = document.getElementById('tutorialQuickActionRow');
  if (quickRow) {
    if (st.showOpenPlanner) {
      quickRow.innerHTML = `<button type="button" class="onboard-secondary-btn" onclick="openPlannerFromTutorial()">${isZh ? '立即試用規劃 ›' : 'Try Planner ›'}</button>`;
    } else if (st.showOpenMap) {
      quickRow.innerHTML = `<button type="button" class="onboard-secondary-btn" onclick="openMapFromTutorial()">${isZh ? '立即打開地圖 ›' : 'Open Map ›'}</button>`;
    } else if (st.showLangTryBtn) {
      quickRow.innerHTML = `<button type="button" class="onboard-secondary-btn" onclick="cycleLanguagePreference()">${isZh ? '切換 English / 自動' : 'Switch 繁體中文 / Auto'}</button>`;
    } else {
      quickRow.innerHTML = '';
    }
  }

  const dotsEl = document.getElementById('tutorialDots');
  if (dotsEl) {
    dotsEl.innerHTML = slides.map((s, idx) =>
      `<button type="button" class="onboard-dot ${idx === activeTutorialStep ? 'active' : ''}" role="tab" aria-selected="${idx === activeTutorialStep ? 'true' : 'false'}" aria-label="${escapeHtml(s.title)}" onclick="setTutorialStep(${idx})"></button>`
    ).join('');
  }

  const backBtn = document.getElementById('tutorialBackBtn');
  if (backBtn) {
    if (activeTutorialStep === 0 && !tutorialOpenedFromSettings) {
      backBtn.style.visibility = 'hidden';
      backBtn.innerText = isZh ? '‹ 上一張' : '‹ Back';
    } else {
      backBtn.style.visibility = 'visible';
      backBtn.innerText = (activeTutorialStep === 0 && tutorialOpenedFromSettings)
        ? (isZh ? '‹ 返回設定' : '‹ Settings')
        : (isZh ? '‹ 上一張' : '‹ Back');
    }
  }

  const dontShowLbl = document.getElementById('tutorialDontShowLabel');
  if (dontShowLbl) {
    dontShowLbl.innerText = isZh
      ? '不再自動顯示（教學更新時會再次提示）'
      : "Don't show again until guide updates";
  }
  const dontShowCb = document.getElementById('tutorialDontShowCheckbox');
  if (dontShowCb) {
    dontShowCb.checked = hasOnboardingDismissedCookie();
  }

  const ctaGroup = document.getElementById('tutorialCtaGroup');
  if (ctaGroup) {
    ctaGroup.innerHTML = st.isFinal
      ? `<button type="button" class="onboard-primary-btn finish-dark" onclick="closeTutorialModal()">${isZh ? '開始使用' : 'Get Started'}</button>`
      : `<button type="button" class="onboard-primary-btn" onclick="setTutorialStep(${activeTutorialStep + 1})">${isZh ? '下一張 ›' : 'Next ›'}</button>`;
  }
}

(function attachTutorialSwipeGestures() {
  const card = document.getElementById('tutorialModalCard');
  if (!card) return;
  let startX = 0, startY = 0;
  card.addEventListener('touchstart', (e) => {
    const t0 = e.changedTouches?.[0];
    if (!t0) return;
    startX = t0.clientX;
    startY = t0.clientY;
  }, { passive: true });
  card.addEventListener('touchend', (e) => {
    const t1 = e.changedTouches?.[0];
    if (!t1) return;
    const dx = t1.clientX - startX;
    const dy = t1.clientY - startY;
    if (Math.abs(dx) >= 38 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0 && activeTutorialStep < TUTORIAL_SLIDE_COUNT - 1) setTutorialStep(activeTutorialStep + 1);
      else if (dx > 0 && activeTutorialStep > 0) setTutorialStep(activeTutorialStep - 1);
    }
  }, { passive: true });
})();

function onTutorialDontShowToggle(checked) {
  triggerHaptic(8);
  setOnboardingDismissedCookie(Boolean(checked));
}

function setTutorialStep(idx) {
  triggerHaptic(8);
  activeTutorialStep = Math.max(0, Math.min(TUTORIAL_SLIDE_COUNT - 1, Number(idx) || 0));
  renderTutorialStep();
}

function onTutorialBackClick() {
  if (activeTutorialStep > 0) {
    setTutorialStep(activeTutorialStep - 1);
  } else {
    const returnToSettings = tutorialOpenedFromSettings;
    closeTutorialModal();
    if (returnToSettings) openSettingsModal();
  }
}

function openPlannerFromTutorial() {
  closeTutorialModal();
  if (typeof openTransferPlannerFromTop === 'function') openTransferPlannerFromTop();
}

function openMapFromTutorial() {
  closeTutorialModal();
  if (typeof openMapBrowserFromTop === 'function') openMapBrowserFromTop();
}

function openTutorialModal(fromSettings = true) {
  triggerHaptic(10);
  tutorialOpenedFromSettings = Boolean(fromSettings);
  activeTutorialStep = 0;
  renderTutorialStep();
  const modal = document.getElementById('tutorialModal');
  if (modal) modal.style.display = 'flex';
}

function closeTutorialModal() {
  SafeStorage.setItem(ONBOARDING_SEEN_KEY, TUTORIAL_CONTENT_VERSION);
  const dontShowCb = document.getElementById('tutorialDontShowCheckbox');
  if (dontShowCb && dontShowCb.checked) {
    setOnboardingDismissedCookie(true, TUTORIAL_CONTENT_VERSION);
  }
  const modal = document.getElementById('tutorialModal');
  if (modal) modal.style.display = 'none';
}

function maybeShowFirstVisitOnboarding(hasDeepLink = false) {
  const params = new URLSearchParams(window.location.search || '');
  if (hasDeepLink || params.get('autostart') === '1') return;
  if (hasOnboardingDismissedCookie(TUTORIAL_CONTENT_VERSION)) return;
  if (SafeStorage.getItem(ONBOARDING_SEEN_KEY) === TUTORIAL_CONTENT_VERSION) return;
  if (document.getElementById('settingsModal')?.style.display === 'flex') return;
  openTutorialModal(false);
}
