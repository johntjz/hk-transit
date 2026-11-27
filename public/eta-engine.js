// ============================================================================
// public/eta-engine.js
// ETA engine, i18n, SafeStorage, signal health, kinematics & expanded-ETA rendering (extracted from index.html)
// Classic (non-module) script: shares global scope with hardcode.js, busspeed.js,
// map.js, planner.js and the other app scripts. Load order in index.html:
// transit-data.js → fare-load-engine.js → hardcode.js → busspeed.js → map-traffic-overlay.js → map.js → commute-hubs.js → raptor-cost-engine.js → planner.js → eta-engine.js → onboarding-pwa.js → app-ui.js
// ============================================================================

// ============================================================================
// PART 1: EXECUTION ENGINE (Modularized across domain scripts)
// ============================================================================
window.__FIXED_JS_BUILD_TS__ = '2026-11-27 21:00 HKT';
const APP_VERSION = '2026-11-27 21:00 HKT';
const HK_UNIFIED_API_BASE = '/api/worker';
let isHydratingInitialData = true;
window.isHydratingInitialData = true;
window.__INITIAL_STOPS_GPS_RESOLVED__ = false;

function setHydratingInitialData(val) {
  isHydratingInitialData = Boolean(val);
  window.isHydratingInitialData = isHydratingInitialData;
}
window.setHydratingInitialData = setHydratingInitialData;

function renderBootLoadingSkeletonHtml(count = 4) {
  const widths = [
    ['68%', '46%'],
    ['58%', '40%'],
    ['74%', '52%'],
    ['62%', '38%']
  ];
  let cards = '';
  for (let i = 0; i < count; i++) {
    const [w1, w2] = widths[i % widths.length];
    cards += `<div class="boot-skeleton-card"><div class="boot-skel-block boot-skel-badge"></div><div class="boot-skel-lines"><div class="boot-skel-block" style="height:14px;width:${w1};"></div><div class="boot-skel-block" style="height:11px;width:${w2};"></div></div><div class="boot-skel-block boot-skel-eta"></div></div>`;
  }
  return `<div class="boot-skeleton-wrap" aria-busy="true">${cards}</div>`;
}
window.renderBootLoadingSkeletonHtml = renderBootLoadingSkeletonHtml;

window.__LAST_TD_UPDATED__ = '';
window.__LIVE_HIGHWAY_KMH__ = 70;
window.__LIVE_CORRIDORS__ = {};
window.__LIVE_TRAFFIC_DETECTORS__ = [];
window.__LIVE_TRAFFIC_CAMERAS__ = [];
window.__LIVE_TRAFFIC_SPEED_GEOJSON__ = null;
window.__LIVE_TRAFFIC_CAPTURED_AT__ = '';
window.__HKO_WEATHER__ = null;
window.MULTI_MODAL_HUBS_DIRECTORY = [];
window.MTR_EXITS_DIRECTORY = [];
window.QUICK_MTR_LINES = [];
window.QUICK_LRT_LINES = [];
window.QUICK_FERRY_LINES = [];

function syncTrafficToggleButtonsUI() {
  const detailOn = (window.trafficLayerEnabled !== false);
  const globalOn = Boolean(window.globalTrafficLayerEnabled);
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  const dBtn = document.getElementById('detailMapTrafficBtn');
  if (dBtn) {
    dBtn.classList.toggle('active', detailOn);
    dBtn.setAttribute('aria-pressed', detailOn ? 'true' : 'false');
    dBtn.innerText = detailOn ? (isZh ? '🚦 實時路況及快拍 開' : '🚦 Traffic & Cams ON') : (isZh ? '🚦 實時路況及快拍' : '🚦 Traffic & Cams');
  }

  const bBtn = document.getElementById('browseMapTrafficBtn');
  if (bBtn) {
    bBtn.classList.toggle('active', globalOn);
    bBtn.setAttribute('aria-pressed', globalOn ? 'true' : 'false');
    bBtn.innerText = globalOn ? (isZh ? '🚦 全港路況 開' : '🚦 Traffic ON') : (isZh ? '🚦 全港路況' : '🚦 Traffic');
  }

  const xBtn = document.getElementById('xferMapTrafficBtn');
  if (xBtn) {
    xBtn.classList.toggle('active', detailOn);
    xBtn.title = isZh ? '切換實時道路交通及路面鏡頭' : 'Toggle Live Road Traffic & Cameras';
  }
}
window.syncTrafficToggleButtonsUI = syncTrafficToggleButtonsUI;

document.addEventListener('keydown', e => {
  const tut = document.getElementById('tutorialModal');
  const tutOpen = Boolean(tut && tut.style.display === 'flex');
  if (tutOpen && e.key === 'ArrowRight' && typeof setTutorialStep === 'function') {
    e.preventDefault();
    setTutorialStep(activeTutorialStep + 1);
    return;
  }
  if (tutOpen && e.key === 'ArrowLeft' && typeof setTutorialStep === 'function') {
    e.preventDefault();
    setTutorialStep(activeTutorialStep - 1);
    return;
  }
  if (e.key === 'Escape') {
    if (tutOpen && typeof closeTutorialModal === 'function') {
      closeTutorialModal();
    }
    ['aboutModal','builtInStatusModal','tutorialModal','settingsModal','commutePickerModal'].forEach(id => {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    });
  }
});

function isUserSelectingText() {
  try {
    return Boolean(window.getSelection && String(window.getSelection()).trim().length > 0);
  } catch (e) {
    return false;
  }
}

function isValidRailOrFerryCoord(lat, lon) {
  const la = parseFloat(lat), lo = parseFloat(lon);
  return Number.isFinite(la) && Number.isFinite(lo) && la > 22.15 && la < 22.58 && lo > 113.82 && lo < 114.45;
}

function isCircularRoute(g, stopsList = null) {
  if (!g) return false;
  if (g.isCircular) return true;
  const rNo = String(g.routeNo || '').trim().toUpperCase();
  if (rNo === '705' || rNo === '706') return true;
  if (/circular|循環/i.test(`${g.orig_e || ''} ${g.dest_e || ''} ${g.orig_tc || ''} ${g.dest_tc || ''}`)) return true;
  const stops = stopsList || (g.routeIds?.[0] ? routeStopsCache[g.routeIds[0]] : null);
  if (Array.isArray(stops) && stops.length >= 4) {
    const first = stops[0], last = stops[stops.length - 1];
    const dKm = calculateDistanceKm(parseFloat(first.latitude), parseFloat(first.longitude), parseFloat(last.latitude), parseFloat(last.longitude));
    if (Number.isFinite(dKm) && dKm <= 0.20) return true;
  }
  return false;
}

function isAirportOrPortZone(lat, lon, nameStr = '') {
  const la = Number(lat), lo = Number(lon);
  if (Number.isFinite(la) && Number.isFinite(lo) && la >= 22.290 && la <= 22.326 && lo >= 113.890 && lo <= 113.958) {
    return true;
  }
  return /airport|chek lap kok|asiaworld|hzmb|cathay city|機場|赤鱲角|博覽館|港珠澳|國泰城/i.test(String(nameStr || ''));
}

function isAirportPremiumRoute(group) {
  if (!group) return false;
  const rNo = String(group.routeNo || '').trim().toUpperCase();
  if (group.mode === 'MTR' && rNo === 'AEL') return true;
  if ((!group.mode || group.mode === 'BUS') && /^(A|NA)\d+[A-Z]?$/.test(rNo)) return true;
  return false;
}

async function fetchEdgeApiJSON(querySuffix, timeoutMs = 6000, bypassCache = false) {
  const res = await fetchJSON(`${HK_UNIFIED_API_BASE}${querySuffix}`, timeoutMs, bypassCache);
  if (res?.csvSchedules) {
    res.csvSchedules = mergeVerifiedMainlineSchedules(res.csvSchedules);
  }
  return res;
}

const isHiddenWaypointStop = (name) => /\(drop-?off\)|dummy\s*stop|alighting\s*only|只供落客/i.test(String(name || ''));

