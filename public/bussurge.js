/* Transit HK — Global Bus Surge & Crowding Risk Engine (bussurge.js)
 * Dual Browser Global + CommonJS module.
 * Combines HKO weather correlation, leisure route/weekend peak curves, inter-stop skip-stop
 * ETA anomalies, and 25-minute decaying rider load reports.
 */
(function (root) {
  'use strict';

  let _weatherMod = null;
  if (typeof require === 'function' && typeof root.getWeatherSurgeMultiplier !== 'function') {
    try {
      _weatherMod = require('./weathercoorelation.js');
    } catch (e) {}
  }

  function _resolveWeatherMultiplier(hkoWeather, nowMs) {
    const fn =
      (typeof root !== 'undefined' && typeof root.getWeatherSurgeMultiplier === 'function'
        ? root.getWeatherSurgeMultiplier
        : null) ||
      (_weatherMod && typeof _weatherMod.getWeatherSurgeMultiplier === 'function'
        ? _weatherMod.getWeatherSurgeMultiplier
        : null);
    if (fn) return fn(hkoWeather, nowMs);
    return 1.0;
  }

  const LEISURE_KEYWORDS_EN = [
    'mui wo',
    'tai o',
    'sai kung',
    'stanley',
    'peak',
    'lantau',
    'airport',
    'tung chung'
  ];

  const LEISURE_KEYWORDS_TC = [
    '梅窩',
    '大澳',
    '西貢',
    '赤柱',
    '山頂',
    '大嶼山',
    '機場',
    '東涌'
  ];

  const RIDER_LOAD_STORAGE_KEY = 'hk_transit_rider_load_reports_v1';
  const RIDER_LOAD_DECAY_MS = 25 * 60 * 1000;

  function _getHkTimeParts(nowMs) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const hkDate = new Date(ms + 8 * 3600 * 1000);
    const year = hkDate.getUTCFullYear();
    const month = hkDate.getUTCMonth() + 1;
    const date = hkDate.getUTCDate();
    const dayOfWeek = hkDate.getUTCDay(); // 0=Sun, 6=Sat
    const hours = hkDate.getUTCHours();
    const mins = hkDate.getUTCMinutes();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    return {
      ms,
      dayOfWeek,
      minsOfDay: hours * 60 + mins,
      dateStr
    };
  }

  function _isWeekendOrHoliday(hkParts, routeGroup, etaEntry) {
    if (etaEntry && typeof etaEntry.isHoliday === 'boolean' && etaEntry.isHoliday) return true;
    if (routeGroup && typeof routeGroup.isHoliday === 'boolean' && routeGroup.isHoliday) return true;
    if (hkParts.dayOfWeek === 0 || hkParts.dayOfWeek === 6) return true;
    try {
      const holSet = root && root.__HK_PUBLIC_HOLIDAYS__;
      if (holSet && typeof holSet.has === 'function' && holSet.has(hkParts.dateStr)) return true;
    } catch (e) {}
    return false;
  }

  function isLeisureBusRoute(routeGroup) {
    if (!routeGroup || typeof routeGroup !== 'object') return false;
    const textEn = [
      routeGroup.dest_en,
      routeGroup.dest_e,
      routeGroup.orig_en,
      routeGroup.orig_e,
      routeGroup.destName,
      routeGroup.origName
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    for (let i = 0; i < LEISURE_KEYWORDS_EN.length; i++) {
      if (textEn.includes(LEISURE_KEYWORDS_EN[i])) return true;
    }

    const textTc = [
      routeGroup.dest_tc,
      routeGroup.orig_tc,
      routeGroup.dest_sc,
      routeGroup.orig_sc
    ]
      .filter(Boolean)
      .join(' ');

    for (let i = 0; i < LEISURE_KEYWORDS_TC.length; i++) {
      if (textTc.includes(LEISURE_KEYWORDS_TC[i])) return true;
    }

    return false;
  }

  function _getWeekendLeisureTimeMultiplier(minsOfDay) {
    // 08:30–11:30 (510..690) -> 1.6
    if (minsOfDay >= 510 && minsOfDay <= 690) return 1.6;
    // 13:30–16:00 (810..960) -> 1.8
    if (minsOfDay >= 810 && minsOfDay <= 960) return 1.8;
    // 16:30–19:30 (990..1170) -> 1.9
    if (minsOfDay >= 990 && minsOfDay <= 1170) return 1.9;
    return 1.0;
  }

  function _extractEtaSpacingSec(etaEntry) {
    if (!etaEntry || typeof etaEntry !== 'object') return null;
    const candidates = [
      etaEntry.etaSpacing,
      etaEntry.etaSpacingSec,
      etaEntry.interStopSec,
      etaEntry.interStopSpacingSec
    ];
    for (let i = 0; i < candidates.length; i++) {
      const raw = candidates[i];
      if (raw === null || raw === undefined || raw === '') continue;
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  /**
   * Estimates global weather-correlated bus crowding & full-bus skip-stop risk.
   *
   * @param {Object} routeGroup
   * @param {number} stopIdx
   * @param {Object|null} etaEntry
   * @param {Object|null} hkoWeather
   * @param {number} [nowMs]
   * @returns {{
   *   level: 'HIGH_LOAD' | 'MODERATE' | 'NORMAL',
   *   label: string,
   *   labelTc: string,
   *   tip: string,
   *   tipTc: string,
   *   score: number,
   *   weatherMultiplier: number,
   *   timeMultiplier: number,
   *   isLeisureRoute: boolean,
   *   hasFastSkipStop: boolean
   * }}
   */
  function estimateGlobalBusLoadRisk(routeGroup, stopIdx, etaEntry, hkoWeather, nowMs) {
    const isLeisureRoute = isLeisureBusRoute(routeGroup);
    const hkParts = _getHkTimeParts(nowMs);
    const isWeekendHol = _isWeekendOrHoliday(hkParts, routeGroup, etaEntry);
    const weatherMultiplier = _resolveWeatherMultiplier(hkoWeather, hkParts.ms);
    const timeMultiplier = (isLeisureRoute && isWeekendHol)
      ? _getWeekendLeisureTimeMultiplier(hkParts.minsOfDay)
      : 1.0;

    const leisureBase = isLeisureRoute ? 1.0 : 0.5;
    const score = Number((leisureBase * weatherMultiplier * timeMultiplier).toFixed(3));

    const etaSpacing = _extractEtaSpacingSec(etaEntry);
    const hasFastSkipStop = etaSpacing !== null && etaSpacing >= 0 && etaSpacing < 60;

    if (score > 2.0 && hasFastSkipStop) {
      return {
        level: 'HIGH_LOAD',
        label: '⚠️ Likely Full',
        labelTc: '⚠️ 易滿座',
        tip: 'Consider boarding upstream.',
        tipTc: '建議改於上游總站上車。',
        score,
        weatherMultiplier,
        timeMultiplier,
        isLeisureRoute,
        hasFastSkipStop
      };
    }

    if (score > 2.0 || (isLeisureRoute && score >= 1.5)) {
      return {
        level: 'MODERATE',
        label: 'Standing',
        labelTc: '企位',
        tip: score > 2.0 ? 'Busy leisure window — expect fuller buses.' : '',
        tipTc: score > 2.0 ? '假日高峰時段 — 班次可能較滿。' : '',
        score,
        weatherMultiplier,
        timeMultiplier,
        isLeisureRoute,
        hasFastSkipStop
      };
    }

    return {
      level: 'NORMAL',
      label: 'Seats',
      labelTc: '有位',
      tip: '',
      tipTc: '',
      score,
      weatherMultiplier,
      timeMultiplier,
      isLeisureRoute,
      hasFastSkipStop
    };
  }

  // ============================================================================
  // 1-TAP RIDER REPORT OVERRIDE (25-MINUTE DECAY)
  // ============================================================================
  function _resolveStorage(storageOverride) {
    if (storageOverride && typeof storageOverride.getItem === 'function') return storageOverride;
    if (root && root.SafeStorage && typeof root.SafeStorage.getItem === 'function') return root.SafeStorage;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) {}
    return null;
  }

  function makeRiderLoadKey(groupKey, stopKey) {
    const gk = String(groupKey || '').trim();
    const sk = String(stopKey || '').trim();
    if (!gk) return '';
    return sk ? `${gk}|${sk}` : gk;
  }

  function _readRiderReportMap(storage) {
    if (!storage) return {};
    try {
      const raw = storage.getItem(RIDER_LOAD_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function _writeRiderReportMap(storage, mapObj) {
    if (!storage) return;
    try {
      storage.setItem(RIDER_LOAD_STORAGE_KEY, JSON.stringify(mapObj));
    } catch (e) {}
  }

  function getActiveRiderLoadReport(groupKey, stopKey, nowMs, storageOverride) {
    const key = makeRiderLoadKey(groupKey, stopKey);
    if (!key) return null;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const storage = _resolveStorage(storageOverride);
    const map = _readRiderReportMap(storage);
    const entry = map[key];
    if (!entry || !entry.status) return null;
    const expiresAt = Number(entry.expiresAt || (Number(entry.reportedAt || 0) + RIDER_LOAD_DECAY_MS));
    if (!Number.isFinite(expiresAt) || now >= expiresAt) {
      // Prune expired entry lazily
      delete map[key];
      _writeRiderReportMap(storage, map);
      return null;
    }
    return {
      status: String(entry.status).toUpperCase(),
      reportedAt: Number(entry.reportedAt || now),
      expiresAt,
      remainingMins: Math.max(1, Math.ceil((expiresAt - now) / 60000))
    };
  }

  function setRiderLoadReport(groupKey, stopKey, status, nowMs, storageOverride) {
    const key = makeRiderLoadKey(groupKey, stopKey);
    if (!key) return null;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const storage = _resolveStorage(storageOverride);
    const map = _readRiderReportMap(storage);

    // Prune any expired entries first
    for (const k of Object.keys(map)) {
      const exp = Number(map[k]?.expiresAt || 0);
      if (!exp || now >= exp) delete map[k];
    }

    if (!status) {
      delete map[key];
      _writeRiderReportMap(storage, map);
      return null;
    }

    const normStatus = String(status).toUpperCase() === 'FULL' ? 'FULL' : 'SEATS';
    const record = {
      status: normStatus,
      reportedAt: now,
      expiresAt: now + RIDER_LOAD_DECAY_MS
    };
    map[key] = record;
    _writeRiderReportMap(storage, map);
    return {
      ...record,
      remainingMins: Math.ceil(RIDER_LOAD_DECAY_MS / 60000)
    };
  }

  const BusSurgeEngine = {
    LEISURE_KEYWORDS_EN,
    LEISURE_KEYWORDS_TC,
    RIDER_LOAD_STORAGE_KEY,
    RIDER_LOAD_DECAY_MS,
    isLeisureBusRoute,
    estimateGlobalBusLoadRisk,
    makeRiderLoadKey,
    getActiveRiderLoadReport,
    setRiderLoadReport
  };

  if (root) {
    root.isLeisureBusRoute = isLeisureBusRoute;
    root.estimateGlobalBusLoadRisk = estimateGlobalBusLoadRisk;
    root.getActiveRiderLoadReport = getActiveRiderLoadReport;
    root.setRiderLoadReport = setRiderLoadReport;
    root.BusSurgeEngine = BusSurgeEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      LEISURE_KEYWORDS_EN,
      LEISURE_KEYWORDS_TC,
      RIDER_LOAD_STORAGE_KEY,
      RIDER_LOAD_DECAY_MS,
      isLeisureBusRoute,
      estimateGlobalBusLoadRisk,
      makeRiderLoadKey,
      getActiveRiderLoadReport,
      setRiderLoadReport,
      BusSurgeEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
