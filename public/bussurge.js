/* Transit HK — Global Bus Surge & Crowding Risk Engine (bussurge.js)
 * Dual Browser Global + CommonJS module.
 * Combines HKO weather correlation, monthly seasonal & structural micro-surges,
 * HK public holidays & eve-of-holiday detection, optional AWE concert surges,
 * inter-stop skip-stop ETA anomalies, and 25-minute decaying rider load reports.
 * Strictly feeds bus crowding badges — NEVER modifies map road-speed telemetry.
 */
(function (root) {
  'use strict';

  let _weatherMod = null;
  if (typeof require === 'function' && typeof root.getWeatherSurgeMultiplier !== 'function') {
    try {
      _weatherMod = require('./weathercoorelation.js');
    } catch (e) {}
  }

  let _monthlyMod = null;
  if (typeof require === 'function' && typeof root.getSeasonalCorridorMultiplier !== 'function') {
    try {
      _monthlyMod = require('./monthly_activity.js');
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

  function _resolveSeasonalMultiplier(params) {
    const fn =
      (typeof root !== 'undefined' && typeof root.getSeasonalCorridorMultiplier === 'function'
        ? root.getSeasonalCorridorMultiplier
        : null) ||
      (_monthlyMod && typeof _monthlyMod.getSeasonalCorridorMultiplier === 'function'
        ? _monthlyMod.getSeasonalCorridorMultiplier
        : null);
    if (fn) return fn(params);
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

  // Safe HKSAR General Holidays fallback (2025–2027) hydrated at runtime via /api/hk-holidays
  const FALLBACK_HK_HOLIDAY_DATES = [
    // 2025
    '2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31',
    '2025-04-04', '2025-04-18', '2025-04-19', '2025-04-21',
    '2025-05-01', '2025-05-05', '2025-05-31', '2025-07-01',
    '2025-10-01', '2025-10-07', '2025-10-29', '2025-12-25', '2025-12-26',
    // 2026
    '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-04-03', '2026-04-04', '2026-04-06', '2026-04-07',
    '2026-05-01', '2026-05-25', '2026-06-19', '2026-07-01',
    '2026-09-26', '2026-10-01', '2026-10-19', '2026-12-25', '2026-12-26',
    // 2027
    '2027-01-01', '2027-02-06', '2027-02-08', '2027-02-09',
    '2027-03-26', '2027-03-27', '2027-03-29', '2027-04-05',
    '2027-05-01', '2027-05-13', '2027-06-09', '2027-07-01',
    '2027-09-16', '2027-10-01', '2027-10-08', '2027-12-25', '2027-12-27'
  ];

  const HK_HOLIDAY_DATE_SET = new Set(FALLBACK_HK_HOLIDAY_DATES);
  const AWE_EVENT_DATES = ['2026-11-28', '2026-11-29'];
  const AWE_EVENT_DATE_SET = new Set(AWE_EVENT_DATES);

  const HK_HOLIDAYS_STORAGE_KEY = 'hk_transit_holidays_cache_v1';
  const HK_HOLIDAYS_CACHE_TTL_MS = 24 * 3600 * 1000;

  const RIDER_LOAD_STORAGE_KEY = 'hk_transit_rider_load_reports_v1';
  const RIDER_LOAD_DECAY_MS = 25 * 60 * 1000;

  const AWE_BUS_ROUTE_RE = /^(A|E)\d+[A-Z]?$/i;

  function _getHkTimeParts(nowMs) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const hkDate = new Date(ms + 8 * 3600 * 1000);
    const year = hkDate.getUTCFullYear();
    const monthIdx = hkDate.getUTCMonth(); // 0..11
    const month = monthIdx + 1;
    const date = hkDate.getUTCDate();
    const dayOfWeek = hkDate.getUTCDay(); // 0=Sun, 6=Sat
    const hours = hkDate.getUTCHours();
    const mins = hkDate.getUTCMinutes();
    const minsOfDay = hours * 60 + mins;
    const hourFloat = hours + mins / 60;
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    return {
      ms,
      year,
      monthIdx,
      month,
      date,
      dayOfWeek,
      hours,
      mins,
      minsOfDay,
      hourFloat,
      dateStr
    };
  }

  function _normalizeYmdList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = String(list[i] || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.push(s);
    }
    return out;
  }

  function setHkPublicHolidays(dates) {
    const valid = _normalizeYmdList(dates);
    if (!valid.length) return HK_HOLIDAY_DATE_SET.size;
    for (let i = 0; i < valid.length; i++) {
      HK_HOLIDAY_DATE_SET.add(valid[i]);
      try {
        if (root && root.__HK_PUBLIC_HOLIDAYS__ && typeof root.__HK_PUBLIC_HOLIDAYS__.add === 'function') {
          root.__HK_PUBLIC_HOLIDAYS__.add(valid[i]);
        }
      } catch (e) {}
    }
    return HK_HOLIDAY_DATE_SET.size;
  }

  function setAweEventDates(dates) {
    const valid = _normalizeYmdList(dates);
    AWE_EVENT_DATE_SET.clear();
    AWE_EVENT_DATES.length = 0;
    for (let i = 0; i < valid.length; i++) {
      if (!AWE_EVENT_DATE_SET.has(valid[i])) {
        AWE_EVENT_DATE_SET.add(valid[i]);
        AWE_EVENT_DATES.push(valid[i]);
      }
    }
    try {
      if (root) root.__AWE_EVENT_DATES__ = AWE_EVENT_DATES.slice();
    } catch (e) {}
    return AWE_EVENT_DATES.length;
  }

  function isHongKongPublicHoliday(nowMs) {
    const hkParts = _getHkTimeParts(nowMs);
    if (HK_HOLIDAY_DATE_SET.has(hkParts.dateStr)) return true;
    try {
      const holSet = root && root.__HK_PUBLIC_HOLIDAYS__;
      if (holSet && typeof holSet.has === 'function' && holSet.has(hkParts.dateStr)) return true;
    } catch (e) {}
    return false;
  }

  function isEveOfPublicHoliday(nowMs) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    return isHongKongPublicHoliday(ms + 24 * 3600 * 1000);
  }

  function isAweEventDate(nowMs) {
    const hkParts = _getHkTimeParts(nowMs);
    if (AWE_EVENT_DATE_SET.has(hkParts.dateStr)) return true;
    try {
      const custom = root && root.__AWE_EVENT_DATES__;
      if (Array.isArray(custom) && custom.includes(hkParts.dateStr)) return true;
      if (custom && typeof custom.has === 'function' && custom.has(hkParts.dateStr)) return true;
    } catch (e) {}
    return false;
  }

  function _resolveStorage(storageOverride) {
    if (storageOverride && typeof storageOverride.getItem === 'function') return storageOverride;
    if (root && root.SafeStorage && typeof root.SafeStorage.getItem === 'function') return root.SafeStorage;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) {}
    return null;
  }

  async function syncHkHolidaysFromWorker(endpoint, opts) {
    const url = typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : '/api/hk-holidays';
    const options = opts && typeof opts === 'object' ? opts : {};
    const storage = _resolveStorage(options.storage);
    const now = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();

    if (!options.force && storage) {
      try {
        const raw = storage.getItem(HK_HOLIDAYS_STORAGE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached && Number(cached.ts || 0) > 0 && (now - Number(cached.ts)) < HK_HOLIDAYS_CACHE_TTL_MS) {
            if (Array.isArray(cached.holidays)) setHkPublicHolidays(cached.holidays);
            if (Array.isArray(cached.aweEventDates)) setAweEventDates(cached.aweEventDates);
            return {
              ok: true,
              fromCache: true,
              holidays: Array.from(HK_HOLIDAY_DATE_SET).sort(),
              aweEventDates: AWE_EVENT_DATES.slice()
            };
          }
        }
      } catch (e) {}
    }

    const fetchFn = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!fetchFn) {
      return {
        ok: false,
        fromCache: false,
        holidays: Array.from(HK_HOLIDAY_DATE_SET).sort(),
        aweEventDates: AWE_EVENT_DATES.slice()
      };
    }

    try {
      const res = await fetchFn(url, { cache: 'no-store' });
      if (!res || !res.ok) {
        return {
          ok: false,
          fromCache: false,
          holidays: Array.from(HK_HOLIDAY_DATE_SET).sort(),
          aweEventDates: AWE_EVENT_DATES.slice()
        };
      }
      const data = await res.json();
      if (data && Array.isArray(data.holidays)) setHkPublicHolidays(data.holidays);
      if (data && Array.isArray(data.aweEventDates)) setAweEventDates(data.aweEventDates);
      if (storage) {
        try {
          storage.setItem(HK_HOLIDAYS_STORAGE_KEY, JSON.stringify({
            ts: now,
            holidays: Array.from(HK_HOLIDAY_DATE_SET).sort(),
            aweEventDates: AWE_EVENT_DATES.slice()
          }));
        } catch (e) {}
      }
      return {
        ok: true,
        fromCache: false,
        source: data?.source || 'WORKER',
        holidays: Array.from(HK_HOLIDAY_DATE_SET).sort(),
        aweEventDates: AWE_EVENT_DATES.slice()
      };
    } catch (e) {
      return {
        ok: false,
        fromCache: false,
        holidays: Array.from(HK_HOLIDAY_DATE_SET).sort(),
        aweEventDates: AWE_EVENT_DATES.slice()
      };
    }
  }

  function _resolveDayFlags(hkParts, routeGroup, etaEntry) {
    const explicitHol =
      (etaEntry && typeof etaEntry.isHoliday === 'boolean') ? etaEntry.isHoliday :
      ((routeGroup && typeof routeGroup.isHoliday === 'boolean') ? routeGroup.isHoliday : null);
    const isHoliday = explicitHol !== null ? explicitHol : isHongKongPublicHoliday(hkParts.ms);
    const isEveOfHoliday =
      (etaEntry && typeof etaEntry.isEveOfHoliday === 'boolean')
        ? etaEntry.isEveOfHoliday
        : isEveOfPublicHoliday(hkParts.ms);

    let dayType = 'weekday';
    if (isHoliday) dayType = 'holiday';
    else if (hkParts.dayOfWeek === 0) dayType = 'sunday';
    else if (hkParts.dayOfWeek === 6) dayType = 'saturday';

    const isWeekendOrHoliday = isHoliday || hkParts.dayOfWeek === 0 || hkParts.dayOfWeek === 6;
    return { dayType, isHoliday, isEveOfHoliday, isWeekendOrHoliday };
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

  function _getAweEventMultiplier(routeNo, corridorText, hkParts, etaEntry) {
    const isAweDate = (etaEntry && typeof etaEntry.isAweEventDate === 'boolean')
      ? etaEntry.isAweEventDate
      : isAweEventDate(hkParts.ms);
    if (!isAweDate) return 1.0;

    const rNo = String(routeNo || '').trim().toUpperCase();
    const isAeRoute = AWE_BUS_ROUTE_RE.test(rNo) || /asiaworld|expo|博覽館/i.test(String(corridorText || ''));
    if (!isAeRoute) return 1.0;

    // Pre-show ingress: 16:00–19:00 (960..1140)
    if (hkParts.minsOfDay >= 960 && hkParts.minsOfDay <= 1140) return 1.65;
    // Post-show egress: 22:30–23:30 (1350..1410)
    if (hkParts.minsOfDay >= 1350 && hkParts.minsOfDay <= 1410) return 1.85;
    return 1.0;
  }

  function _buildCorridorText(routeGroup, etaEntry) {
    const parts = [];
    if (routeGroup && typeof routeGroup === 'object') {
      parts.push(
        routeGroup.routeNo,
        routeGroup.orig_en,
        routeGroup.orig_e,
        routeGroup.orig_tc,
        routeGroup.origName,
        routeGroup.dest_en,
        routeGroup.dest_e,
        routeGroup.dest_tc,
        routeGroup.destName
      );
    }
    if (etaEntry && typeof etaEntry === 'object') {
      parts.push(etaEntry.stopName, etaEntry.stopName_e, etaEntry.name_tc, etaEntry.corridorText);
    }
    return parts.filter(Boolean).join(' ');
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
   * Estimates global weather-, seasonal-, holiday-, event-, and skip-stop-correlated
   * bus crowding risk across all 7 days of the week.
   *
   * @param {Object} routeGroup
   * @param {number} stopIdx
   * @param {Object|null} etaEntry
   * @param {Object|null} hkoWeather
   * @param {number} [nowMs]
   */
  function estimateGlobalBusLoadRisk(routeGroup, stopIdx, etaEntry, hkoWeather, nowMs) {
    const isLeisureRoute = isLeisureBusRoute(routeGroup);
    const hkParts = _getHkTimeParts(nowMs);
    const { dayType, isHoliday, isEveOfHoliday, isWeekendOrHoliday } = _resolveDayFlags(hkParts, routeGroup, etaEntry);
    const weatherMultiplier = _resolveWeatherMultiplier(hkoWeather, hkParts.ms);
    const timeMultiplier = (isLeisureRoute && isWeekendOrHoliday)
      ? _getWeekendLeisureTimeMultiplier(hkParts.minsOfDay)
      : 1.0;

    const routeNo = String(routeGroup?.routeNo || etaEntry?.routeNo || '').trim().toUpperCase();
    const corridorText = _buildCorridorText(routeGroup, etaEntry);
    const seasonalMultiplier = _resolveSeasonalMultiplier({
      month: hkParts.monthIdx,
      dayType,
      hourFloat: hkParts.hourFloat,
      corridorText,
      routeNo,
      isEveOfHoliday,
      isSchoolHoliday: Boolean(etaEntry && etaEntry.isSchoolHoliday)
    });

    const aweMultiplier = _getAweEventMultiplier(routeNo, corridorText, hkParts, etaEntry);

    const hasStructuralSurge = seasonalMultiplier >= 1.35 || aweMultiplier > 1.0;
    const base = (isLeisureRoute || hasStructuralSurge) ? 1.0 : 0.5;
    const score = Number((base * weatherMultiplier * timeMultiplier * seasonalMultiplier * aweMultiplier).toFixed(3));

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
        seasonalMultiplier,
        timeMultiplier,
        aweMultiplier,
        dayType,
        isHoliday,
        isEveOfHoliday,
        isLeisureRoute,
        hasFastSkipStop
      };
    }

    if (score > 2.0 || (isLeisureRoute && score >= 1.5) || (hasStructuralSurge && score >= 1.45)) {
      let tip = '';
      let tipTc = '';
      if (aweMultiplier > 1.0) {
        tip = 'AsiaWorld-Expo event crowd — expect fuller A/E buses.';
        tipTc = '亞博館大型活動人潮 — A/E線班次可能較滿。';
      } else if (isEveOfHoliday && seasonalMultiplier >= 1.7) {
        tip = 'Holiday eve exodus — heavier airport & border demand.';
        tipTc = '假期前夕出行高峰 — 機場及口岸線需求上升。';
      } else if (dayType === 'weekday' && seasonalMultiplier >= 1.5) {
        tip = 'School dismissal window — busy corridor.';
        tipTc = '放學高峰時段 — 沿線候車人數較多。';
      } else if (score > 2.0) {
        tip = 'Busy leisure window — expect fuller buses.';
        tipTc = '假日高峰時段 — 班次可能較滿。';
      }
      return {
        level: 'MODERATE',
        label: 'Standing',
        labelTc: '企位',
        tip,
        tipTc,
        score,
        weatherMultiplier,
        seasonalMultiplier,
        timeMultiplier,
        aweMultiplier,
        dayType,
        isHoliday,
        isEveOfHoliday,
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
      seasonalMultiplier,
      timeMultiplier,
      aweMultiplier,
      dayType,
      isHoliday,
      isEveOfHoliday,
      isLeisureRoute,
      hasFastSkipStop
    };
  }

  // ============================================================================
  // 1-TAP RIDER REPORT OVERRIDE (25-MINUTE DECAY)
  // ============================================================================
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
    FALLBACK_HK_HOLIDAY_DATES,
    AWE_EVENT_DATES,
    HK_HOLIDAYS_STORAGE_KEY,
    RIDER_LOAD_STORAGE_KEY,
    RIDER_LOAD_DECAY_MS,
    isLeisureBusRoute,
    isHongKongPublicHoliday,
    isEveOfPublicHoliday,
    isAweEventDate,
    setHkPublicHolidays,
    setAweEventDates,
    syncHkHolidaysFromWorker,
    estimateGlobalBusLoadRisk,
    makeRiderLoadKey,
    getActiveRiderLoadReport,
    setRiderLoadReport
  };

  if (root) {
    root.AWE_EVENT_DATES = AWE_EVENT_DATES;
    root.isLeisureBusRoute = isLeisureBusRoute;
    root.isHongKongPublicHoliday = isHongKongPublicHoliday;
    root.isEveOfPublicHoliday = isEveOfPublicHoliday;
    root.isAweEventDate = isAweEventDate;
    root.setHkPublicHolidays = setHkPublicHolidays;
    root.setAweEventDates = setAweEventDates;
    root.syncHkHolidaysFromWorker = syncHkHolidaysFromWorker;
    root.estimateGlobalBusLoadRisk = estimateGlobalBusLoadRisk;
    root.getActiveRiderLoadReport = getActiveRiderLoadReport;
    root.setRiderLoadReport = setRiderLoadReport;
    root.BusSurgeEngine = BusSurgeEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      LEISURE_KEYWORDS_EN,
      LEISURE_KEYWORDS_TC,
      FALLBACK_HK_HOLIDAY_DATES,
      AWE_EVENT_DATES,
      HK_HOLIDAYS_STORAGE_KEY,
      RIDER_LOAD_STORAGE_KEY,
      RIDER_LOAD_DECAY_MS,
      isLeisureBusRoute,
      isHongKongPublicHoliday,
      isEveOfPublicHoliday,
      isAweEventDate,
      setHkPublicHolidays,
      setAweEventDates,
      syncHkHolidaysFromWorker,
      estimateGlobalBusLoadRisk,
      makeRiderLoadKey,
      getActiveRiderLoadReport,
      setRiderLoadReport,
      BusSurgeEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