function cleanFerryLabel(raw) {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s*[\(（][^\)）]*(fare|pre-?paid|boarding|extend|return|single|circular|skip|只限|收費|單程|來回|登船|上落|延展|循環)[^\)）]*[\)）]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normStationLookupKey(s) {
  return typeof normName === 'function' ? normName(s, true) : String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function getCanonicalFerryPairKey(origEn, destEn) {
  const a = normStationLookupKey(origEn), b = normStationLookupKey(destEn);
  if (!a || !b) return '';
  return [a, b].sort().join('_');
}

function extractPierNumberBadge(rawEn, rawTc, destNameEn = '') {
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const mEn = String(rawEn || '').match(/\bPier\s*(?:No\.?\s*)?(\d+)\b/i);
  if (mEn) return isZh ? `${mEn[1]}號碼頭` : `Pier ${mEn[1]}`;
  const mTc = String(rawTc || '').match(/([一二三四五六七八九十\d]+號碼頭)/);
  if (mTc) return mTc[1];
  if (/landing\s*steps|登岸梯級/i.test(`${rawEn || ''} ${rawTc || ''}`)) {
    return isZh ? '登岸梯級' : 'Landing Steps';
  }
  const lowDest = String(destNameEn || '').toLowerCase();
  const CENTRAL_MAP = {
    'discovery bay': ['Pier 3', '3號碼頭'],
    'sok kwu wan':   ['Pier 4', '4號碼頭'],
    'yung shue wan': ['Pier 4', '4號碼頭'],
    'cheung chau':   ['Pier 5', '5號碼頭'],
    'mui wo':        ['Pier 6', '6號碼頭'],
    'peng chau':     ['Pier 6', '6號碼頭'],
    'ma wan':        ['Pier 2', '2號碼頭'],
    'tsim sha tsui': ['Pier 7', '7號碼頭'],
    'hung hom':      ['Pier 8', '8號碼頭']
  };
  if (/central/i.test(String(rawEn || ''))) {
    const hit = Object.entries(CENTRAL_MAP).find(([k]) => lowDest.includes(k));
    if (hit) return isZh ? hit[1][1] : hit[1][0];
  }
  return '';
}

function resolveFerryLiveEtaKeyClient(origEn, destEn) {
  return typeof resolveFerryLiveEtaKey === 'function' ? resolveFerryLiveEtaKey(origEn, destEn) : null;
}

const i18n = {
  en: {
    docTitle: 'Transit — HK Bus, MTR & Ferry (通)',
    busApp: 'Bus', mtrApp: 'Rail', ferryApp: 'Ferry', planApp: 'Plan',
    connecting: 'Locking Nearest Stop...',
    gpsResetBtn: 'GPS', reverseDir: 'Swap',
    favoriteRoutes: 'Saved Bookmarks (Bus / MTR / Ferry)',
    flipFavOrder: 'Flip Order',
    noSavedRoutes: 'Tap ☆ on any Bus stop, MTR station, or Ferry pier to bookmark it here.',
    noNearbyStations: 'No nearby stops found',
    noRoutesFound: 'No active routes at this stop',
    noStopsFound: 'No matching stops or routes found',
    loadingTimes: 'Sampling live telemetry...',
    noScheduled: 'No upcoming departures',
    networkFailed: 'Network Offline — Check Connection',
    searchStopPlaceholder: 'Search stop/station name or route number...',
    nearestStopsHeader: 'Nearby Stops / Stations / Piers',
    busRoutesHeader: 'Matching Routes & Lines',
    busStopsHeader: 'Matching Stops, Stations & Piers',
    to: 'To ',
    due: 'Due', dueEst: 'Due', minsUnit: 'm',
    viaHospitalTag: 'Via Hospital',
    actWalk: 'Walk', actAllRoutes: 'All Stop Routes',
    boardBadge: 'Board', alightBadge: 'Alight', farePrefix: 'Fare: $',
    bookmarkAdded: 'Saved to Bookmarks', bookmarkRemoved: 'Removed from Bookmarks',
    mapTapHint: 'Tap any stop/station/pier for ETAs • Hold map to pin From/To',
    exportDiagMainLabel: '{ } Log'
  },
  zh: {
    docTitle: '通 — 全港巴士、港鐵、輕鐵及渡輪實時雷達',
    busApp: '巴士', mtrApp: '港鐵', ferryApp: '渡輪', planApp: '規劃',
    connecting: '正在鎖定最近車站...',
    gpsResetBtn: '定位', reverseDir: '對調',
    favoriteRoutes: '已收藏車站及碼頭 (巴士/港鐵/渡輪)',
    flipFavOrder: '反轉次序',
    noSavedRoutes: '點擊任何巴士站、港鐵站或渡輪碼頭旁的 ☆ 即可收藏至此。',
    noNearbyStations: '附近找不到車站',
    noRoutesFound: '此站目前暫無路線',
    noStopsFound: '找不到符合的車站或路線',
    loadingTimes: '正在讀取實時訊號...',
    noScheduled: '暫無班次',
    networkFailed: '網絡離線 — 請檢查連線',
    searchStopPlaceholder: '輸入車站／地方名稱 或 路線號碼...',
    nearestStopsHeader: '附近巴士站 / 港鐵站 / 碼頭',
    busRoutesHeader: '符合的路線及航線',
    busStopsHeader: '符合的車站及碼頭',
    to: '往 ',
    due: '即將到站', dueEst: '即將到站', minsUnit: '分',
    viaHospitalTag: '經醫院',
    actWalk: '步行導航', actAllRoutes: '同站路線',
    boardBadge: '上車', alightBadge: '落車', farePrefix: '車資: $',
    bookmarkAdded: '已收藏至書籤', bookmarkRemoved: '已移除書籤',
    mapTapHint: '點選任何車站／碼頭查看班次 • 長按地圖設為起終點',
    exportDiagMainLabel: '{ } 日誌'
  }
};

window.renderStationBusynessPillHtml = function() {
  return '';
};

window.getDisplayRouteBadge = function(g) {
  if (!g) return '';
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (isZh) {
    if (g.mode === 'FERRY' && g.routeNo_tc) return cleanFerryLabel(g.routeNo_tc);
    if (g.mode === 'MTR' && g.company === 'MTR' && g.routeNo_tc) return g.routeNo_tc;
  }
  return cleanFerryLabel(g.routeNo || '');
};

window.crossesWaterBarrier = function(lat1, lon1, lat2, lon2) {
  const n1 = Number(lat1), m1 = Number(lon1), n2 = Number(lat2), m2 = Number(lon2);
  if (!Number.isFinite(n1) || !Number.isFinite(m1) || !Number.isFinite(n2) || !Number.isFinite(m2)) return false;

  const isTsingYi = (la, lo) => la >= 22.332 && la <= 22.365 && lo >= 114.085 && lo <= 114.111;
  if (isTsingYi(n1, m1) !== isTsingYi(n2, m2)) return true;

  const isMaWan = (la, lo) => la >= 22.345 && la <= 22.356 && lo >= 114.052 && lo <= 114.066;
  if (isMaWan(n1, m1) !== isMaWan(n2, m2)) return true;

  const isLantau = (la, lo) => lo < 114.052 && la < 22.356;
  if (isLantau(n1, m1) !== isLantau(n2, m2)) return true;

  const isHkIsland = (la, lo) => {
    const harbourLatLine = lo < 114.185 ? 22.2918 : 22.2945;
    return la < harbourLatLine && lo >= 114.110 && lo <= 114.265;
  };
  if (isHkIsland(n1, m1) !== isHkIsland(n2, m2)) return true;

  return false;
};

const dynamicPublicHolidaysSet = window.__HK_PUBLIC_HOLIDAYS__ || new Set();
function isHongKongHolidayFareDay(dObj = null) {
  const hk = dObj || getHongKongNow();
  if (hk.getDay() === 0) return true;
  const ymd = getHongKongDateYYYYMMDD(hk);
  return dynamicPublicHolidaysSet.has(ymd) || (window.__HK_PUBLIC_HOLIDAYS__ && window.__HK_PUBLIC_HOLIDAYS__.has(ymd));
}

function isRouteOperatingToday(group, isOvernightWindow = false, queryDateObj = null) {
  if (!group) return false;
  if (group.serviceMode === 'FESTIVAL_ONLY') return false;

  const qDate = queryDateObj || getHongKongNow();
  const minsOfDay = qDate.getHours() * 60 + qDate.getMinutes();
  const sMode = String(group.serviceMode || 'DAILY').toUpperCase();
  const wins = Array.isArray(group.activeWindows) && group.activeWindows.length > 0
    ? group.activeWindows
    : window.__DERIVE_DEFAULT_ACTIVE_WINDOWS__(group);

  const inActiveWindow = wins.some(w => Array.isArray(w) && minsOfDay >= w[0] && minsOfDay <= w[1]);

  if (sMode === 'OVERNIGHT_ONLY') {
    return inActiveWindow || Boolean(isOvernightWindow);
  }

  if (group.mode === 'MTR' && group.company === 'MTR') {
    if (typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isClosedAt(qDate)) return false;
    return inActiveWindow;
  }

  const serviceDate = (minsOfDay < 300)
    ? new Date(qDate.getTime() - 6 * 3600000)
    : qDate;
  const hkDay = serviceDate.getDay();
  const isHol = isHongKongHolidayFareDay(serviceDate);

  if (sMode === 'HOLIDAY_ONLY') return Boolean(isHol || (Array.isArray(group.operatingDays) && group.operatingDays.includes(hkDay)));
  if (sMode === 'WEEKDAY_ONLY' || sMode === 'PEAK_WEEKDAY_ONLY') {
    const allowedDays = Array.isArray(group.operatingDays) && group.operatingDays.length ? group.operatingDays : [1, 2, 3, 4, 5, 6];
    return !isHol && allowedDays.includes(hkDay);
  }
  if (Array.isArray(group.operatingDays) && group.operatingDays.length > 0) {
    if (isHol && group.excludeHolidays) return false;
    if (isHol && group.includeHolidays) return true;
    return group.operatingDays.includes(hkDay);
  }
  return true;
}

function isRouteActiveAtPlannerTime(g, queryDateObj, isOvernightWindow = false) {
  const qDate = queryDateObj || getHongKongNow();
  if (!g || !isRouteOperatingToday(g, isOvernightWindow, qDate)) return false;
  if (g.serviceMode === 'FESTIVAL_ONLY') return false;

  const minsOfDay = qDate.getHours() * 60 + qDate.getMinutes();
  const serviceDate = (minsOfDay < 300)
    ? new Date(qDate.getTime() - 6 * 3600000)
    : qDate;
  const isHoliday = isHongKongHolidayFareDay(serviceDate);

  const wins = Array.isArray(g.activeWindows) && g.activeWindows.length > 0
    ? g.activeWindows
    : window.__DERIVE_DEFAULT_ACTIVE_WINDOWS__(g);

  if (wins.length > 0) {
    if (isHoliday && g.excludeHolidays) return false;
    return wins.some(w => Array.isArray(w) && minsOfDay >= w[0] && minsOfDay <= w[1]);
  }
  if (g.serviceMode === 'PEAK_WEEKDAY_ONLY') {
    if (isHoliday) return false;
    return (minsOfDay >= 405 && minsOfDay <= 585) || (minsOfDay >= 1020 && minsOfDay <= 1215);
  }
  return true;
}

async function ensureNlbHolidayFaresLoaded(group) {
  if (group?.company !== 'NLB' || group._nlbFareHydrated) return false;
  const stops = getStopsForGroup(group);
  if (!stops.length || stops.some(s => s.fareHol !== undefined)) {
    group._nlbFareHydrated = true;
    return false;
  }
  group._nlbFareHydrated = true;
  try {
    const rIdKey = group.routeIds?.[0] || '';
    const nlbRouteId = rIdKey.startsWith('NLB_') ? rIdKey.replace('NLB_', '') : '';
    if (!/^\d+$/.test(nlbRouteId)) return false;
    const res = await fetchJSON(`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=list&routeId=${encodeURIComponent(nlbRouteId)}`, 3500, false);
    if (Array.isArray(res?.stops) && res.stops.length > 0 && getBaseStopNameKey(res.stops[0].stopName_e) === getBaseStopNameKey(stops[0]?.stopName_e)) {
      res.stops.forEach((st, idx) => {
        if (stops[idx]) {
          if (st.fare) stops[idx].fare = String(st.fare);
          if (st.fareHoliday) stops[idx].fareHol = String(st.fareHoliday);
        }
      });
      return true;
    }
  } catch (e) {}
  return false;
}

function computeLrtZoneFare(boardStop, alightStop) {
  const baseFare = Number(window.__MIN_OCTOPUS_RAIL_FARE__) || 5.2;
  if (!boardStop || !alightStop) return baseFare;
  const bId = resolveLrtNumericId(boardStop.lrtCode || boardStop.stopId, boardStop.stopName_e, boardStop.name_tc);
  const aId = resolveLrtNumericId(alightStop.lrtCode || alightStop.stopId, alightStop.stopName_e, alightStop.name_tc);
  const zA = LRT_STATION_DIRECTORY[bId]?.zone;
  const zB = LRT_STATION_DIRECTORY[aId]?.zone;
  if (!zA || !zB) return baseFare;
  if (zA === zB) return baseFare;

  let zonesCrossed = 2;
  if ((zA === '5A' && zB === '5') || (zA === '5' && zB === '5A')) {
    zonesCrossed = 3;
  } else {
    const nA = zA === '5A' ? 5 : Number(zA);
    const nB = zB === '5A' ? 5 : Number(zB);
    zonesCrossed = Math.abs(nA - nB) + 1;
  }

  if (zonesCrossed <= 2) return 5.2;
  if (zonesCrossed === 3) return 6.0;
  if (zonesCrossed === 4) return 6.9;
  return 7.9;
}

function getEffectiveStopFare(group, boardStop, alightStop = null, isHoliday = isHongKongHolidayFareDay(), vesselClass = null) {
  if (!group || !boardStop) return 0;

  if (group.mode === 'MTR' && group.company !== 'LRT') {
    const oCode = boardStop.mtrCode || boardStop.stopId;
    const dCode = alightStop?.mtrCode || alightStop?.stopId;
    if (oCode && dCode && typeof MTR_ENGINE !== 'undefined') {
      const exact = MTR_ENGINE.lookupExactHeavyRailFare(oCode, dCode, window.getExactMtrFare);
      if (exact > 0) return exact;
    }
    const fb = parseFloat(boardStop.fare || '0');
    return (Number.isFinite(fb) && fb > 0) ? fb : 0;
  }

  if (group.company === 'LRT') {
    return computeLrtZoneFare(boardStop, alightStop);
  }

  if (group.mode === 'FERRY') {
    const fm = group.ferryMeta || {};
    const pairKey = getCanonicalFerryPairKey(group.orig_e, group.dest_e);
    if (pairKey === 'central_muiwo') return isHoliday ? 48.5 : 33.5;
    if (pairKey === 'central_cheungchau') {
      const vClass = vesselClass || fm._activeVesselClass || 'FAST';
      const isOrd = (vClass === 'ORD');
      return isHoliday ? (isOrd ? 24.8 : 47.6) : (isOrd ? 16.7 : 32.9);
    }
    if (pairKey === 'central_pengchau') return isHoliday ? 46.6 : 31.9;
    if (pairKey === 'central_yungshuewan') return isHoliday ? 34.7 : 24.9;
    if (pairKey === 'central_sokkwuwan') return isHoliday ? 43.5 : 30.9;
    const vClass = vesselClass || fm._activeVesselClass || 'FAST';
    const isOrd = (vClass === 'ORD');
    const fVal = isHoliday
      ? (isOrd ? (fm.fareHolOrd || fm.fareHol) : (fm.fareHolFast || fm.fareHol))
      : (isOrd ? (fm.fareWkOrd  || fm.fareWk)  : (fm.fareWkFast  || fm.fareWk));
    if (fVal > 0) return Number(fVal);
  }

  if (alightStop && typeof resolveBusLegNetFare === 'function') {
    const sec = resolveBusLegNetFare(group, boardStop, alightStop, isHoliday);
    if (sec.netFare > 0) return sec.netFare;
  }

  const rawStr = (isHoliday && boardStop.fareHol && parseFloat(boardStop.fareHol) > 0)
    ? boardStop.fareHol
    : boardStop.fare;
  const val = parseFloat(rawStr || '0');
  if (Number.isFinite(val) && val > 0) return val;
  return Number(group.maxFare || 0);
}

function analyzeStopSectionFareProfile(group, stops, stopIdx, isHol = isHongKongHolidayFareDay()) {
  if (!group || !Array.isArray(stops) || !stops[stopIdx]) {
    return { fullFare: 0, minSectionFare: 0, hasSectionTiers: false, labelText: '', secBadge: '' };
  }
  const terminalStop = stops[stops.length - 1] || null;
  const fullFare = getEffectiveStopFare(group, stops[stopIdx], terminalStop, isHol);
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  if (group.company === 'LRT') {
    const bId = resolveLrtNumericId(stops[stopIdx].lrtCode || stops[stopIdx].stopId, stops[stopIdx].stopName_e, stops[stopIdx].name_tc);
    const zCode = LRT_STATION_DIRECTORY[bId]?.zone || '';
    const zTag = zCode ? (isZh ? ` (${zCode}收費區)` : ` (Zone ${zCode})`) : '';
    const minF = 5.2;
    const lbl = fullFare > minF + 0.1
      ? `${t('farePrefix')}${minF.toFixed(1)}–$${fullFare.toFixed(1)}${zTag}`
      : `${t('farePrefix')}${fullFare.toFixed(1)}${zTag}`;
    return { fullFare, minSectionFare: minF, hasSectionTiers: fullFare > minF, labelText: lbl, secBadge: '' };
  }

  const hasTwoWayHere = (!group.mode || group.mode === 'BUS') && typeof hasStopTwoWaySectionalFare === 'function'
    ? hasStopTwoWaySectionalFare(group, stops, stopIdx, isHol)
    : false;
  const secBadge = hasTwoWayHere
    ? (isZh ? '雙向分段' : '2-Way Section')
    : '';

  return {
    fullFare,
    minSectionFare: fullFare,
    hasSectionTiers: hasTwoWayHere,
    labelText: fullFare > 0 ? `${t('farePrefix')}${fullFare.toFixed(1)}` : '',
    secBadge
  };
}

function extractRouteBoundCode(group) {
  const tdB = String(group?.tdBound || group?.bound || '').trim().toUpperCase();
  if (tdB === 'I' || tdB === 'INBOUND' || tdB === '2') return 'I';
  if (tdB === 'O' || tdB === 'OUTBOUND' || tdB === '1') return 'O';
  const rId = String(group?.routeIds?.[0] || '');
  if (rId.includes('_I') || String(group?.key || '').endsWith('_I')) return 'I';
  return 'O';
}

function stripPlatformCodeFromDisplay(name) {
  return cleanFerryLabel(name)
    .replace(/\s*\([A-Z]{1,3}\d{2,4}\)\s*/g, '')
    .replace(/\s*\(Platform\s*[^)]+\)\s*/gi, '')
    .trim();
}

function getBaseStopNameKey(name) {
  return stripPlatformCodeFromDisplay(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function getGlobalStopKey(s) {
  if (!s) return '';
  if (s.stopKey) return s.stopKey;
  if (s.mode === 'FERRY') {
    const pierCanon = normStationLookupKey(s.stopName_e) || getBaseStopNameKey(s.stopName_e);
    return `FERRY_PIER_${pierCanon}`;
  }
  if (s.mode === 'MTR') {
    const isLrt = s.company === 'LRT' || Boolean(s.lrtCode);
    if (isLrt) {
      const lrtNumId = typeof resolveLrtNumericId === 'function'
        ? resolveLrtNumericId(s.lrtCode || s.stopId, s.stopName_e, s.name_tc)
        : String(s.lrtCode || s.stopId || '').replace(/\D/g, '');
      if (lrtNumId) return `LRT_STN_${lrtNumId}`;
    } else {
      const stCode = String(s.mtrCode || s.stopId || '').trim().toUpperCase();
      if (stCode) return `MTR_STN_${stCode}`;
    }
  }
  const lat = parseFloat(s.latitude ?? s.lat ?? 0).toFixed(4);
  const lon = parseFloat(s.longitude ?? s.lon ?? 0).toFixed(4);
  return `${getBaseStopNameKey(s.stopName_e)}_${lat}_${lon}`;
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const n1 = Number(lat1), m1 = Number(lon1), n2 = Number(lat2), m2 = Number(lon2);
  if (!Number.isFinite(n1) || !Number.isFinite(m1) || !Number.isFinite(n2) || !Number.isFinite(m2)) return 999;
  const R = 6371, dLat = (n2 - n1) * Math.PI / 180, dLon = (m2 - m1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(n1 * Math.PI / 180) * Math.cos(n2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
}

function formatStopDistance(stopObj) {
  if (!stopObj || typeof lastKnownPos === 'undefined' || !lastKnownPos || !lastKnownPos.hasLiveFix) return '';
  if (Number(lastKnownPos.acc) > 450) return '';
  const dKm = calculateDistanceKm(lastKnownPos.lat, lastKnownPos.lon, parseFloat(stopObj.latitude), parseFloat(stopObj.longitude));
  if (!Number.isFinite(dKm) || dKm > 60) return '';
  return dKm < 1.0 ? `${Math.round(dKm * 1000)}m` : `${dKm.toFixed(1)}km`;
}

function getStopDistrictTag(stopObj, maybeLon = null) {
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  let lat, lon;
  if (typeof stopObj === 'number' && typeof maybeLon === 'number') {
    lat = stopObj;
    lon = maybeLon;
  } else if (stopObj && typeof stopObj === 'object') {
    if (stopObj.district_en || stopObj.district_tc) {
      return isZh ? (stopObj.district_tc || stopObj.district_en) : (stopObj.district_en || stopObj.district_tc);
    }
    lat = parseFloat(stopObj.latitude ?? stopObj.lat);
    lon = parseFloat(stopObj.longitude ?? stopObj.lon);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0) return '';
  if (lat >= 22.475 && lon >= 114.05 && lon <= 114.23) return isZh ? '北區' : 'North District';
  if (lat < 22.28 && lon < 114.05) return isZh ? '大嶼山南' : 'South Lantau';
  if (lat >= 22.28 && lat <= 22.335 && lon < 114.01) return isZh ? '東涌/機場' : 'Tung Chung / Airport';
  if (lat >= 22.42 && lon < 114.08) return isZh ? '元朗' : 'Yuen Long';
  if (lat >= 22.36 && lat < 22.42 && lon < 114.02) return isZh ? '屯門' : 'Tuen Mun';
  if (lat >= 22.35 && lat <= 22.39 && lon >= 114.06 && lon <= 114.14) return isZh ? '荃灣' : 'Tsuen Wan';
  if (lat >= 22.43 && lon >= 114.13) return isZh ? '大埔' : 'Tai Po';
  if (lat >= 22.36 && lat < 22.43 && lon >= 114.16) return isZh ? '沙田' : 'Sha Tin';
  if (lat < 22.292 && lon >= 114.12) return isZh ? '港島' : 'HK Island';
  return isZh ? '九龍' : 'Kowloon';
}

function getStopName(s) {
  if (!s) return '';
  const raw = (typeof currentLang !== 'undefined' && currentLang === 'zh' && s.name_tc) ? s.name_tc : s.stopName_e;
  return stripPlatformCodeFromDisplay(raw);
}

function getRouteName(g) {
  if (!g) return '';
  const raw = (typeof currentLang !== 'undefined' && currentLang === 'zh' && g.dest_tc) ? g.dest_tc : g.dest_e;
  return cleanFerryLabel(raw);
}

function getCompanyName(g) {
  if (!g) return '';
  return (typeof currentLang !== 'undefined' && currentLang === 'zh' && g.company_tc) ? g.company_tc : g.company;
}

function getStopsForGroup(g, preferredStopKey = null) {
  if (!g || !Array.isArray(g.routeIds) || !g.routeIds.length) return [];
  const sortedIds = [...g.routeIds].sort((a, b) => (routeStopsCache[b]?.length || 0) - (routeStopsCache[a]?.length || 0));
  if (preferredStopKey) {
    const cleanKey = String(preferredStopKey).replace(/^(MTR_STN_|MTR_HUB_|MTR_|LRT_STN_|LRT_|FERRY_PIER_|FERRY_)/, '');
    const targetBase = getBaseStopNameKey(cleanKey.split('_')[0]);
    const targetPierCanon = normStationLookupKey(cleanKey.split('_')[0]);
    for (const rId of sortedIds) {
      const sList = routeStopsCache[rId] || [];
      if (sList.some(s =>
        s.stopKey === preferredStopKey ||
        getGlobalStopKey(s) === preferredStopKey ||
        String(s.mtrCode || s.lrtCode || s.stopId || '').toUpperCase() === cleanKey.toUpperCase() ||
        getBaseStopNameKey(s.stopName_e) === targetBase ||
        (g.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon)
      )) {
        return sList;
      }
    }
  }
  const bestId = sortedIds[0];
  return (typeof routeStopsCache !== 'undefined' && routeStopsCache[bestId]) ? routeStopsCache[bestId] : [];
}

function findNearestStopIdx(stops, pos) {
  if (!stops || !stops.length || !pos) return 0;
  let bestIdx = 0, bestD = Infinity;
  stops.forEach((s, i) => {
    const d = calculateDistanceKm(pos.lat, pos.lon, parseFloat(s.latitude), parseFloat(s.longitude));
    if (d < bestD) { bestD = d; bestIdx = i; }
  });
  return bestIdx;
}

const SafeStorage = {
  _mem: {},
  _cookieMirrorKeys: new Set([
    'transit_saved_hubs_v1',
    'transit_lang_pref_v2',
    'transit_theme_pref_v4',
    'transit_text_size',
    'transit_onboarding_never_show_v1',
    'transit_onboarding_seen_v2'
  ]),
  _readCookieVal(k) {
    try {
      const prefix = `ts_${k}=`;
      const parts = String(document.cookie || '').split(';');
      for (const p of parts) {
        const t = p.trim();
        if (t.startsWith(prefix)) return decodeURIComponent(t.slice(prefix.length));
      }
    } catch (e) {}
    return null;
  },
  _writeCookieVal(k, v) {
    try {
      if (!this._cookieMirrorKeys.has(k)) return;
      const enc = encodeURIComponent(String(v));
      if (enc.length > 3500) return;
      document.cookie = `ts_${k}=${enc}; max-age=315360000; path=/; SameSite=Lax`;
    } catch (e) {}
  },
  _clearCookieVal(k) {
    try {
      if (!this._cookieMirrorKeys.has(k)) return;
      document.cookie = `ts_${k}=; max-age=0; path=/; SameSite=Lax`;
    } catch (e) {}
  },
  getItem(k) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) return v;
    } catch (e) {}
    if (this._mem[k] !== undefined) return this._mem[k];
    if (this._cookieMirrorKeys.has(k)) {
      const cv = this._readCookieVal(k);
      if (cv !== null) {
        this._mem[k] = cv;
        try { localStorage.setItem(k, cv); } catch (e) {}
        return cv;
      }
    }
    return null;
  },
  setItem(k, v) {
    const s = String(v);
    this._mem[k] = s;
    try { localStorage.setItem(k, s); } catch (e) {}
    this._writeCookieVal(k, s);
  },
  removeItem(k) {
    delete this._mem[k];
    try { localStorage.removeItem(k); } catch (e) {}
    this._clearCookieVal(k);
  }
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function escapeJsAttr(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function triggerHaptic(ms = 10) { try { if (!navigator.userActivation || navigator.userActivation.hasBeenActive) navigator.vibrate?.(ms); } catch (e) {} }

function getHongKongNow(targetEpochMs = null) {
  const dObj = Number.isFinite(targetEpochMs) ? new Date(targetEpochMs) : new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(dObj);
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return new Date(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
}

function getHongKongDateYYYYMMDD(dObj = null) {
  const hk = dObj || getHongKongNow();
  return `${hk.getFullYear()}-${String(hk.getMonth() + 1).padStart(2, '0')}-${String(hk.getDate()).padStart(2, '0')}`;
}

function getLiveHktTimeString() {
  const hk = getHongKongNow();
  return `${String(hk.getHours()).padStart(2, '0')}:${String(hk.getMinutes()).padStart(2, '0')}:${String(hk.getSeconds()).padStart(2, '0')}`;
}

function formatHkArrivalClock(targetMs) {
  if (!Number.isFinite(targetMs)) return '';
  try {
    const truncatedMs = Math.floor((targetMs + 15000) / 60000) * 60000;
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(truncatedMs));
  } catch (e) { return ''; }
}

function renderMtrStyleReportFooterHtml() {
  return `<div style="text-align:center; padding:16px 10px 26px 10px; font-size:0.66rem; color:var(--text-sub); font-family:ui-monospace,'SF Mono',monospace;">${APP_VERSION}</div>`;
}

const REFRESH_INTERVAL_LIVE = 8;
const REFRESH_INTERVAL_FERRY = 30;
let countdown = REFRESH_INTERVAL_LIVE, isSyncing = false;
let groupedRoutes = [], routeStopsCache = {}, allStops = [], nearbyStopsList = [];
const stopMapIndex = new Map(), routeMapIndex = new Map(), indexedGroupKeys = new Set();

let activeAppMode = location.hostname.includes('hk-rail') ? 'MTR' : (location.hostname.includes('hk-ferry') ? 'FERRY' : 'BUS');
let currentView = 'main', currentNearestStopKey = null, lastRenderedCenterStopKey = null;
let stopDirectionFilterMode = 'BOTH';

function detectClientDeviceLang(navObj) {
  try {
    const n = navObj || (typeof navigator !== 'undefined' ? navigator : {});
    const primary = (Array.isArray(n.languages) && n.languages.length > 0 && n.languages[0])
      || n.language
      || n.userLanguage
      || (typeof Intl !== 'undefined' && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().locale : '')
      || 'en';
    const norm = String(primary || '').trim().toLowerCase();
    return /^(zh|yue)\b/.test(norm) ? 'zh' : 'en';
  } catch (e) {
    return 'en';
  }
}

let userLangPref = SafeStorage.getItem('transit_lang_pref_v2') || 'auto';
let currentLang = userLangPref === 'auto' ? detectClientDeviceLang() : userLangPref;
let userThemePref = SafeStorage.getItem('transit_theme_pref_v4') || 'light';

const navHistoryStack = [];

function getAdaptiveRefreshIntervalSec() {
  if (currentView === 'detail' && detailRouteGroup?.mode === 'FERRY') return REFRESH_INTERVAL_FERRY;
  if (currentView === 'main' && activeAppMode === 'FERRY') return REFRESH_INTERVAL_FERRY;
  return REFRESH_INTERVAL_LIVE;
}

function syncTopNavHighlights() {
  const isModeView = (currentView === 'main' || currentView === 'detail');
  document.getElementById('navModeBus')?.classList.toggle('active-bus', isModeView && activeAppMode === 'BUS');
  document.getElementById('navModeMtr')?.classList.toggle('active-mtr', isModeView && activeAppMode === 'MTR');
  document.getElementById('navModeFerry')?.classList.toggle('active-ferry', isModeView && activeAppMode === 'FERRY');
  document.getElementById('topXferBtn')?.classList.toggle('active-top-tab', currentView === 'xfer');
  document.getElementById('topMapBtn')?.classList.toggle('active-top-tab', currentView === 'map');
  document.getElementById('topFavBtn')?.classList.toggle('active-top-tab', currentView === 'fav');
}

function updateTopBackButtonVisibility() {
  const backBtn = document.getElementById('backBtn');
  const backLbl = document.getElementById('topBackBtnLbl');
  if (!backBtn) return;
  if (backLbl) backLbl.innerText = currentLang === 'zh' ? '返回' : 'Back';
  const isManualStopPinned = (currentView === 'main' && Date.now() < userManualStopBrowseUntilMs);
  const showBack = (currentView !== 'main') || isStopSearchOpen() || navHistoryStack.length > 0 || isManualStopPinned;
  backBtn.style.display = showBack ? 'flex' : 'none';
}

async function switchTransitAppMode(mode) {
  triggerHaptic(12);
  activeAppMode = (mode === 'MTR' || mode === 'FERRY') ? mode : 'BUS';
  countdown = getAdaptiveRefreshIntervalSec();

  userManualStopBrowseUntilMs = 0;
  lastRenderedCenterStopKey = null;
  clearStopSearchInput();

  if (currentView !== 'main') {
    switchView('main', false);
  } else {
    syncTopNavHighlights();
    updateTopBackButtonVisibility();
  }

  if (lastKnownPos) syncNearestStopFromGPS(lastKnownPos.lat, lastKnownPos.lon, true);
  renderMainNearby(false);
}

function resolveEffectiveTheme() {
  if (userThemePref === 'dark' || userThemePref === 'light') return userThemePref;
  const h = getHongKongNow().getHours();
  return (h >= 6 && h < 18) ? 'light' : 'dark';
}

function applyTheme() {
  const isLight = resolveEffectiveTheme() === 'light';
  document.documentElement.classList.toggle('light-mode', isLight);
  const chromeBg = isLight ? '#FFFFFF' : '#1C1C1E';
  const meta = document.getElementById('themeColorMeta');
  if (meta) meta.setAttribute('content', chromeBg);
  document.documentElement.style.backgroundColor = chromeBg;
}
applyTheme();

function triggerIosStandaloneTopBarReflow() {
  try {
    const isStandalone = Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator.standalone === true);
    const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isStandalone || !isIos) return;
    document.documentElement.classList.add('ios-standalone');
    const nudge = document.createElement('div');
    nudge.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:1px;background:rgba(0,0,0,0.01);z-index:2147483647;pointer-events:none;';
    document.body.appendChild(nudge);
    requestAnimationFrame(() => nudge.remove());
  } catch (e) {}
}

let currentTextSize = SafeStorage.getItem('transit_text_size') || 'lg';
function applyTextSize() {
  document.documentElement.classList.remove('text-sm', 'text-xs');
  if (currentTextSize === 'sm') document.documentElement.classList.add('text-sm');
  else if (currentTextSize === 'xs') document.documentElement.classList.add('text-xs');
}
applyTextSize();

let bookmarkedStops = [];
try {
  const savedBm = JSON.parse(SafeStorage.getItem('transit_stop_bookmarks_v1') || 'null');
  if (Array.isArray(savedBm)) bookmarkedStops = savedBm;
} catch (e) { bookmarkedStops = []; }

let recentStopSearches = [];
try {
  const savedRec = JSON.parse(SafeStorage.getItem('transit_recent_stops_v1') || '[]');
  if (Array.isArray(savedRec)) recentStopSearches = savedRec;
} catch (e) { recentStopSearches = []; }

let lastKnownPos = { lat: 22.2855, lon: 114.1577, acc: 25, hasLiveFix: false };
try {
  const savedPos = JSON.parse(SafeStorage.getItem('transit_last_gps_pos_v2') || 'null');
  if (savedPos && Number.isFinite(savedPos.lat) && Number.isFinite(savedPos.lon)) lastKnownPos = { ...savedPos, hasLiveFix: false };
} catch (e) {}

let userManualStopBrowseUntilMs = 0;
let detailRouteGroup = null, detailBoardStopKey = null, detailTargetStopKey = null, detailExpandedStopIdx = -1;
window.detailTargetStopKey = null;
let detailSelectedEtaBusIdx = 0;
let detailLastFetchedArrs = [];
let detailOpenToken = 0, expandStopRequestToken = 0;

const SignalHealthMonitor = {
  lastGpsFixMs: 0, lastGpsAccMeters: null, lastRawGpsAccMeters: null, lastApiRttMs: 0, lastApiOk: true,
  byOperator: {
    KMB:   { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    NLB:   { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    CTB:   { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    GMB:   { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    MTRB:  { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    MTR:   { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    LRT:   { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    FERRY: { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' },
    EDGE:  { calls: 0, ms: 0, okMs: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null, lastValidYieldMs: 0, lastErrMsg: '' }
  },
  recordGpsFix(accMeters) {
    this.lastGpsFixMs = Date.now();
    const rawAcc = Number.isFinite(accMeters) ? Math.round(accMeters) : 20;
    this.lastRawGpsAccMeters = rawAcc;
    this.lastGpsAccMeters = rawAcc;
  },
  resolveOpKey(urlStr = '') {
    const u = String(urlStr || '');
    if (u.includes('etabus.gov.hk')) return 'KMB';
    if (u.includes('/nlb/')) return 'NLB';
    if (u.includes('/citybus/')) return 'CTB';
    if (u.includes('etagmb.gov.hk')) return 'GMB';
    if (u.includes('mtr/bus') || u.includes('mtr_bus')) return 'MTRB';
    if (u.includes('/mtr/lrt/') || u.includes('lrt_live')) return 'LRT';
    if (u.includes('/mtr/')) return 'MTR';
    if (u.includes('ferry_live') || u.includes('ferry-live')) return 'FERRY';
    if (u.includes('/api/worker')) return 'EDGE';
    return null;
  },
  recordApiSample(rttMs, ok, urlStr = '', errMsg = '') {
    this.lastApiRttMs = Math.max(1, Math.round(rttMs));
    this.lastApiOk = Boolean(ok);
    const opKey = this.resolveOpKey(urlStr);
    if (opKey && this.byOperator[opKey]) {
      const b = this.byOperator[opKey];
      b.calls++;
      b.ms = this.lastApiRttMs;
      if (ok) b.okMs = Date.now();
      else {
        b.errors++;
        if (errMsg) b.lastErrMsg = errMsg;
      }
    }
  },
  recordParsedYield(opKey, parsedCount, contextNote = '') {
    const b = this.byOperator[opKey];
    if (!b) return;
    if (parsedCount > 0) {
      b.lastYieldCount = parsedCount;
      b.lastValidYieldMs = Date.now();
      b.emptyPayloads = 0;
    } else if (!b.lastValidYieldMs || (Date.now() - b.lastValidYieldMs) > 30000) {
      b.lastYieldCount = 0;
      b.emptyPayloads++;
      if (contextNote) b.lastErrMsg = contextNote;
    }
  },
  getGpsStatus() {
    if (!this.lastGpsFixMs || !Number.isFinite(this.lastGpsAccMeters) || this.lastGpsAccMeters > 450) {
      return { grade: 'DEFAULT', label: currentLang === 'zh' ? '未定位/預設' : 'No Live Fix (Default)' };
    }
    const ageSec = Math.round((Date.now() - this.lastGpsFixMs) / 1000);
    return { grade: ageSec > 120 ? 'STALE' : 'GOOD', label: `±${this.lastGpsAccMeters}m (${ageSec}s ago)` };
  },
  getCellStatus() {
    if (navigator.onLine === false) return { grade: 'DEAD', label: currentLang === 'zh' ? '離線' : 'Offline' };
    return { grade: this.lastApiRttMs > 1200 ? 'SLOW' : 'GOOD', label: `${this.lastApiRttMs || 45}ms` };
  }
};

function t(key) { return (typeof i18n !== 'undefined' && (i18n[currentLang]?.[key] || i18n.en?.[key])) || key; }

function showToast(msg) {
  const el = document.getElementById('toastMsg');
  if (!el) return;
  el.innerText = msg;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ============================================================================
// TELEMETRY, ETA-DRIFT TRACKERS & CONTINUOUS BUS KINEMATICS
// ============================================================================
const requestCache = new Map();
const kmbBulkRouteCache = new Map();
const inFlightStopEtaPromises = new Map();
const busEtaDriftTracker = new Map();
const mtrEalHoldTracker = new Map();
let liveFerryApiCache = { ts: 0, data: null };

function pruneTelemetryCachesIfNeeded() {
  const now = Date.now();
  if (requestCache.size > 80) {
    for (const [k, v] of requestCache.entries()) {
      if (now - (v.time || 0) > 30000) requestCache.delete(k);
    }
  }
  if (kmbBulkRouteCache.size > 60) {
    for (const [k, v] of kmbBulkRouteCache.entries()) {
      if (now - (v.time || 0) > 30000) kmbBulkRouteCache.delete(k);
    }
  }
  if (busEtaDriftTracker.size > 160) {
    for (const [k, v] of busEtaDriftTracker.entries()) {
      if (now - (v.ts || 0) > 240000) busEtaDriftTracker.delete(k);
    }
  }
  if (mtrEalHoldTracker.size > 80) {
    for (const [k, v] of mtrEalHoldTracker.entries()) {
      if (now - (v.lastTs || 0) > 180000) mtrEalHoldTracker.delete(k);
    }
  }
}

async function fetchJSON(url, timeoutMs = 4500, bypassCache = false) {
  const now = Date.now();
  pruneTelemetryCachesIfNeeded();
  if (!bypassCache && requestCache.has(url)) {
    const c = requestCache.get(url);
    if (now - c.time < 2500 && c.data) return c.data;
    if (c.promise) return c.promise;
  }
  const p = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t0 = performance.now();
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(tid);
        SignalHealthMonitor.recordApiSample(performance.now() - t0, r.ok, url);
        if (!r.ok) continue;
        const d = await r.json();
        requestCache.set(url, { time: Date.now(), data: d });
        return d;
      } catch (e) {
        clearTimeout(tid);
        SignalHealthMonitor.recordApiSample(performance.now() - t0, false, url, e?.message || 'timeout');
      }
    }
    return null;
  })();
  requestCache.set(url, { time: requestCache.get(url)?.time || 0, data: requestCache.get(url)?.data || null, promise: p });
  return p;
}

async function fetchKmbRouteBulkEta(routeNo, serviceType = '1', bypassCache = false) {
  const key = `${routeNo}_${serviceType}`;
  const now = Date.now();
  const cached = kmbBulkRouteCache.get(key);
  if (!bypassCache && cached && (now - cached.time < 2500)) return cached.byStopSeq;
  if (!bypassCache && cached?.promise) return cached.promise;

  const p = (async () => {
    const res = await fetchJSON(`https://data.etabus.gov.hk/v1/transport/kmb/route-eta/${routeNo}/${serviceType}`, 4500, bypassCache);
    const byStopSeq = new Map();
    if (Array.isArray(res?.data)) {
      res.data.forEach(item => {
        if (!item?.eta) return;
        const mapKey = `${item.dir}_${item.seq}`;
        if (!byStopSeq.has(mapKey)) byStopSeq.set(mapKey, []);
        byStopSeq.get(mapKey).push(item);
      });
    }
    kmbBulkRouteCache.set(key, { time: Date.now(), byStopSeq });
    return byStopSeq;
  })();
  kmbBulkRouteCache.set(key, { time: cached?.time || 0, byStopSeq: cached?.byStopSeq || new Map(), promise: p });
  return p;
}

function getCorridorLiveStatusAt(midLat, midLon) {
  const la = Number(midLat), lo = Number(midLon);
  const liveMap = window.__LIVE_CORRIDORS__;
  const corList = window.HK_STRATEGIC_CORRIDORS;
  if (!Number.isFinite(la) || !Number.isFinite(lo) || !liveMap || !Array.isArray(corList)) {
    return { status: 'SMOOTH', speedKmh: 70 };
  }
  let worst = { status: 'SMOOTH', speedKmh: 70 };
  for (const cor of corList) {
    const st = liveMap[cor.id];
    if (!st || st.status === 'SMOOTH') continue;
    const dKm = calculateDistanceKm(la, lo, cor.lat, cor.lon);
    if (dKm <= cor.radiusKm && Number(st.speedKmh) < worst.speedKmh) {
      worst = { status: st.status, speedKmh: Number(st.speedKmh) };
    }
  }
  return worst;
}

// Continuous inter-stop bus speed & dwell curve (fixes E36A Tung Chung North loop runtime globally)
function computeSegmentStepSeconds(mode, company, dKm, isTerminalHop = false, midLat = null, midLon = null) {
  const distM = Number.isFinite(dKm) && dKm < 35 ? dKm * 1000 : 280;
  if (mode === 'MTR') {
    if (company === 'LRT') return Math.max(28, Math.round((distM * 1.08) / 7.8) + 16);
    const speedMps = distM >= 2500 ? 22.8 : (distM >= 1400 ? 18.2 : 14.8);
    return Math.max(40, Math.round((distM * 1.03) / speedMps) + 18);
  }
  if (mode === 'FERRY') {
    return Math.max(60, Math.round((distM * 1.03) / 11.2));
  }

  // Short spacing (<500m) = urban/estate loop (~18 km/h = 5.0 m/s) + 38s stop/light friction
  // Long spacing (>2300m) = expressway/tunnel (~65 km/h = 18.0 m/s) + 10s minimal friction
  const highwayRatio = Math.min(1, Math.max(0, (distM - 500) / 1800));
  const isSouthLantauRural = (company === 'NLB') && Number.isFinite(midLat) && Number.isFinite(midLon) && midLat < 22.275 && midLon < 114.03;
  if (isSouthLantauRural) {
    const ruralSpeedMps = Math.max(8.2, 5.0 + highwayRatio * 13.0);
    const ruralDwellSec = isTerminalHop ? 8 : 14;
    return Math.max(20, Math.round((distM * 1.08) / ruralSpeedMps) + ruralDwellSec);
  }
  let speedMps = 5.0 + highwayRatio * 13.0;
  const liveCor = getCorridorLiveStatusAt(midLat, midLon);
  if (highwayRatio > 0.35 && liveCor.speedKmh < 58) {
    speedMps = Math.min(speedMps, Math.max(7.5, (liveCor.speedKmh / 3.6) * 0.88));
  }
  const dwellAndLightSec = isTerminalHop
    ? Math.round(12 - highwayRatio * 8)
    : Math.round(38 - highwayRatio * 28);
  const roadDistM = distM * (1.06 + (1 - highwayRatio) * 0.04);
  return Math.max(22, Math.round(roadDistM / speedMps) + dwellAndLightSec);
}

function isParallelRailTerminusPair(codeA, codeB) {
  const a = String(codeA || '').toUpperCase();
  const b = String(codeB || '').toUpperCase();
  if ((a === 'LOW' && b === 'LMC') || (a === 'LMC' && b === 'LOW')) return true;
  if (a === 'LHP' && (b === 'POA' || b === 'HAH')) return true;
  if (b === 'LHP' && (a === 'POA' || a === 'HAH')) return true;
  return false;
}

function computeInterStopKinematics(group, stops, fromIdx, toIdx) {
  if (!stops || fromIdx < 0 || toIdx <= fromIdx || toIdx >= stops.length) {
    return { distMeters: 280, driveSec: 28, dwellSec: 10, transitSec: 38, cruiseKmh: 34 };
  }
  const mode = group?.mode || 'BUS';
  const company = group?.company || '';
  const isHeavyMtr = (mode === 'MTR' && company !== 'LRT');

  if (mode === 'MTR' && toIdx - fromIdx > 1) {
    const fromCode = stops[fromIdx]?.mtrCode || stops[fromIdx]?.stopId;
    const toCode = stops[toIdx]?.mtrCode || stops[toIdx]?.stopId;
    let allIntermediateParallel = true;
    for (let m = fromIdx + 1; m < toIdx; m++) {
      const midCode = stops[m]?.mtrCode || stops[m]?.stopId;
      if (!isParallelRailTerminusPair(fromCode, midCode) && !isParallelRailTerminusPair(toCode, midCode)) {
        allIntermediateParallel = false;
        break;
      }
    }
    if (allIntermediateParallel) {
      const fLa = parseFloat(stops[fromIdx].latitude), fLo = parseFloat(stops[fromIdx].longitude);
      const tLa = parseFloat(stops[toIdx].latitude), tLo = parseFloat(stops[toIdx].longitude);
      const dKm = calculateDistanceKm(fLa, fLo, tLa, tLo);
      const roadMeters = (Number.isFinite(dKm) && dKm < 35) ? (dKm * 1000 * 1.15) : 1800;
      const transitSec = (isHeavyMtr && typeof MTR_ENGINE !== 'undefined')
        ? MTR_ENGINE.getAdjacentRunningTimeSec(fromCode, toCode)
        : computeSegmentStepSeconds(mode, company, dKm, toIdx >= stops.length - 2, (fLa + tLa) / 2, (fLo + tLo) / 2);
      const cruiseKmh = Math.max(18, Math.min(80, Math.round((roadMeters / Math.max(1, transitSec)) * 3.6)));
      return { distMeters: Math.round(roadMeters), driveSec: transitSec, dwellSec: 0, transitSec, cruiseKmh };
    }
  }

  let roadMeters = 0, transitSec = 0;
  for (let m = fromIdx; m < toIdx; m++) {
    const pLa = parseFloat(stops[m].latitude), pLo = parseFloat(stops[m].longitude);
    const sLa = parseFloat(stops[m + 1].latitude), sLo = parseFloat(stops[m + 1].longitude);
    const dKm = calculateDistanceKm(pLa, pLo, sLa, sLo);
    roadMeters += (Number.isFinite(dKm) && dKm < 35) ? (dKm * 1000 * 1.15) : 280;
    if (isHeavyMtr && typeof MTR_ENGINE !== 'undefined') {
      const cA = stops[m]?.mtrCode || stops[m]?.stopId;
      const cB = stops[m + 1]?.mtrCode || stops[m + 1]?.stopId;
      transitSec += MTR_ENGINE.getAdjacentRunningTimeSec(cA, cB);
    } else {
      transitSec += computeSegmentStepSeconds(mode, company, dKm, m === toIdx - 1, (pLa + sLa) / 2, (pLo + sLo) / 2);
    }
  }
  const cruiseKmh = Math.max(18, Math.min(80, Math.round((roadMeters / Math.max(1, transitSec)) * 3.6)));
  return { distMeters: Math.round(roadMeters), driveSec: transitSec, dwellSec: 0, transitSec, cruiseKmh };
}

function isHospitalBranchStop(stopObj) {
  if (!stopObj) return false;
  const nE = String(stopObj.stopName_e || '').toLowerCase();
  const nZ = String(stopObj.name_tc || '');
  return (nE.includes('north lantau hospital') || nZ.includes('北大嶼山醫院')) && !nE.includes('mei yat house');
}

function getMtrStationDisplayByCode(code, routeStops = []) {
  const c = String(code || '').trim().toUpperCase();
  const hit = (routeStops || []).find(s => String(s.stopId || s.mtrCode || '').toUpperCase() === c);
  if (hit) return getStopName(hit);
  for (const s of allStops) {
    if (s.mode === 'MTR' && String(s.mtrCode || s.stopId || '').toUpperCase() === c) {
      return getStopName(s);
    }
  }
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const FALLBACK_NAMES = {
    LOW: isZh ? '羅湖港鐵站' : 'Lo Wu MTR Station',
    LMC: isZh ? '落馬洲港鐵站' : 'Lok Ma Chau MTR Station',
    POA: isZh ? '寶琳港鐵站' : 'Po Lam MTR Station',
    LHP: isZh ? '康城港鐵站' : 'LOHAS Park MTR Station',
    RAC: isZh ? '馬場港鐵站' : 'Racecourse MTR Station',
    ADM: isZh ? '金鐘港鐵站' : 'Admiralty MTR Station',
    HUH: isZh ? '紅磡港鐵站' : 'Hung Hom MTR Station',
    NOP: isZh ? '北角港鐵站' : 'North Point MTR Station',
    TIK: isZh ? '調景嶺港鐵站' : 'Tiu Keng Leng MTR Station'
  };
  return FALLBACK_NAMES[c] || c;
}

async function fetchStopSingleRaw(group, targetStop, bypassCache = false, afterMs = Date.now()) {
  if (!group || !targetStop) return [];
  const now = Date.now();
  const refMs = Math.max(now, afterMs);
  const inflightKey = `${group.key}_${targetStop.stopKey || targetStop.stopId}_${Math.floor(refMs / 60000)}`;

  if (!bypassCache && inFlightStopEtaPromises.has(inflightKey)) {
    return inFlightStopEtaPromises.get(inflightKey);
  }

  const workPromise = (async () => {
    const results = [];
    const isZh = (currentLang === 'zh');
    const isFutureBeyondLive = (refMs - now) > 25 * 60000;
    const sortedRouteIds = [...(group.routeIds || [])].sort((a, b) => (routeStopsCache[b]?.length || 0) - (routeStopsCache[a]?.length || 0));
    if (!sortedRouteIds.length) return [];

    const opAuditKey = group.mode === 'FERRY'
      ? 'FERRY'
      : (group.company === 'LRT'
        ? 'LRT'
        : (group.mode === 'MTR'
          ? 'MTR'
          : (String(group.company).startsWith('GMB')
            ? 'GMB'
            : (group.company === 'LWB' ? 'KMB' : (group.company || 'KMB')))));

    const targetBaseName = getBaseStopNameKey(targetStop.stopName_e);
    const targetPierCanon = normStationLookupKey(targetStop.stopName_e);
    const matchingPairs = [];
    for (const rId of sortedRouteIds) {
      const rStops = routeStopsCache[rId] || [];
      const allowFinalStop = isCircularRoute(group, rStops);
      const isPenultimateDualBranch = (group.mode === 'MTR' && rStops.length >= 3 && isParallelRailTerminusPair(rStops[rStops.length - 2]?.stopId, rStops[rStops.length - 1]?.stopId));
      const maxBoardIdx = isPenultimateDualBranch ? rStops.length - 3 : rStops.length - 2;

      const exactSeqMatch = targetStop.seq ? rStops.find(s => s.seq === targetStop.seq && (s.stopKey === targetStop.stopKey || getGlobalStopKey(s) === targetStop.stopKey || getBaseStopNameKey(s.stopName_e) === targetBaseName || (group.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon))) : null;
      const mStop = exactSeqMatch ||
                    rStops.find((s, idx) => (idx <= maxBoardIdx || rStops.length === 1 || allowFinalStop) && (s.stopKey === targetStop.stopKey || getGlobalStopKey(s) === targetStop.stopKey || getBaseStopNameKey(s.stopName_e) === targetBaseName || (group.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon))) ||
                    rStops.find(s => s.stopKey === targetStop.stopKey || getGlobalStopKey(s) === targetStop.stopKey || getBaseStopNameKey(s.stopName_e) === targetBaseName || (group.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon));
      if (mStop) matchingPairs.push({ rId, routeStops: rStops, matchStop: mStop });
    }
    if (!matchingPairs.length) return [];

    const { rId, routeStops, matchStop } = matchingPairs[0];

    if (group.mode === 'MTR' || rId.startsWith('MTR_') || rId.startsWith('LRT_')) {
      if (isFutureBeyondLive) return [];
      if (typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isClosedAt(getHongKongNow(refMs))) return [];

      if (rId.startsWith('LRT_')) {
        const curLrtIdx = routeStops.indexOf(matchStop);
        if (!isCircularRoute(group, routeStops) && routeStops.length >= 2 && curLrtIdx >= routeStops.length - 1) {
          return [];
        }
        const stId = resolveLrtNumericId(matchStop.lrtCode || matchStop.stopId, matchStop.stopName_e, matchStop.name_tc);
        if (!stId) return [];
        let res = await fetchJSON(`https://rt.data.gov.hk/v1/transport/mtr/lrt/getSchedule?station_id=${stId}`, 3800, bypassCache);
        if (!res || !Array.isArray(res.platform_list)) {
          res = await fetchEdgeApiJSON(`?action=lrt_live&station_id=${stId}`, 3800, bypassCache);
        }
        const targetRouteNo = String(group.routeNo).toUpperCase();
        (res?.platform_list || []).forEach(plat => {
          (plat.route_list || []).forEach(tr => {
            if (String(tr.route_no || '').toUpperCase() !== targetRouteNo) return;
            const m = String(tr.time_en || '').match(/\d+/);
            const mins = m ? parseInt(m[0], 10) : 0;
            const remSec = mins === 0 ? 20 : mins * 60;
            const tMs = now + remSec * 1000;
            if (tMs < refMs - 30000) return;
            const tLen = Number(tr.train_length) === 2 ? 2 : 1;
            const carsTxt = isZh ? (tLen === 2 ? '雙卡' : '單卡') : (tLen === 2 ? '2-Car' : '1-Car');
            const platTxt = isZh ? `${plat.platform_id || '1'}號月台` : `Plat ${plat.platform_id || '1'}`;
            const destTxt = isZh ? (tr.dest_ch || tr.dest_en) : (tr.dest_en || tr.dest_ch);
            results.push({
              targetMs: tMs, rawTargetMs: tMs, noGPS: 0, isSched: false,
              trainLength: tLen,
              remark: `${platTxt} • ${carsTxt} ➔ ${destTxt}`
            });
          });
        });
        SignalHealthMonitor.recordParsedYield('LRT', results.length, results.length === 0 ? `0 LRT ETAs for ${group.routeNo}` : '');
        return results;
      }

      const parts = rId.split('_');
      const lineCode = parts[1];
      const dirCode = parts[parts.length - 1] || 'O';
      const staCode = matchStop.stopId;
      const curStopIdx = routeStops.findIndex(s => s.stopId === staCode);
      const downstreamCodes = new Set(
        routeStops
          .slice(curStopIdx + 1)
          .filter(s => !isParallelRailTerminusPair(staCode, s.stopId))
          .map(s => s.stopId)
      );

      if (!isCircularRoute(group, routeStops) && downstreamCodes.size === 0) {
        return [];
      }

      if (lineCode === 'EAL' && (downstreamCodes.has('LOW') || downstreamCodes.has('LMC'))) {
        downstreamCodes.add('LOW');
        downstreamCodes.add('LMC');
        downstreamCodes.add('RAC');
      }
      if (lineCode === 'TKL' && (downstreamCodes.has('POA') || downstreamCodes.has('LHP'))) {
        downstreamCodes.add('POA');
        downstreamCodes.add('LHP');
      }

      const res = await fetchJSON(`https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${lineCode}&sta=${staCode}`, 3800, bypassCache);
      const isLineDelayed = String(res?.isdelay || '').toUpperCase() === 'Y';
      const stnData = res?.data?.[`${lineCode}-${staCode}`];
      if (stnData) {
        const upList = stnData.UP || [];
        const downList = stnData.DOWN || [];
        const allTrains = [...upList, ...downList];
        const hasDestTags = allTrains.some(tr => Boolean(tr.dest));
        const dirMatched = allTrains.filter(tr => tr.dest && downstreamCodes.has(tr.dest));
        const chosen = hasDestTags
          ? dirMatched
          : (dirCode === 'O' ? (upList.length ? upList : downList) : (downList.length ? downList : upList));

        // Track EAL Arrival-to-Departure platform hold dwell (timetype "A" / ttnt === 0)
        if (lineCode === 'EAL' && chosen[0]) {
          const holdKey = `EAL_${staCode}_${dirCode}`;
          const t0Type = String(chosen[0].timetype || '').toUpperCase();
          const t0Min = parseInt(String(chosen[0].ttnt || '99'), 10);
          const prevHold = mtrEalHoldTracker.get(holdKey);
          if (t0Type === 'A' || t0Min === 0) {
            if (!prevHold || (now - prevHold.lastTs) > 95000) {
              mtrEalHoldTracker.set(holdKey, { startTs: now, lastTs: now, holdSec: 0 });
            } else {
              prevHold.lastTs = now;
              prevHold.holdSec = Math.round((now - prevHold.startTs) / 1000);
            }
          } else if (prevHold && (now - prevHold.lastTs) > 45000) {
            mtrEalHoldTracker.delete(holdKey);
          }
        }

        chosen.slice(0, 4).forEach(tr => {
          const ttnt = parseInt(String(tr.ttnt || '').trim(), 10);
          const exactMs = tr.time ? Date.parse(String(tr.time).trim().replace(' ', 'T') + '+08:00') : NaN;
          let tMs;
          if (Number.isFinite(exactMs) && (exactMs - now) >= -30000 && (exactMs - now) <= 5400000) {
            tMs = Math.max(now + 15000, exactMs);
          } else {
            if (isNaN(ttnt) || ttnt < 0 || ttnt > 90) return;
            tMs = now + (ttnt === 0 ? 20 : ttnt * 60) * 1000;
          }
          if (tMs < refMs - 30000) return;
          const destCode = String(tr.dest || '').toUpperCase();
          const destName = getMtrStationDisplayByCode(destCode, routeStops);
          const platTxt = isZh ? `${tr.plat || '1'}號月台` : `Plat ${tr.plat || '1'}`;
          const isEalSouth = (destCode === 'ADM' || destCode === 'EXC' || destCode === 'HUH');
          const fcNote = lineCode === 'EAL'
            ? (isEalSouth ? (isZh ? ' • 頭等:第4卡' : ' • 1st:Car 4') : (isZh ? ' • 頭等:第6卡' : ' • 1st:Car 6'))
            : '';
          results.push({
            targetMs: tMs,
            rawTargetMs: tMs,
            noGPS: 0,
            isSched: false,
            destCode,
            isDelay: isLineDelayed,
            timeType: String(tr.timetype || '').toUpperCase(),
            remark: `${platTxt} ➔ ${destName}${fcNote}`
          });
        });
      }
      SignalHealthMonitor.recordParsedYield('MTR', results.length, results.length === 0 ? `0 MTR ETAs for ${lineCode}` : '');
      return results;
    }

    if (group.mode === 'FERRY' || rId.startsWith('FERRY_')) {
      const curPierIdx = Math.max(0, routeStops.indexOf(matchStop));
      if (!isCircularRoute(group, routeStops) && routeStops.length >= 2 && curPierIdx >= routeStops.length - 1) {
        return [];
      }

      const canonPair = getCanonicalFerryPairKey(group.orig_e, group.dest_e);
      const isMuiWoCorridor = (canonPair === 'central_muiwo');
      const isCheungChauDual = (canonPair === 'central_cheungchau');
      const fMeta = group.ferryMeta || { dur: 35, durFast: 35, durOrd: isMuiWoCorridor ? 35 : 55 };
      const liveKey = resolveFerryLiveEtaKeyClient(group.orig_e, group.dest_e)
        || (routeStops.length >= 2 ? resolveFerryLiveEtaKeyClient(routeStops[0].stopName_e, routeStops[routeStops.length - 1].stopName_e) : null)
        || group.liveEtaKey;

      if (!liveFerryApiCache.data) {
        liveFerryApiCache.data = { liveEtas: {}, csvSchedules: mergeVerifiedMainlineSchedules({}), keyTs: {} };
      }
      const keyAge = now - (liveFerryApiCache.data.keyTs?.[liveKey || '_CSV'] || 0);
      if (liveKey && keyAge > 25000 && !isFutureBeyondLive) {
        liveFerryApiCache.ts = now;
        liveFerryApiCache.data.keyTs[liveKey] = now;
        try {
          const d = await fetchEdgeApiJSON(`?action=ferry_live&key=${encodeURIComponent(liveKey)}`, 3500, false);
          if (d?.ok) {
            Object.assign(liveFerryApiCache.data.liveEtas, d.liveEtas || {});
          }
        } catch (e) {}
      }

      const pierOffsetMins = curPierIdx > 0
        ? Math.max(curPierIdx * 12, Math.round(computeInterStopKinematics(group, routeStops, 0, curPierIdx).transitSec / 60))
        : 0;

      const isPlannedFuture = (refMs - now) > 120000;
      const hkRef = getHongKongNow(refMs);
      const isHolRef = isHongKongHolidayFareDay(hkRef);
      const nowSecOfDay = hkRef.getHours() * 3600 + hkRef.getMinutes() * 60 + hkRef.getSeconds();
      const liveStampStr = `${String(hkRef.getHours()).padStart(2, '0')}:${String(hkRef.getMinutes()).padStart(2, '0')} HKT`;

      const pairKeyHdr  = `${normStationLookupKey(group.orig_e)}_${normStationLookupKey(group.dest_e)}`;
      const pairKeyStop = routeStops.length >= 2
        ? `${normStationLookupKey(routeStops[0].stopName_e)}_${normStationLookupKey(routeStops[routeStops.length - 1].stopName_e)}`
        : pairKeyHdr;
      const pairKeyCurStop = routeStops.length >= 2
        ? `${normStationLookupKey(matchStop.stopName_e)}_${normStationLookupKey(routeStops[routeStops.length - 1].stopName_e)}`
        : pairKeyHdr;

      const liveArr = (!isPlannedFuture && liveKey) ? liveFerryApiCache.data?.liveEtas?.[liveKey] : null;
      if (Array.isArray(liveArr) && liveArr.length > 0) {
        liveArr.forEach(item => {
          const depStr = item.depart_time || item.ETA || item.eta || item.time || item.rmk_en || '';
          const m = String(depStr).match(/(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?[Mm]\.?)?/);
          if (!m) return;
          let hh = Number(m[1]);
          const mm = Number(m[2]);
          if (m[3]) {
            hh = hh % 12;
            if (m[3].toLowerCase() === 'p') hh += 12;
          }
          const rawApiMin = hh * 60 + mm;
          const effDepMin = (rawApiMin + pierOffsetMins) % 1440;
          let diffSec = effDepMin * 60 - nowSecOfDay;
          if (diffSec < -43200) diffSec += 86400;
          if (diffSec >= -60 && diffSec <= 14400) {
            const tMs = refMs + Math.max(0, diffSec) * 1000;
            const dispH = String(Math.floor(effDepMin / 60) % 24).padStart(2, '0');
            const dispM = String(effDepMin % 60).padStart(2, '0');
            const csvSch = liveFerryApiCache.data?.csvSchedules?.[pairKeyHdr] || fMeta.sched;
            const dayK = isHolRef ? 'hol' : (hkRef.getDay() === 6 ? 'sat' : 'wk');
            const daySlots = (Array.isArray(csvSch?.[dayK]) && csvSch[dayK].length)
              ? csvSch[dayK]
              : ((Array.isArray(csvSch?.wk) && csvSch.wk.length) ? csvSch.wk : (csvSch?.sat || csvSch?.hol || []));

            const matchedSlot = daySlots.find(s => {
              const slotM = Array.isArray(s) ? Number(s[0]) : Number(s);
              return Number.isFinite(slotM) && Math.abs(slotM - rawApiMin) <= 3;
            });
            if (daySlots.length > 0 && !matchedSlot && window.__LIVE_FERRY_DRIFT_ALERTS__) {
              const apiHHMM = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
              window.__LIVE_FERRY_DRIFT_ALERTS__.set(`${pairKeyHdr}_${apiHHMM}`, {
                category: 'LIVE_API_FERRY_DRIFT',
                date: getHongKongDateYYYYMMDD(hkRef),
                message: `Live API reported ${apiHHMM} sailing on ${group.orig_e} -> ${group.dest_e} (${dayK}), which is not in VERIFIED_MAINLINE_FERRIES.`
              });
            }

            const csvDur = isMuiWoCorridor ? 35 : ((Array.isArray(matchedSlot) && matchedSlot[1]) ? Number(matchedSlot[1]) : 0);
            const rawShipEn = item.vessel_type || item.ship_type_en || item.rmk_en || '';
            const isOrd = !isMuiWoCorridor && (/ordinary|普通/i.test(rawShipEn) || (!rawShipEn && csvDur >= 50));
            const isFast = !isOrd && (isMuiWoCorridor || /fast|高速/i.test(rawShipEn) || csvDur <= 40 || (fMeta.durFast || fMeta.dur || 35) <= 42);
            const vClass = isOrd ? 'ORD' : 'FAST';
            const shipEn = rawShipEn || (isCheungChauDual ? (isFast ? 'Fast Ferry' : 'Ordinary Ferry') : `${dispH}:${dispM} Sailing`);
            const shipZh = item.vessel_type_tc || item.ship_type_tc || item.rmk_tc || (isCheungChauDual ? (isFast ? '高速船' : '普通渡輪') : `${dispH}:${dispM} 航班`);
            const baseDur = isMuiWoCorridor ? 35 : (csvDur || (isFast ? (fMeta.durFast || 35) : (isOrd ? (fMeta.durOrd || 55) : (fMeta.dur || 35))));
            const remDur = Math.max(5, baseDur - pierOffsetMins);
            const durTxt = isZh ? `航程約${remDur}分` : `${remDur}m crossing`;
            results.push({
              targetMs: tMs, rawTargetMs: tMs, noGPS: 0, isSched: false, vesselClass: vClass,
              remark: `${isZh ? shipZh : shipEn} • ${durTxt}`,
              schedUpdated: `Live API (${liveStampStr})`
            });
          }
        });
        if (results.length >= 3) {
          results.sort((a, b) => a.targetMs - b.targetMs);
          if (group.ferryMeta && results[0]?.vesselClass) {
            group.ferryMeta._activeVesselClass = results[0].vesselClass;
          }
          SignalHealthMonitor.recordParsedYield('FERRY', results.length);
          return results.slice(0, 4);
        }
      }

      const directSubPierSched = curPierIdx > 0 ? liveFerryApiCache.data?.csvSchedules?.[pairKeyCurStop] : null;
      const effectiveOffsetMins = directSubPierSched ? 0 : pierOffsetMins;
      const activeSchedKey = directSubPierSched ? pairKeyCurStop : (liveFerryApiCache.data?.csvSchedules?.[pairKeyHdr] ? pairKeyHdr : pairKeyStop);

      let sched = directSubPierSched
        || liveFerryApiCache.data?.csvSchedules?.[pairKeyHdr]
        || liveFerryApiCache.data?.csvSchedules?.[pairKeyStop]
        || fMeta.sched
        || fMeta.schedule
        || null;

      if (sched) {
        const dayKey = isHolRef ? 'hol' : (hkRef.getDay() === 6 ? 'sat' : 'wk');
        let slots = Array.isArray(sched[dayKey]) && sched[dayKey].length > 0 ? sched[dayKey] : [];
        if (!slots.length) {
          if (dayKey === 'wk' && group.serviceMode !== 'HOLIDAY_ONLY') {
            slots = (Array.isArray(sched.sat) && sched.sat.length > 0) ? sched.sat : (sched.hol || []);
          } else {
            slots = (Array.isArray(sched.sat) && sched.sat.length > 0) ? sched.sat : (sched.wk || sched.hol || []);
          }
        }

        const updDate = sched.updated || window.__DB_TD_LAST_UPDATED__ || APP_VERSION.slice(0, 10);
        const updBadge = `Verified (${updDate})`;

        const candResults = [];
        for (const entry of slots) {
          const baseMin = Array.isArray(entry) ? Number(entry[0]) : Number(entry);
          const rawSlotDur = (Array.isArray(entry) && entry[1]) ? Number(entry[1]) : 0;
          const csvSlotDur = isMuiWoCorridor ? 35 : rawSlotDur;
          if (!Number.isFinite(baseMin)) continue;
          const depMin = (baseMin + effectiveOffsetMins) % 1440;
          let diffSec = depMin * 60 - nowSecOfDay;
          if (diffSec < -60 && nowSecOfDay >= 72000 && depMin < 180) {
            diffSec += 86400;
          }
          if (diffSec < -60 || diffSec > 86340) continue;

          const hh = String(Math.floor(depMin / 60) % 24).padStart(2, '0');
          const mm = String(depMin % 60).padStart(2, '0');
          const tMs = refMs + Math.max(0, diffSec) * 1000;
          if (results.some(r => Math.abs(r.targetMs - tMs) <= 600000)) continue;
          const isOrd = !isMuiWoCorridor && csvSlotDur >= 50;
          const vClass = isOrd ? 'ORD' : 'FAST';
          const sailDur = Math.max(5, (csvSlotDur || (isOrd ? fMeta.durOrd : fMeta.durFast) || fMeta.dur || 35) - effectiveOffsetMins);
          const shipLbl = (isCheungChauDual && csvSlotDur)
            ? (!isOrd ? (isZh ? '高速船 ' : 'Fast Ferry ') : (isZh ? '普通渡輪 ' : 'Ordinary Ferry '))
            : '';

          let footnoteSuffix = '';
          if (depMin === 1425 && /pengchau/.test(activeSchedKey)) {
            footnoteSuffix = isZh ? ' • ^以梅窩為終點站' : ' • ^Terminates at Mui Wo';
          } else if ((depMin === 360 || depMin === 390) && /cheungchau_pengchau|muiwo_pengchau/.test(activeSchedKey)) {
            footnoteSuffix = isZh ? ' • *以坪洲為終點站' : ' • *Terminates at Peng Chau';
          } else if (depMin === 1040 && /muiwo_cheungchau/.test(activeSchedKey)) {
            footnoteSuffix = isZh ? ' • #只限星期一至五(直航長洲)' : ' • #Mon–Fri only (Direct)';
          }

          const durTxt = isZh
            ? `${shipLbl}時間表 ${hh}:${mm} • 約${sailDur}分${footnoteSuffix}`
            : `${shipLbl}Timetable ${hh}:${mm} • ${sailDur}m${footnoteSuffix}`;
          candResults.push({
            targetMs: tMs, rawTargetMs: tMs, noGPS: 1, isSched: true, vesselClass: vClass,
            remark: durTxt, schedUpdated: updBadge
          });
        }
        candResults.sort((a, b) => a.targetMs - b.targetMs);
        results.push(...candResults);
        results.sort((a, b) => a.targetMs - b.targetMs);
        if (results.length > 4) results.length = 4;

        if (!results.length) {
          const tmrDay = (hkRef.getDay() + 1) % 7;
          const tmrKey = tmrDay === 0 ? 'hol' : (tmrDay === 6 ? 'sat' : 'wk');
          const tmrSlots = Array.isArray(sched[tmrKey]) && sched[tmrKey].length ? sched[tmrKey] : (sched.sat || sched.hol || sched.wk || []);
          if (tmrSlots.length > 0) {
            const firstEntry = tmrSlots[0];
            const firstBaseMin = Array.isArray(firstEntry) ? Number(firstEntry[0]) : Number(firstEntry);
            const firstSlotDur = isMuiWoCorridor ? 35 : ((Array.isArray(firstEntry) && firstEntry[1]) ? Number(firstEntry[1]) : 0);
            if (Number.isFinite(firstBaseMin)) {
              const nextDep = (firstBaseMin + effectiveOffsetMins) % 1440;
              const hh = String(Math.floor(nextDep / 60) % 24).padStart(2, '0');
              const mm = String(nextDep % 60).padStart(2, '0');
              const secUntilTmr = (86400 - nowSecOfDay) + nextDep * 60;
              const tMs = refMs + secUntilTmr * 1000;
              const vClass = firstSlotDur >= 50 ? 'ORD' : 'FAST';
              const lbl = (Array.isArray(sched[tmrKey]) && sched[tmrKey].length)
                ? (isZh ? `明日頭班 ${hh}:${mm} (今日尾班已過)` : `Tomorrow ${hh}:${mm} (Last boat sailed)`)
                : (isZh ? `週末/假日 ${hh}:${mm} 服務` : `Sat/Sun/Hol ${hh}:${mm} only`);
              results.push({
                targetMs: tMs, rawTargetMs: tMs, noGPS: 1, isSched: true, vesselClass: vClass,
                remark: lbl, schedUpdated: updBadge
              });
            }
          }
        }
        if (group.ferryMeta && results[0]?.vesselClass) {
          group.ferryMeta._activeVesselClass = results[0].vesselClass;
        }
      }
      SignalHealthMonitor.recordParsedYield('FERRY', results.length, results.length === 0 ? `0 Ferry ETAs for ${pairKeyHdr}` : '');
      return results;
    }

    if (rId.startsWith('KMB_') || rId.startsWith('LWB_')) {
      if (isFutureBeyondLive) return [];
      const seenEtaMs = new Set();
      await Promise.all(matchingPairs.slice(0, 4).map(async (pair) => {
        const parts = pair.rId.split('_');
        const routeNo = parts[1], dirChar = parts[2], srvType = parts[3] || '1';
        const byStopSeq = await fetchKmbRouteBulkEta(routeNo, srvType, bypassCache);
        const seqNum = pair.matchStop.seq || (pair.routeStops.indexOf(pair.matchStop) + 1);
        const items = byStopSeq.get(`${dirChar}_${seqNum}`) || [];
        items.forEach(e => {
          const tMs = new Date(e.eta).getTime();
          if (!isNaN(tMs) && (tMs - now) >= -5000 && tMs >= refMs - 30000) {
            const roundedKey = Math.round(tMs / 30000);
            if (seenEtaMs.has(roundedKey)) return;
            seenEtaMs.add(roundedKey);
            const diffMins = (tMs - now) / 60000;
            const rmk = String(e.rmk_en || '').toLowerCase();
            const rmkTc = String(e.rmk_tc || '');
            const isSched = rmk.includes('scheduled') || rmk.includes('not yet') || rmkTc.includes('預定') || rmkTc.includes('未開出') || diffMins > 38;
            results.push({ targetMs: tMs, rawTargetMs: tMs, etaSeq: e.eta_seq || 1, noGPS: isSched ? 1 : 0, isSched, remark: isZh ? (e.rmk_tc || '') : (e.rmk_en || '') });
          }
        });
      }));
    } else if (rId.startsWith('CTB_')) {
      if (isFutureBeyondLive) return [];
      const seenCtbMs = new Set();
      await Promise.all(matchingPairs.slice(0, 3).map(async (pair) => {
        const parts = pair.rId.split('_');
        const res = await fetchJSON(`https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/${pair.matchStop.stopId}/${parts[1]}`, 4200, bypassCache);
        (res?.data || []).forEach(e => {
          if (!e.eta || e.dir !== parts[2]) return;
          const tMs = new Date(e.eta).getTime();
          if (!isNaN(tMs) && (tMs - now) >= -5000 && tMs >= refMs - 30000) {
            const roundedKey = Math.round(tMs / 30000);
            if (seenCtbMs.has(roundedKey)) return;
            seenCtbMs.add(roundedKey);
            const diffMins = (tMs - now) / 60000;
            const rmk = String(e.rmk_en || '').toLowerCase();
            const rmkTc = String(e.rmk_tc || '');
            const isSched = rmk.includes('scheduled') || rmkTc.includes('預定') || diffMins > 38;
            results.push({ targetMs: tMs, rawTargetMs: tMs, noGPS: isSched ? 1 : 0, isSched, remark: isZh ? (e.rmk_tc || '') : (e.rmk_en || '') });
          }
        });
      }));
    } else if (rId.startsWith('NLB_')) {
      if (isFutureBeyondLive) return [];
      const seenNlbMs = new Set();
      await Promise.all(matchingPairs.slice(0, 4).map(async (pair) => {
        const nlbRouteId = pair.rId.replace('NLB_', '');
        const res = await fetchJSON(`https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals&routeId=${nlbRouteId}&stopId=${pair.matchStop.stopId}&language=en`, 4500, bypassCache);
        (res?.estimatedArrivals || []).forEach(arr => {
          if (!arr.estimatedArrivalTime) return;
          const isoHk = String(arr.estimatedArrivalTime).trim().replace(' ', 'T') + '+08:00';
          const tMs = Date.parse(isoHk);
          if (!isNaN(tMs) && (tMs - now) >= -5000 && tMs >= refMs - 30000) {
            const roundedKey = Math.round(tMs / 30000);
            if (seenNlbMs.has(roundedKey)) return;
            seenNlbMs.add(roundedKey);
            const hasDeparted = String(arr.departed) === '1' || arr.departed === 1;
            const isNoGps = String(arr.noGPS) === '1' || arr.noGPS === 1;
            const isSched = !hasDeparted;
            results.push({
              targetMs: tMs, rawTargetMs: tMs,
              noGPS: (isNoGps || isSched) ? 1 : 0,
              isTempGpsBlind: hasDeparted && isNoGps,
              isSched,
              variantName: arr.routeVariantName || ''
            });
          }
        });
      }));
    } else if (rId.startsWith('GMB_')) {
      if (isFutureBeyondLive) return [];
      const seenGmbMs = new Set();
      await Promise.all(matchingPairs.slice(0, 3).map(async (pair) => {
        const parts = pair.rId.split('_');
        const seqNum = pair.matchStop.seq || (pair.routeStops.indexOf(pair.matchStop) + 1);
        let etaList = [];
        if (!String(pair.matchStop.stopId).startsWith('SYNTH_')) {
          const res = await fetchJSON(`https://data.etagmb.gov.hk/eta/stop/${pair.matchStop.stopId}`, 4200, bypassCache);
          const targetData = res?.data?.find(d => String(d.route_id) === parts[1] && String(d.route_seq) === parts[2] && (!d.stop_seq || Number(d.stop_seq) === seqNum)) ||
                             res?.data?.find(d => String(d.route_id) === parts[1] && String(d.route_seq) === parts[2]);
          if (Array.isArray(targetData?.eta) && targetData.eta.length > 0) {
            etaList = targetData.eta;
          }
        }
        // Fallback to TD's direct route-stop GMB ETA endpoint when /eta/stop misses or stopId drifted
        if (!etaList.length && parts[1] && parts[2] && seqNum >= 1) {
          const rsRes = await fetchJSON(`https://data.etagmb.gov.hk/eta/route-stop/${parts[1]}/${parts[2]}/${seqNum}`, 4200, bypassCache);
          if (Array.isArray(rsRes?.data?.eta) && rsRes.data.eta.length > 0) {
            etaList = rsRes.data.eta;
          }
        }
        etaList.forEach(e => {
          if (!e.timestamp) return;
          const tMs = new Date(e.timestamp).getTime();
          if (!isNaN(tMs) && (tMs - now) >= -5000 && tMs >= refMs - 30000) {
            const roundedKey = Math.round(tMs / 30000);
            if (seenGmbMs.has(roundedKey)) return;
            seenGmbMs.add(roundedKey);
            const rmk = String(e.remarks_en || '').toLowerCase();
            const rmkTc = String(e.remarks_tc || '');
            const isSched = rmk.includes('scheduled') || rmkTc.includes('預定');
            results.push({ targetMs: tMs, rawTargetMs: tMs, noGPS: isSched ? 1 : 0, isSched, fetchedAtMs: now, remark: isZh ? (e.remarks_tc || '') : (e.remarks_en || '') });
          }
        });
      }));
    } else if (rId.startsWith('MTRB_')) {
      if (isFutureBeyondLive) return [];
      const routeNo = rId.replace('MTRB_', '').split('_')[0];
      const cacheKey = `MTRB_POST_${routeNo}_${isZh ? 'zh' : 'en'}`;
      const cachedMtrb = (!bypassCache && requestCache.has(cacheKey)) ? requestCache.get(cacheKey) : null;
      let d = (cachedMtrb && (now - cachedMtrb.time < 2500)) ? cachedMtrb.data : null;
      if (!d) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3800);
        const t0 = performance.now();
        try {
          const r = await fetch('https://rt.data.gov.hk/v1/transport/mtr/bus/getSchedule', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: isZh ? 'zh' : 'en', routeName: routeNo }), signal: ctrl.signal
          });
          clearTimeout(tid);
          SignalHealthMonitor.recordApiSample(performance.now() - t0, r.ok, 'mtr_bus');
          if (r.ok) {
            d = await r.json();
            requestCache.set(cacheKey, { time: Date.now(), data: d });
          }
        } catch (e) {
          clearTimeout(tid);
          SignalHealthMonitor.recordApiSample(performance.now() - t0, false, 'mtr_bus', e?.message || 'timeout');
        }
      }
      if (d) {
        const stItem = (d.busStop || []).find(bs => bs.busStopId === matchStop.stopId);
        (stItem?.bus || []).forEach(b => {
          const sec = parseInt(b.arrivalTimeInSecond || b.departureTimeInSecond || '9999', 10);
          if (sec >= 0 && sec < 7200) {
            const tMs = now + sec * 1000;
            if (tMs < refMs - 30000) return;
            const isSched = String(b.isScheduled) === '1';
            results.push({ targetMs: tMs, rawTargetMs: tMs, noGPS: isSched ? 1 : 0, isSched, remark: b.busRemark || '' });
          }
        });
      }
    }

    results.sort((a, b) => a.targetMs - b.targetMs);
    SignalHealthMonitor.recordParsedYield(opAuditKey, results.length, results.length === 0 ? `0 ETAs for ${group.routeNo}` : '');
    return results;
  })();

  inFlightStopEtaPromises.set(inflightKey, workPromise);
  try {
    return await workPromise;
  } finally {
    inFlightStopEtaPromises.delete(inflightKey);
  }
}

// ============================================================================
// LIVE BUS/MTR LOAD FACTOR INJECTION
// ============================================================================
function formatLoadPillHtml(loadEst, compact = false) {
  if (!loadEst || !loadEst.cssClass) return '';
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const lbl = isZh ? loadEst.labelTc : loadEst.labelEn;
  const titleAttr = (isZh ? loadEst.tipTc : loadEst.tipEn) || `${loadEst.pct}%`;
  const pad = compact ? 'padding:1px 6px;font-size:0.62rem;' : 'padding:1px 7px;font-size:0.64rem;';
  return `<span class="load-pill ${escapeHtml(loadEst.cssClass)}" style="${pad}" title="${escapeHtml(titleAttr)}">${escapeHtml(lbl)}</span>`;
}

async function fetchEtaRaw(group, stopKey, isExpandedDetailView = false, afterMs = Date.now(), explicitStopIdx = null) {
  if (!group) return [];
  const now = Date.now();
  const refMs = Math.max(now, afterMs);

  const stops = getStopsForGroup(group, stopKey);
  const allowFinalStop = isCircularRoute(group, stops);
  const isPenultimateDualBranch = (group.mode === 'MTR' && stops.length >= 3 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId));
  const maxBoardIdx = isPenultimateDualBranch ? stops.length - 3 : stops.length - 2;

  const cleanKey = String(stopKey || '').replace(/^(MTR_STN_|MTR_HUB_|MTR_|LRT_STN_|LRT_|FERRY_PIER_|FERRY_)/, '');
  const targetBase = getBaseStopNameKey(cleanKey.split('_')[0]);
  const targetPierCanon = normStationLookupKey(cleanKey.split('_')[0]);

  let kIdx = (Number.isInteger(explicitStopIdx) && explicitStopIdx >= 0 && explicitStopIdx < stops.length) ? explicitStopIdx : -1;
  if (kIdx === -1) {
    kIdx = stops.findIndex((s, idx) => (idx <= maxBoardIdx || stops.length === 1 || allowFinalStop) && (s.stopKey === stopKey || String(s.mtrCode || s.lrtCode || s.stopId || '').toUpperCase() === cleanKey.toUpperCase() || getBaseStopNameKey(s.stopName_e) === targetBase || (group.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon)));
  }
  if (kIdx === -1) {
    kIdx = stops.findIndex(s => s.stopKey === stopKey || String(s.mtrCode || s.lrtCode || s.stopId || '').toUpperCase() === cleanKey.toUpperCase() || getBaseStopNameKey(s.stopName_e) === targetBase || (group.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon));
  }
  if (kIdx === -1) return [];
  const targetStop = stops[kIdx];

  const rawK = await fetchStopSingleRaw(group, targetStop, false, refMs);

  const effStopIdx = kIdx;
  const effStopObj = targetStop;
  const kinSeg = computeInterStopKinematics(group, stops, Math.max(0, effStopIdx - 1), effStopIdx);
  const hkNow = getHongKongNow(now);
  const isHol = isHongKongHolidayFareDay(hkNow);

  // Track live Bus ETA slippage across 8s polls (residual dwell anomaly proxy)
  let busDriftSec = 0;
  if ((!group.mode || group.mode === 'BUS') && rawK[0]) {
    const dKey = `${group.key}_${effStopObj?.stopId || effStopIdx}`;
    const firstMs = rawK[0].rawTargetMs || rawK[0].targetMs;
    const prev = busEtaDriftTracker.get(dKey);
    if (prev && (now - prev.ts) >= 6000 && (now - prev.ts) <= 180000) {
      const slip = Math.round((firstMs - prev.firstMs) / 1000);
      if (slip > 0 && slip <= 240) {
        busDriftSec = Math.min(180, (prev.driftSec || 0) + slip);
      } else if (slip < -240) {
        busDriftSec = 0; // Next bus rolled into slot 0
      } else {
        busDriftSec = Math.max(0, Math.round((prev.driftSec || 0) * 0.7));
      }
    }
    busEtaDriftTracker.set(dKey, { ts: now, firstMs, driftSec: busDriftSec });
  }

  const corStatus = (!group.mode || group.mode === 'BUS')
    ? getCorridorLiveStatusAt(parseFloat(effStopObj?.latitude), parseFloat(effStopObj?.longitude)).status
    : 'SMOOTH';

  const ealHoldKey = (group.mode === 'MTR' && group.routeNo === 'EAL')
    ? `EAL_${effStopObj?.stopId || ''}_${extractRouteBoundCode(group)}`
    : '';
  const ealDwellDeltaSec = ealHoldKey ? (mtrEalHoldTracker.get(ealHoldKey)?.holdSec || 0) : 0;

  return rawK.slice(0, 4).map((item, idx) => {
    const remSec = Math.round((item.targetMs - now) / 1000);
    let kinematicState = 'LIVE_GPS';
    if (item.isSched) kinematicState = 'SCHED_GHOST';
    else if (remSec <= 60) kinematicState = 'AT_STOP';

    // Pairwise headway gap for this specific vehicle (idx 0 uses gap to idx 1; idx >= 1 uses trailing gap from idx - 1)
    let obsHwSec = 0;
    if (idx === 0 && rawK[1]) {
      obsHwSec = Math.max(0, Math.round((rawK[1].targetMs - item.targetMs) / 1000));
    } else if (idx > 0 && rawK[idx - 1]) {
      obsHwSec = Math.max(0, Math.round((item.targetMs - rawK[idx - 1].targetMs) / 1000));
    }
    const trailingHwSec = (idx === 0 && rawK[1] && rawK[2])
      ? Math.max(0, Math.round((rawK[2].targetMs - rawK[1].targetMs) / 1000))
      : 0;

    let loadEstimate = null;
    if (typeof LoadFactorEngine !== 'undefined') {
      if (group.mode === 'MTR') {
        loadEstimate = LoadFactorEngine.inferMtrLoad({
          isLrt: group.company === 'LRT',
          company: group.company,
          lineCode: group.routeNo,
          staCode: effStopObj?.mtrCode || effStopObj?.stopId || '',
          dirCode: extractRouteBoundCode(group),
          destCode: item.destCode || '',
          destName: group.dest_e || '',
          lrtTrainLength: item.trainLength || 0,
          obsHeadwaySec: obsHwSec,
          ealDwellDeltaSec: idx === 0 ? ealDwellDeltaSec : 0,
          isDelay: Boolean(item.isDelay),
          dateObj: hkNow,
          isHoliday: isHol
        });
      } else if (group.mode === 'FERRY') {
        loadEstimate = typeof LoadFactorEngine.inferFerryLoad === 'function'
          ? LoadFactorEngine.inferFerryLoad({
              group,
              origName: stops[0]?.stopName_e || group.orig_e || '',
              destName: stops[stops.length - 1]?.stopName_e || group.dest_e || '',
              vesselClass: item.vesselClass || group.ferryMeta?._activeVesselClass || '',
              obsHeadwaySec: obsHwSec,
              schedHeadwaySec: (typeof getPeriodHeadwaySecs === 'function')
                ? getPeriodHeadwaySecs(group, item.targetMs || now)
                : ((Number(group.headwayMins) || 35) * 60),
              isSched: Boolean(item.isSched),
              dateObj: hkNow,
              isHoliday: isHol
            })
          : null;
      } else {
        const periodBusHwSec = (typeof getPeriodHeadwaySecs === 'function')
          ? getPeriodHeadwaySecs(group, item.targetMs || now)
          : ((Number(group.headwayMins) || 12) * 60);
        loadEstimate = LoadFactorEngine.inferBusLoad({
          group,
          stopObj: effStopObj,
          origName: stops[0]?.stopName_e || group.orig_e || '',
          destName: stops[stops.length - 1]?.stopName_e || group.dest_e || '',
          stopIdx: effStopIdx,
          totalStops: stops.length || 12,
          obsHeadwaySec: obsHwSec,
          trailingHeadwaySec: trailingHwSec,
          schedHeadwaySec: periodBusHwSec,
          etaDriftSec: idx === 0 ? busDriftSec : 0,
          corridorStatus: corStatus,
          isSched: Boolean(item.isSched),
          dateObj: hkNow,
          isHoliday: isHol
        });
      }
    }

    return {
      ...item,
      rawTargetMs: item.rawTargetMs || item.targetMs,
      kinematicState,
      speedKmh: kinSeg.cruiseKmh,
      isDegradedGps: Boolean(item.isTempGpsBlind || (item.noGPS === 1 && !item.isSched)),
      gateName: 'RAW_LIVE',
      loadEstimate
    };
  });
}

function formatEtaUI(arr, group = null) {
  const now = Date.now();
  const remSec = Math.round((arr.targetMs - now) / 1000);
  const clk = formatHkArrivalClock(arr.rawTargetMs || arr.targetMs);
  const isAtStop = remSec <= 60 || arr.kinematicState === 'AT_STOP';
  const minsVal = group?.mode === 'MTR' ? Math.round(remSec / 60) : Math.floor(remSec / 60);
  const mainTimeStr = isAtStop
    ? `<span style="color:var(--ios-green);">${t('due')}</span>`
    : (minsVal >= 120
      ? `${Math.floor(minsVal / 60)}<span class="eta-unit-sm">h</span>${String(minsVal % 60).padStart(2, '0')}<span class="eta-unit-sm">m</span>`
      : `${Math.max(1, minsVal)}<span class="eta-unit-sm">${t('minsUnit')}</span>`);
  return { mainTimeStr, clockStr: clk, statePillHtml: '' };
}

function selectExpandedBusEtaIndex(busIdx) {
  triggerHaptic(10);
  detailSelectedEtaBusIdx = busIdx;
  const expScope = document.getElementById(`detail-eta-expanded-${detailExpandedStopIdx}`) || document.getElementById('stop-list-container');
  expScope?.querySelectorAll('.kmb-eta-line').forEach((el, i) => {
    el.classList.toggle('selected-bus-eta', i === busIdx);
  });
  if (detailRouteGroup?.mode === 'FERRY' && detailLastFetchedArrs[busIdx]?.vesselClass) {
    if (!detailRouteGroup.ferryMeta) detailRouteGroup.ferryMeta = {};
    detailRouteGroup.ferryMeta._activeVesselClass = detailLastFetchedArrs[busIdx].vesselClass;
    const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
    const s = stops[detailExpandedStopIdx];
    const fareEl = document.getElementById(`stop-fare-lbl-${detailExpandedStopIdx}`);
    if (s && fareEl) {
      const fVal = getEffectiveStopFare(detailRouteGroup, s, stops[stops.length - 1], isHongKongHolidayFareDay(), detailLastFetchedArrs[busIdx].vesselClass);
      if (fVal > 0) fareEl.innerText = `${t('farePrefix')}${fVal.toFixed(1)}`;
    }
  }
  if (typeof updateDownstreamAlightTimes === 'function' && detailRouteGroup && detailExpandedStopIdx !== -1) {
    updateDownstreamAlightTimes(detailRouteGroup, detailExpandedStopIdx, detailLastFetchedArrs, busIdx);
  }
}

function generateExpandedETAsHtml(arrs, group, stopKey, stopIdx) {
  const stops = getStopsForGroup(group, stopKey);
  const stObjRaw = stops[stopIdx];
  const rawStKey = stObjRaw?.stopKey || getGlobalStopKey(stObjRaw) || stopKey;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  // Auto-hide Home/Work buttons in Detail view once configured (users edit/clear them in Settings)
  const savedHubs = typeof SavedHubsManager !== 'undefined' ? SavedHubsManager.getHubs() : { home: null, work: null };
  const showHomeBtn = !savedHubs.home;
  const showWorkBtn = !savedHubs.work;

  const tempNoticeTxt = isZh
    ? (group?.ferryMeta?.tempNoticeTc || group?.ferryMeta?.sched?.tempNoticeTc || '')
    : (group?.ferryMeta?.tempNoticeEn || group?.ferryMeta?.sched?.tempNoticeEn || '');
  const tempNoticeBannerHtml = tempNoticeTxt
    ? `<div style="background:rgba(255,149,0,0.14); color:var(--ios-orange); border:1px solid rgba(255,149,0,0.32); border-radius:10px; padding:6px 10px; margin:2px 2px 4px 2px; font-size:0.74rem; font-weight:700;">
         🛠️ ${escapeHtml(tempNoticeTxt)}
       </div>`
    : '';

  const isHol = isHongKongHolidayFareDay();
  const secMeta = (!group?.mode || group?.mode === 'BUS') && typeof getSectionalFareMeta === 'function'
    ? getSectionalFareMeta(group.company, group.routeNo)
    : null;
  const showTwoWayBanner = Boolean(
    secMeta?.hasSectionalFare &&
    typeof hasStopTwoWaySectionalFare === 'function' &&
    hasStopTwoWaySectionalFare(group, stops, stopIdx, isHol)
  );
  let strictNoticeRes = null;
  if (!showTwoWayBanner && secMeta?.rebateType === 'strict_boarding_only' && typeof resolveBusLegNetFare === 'function') {
    const sampleAlight = stops[Math.min(stops.length - 1, stopIdx + 2)] || stops[stops.length - 1];
    strictNoticeRes = (stObjRaw && sampleAlight) ? resolveBusLegNetFare(group, stObjRaw, sampleAlight, isHol) : null;
  }
  const activeNoticeEn = showTwoWayBanner ? secMeta.noticeEn : (strictNoticeRes?.noticeEn || '');
  const activeNoticeTc = showTwoWayBanner ? (secMeta.noticeTc || secMeta.noticeEn) : (strictNoticeRes?.noticeTc || strictNoticeRes?.noticeEn || '');
  const sectionalBannerHtml = activeNoticeEn
    ? `<div class="sectional-notice-banner">${(secMeta.rebateType === 'driver_override' || secMeta.rebateType === 'strict_boarding_only') ? '⚠️' : '💳'} ${escapeHtml(isZh ? activeNoticeTc : activeNoticeEn)}</div>`
    : '';

  let roadTrafficBannerHtml = '';
  const hasLiveTdDets = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) && window.__LIVE_TRAFFIC_DETECTORS__.length > 0;
  const activeBusSegs = (window.trafficLayerEnabled !== false && Array.isArray(window.__DETAIL_BUS_SPEED_SEGMENTS__))
    ? window.__DETAIL_BUS_SPEED_SEGMENTS__
    : [];
  if ((!group?.mode || group?.mode === 'BUS') && (hasLiveTdDets || activeBusSegs.length > 0 || (window.trafficLayerEnabled !== false && Array.isArray(stops) && stops.length >= 2 && typeof window.buildStopByStopSegmentTraffic === 'function')) && typeof getDirectionalRoadSummary === 'function') {
    const roadPoly = (typeof window.getCurrentDetailRoadPolyline === 'function' && group?.key)
      ? (window.getCurrentDetailRoadPolyline(group.key) || window.__ROUTE_GEOM_CACHE__?.[group.key] || null)
      : ((window.__ROUTE_GEOM_CACHE__ && group?.key) ? window.__ROUTE_GEOM_CACHE__[group.key] : null);
    const exitIdxRaw = detailTargetStopKey
      ? stops.findIndex(s => s && (s.stopKey === detailTargetStopKey || s.stopId === detailTargetStopKey))
      : -1;
    const exitStopIdx = (exitIdxRaw > stopIdx) ? exitIdxRaw : null;

    // Single Source of Truth: build/reuse the exact same unified stop-by-stop segment array
    // (after TD ground-truth suppression) that drives stop-row pills & horizontal journey bar so they NEVER contradict.
    let unifiedSegs = null;
    if (typeof window.buildStopByStopSegmentTraffic === 'function' && Array.isArray(stops) && stops.length >= 2) {
      unifiedSegs = window.buildStopByStopSegmentTraffic(
        stops,
        roadPoly,
        window.__LIVE_TRAFFIC_DETECTORS__ || [],
        window.__LIVE_TRAFFIC_CAMERAS__ || [],
        activeBusSegs,
        {
          tdSpeedGeoJson: window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null,
          routeNo: group?.routeNo || ''
        }
      );
      if (typeof detailRouteGroup !== 'undefined' && detailRouteGroup?.key === group?.key) {
        window.__DETAIL_STOP_SEGMENTS__ = unifiedSegs;
      }
    } else if (Array.isArray(window.__DETAIL_STOP_SEGMENTS__) && window.__DETAIL_STOP_SEGMENTS__.length === Math.max(0, stops.length - 1)) {
      unifiedSegs = window.__DETAIL_STOP_SEGMENTS__;
    }

    const roadSum = getDirectionalRoadSummary(
      stops,
      stopIdx,
      window.__LIVE_TRAFFIC_DETECTORS__ || [],
      isZh,
      40,
      roadPoly,
      12000,
      window.__LIVE_TRAFFIC_CAMERAS__,
      {
        routeNo: group?.routeNo || '',
        exitStopIdx,
        busSpeedSegments: activeBusSegs,
        unifiedSegments: unifiedSegs,
        tdSpeedGeoJson: window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null
      }
    );

    const _cleanLbl = (s) => {
      const base = (typeof sanitizeBottleneckLabel === 'function')
        ? sanitizeBottleneckLabel(s)
        : String(s || '').replace(/\s*[·•]?\s*\b\d{1,3}\s*(?:°|deg|["″”]|'')\s*$/gi, '').trim();
      return base
        .replace(/\bSouththbound\b/gi, 'Southbound')
        .replace(/\bNorththbound\b/gi, 'Northbound')
        .replace(/\bEastthbound\b/gi, 'Eastbound')
        .replace(/\bWestthbound\b/gi, 'Westbound');
    };

    const _effSegTier = (seg) => {
      if (!seg) return 'NONE';
      if (seg.source === 'BUS_EST' || seg.isSyntheticFallback) {
        const spd = Number(seg.speedKmh);
        return (Number.isFinite(spd) && Math.abs(spd) >= 18) ? 'SMOOTH' : 'MODERATE';
      }
      if (seg.source === 'BUS_API') {
        if (typeof window.capBusApiTierHardcode === 'function') {
          return window.capBusApiTierHardcode(seg.tier, seg.speedKmh, {
            isTerminusApproach: Boolean(seg.isTerminusApproach),
            isScheduledFallback: Boolean(seg.isScheduledFallback),
            isVerifiedMultiBusStall: Boolean(seg.isVerifiedMultiBusStall)
          });
        }
        if (seg.isTerminusApproach) return 'SMOOTH';
        const spd = Number(seg.speedKmh);
        if (seg.isVerifiedMultiBusStall && Number.isFinite(spd) && spd > 0 && Math.abs(spd) < 8) return 'CONGESTED';
        return (Number.isFinite(spd) && Math.abs(spd) >= 18) ? 'SMOOTH' : 'MODERATE';
      }
      return seg.tier || 'SMOOTH';
    };

    // Compact horizontal Board -> Terminus multi-segment journey bar (qualitative Clear/Slow/Jammed/Unmonitored)
    let journeyBarHtml = '';
    const journeyEndIdx = (exitStopIdx !== null && exitStopIdx > stopIdx) ? exitStopIdx : (stops.length - 1);
    const journeySegs = Array.isArray(unifiedSegs)
      ? unifiedSegs.filter((u) => u && Number(u.fromIdx) >= stopIdx && Number(u.toIdx) <= journeyEndIdx)
      : [];
    if (journeySegs.length > 0) {
      const endStopName = stops[journeyEndIdx] ? _cleanLbl(getStopName(stops[journeyEndIdx])) : (isZh ? '總站' : 'Terminus');
      const segButtonsHtml = journeySegs.map((seg) => {
        const isMonitored = seg.source === 'TD' || seg.source === 'BUS_API' || seg.source === 'BUS_EST';
        const effTier = isMonitored ? _effSegTier(seg) : 'NONE';
        const legTone = !isMonitored
          ? 'none'
          : (effTier === 'CONGESTED' ? 'congested' : (effTier === 'MODERATE' ? 'moderate' : 'smooth'));
        const qualLbl = !isMonitored
          ? (isZh ? '未監測' : 'Unmonitored')
          : (effTier === 'CONGESTED'
            ? (isZh ? '擠塞' : 'Jammed')
            : (effTier === 'MODERATE' ? (isZh ? '緩慢' : 'Slow') : (isZh ? '暢通' : 'Clear')));
        const rawFrom = isZh ? (seg.fromNameTc || seg.fromNameEn) : (seg.fromNameEn || seg.fromNameTc);
        const rawTo = isZh ? (seg.toNameTc || seg.toNameEn) : (seg.toNameEn || seg.toNameTc);
        const absLegSpd = Number.isFinite(Number(seg.speedKmh)) && Number(seg.speedKmh) > 0
          ? Math.abs(Math.round(Number(seg.speedKmh)))
          : null;
        const busTipPart = (seg.source === 'BUS_EST' && absLegSpd !== null)
          ? (isZh ? ` · 路況估算 • ${absLegSpd} km/h` : ` · Bus Est. • ${absLegSpd} km/h`)
          : ((seg.source === 'BUS_API' && absLegSpd !== null && !seg.isScheduledFallback)
            ? (isZh ? ` · 巴士推算 • ${absLegSpd} km/h` : ` · Bus API • ${absLegSpd} km/h`)
            : '');
        const legTip = `#${seg.fromSeq} ${_cleanLbl(rawFrom)} → #${seg.toSeq} ${_cleanLbl(rawTo)} · ${qualLbl}${busTipPart}`;
        const flexWeight = Math.max(1, Math.min(40, Math.round(Math.abs(Number(seg.roadDistKm) || 0.35) * 10)));
        return `<button type="button" class="traffic-journey-seg tone-${legTone}" data-from-idx="${seg.fromIdx}" data-seg-tier="${escapeHtml(effTier)}" style="flex:${flexWeight} 1 0;" title="${escapeHtml(legTip)}" aria-label="${escapeHtml(legTip)}" onclick="event.stopPropagation(); if(typeof focusJourneySegmentOnDetailMap==='function'){focusJourneySegmentOnDetailMap(${seg.fromIdx});}else if(typeof openStopSegmentTrafficModal==='function'){openStopSegmentTrafficModal(${seg.fromIdx});}"></button>`;
      }).join('');
      const headLeft = isZh
        ? `全程路況 · 第${stopIdx + 1}站 → 第${journeyEndIdx + 1}站 (${endStopName})`
        : `Board #${stopIdx + 1} → #${journeyEndIdx + 1} ${endStopName}`;
      const headRight = isZh ? '點按分段查看' : 'Tap leg';
      journeyBarHtml = `<div class="traffic-journey-bar-wrap" data-board-idx="${stopIdx}" data-end-idx="${journeyEndIdx}" onclick="event.stopPropagation();"><div class="traffic-journey-bar-head"><span>${escapeHtml(headLeft)}</span><span style="opacity:0.75;">${escapeHtml(headRight)}</span></div><div class="traffic-journey-bar" role="group" aria-label="${escapeHtml(headLeft)}">${segButtonsHtml}</div></div>`;
    }

    if (roadSum && roadSum.headline) {
      const fDet = roadSum.focusDet;
      const oppDet = roadSum.oppDet;
      const segNote = roadSum.betweenLabel || '';
      const breakdownSegs = Array.isArray(roadSum.stopBreakdownSegments)
        ? roadSum.stopBreakdownSegments.filter(s => s && (s.source === 'TD' || s.source === 'BUS_API' || s.source === 'BUS_EST'))
        : [];
      const hasInlineBreakdown = breakdownSegs.length > 0;
      const breakdownId = `traffic-inline-breakdown-${stopIdx}`;
      const barUsesInlineToggle = Boolean(hasInlineBreakdown && (!fDet || !fDet.camKey));

      const openCall = barUsesInlineToggle
        ? `event.stopPropagation(); toggleTrafficInlineBreakdown(${stopIdx}, this);`
        : (fDet
          ? `event.stopPropagation(); openTrafficDecisionModal('${escapeJsAttr(fDet.id)}', '${escapeJsAttr(oppDet?.id || '')}', '${escapeJsAttr(segNote)}', false);`
          : (roadSum.aheadCam?.key
            ? `event.stopPropagation(); openTrafficCameraByKey('${escapeJsAttr(roadSum.aheadCam.key)}', '${escapeJsAttr(roadSum.aheadCam.desc || '')}');`
            : `event.stopPropagation(); toggleTrafficInlineBreakdown(${stopIdx}, this);`));
      const camIcon = (!barUsesInlineToggle && fDet?.camKey)
        ? (isZh ? '📷 詳情/實拍 ›' : '📷 Verdict & Cam ›')
        : ((!barUsesInlineToggle && roadSum.aheadCam?.key) ? (isZh ? '📷 鏡頭 ›' : '📷 Cam ›') : (isZh ? '詳情 ›' : 'Details ›'));
      const toneDot = roadSum.tone === 'jammed' ? '🔴' : (roadSum.tone === 'slow' ? '🟠' : '🟢');
      const cleanHeadline = _cleanLbl(roadSum.headline);
      const cleanDetail = roadSum.detail ? _cleanLbl(roadSum.detail) : '';

      // Keep ONLY 1 clean top corridor status bar + compact Board->Terminus journey bar + optional camera chip + toggleable Details breakdown
      const chipParts = [];
      if (roadSum.aheadCam?.key) {
        const mVal = Math.abs(Number(roadSum.aheadCam.aheadMeters));
        const distTag = Number.isFinite(mVal)
          ? (mVal < 1000 ? `${Math.max(50, Math.round(mVal / 50) * 50)}m` : `${(mVal / 1000).toFixed(1)}km`)
          : '';
        const chipLbl = isZh
          ? `📷 前方路況${distTag ? ` · ${distTag}` : ''}`
          : `📷 Road Ahead${distTag ? ` · ${distTag}` : ''}`;
        chipParts.push(
          `<button type="button" class="traffic-ahead-cam-chip" data-cam-key="${escapeHtml(roadSum.aheadCam.key)}" onclick="event.stopPropagation(); openTrafficCameraByKey('${escapeJsAttr(roadSum.aheadCam.key)}', '${escapeJsAttr(_cleanLbl(roadSum.aheadCam.desc || ''))}');">${escapeHtml(chipLbl)}</button>`
        );
      }
      if (!barUsesInlineToggle && hasInlineBreakdown) {
        chipParts.push(
          `<button type="button" class="traffic-tod-chip" aria-expanded="false" aria-controls="${breakdownId}" onclick="event.stopPropagation(); toggleTrafficInlineBreakdown(${stopIdx}, this);">${isZh ? '分段詳情 ›' : 'Details ›'}</button>`
        );
      }
      if (exitStopIdx !== null && stops[exitStopIdx]) {
        const exitName = getStopName(stops[exitStopIdx]);
        chipParts.push(
          `<span class="traffic-tod-chip" style="border-color:rgba(22,163,74,0.45);color:#16a34a;">${isZh ? `下車範圍：至第${exitStopIdx + 1}站 ${escapeHtml(exitName)}` : `Clamped to Exit #${exitStopIdx + 1}`}</span>`
        );
      }
      const extrasHtml = chipParts.length
        ? `<div class="traffic-card-extras"><div class="traffic-chip-row">${chipParts.join('')}</div></div>`
        : '';

      let inlineBreakdownHtml = '';
      if (hasInlineBreakdown) {
        const breakdownRows = breakdownSegs.slice(0, 10).map((seg) => {
          const effTier = _effSegTier(seg);
          const sDot = effTier === 'CONGESTED' ? '🔴' : (effTier === 'MODERATE' ? '🟠' : '🟢');
          const rawFrom = isZh ? (seg.fromNameTc || seg.fromNameEn) : (seg.fromNameEn || seg.fromNameTc);
          const rawTo = isZh ? (seg.toNameTc || seg.toNameEn) : (seg.toNameEn || seg.toNameTc);
          const pairLbl = (rawFrom && rawTo)
            ? `${seg.fromSeq ? `#${seg.fromSeq} ` : ''}${_cleanLbl(rawFrom)} → ${seg.toSeq ? `#${seg.toSeq} ` : ''}${_cleanLbl(rawTo)}`
            : (_cleanLbl(isZh ? (seg.roadTc || seg.roadEn) : (seg.roadEn || seg.roadTc)) || (isZh ? '前方路段' : 'Forward stretch'));
          const hasSpd = Number.isFinite(Number(seg.speedKmh)) && Number(seg.speedKmh) > 0;
          const absSpd = hasSpd ? Math.abs(Math.round(Number(seg.speedKmh))) : null;
          const spdVal = absSpd !== null ? `${absSpd} km/h` : '-- km/h';
          const srcLabel = seg.source === 'TD'
            ? (seg.roundaboutBottleneck
              ? (isZh ? '運輸署測速 · 迴旋處/交匯處瓶頸 (TD Detector)' : 'TD Detector · Roundabout/Interchange')
              : (isZh ? '運輸署測速 (TD Detector)' : 'TD Detector'))
            : ((seg.source === 'BUS_EST' || seg.isSyntheticFallback)
              ? (absSpd !== null
                ? (isZh ? `路況估算 • ${absSpd} km/h` : `Bus Est. • ${absSpd} km/h`)
                : (isZh ? '道路類型估算 (Bus Est.)' : 'Bus Est.'))
              : (absSpd !== null
                ? (isZh ? `巴士推算 • ${absSpd} km/h` : `Bus API • ${absSpd} km/h`)
                : (isZh ? '巴士實時推算 (Bus API inferred)' : 'Bus API inferred')));
          return `<div class="traffic-inline-item" data-seg-source="${escapeHtml(seg.source)}" data-seg-tier="${escapeHtml(effTier)}" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid rgba(148,163,184,0.18);">
            <span style="min-width:0;flex:1;line-height:1.3;">${sDot} <strong>${escapeHtml(pairLbl)}</strong><br><span class="traffic-inline-src" style="font-size:0.68rem;color:var(--text-sub);">${escapeHtml(srcLabel)}</span></span>
            <span style="white-space:nowrap;font-weight:700;font-variant-numeric:tabular-nums;">${escapeHtml(spdVal)}</span>
          </div>`;
        }).join('');
        const modalBtnHtml = fDet
          ? `<div style="padding-top:6px;text-align:right;"><button type="button" class="traffic-tod-chip" onclick="event.stopPropagation(); openTrafficDecisionModal('${escapeJsAttr(fDet.id)}', '${escapeJsAttr(oppDet?.id || '')}', '${escapeJsAttr(segNote)}', false);">${isZh ? '查看運輸署感應器詳情 ›' : 'Open TD Sensor Verdict ›'}</button></div>`
          : '';
        inlineBreakdownHtml = `<div id="${breakdownId}" class="traffic-inline-breakdown" data-stop-idx="${stopIdx}" style="display:none;margin-top:6px;padding:6px 10px;border-radius:10px;background:rgba(15,23,42,0.05);border:1px solid var(--border-color);font-size:0.75rem;text-align:left;" onclick="event.stopPropagation();">${breakdownRows}${modalBtnHtml}</div>`;
      }

      roadTrafficBannerHtml = `
        <button type="button" class="traffic-road-status-bar tone-${roadSum.tone}"${barUsesInlineToggle ? ` aria-expanded="false" aria-controls="${breakdownId}"` : ''} onclick="${openCall}">
          <span class="traffic-road-main">
            <span class="traffic-road-headline">${toneDot} ${escapeHtml(cleanHeadline)}</span>
            ${cleanDetail ? `<span class="traffic-road-sub">${escapeHtml(cleanDetail)}</span>` : ''}
          </span>
          <span class="traffic-road-cta">${camIcon}</span>
        </button>${journeyBarHtml}${extrasHtml}${inlineBreakdownHtml}`;
    } else if (journeyBarHtml) {
      roadTrafficBannerHtml = journeyBarHtml;
    }
  }

  if (!arrs || !arrs.length) {
    const allowFinal = isCircularRoute(group, stops);
    const isPenDual = (group?.mode === 'MTR' && stops.length >= 3 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId));
    const maxBoard = isPenDual ? stops.length - 3 : stops.length - 2;
    const hubRow = (showHomeBtn || showWorkBtn)
      ? `<div class="stop-action-strip" onclick="event.stopPropagation()">
           ${showHomeBtn ? `<button class="stop-hub-pill" onclick="toggleSavedStopHub('home', ${stopIdx})" title="Set as Home Hub">🏠 ${isZh ? '設為屋企' : 'Set Home'}</button>` : ''}
           ${showWorkBtn ? `<button class="stop-hub-pill" onclick="toggleSavedStopHub('work', ${stopIdx})" title="Set as Work Hub">💼 ${isZh ? '設為公司' : 'Set Work'}</button>` : ''}
         </div>`
      : '';
    if (!allowFinal && stops.length >= 2 && stopIdx > maxBoard) {
      return `<div class="last60-hud-box">${tempNoticeBannerHtml}<div onclick="event.stopPropagation(); reverseCurrentRouteDirection();" style="font-size:0.82rem;color:var(--ios-blue);font-weight:700;text-align:center;padding:8px 6px;cursor:pointer;">${isZh ? '🏁 終點落車站 · 點擊「⇅ 對調」查看反方向班次 ›' : '🏁 Terminus (Alight Only) · Tap ⇅ Swap for opposite direction ›'}</div>${hubRow}</div>`;
    }
    return `<div class="last60-hud-box">${tempNoticeBannerHtml}${sectionalBannerHtml}${roadTrafficBannerHtml}<div style="font-size:0.86rem;color:var(--text-sub);font-weight:600;text-align:center;padding:6px 0;">${t('noScheduled')}</div>${hubRow}</div>`;
  }

  const now = Date.now();

  // EAL 9-Car First Class Warning (Car 4/6 + $1,000 surcharge) & Crowded Tip (Bus/MTR/Ferry)
  const firstLoad = arrs[0]?.loadEstimate || null;
  let loadTipBannerHtml = '';
  if (firstLoad) {
    const tipTxt = isZh ? firstLoad.tipTc : firstLoad.tipEn;
    if (firstLoad.firstClassWarning && tipTxt) {
      loadTipBannerHtml = `<div class="sectional-notice-banner">🚆 ${escapeHtml(tipTxt)}</div>`;
    } else if (tipTxt && firstLoad.pct >= 72) {
      loadTipBannerHtml = `<div class="load-tip-banner">👥 ${escapeHtml(tipTxt)}</div>`;
    }
  }

  const maxRows = group?.mode === 'MTR' ? 4 : 3;
  const activeBusIdx = Math.min(detailSelectedEtaBusIdx, Math.min(maxRows - 1, arrs.length - 1));
  const rowsHtml = arrs.slice(0, maxRows).map((a, bIdx) => {
    const remSec = Math.round((a.targetMs - now) / 1000);
    const isDue = remSec <= 60 || a.kinematicState === 'AT_STOP';
    const minsVal = group?.mode === 'MTR' ? Math.round(remSec / 60) : Math.floor(remSec / 60);
    const minsTxt = isDue
      ? `<span style="color:var(--ios-green);">${t('due')}</span>`
      : (minsVal >= 120
        ? `${Math.floor(minsVal / 60)}<span class="eta-unit-sm">h</span>${String(minsVal % 60).padStart(2, '0')}<span class="eta-unit-sm">m</span>`
        : `${Math.max(1, minsVal)}<span class="eta-unit-sm">${t('minsUnit')}</span>`);
    const clk = formatHkArrivalClock(a.rawTargetMs || a.targetMs);
    const isSelected = (bIdx === activeBusIdx);
    const rowRemark = a.remark || '';
    const loadPillHtml = a.loadEstimate ? formatLoadPillHtml(a.loadEstimate, true) : '';
    return `
      <div class="kmb-eta-line ${isSelected ? 'selected-bus-eta' : ''}" onclick="event.stopPropagation(); selectExpandedBusEtaIndex(${bIdx});">
        <span class="kmb-eta-mins">${minsTxt}</span>
        <span class="eta-clock-tag">${clk || '--:--'}</span>
        <span class="kmb-eta-remark">${loadPillHtml}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(rowRemark)}</span></span>
      </div>`;
  }).join('');

  const stObj = stops[stopIdx];
  const escKey = escapeJsAttr(stObj?.stopKey || rawStKey || '');

  const ferryUpdNote = (group?.mode === 'FERRY' && arrs[0]?.schedUpdated)
    ? `<div style="font-size:0.68rem; color:var(--text-sub); padding:5px 10px 2px 10px; border-top:1px solid var(--border-color); text-align:right;">
         ${isZh ? `時間表更新：${escapeHtml(arrs[0].schedUpdated)}` : `Timetable last updated: ${escapeHtml(arrs[0].schedUpdated)}`}
       </div>`
    : '';

  const sLat = parseFloat(stObj?.latitude) || 0, sLon = parseFloat(stObj?.longitude) || 0;
  const walkUrl = `https://www.google.com/maps/dir/?api=1&destination=${sLat},${sLon}&travelmode=walking`;
  const escStopName = escapeJsAttr(stObj?.stopName_e || '');
  const walkBtnLabel = `↗ ${t('actWalk')}`;

  const actionStrip = `
    <div class="stop-action-strip" onclick="event.stopPropagation()">
      <a href="${walkUrl}" target="_blank" rel="noopener" class="stop-action-pill">${escapeHtml(walkBtnLabel)}</a>
      <button class="stop-action-pill" onclick="jumpToMainStopFromDetail('${escKey}', '${escStopName}')">≡ ${t('actAllRoutes')}</button>
      ${showHomeBtn ? `<button class="stop-hub-pill" onclick="toggleSavedStopHub('home', ${stopIdx})" title="${isZh ? '設此站為屋企捷徑' : 'Set this stop as Home hub'}">🏠</button>` : ''}
      ${showWorkBtn ? `<button class="stop-hub-pill" onclick="toggleSavedStopHub('work', ${stopIdx})" title="${isZh ? '設此站為公司捷徑' : 'Set this stop as Work hub'}">💼</button>` : ''}
    </div>`;

  return `<div class="last60-hud-box">${tempNoticeBannerHtml}${sectionalBannerHtml}${roadTrafficBannerHtml}${loadTipBannerHtml}${rowsHtml}${ferryUpdNote}${actionStrip}</div>`;
}


// ============================================================================
// MAINLINE FERRY LINKER (Uses VERIFIED_MAINLINE_FERRIES from hardcode.js)
// ============================================================================
function isMainlineFerryRoute(g) {
  if (!g || g.mode !== 'FERRY') return true;
  const o = normStationLookupKey(g.orig_e);
  const d = normStationLookupKey(g.dest_e);
  const pair = `${o}_${d}`;
  if (typeof VERIFIED_MAINLINE_FERRIES !== 'undefined' && VERIFIED_MAINLINE_FERRIES[pair]) return true;
  if ((o === 'chimawan' || d === 'chimawan') && (o === 'muiwo' || d === 'muiwo' || o === 'pengchau' || d === 'pengchau' || o === 'cheungchau' || d === 'cheungchau')) {
    return true;
  }
  if ((o === 'shalowan' || d === 'shalowan') && (o === 'tuenmun' || d === 'tuenmun' || o === 'tungchung' || d === 'tungchung' || o === 'taio' || d === 'taio')) {
    return true;
  }
  return false;
}

function mergeVerifiedMainlineSchedules(targetObj = {}) {
  const out = { ...targetObj };
  if (typeof VERIFIED_MAINLINE_FERRIES === 'undefined') return out;
  for (const [pairKey, spec] of Object.entries(VERIFIED_MAINLINE_FERRIES)) {
    out[pairKey] = {
      wk: spec.wk,
      sat: spec.sat,
      hol: spec.hol,
      updated: spec.updated,
      ...(spec.tempNoticeEn ? { tempNoticeEn: spec.tempNoticeEn, tempNoticeTc: spec.tempNoticeTc, reviewAfter: spec.reviewAfter } : {})
    };
  }
  return out;
}

function enrichFerryRouteFromDynamicMeta(g) {
  if (!g) return g;
  if (!Array.isArray(g.activeWindows) || !g.activeWindows.length) {
    g.activeWindows = window.__DERIVE_DEFAULT_ACTIVE_WINDOWS__(g);
  }
  if (g.mode !== 'FERRY') return g;
  const fixedKey = resolveFerryLiveEtaKeyClient(g.orig_e, g.dest_e);
  if (fixedKey) g.liveEtaKey = fixedKey;

  const dirKey = `${normStationLookupKey(g.orig_e)}_${normStationLookupKey(g.dest_e)}`;
  const vSpec = typeof VERIFIED_MAINLINE_FERRIES !== 'undefined' ? VERIFIED_MAINLINE_FERRIES[dirKey] : null;
  if (!g.ferryMeta) g.ferryMeta = {};

  if (vSpec) {
    g.ferryMeta.dur         = vSpec.dur;
    g.ferryMeta.durFast     = vSpec.durFast;
    g.ferryMeta.durOrd      = vSpec.durOrd;
    g.ferryMeta.fareWk      = vSpec.fareWk;
    g.ferryMeta.fareHol     = vSpec.fareHol;
    g.ferryMeta.fareWkOrd   = vSpec.fareWkOrd;
    g.ferryMeta.fareWkFast  = vSpec.fareWkFast;
    g.ferryMeta.fareHolOrd  = vSpec.fareHolOrd;
    g.ferryMeta.fareHolFast = vSpec.fareHolFast;
    if (vSpec.tempNoticeEn) {
      g.ferryMeta.tempNoticeEn = vSpec.tempNoticeEn;
      g.ferryMeta.tempNoticeTc = vSpec.tempNoticeTc;
      g.ferryMeta.reviewAfter  = vSpec.reviewAfter;
    }
    g.ferryMeta.sched = {
      wk: vSpec.wk,
      sat: vSpec.sat,
      hol: vSpec.hol,
      updated: vSpec.updated,
      ...(vSpec.tempNoticeEn ? { tempNoticeEn: vSpec.tempNoticeEn, tempNoticeTc: vSpec.tempNoticeTc, reviewAfter: vSpec.reviewAfter } : {})
    };
  }

  const wkFare = g.ferryMeta.fareWkFast || g.ferryMeta.fareWk || 0;
  const holFare = g.ferryMeta.fareHolFast || g.ferryMeta.fareHol || wkFare;
  if (wkFare > 0) {
    (g.routeIds || []).forEach(rId => {
      (routeStopsCache[rId] || []).forEach(st => {
        st.fare = String(wkFare);
        st.fareHol = String(holFare);
      });
    });
  }
  return g;
}

function filterToMainlineFerriesOnly() {
  groupedRoutes = groupedRoutes.filter(isMainlineFerryRoute).map(enrichFerryRouteFromDynamicMeta);
  const validFerryFullKeys = new Set(groupedRoutes.filter(g => g.mode === 'FERRY').map(g => g.key));
  const validFerryBaseKeys = new Set(groupedRoutes.filter(g => g.mode === 'FERRY').map(g => String(g.key).replace(/_(O|I)$/, '')));
  if (Array.isArray(window.QUICK_FERRY_LINES)) {
    window.QUICK_FERRY_LINES = window.QUICK_FERRY_LINES.filter(f => validFerryBaseKeys.has(f.key));
  }
  if (Array.isArray(window.MULTI_MODAL_HUBS_DIRECTORY)) {
    window.MULTI_MODAL_HUBS_DIRECTORY = window.MULTI_MODAL_HUBS_DIRECTORY.filter(h => h.mode !== 'FERRY' || validFerryFullKeys.has(h.groupKey));
  }
}
