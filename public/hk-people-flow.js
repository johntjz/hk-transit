/* Transit HK — Standalone Hong Kong People Flow Simulator (hk-people-flow.js)
 * Dual Browser Global + CommonJS module.
 *
 * 100% mode-agnostic citywide population movement engine (zero DOM/UI code, zero bus-card formatting).
 * Consumes weathercoorelation.js, monthly_activity.js, and cached /api/hk-holidays data.
 * Projects normalized directional movement pressures (0.0–2.0) across Hong Kong's 52-week annual cycle,
 * and translates any Bus, MTR, or Ferry corridor onto the shared directional vector dictionary.
 */
(function (root) {
  'use strict';

  let _weatherMod = null;
  if (typeof require === 'function' && typeof root.getWeatherFlowModifiers !== 'function') {
    try {
      _weatherMod = require('./weathercoorelation.js');
    } catch (e) {}
  }

  let _monthlyMod = null;
  if (typeof require === 'function' && typeof root.MONTHLY_ACTIVITY_PROFILES === 'undefined') {
    try {
      _monthlyMod = require('./monthly_activity.js');
    } catch (e) {}
  }

  // Gazetted 2025, 2026 & 2027 HKSAR General Holidays (instant zero-latency fallback)
  const GAZETTED_HK_HOLIDAYS_2025 = [
    '2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31',
    '2025-04-04', '2025-04-18', '2025-04-19', '2025-04-21',
    '2025-05-01', '2025-05-05', '2025-05-31', '2025-07-01',
    '2025-10-01', '2025-10-07', '2025-10-29', '2025-12-25', '2025-12-26'
  ];

  const GAZETTED_HK_HOLIDAYS_2026 = [
    '2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-04-03', '2026-04-04', '2026-04-06', '2026-04-07',
    '2026-05-01', '2026-05-25', '2026-06-19', '2026-07-01',
    '2026-09-26', '2026-10-01', '2026-10-19', '2026-12-25', '2026-12-26'
  ];

  const GAZETTED_HK_HOLIDAYS_2027 = [
    '2027-01-01', '2027-02-06', '2027-02-08', '2027-02-09',
    '2027-03-26', '2027-03-27', '2027-03-29', '2027-04-05',
    '2027-05-01', '2027-05-13', '2027-06-09', '2027-07-01',
    '2027-09-16', '2027-10-01', '2027-10-08', '2027-12-25', '2027-12-27'
  ];

  const FALLBACK_HK_HOLIDAY_DATES = [
    ...GAZETTED_HK_HOLIDAYS_2025,
    ...GAZETTED_HK_HOLIDAYS_2026,
    ...GAZETTED_HK_HOLIDAYS_2027
  ];

  // Official 2026/27 EDB Local School Breaks
  const HK_SCHOOL_HOLIDAY_RANGES = Object.freeze([
    Object.freeze({ name: 'Summer 2026', start: '2026-07-09', end: '2026-08-31' }),
    Object.freeze({ name: 'Christmas & New Year 2026/27', start: '2026-12-24', end: '2027-01-02' }),
    Object.freeze({ name: 'Lunar New Year 2027', start: '2027-02-04', end: '2027-02-13' }),
    Object.freeze({ name: 'Easter 2027', start: '2027-03-24', end: '2027-03-31' }),
    Object.freeze({ name: 'Summer 2027', start: '2027-07-09', end: '2027-08-31' })
  ]);

  // Ching Ming & Chung Yeung cemetery peak anchors (gazetted dates ± weekend proximity)
  const CEMETERY_FESTIVAL_ANCHORS = [
    '2026-04-04', '2026-04-05', '2026-04-06', '2026-10-18', '2026-10-19',
    '2027-04-04', '2027-04-05', '2027-10-08', '2027-10-09', '2027-10-10'
  ];

  const HK_HOLIDAY_DATE_SET = new Set(FALLBACK_HK_HOLIDAY_DATES);
  const AWE_EVENT_DATES = ['2026-11-28', '2026-11-29'];
  const AWE_EVENT_DATE_SET = new Set(AWE_EVENT_DATES);

  const HK_HOLIDAYS_STORAGE_KEY = 'hk_transit_holidays_cache_v1';
  const HK_HOLIDAYS_CACHE_TTL_MS = 24 * 3600 * 1000;

  const FLOW_VECTOR_KEYS = Object.freeze([
    'CBD_INBOUND',
    'CBD_OUTBOUND',
    'SCHOOL_ZONE',
    'TO_TRAIL_EXPOSED',
    'FROM_TRAIL_EXPOSED',
    'TO_BEACH_WATER',
    'FROM_BEACH_WATER',
    'TO_BORDER_NORTH',
    'FROM_BORDER_NORTH',
    'TO_AIRPORT_AWE',
    'FROM_AIRPORT_AWE',
    'ISLAND_OUTBOUND',
    'ISLAND_INBOUND',
    'SUNDAY_URBAN_HUB',
    'CEMETERY_FESTIVAL'
  ]);

  function _clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function _round3(val) {
    return Number(_clamp(val, 0.0, 2.0).toFixed(3));
  }

  function _bell(hourFloat, centerHour, halfWidthHours) {
    const z = (hourFloat - centerHour) / Math.max(0.1, halfWidthHours);
    return Math.exp(-0.5 * z * z);
  }

  function _getIsoWeek(year, monthIdx, day) {
    const d = new Date(Date.UTC(year, monthIdx, day));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return _clamp(weekNo, 1, 52);
  }

  function _getHkTimeParts(nowMs) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const hkDate = new Date(ms + 8 * 3600 * 1000);
    const year = hkDate.getUTCFullYear();
    const month = hkDate.getUTCMonth(); // 0..11
    const month1 = month + 1;
    const date = hkDate.getUTCDate();
    const dayOfWeek = hkDate.getUTCDay(); // 0=Sun .. 6=Sat
    const hours = hkDate.getUTCHours();
    const mins = hkDate.getUTCMinutes();
    const minsOfDay = hours * 60 + mins;
    const hourFloat = Number((hours + mins / 60).toFixed(4));
    const dateStr = `${year}-${String(month1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    const isoWeek = _getIsoWeek(year, month, date);
    return {
      ms,
      year,
      month,
      month1,
      date,
      dayOfWeek,
      hours,
      mins,
      minsOfDay,
      hourFloat,
      dateStr,
      isoWeek
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

  function isSchoolHolidayDate(dateStr) {
    const s = String(dateStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    for (let i = 0; i < HK_SCHOOL_HOLIDAY_RANGES.length; i++) {
      const r = HK_SCHOOL_HOLIDAY_RANGES[i];
      if (s >= r.start && s <= r.end) return true;
    }
    const md = s.slice(5);
    if (md >= '07-09' && md <= '08-31') return true;
    return false;
  }

  function isHongKongSchoolDay(nowMs, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.isSchoolHoliday === true) return false;
    const hkParts = _getHkTimeParts(nowMs);
    if (hkParts.dayOfWeek === 0 || hkParts.dayOfWeek === 6) return false;
    const isHol = typeof o.isHoliday === 'boolean' ? o.isHoliday : isHongKongPublicHoliday(hkParts.ms);
    if (isHol) return false;
    if (isSchoolHolidayDate(hkParts.dateStr)) return false;
    return true;
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

  function _resolveWeatherModifiers(hkoWeather, nowMs) {
    const fn =
      (typeof root !== 'undefined' && typeof root.getWeatherFlowModifiers === 'function'
        ? root.getWeatherFlowModifiers
        : null) ||
      (_weatherMod && typeof _weatherMod.getWeatherFlowModifiers === 'function'
        ? _weatherMod.getWeatherFlowModifiers
        : null);
    if (fn) return fn(hkoWeather, nowMs);

    const legacyFn =
      (typeof root !== 'undefined' && typeof root.getWeatherSurgeMultiplier === 'function'
        ? root.getWeatherSurgeMultiplier
        : null) ||
      (_weatherMod && typeof _weatherMod.getWeatherSurgeMultiplier === 'function'
        ? _weatherMod.getWeatherSurgeMultiplier
        : null);
    const outdoorMod = legacyFn ? legacyFn(hkoWeather, nowMs) : 1.0;
    return {
      outdoorMod,
      urbanIndoorMod: outdoorMod <= 0.35 ? 1.2 : 1.0,
      preTyphoonEvacMod: 1.0
    };
  }

  function _resolveMonthlyProfile(monthIdx) {
    const profiles =
      (typeof root !== 'undefined' && root.MONTHLY_ACTIVITY_PROFILES) ||
      (_monthlyMod && _monthlyMod.MONTHLY_ACTIVITY_PROFILES) ||
      null;
    if (profiles && profiles[monthIdx]) return profiles[monthIdx];
    const isCool = monthIdx >= 9 || monthIdx <= 3;
    return {
      month: monthIdx,
      trailWeight: isCool ? 1.5 : 0.7,
      beachWeight: isCool ? 0.45 : 1.55,
      earlyHikeBoost: 1.25
    };
  }

  function _get52WeekSeasonalFactor(isoWeek, monthIdx) {
    const prof = _resolveMonthlyProfile(monthIdx);
    // Fine-grained ISO week multipliers capturing HK annual peaks:
    // W44–W49 (Nov–early Dec): silvergrass & autumn trail races peak
    // W22–W35 (Jun–Aug): summer beach & waterfall peak, exposed ridge trough
    // W05–W08 (LNY), W13–W15 (Ching Ming/Easter), W40–W41 (Golden Week): holiday border/island waves
    let trailSeason = (Number(prof.trailWeight) || 1.0) / 1.45;
    let beachSeason = (Number(prof.beachWeight) || 1.0) / 1.45;
    let borderHolidayWave = 1.0;
    let islandFestivalBoost = 1.0;

    if (isoWeek >= 44 && isoWeek <= 49) trailSeason = Math.max(trailSeason, 1.18);
    if (isoWeek >= 22 && isoWeek <= 35) {
      beachSeason = Math.max(beachSeason, 1.15);
      trailSeason = Math.min(trailSeason, 0.45);
    }
    if ((isoWeek >= 5 && isoWeek <= 8) || (isoWeek >= 13 && isoWeek <= 15) || isoWeek === 18 || isoWeek === 40 || isoWeek >= 51) {
      borderHolidayWave = 1.18;
    }
    if (isoWeek >= 19 && isoWeek <= 21) {
      // Cheung Chau Bun Festival / Buddha's Birthday
      islandFestivalBoost = 1.18;
    }
    return { trailSeason, beachSeason, borderHolidayWave, islandFestivalBoost };
  }

  function _isCemeteryFestivalWindow(hkParts, isWeekendOrHoliday) {
    if (!isWeekendOrHoliday) return false;
    if (CEMETERY_FESTIVAL_ANCHORS.includes(hkParts.dateStr)) return true;
    // Ching Ming window (late Mar – mid Apr, ISO W13–W15) & Chung Yeung window (Oct W41–W43)
    const md = hkParts.dateStr.slice(5);
    if ((md >= '03-28' && md <= '04-12') || (md >= '10-05' && md <= '10-25')) {
      return hkParts.isoWeek === 14 || hkParts.isoWeek === 15 || hkParts.isoWeek === 41 || hkParts.isoWeek === 42 || hkParts.isoWeek === 43;
    }
    return false;
  }

  /**
   * Simulates citywide Hong Kong population movement pressures (0.0–2.0) across all
   * 15 directional flow vectors for any timestamp and HKO weather snapshot.
   *
   * @param {number} [nowMs]
   * @param {Object|null} [hkoWeather]
   * @param {Object} [opts]
   * @returns {{
   *   calendar: { isoWeek: number, month: number, dayType: string, isEveOfHoliday: boolean, isSchoolDay: boolean, hourFloat: number, dateStr: string, isHoliday: boolean, isAweEventDate: boolean },
   *   weather: { outdoorMod: number, urbanIndoorMod: number, preTyphoonEvacMod: number },
   *   vectors: Record<string, number>
   * }}
   */
  function simulateCityPeopleFlow(nowMs, hkoWeather, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const hk = _getHkTimeParts(nowMs);

    const isHoliday = typeof o.isHoliday === 'boolean' ? o.isHoliday : isHongKongPublicHoliday(hk.ms);
    const isEveOfHoliday = typeof o.isEveOfHoliday === 'boolean' ? o.isEveOfHoliday : isEveOfPublicHoliday(hk.ms);
    const isAweDate = typeof o.isAweEventDate === 'boolean' ? o.isAweEventDate : isAweEventDate(hk.ms);

    let dayType = 'weekday';
    if (isHoliday) dayType = 'holiday';
    else if (hk.dayOfWeek === 0) dayType = 'sunday';
    else if (hk.dayOfWeek === 6) dayType = 'saturday';

    const isWeekendOrHoliday = dayType !== 'weekday';
    const isFriday = dayType === 'weekday' && hk.dayOfWeek === 5;
    const isSchoolDay = isHongKongSchoolDay(hk.ms, { isHoliday, isSchoolHoliday: o.isSchoolHoliday });

    const weather = _resolveWeatherModifiers(hkoWeather, hk.ms);
    const season52 = _get52WeekSeasonalFactor(hk.isoWeek, hk.month);
    const h = hk.hourFloat;
    const isCoolMonth = hk.month >= 9 || hk.month <= 3; // Oct–Apr
    const isBeachMonth = hk.month >= 4 && hk.month <= 9; // May–Oct

    // 1. CBD_INBOUND & CBD_OUTBOUND (Mon–Fri AM/PM peaks, Fri evening extension, pre-T8 evacuation)
    let cbdIn = 0.25;
    let cbdOut = 0.25;
    if (dayType === 'weekday') {
      const amCrush = _bell(h, 8.35, 0.85);
      const lunchWave = _bell(h, 13.0, 0.9);
      const pmCrush = _bell(h, 18.25, 1.05);
      const friExt = isFriday ? _bell(h, 20.5, 1.1) : 0;
      cbdIn = (0.30 + amCrush * 1.35 + lunchWave * 0.45 + pmCrush * 0.35 + friExt * 0.35) * weather.urbanIndoorMod;
      cbdOut = (0.30 + amCrush * 0.35 + lunchWave * 0.40 + pmCrush * 1.40 + friExt * 0.78) * weather.urbanIndoorMod * weather.preTyphoonEvacMod;
    } else if (dayType === 'saturday') {
      const midRetail = _bell(h, 14.5, 2.3);
      const eveReturn = _bell(h, 19.5, 1.6);
      cbdIn = (0.28 + midRetail * 0.85) * weather.urbanIndoorMod;
      cbdOut = (0.28 + midRetail * 0.45 + eveReturn * 0.88) * weather.urbanIndoorMod * weather.preTyphoonEvacMod;
    } else {
      // Sunday / Public Holiday
      const midLeisure = _bell(h, 14.25, 2.2);
      const eveReturn = _bell(h, 18.75, 1.6);
      cbdIn = (0.24 + midLeisure * 0.78) * weather.urbanIndoorMod;
      cbdOut = (0.24 + midLeisure * 0.40 + eveReturn * 0.82) * weather.urbanIndoorMod * weather.preTyphoonEvacMod;
    }

    // 2. SCHOOL_ZONE (Mon–Fri 07:15–08:30, 14:30–16:15; strictly 0.0 on weekends/holidays/school breaks)
    let schoolZone = 0.0;
    if (isSchoolDay) {
      if (h >= 7.25 && h <= 8.5) {
        schoolZone = 1.62 * weather.urbanIndoorMod;
      } else if (h >= 14.5 && h <= 16.25) {
        schoolZone = 1.65 * weather.urbanIndoorMod;
      } else if (h >= 6.75 && h < 7.25) {
        schoolZone = 0.85 * weather.urbanIndoorMod;
      } else if (h > 16.25 && h <= 17.0) {
        schoolZone = 0.75 * weather.urbanIndoorMod;
      } else {
        schoolZone = 0.15;
      }
    }

    // 3. TO_TRAIL_EXPOSED & FROM_TRAIL_EXPOSED (Oct–Apr peak; summer dawn-only shift)
    let toTrail = 0.18;
    let fromTrail = 0.18;
    if (isWeekendOrHoliday) {
      if (isCoolMonth) {
        // Morning climb (08:30–11:30), afternoon sunset rush (13:30–16:15), evening descent (16:30–19:30)
        const amClimb = (h >= 8.5 && h <= 11.5) ? 1.32 : (_bell(h, 10.0, 1.3) * 1.15);
        const pmSunsetClimb = (h >= 13.5 && h <= 16.25) ? 1.48 : (_bell(h, 15.0, 1.2) * 1.25);
        const pmDescent = (h >= 16.5 && h <= 19.5) ? 1.56 : (_bell(h, 17.75, 1.25) * 1.35);
        const earlyDescent = (h >= 14.5 && h < 16.5) ? 0.95 : 0;
        toTrail = Math.max(0.25, amClimb, pmSunsetClimb) * season52.trailSeason * weather.outdoorMod;
        fromTrail = Math.max(0.25, earlyDescent, pmDescent) * season52.trailSeason * weather.outdoorMod;
      } else {
        // Hot summer (May–Sep): dawn-only shift (05:30–08:30); exposed midday/afternoon dampens hard
        if (h >= 5.5 && h <= 8.5) {
          toTrail = 1.25 * weather.outdoorMod;
          fromTrail = 0.40 * weather.outdoorMod;
        } else if (h >= 9.0 && h <= 12.0) {
          toTrail = 0.45 * weather.outdoorMod;
          fromTrail = 1.05 * weather.outdoorMod;
        } else if (h > 12.0 && h <= 18.0) {
          toTrail = 0.42 * season52.trailSeason * weather.outdoorMod;
          fromTrail = 0.45 * season52.trailSeason * weather.outdoorMod;
        } else {
          toTrail = 0.25 * weather.outdoorMod;
          fromTrail = 0.35 * weather.outdoorMod;
        }
      }
    } else {
      // Quiet weekday trails
      toTrail = (isCoolMonth ? 0.35 : 0.20) * weather.outdoorMod;
      fromTrail = (isCoolMonth ? 0.35 : 0.20) * weather.outdoorMod;
    }

    // 4. TO_BEACH_WATER & FROM_BEACH_WATER (May–Oct peak, dampened in winter)
    // Beach visitors tolerate warm summer days (26–31°C) well unless raining/typhoon or extreme heat >31°C
    const beachWeatherMod = weather.outdoorMod <= 0.35
      ? 0.3
      : (isBeachMonth && weather.outdoorMod === 1.0 ? 1.25 : weather.outdoorMod);
    let toBeach = 0.15;
    let fromBeach = 0.15;
    if (isWeekendOrHoliday) {
      if (isBeachMonth) {
        const amBeach = (h >= 9.0 && h <= 15.0) ? 1.38 : (_bell(h, 12.0, 2.0) * 1.15);
        const pmBeachRet = (h >= 15.5 && h <= 19.5) ? 1.48 : (_bell(h, 17.5, 1.4) * 1.25);
        toBeach = Math.max(0.25, amBeach) * season52.beachSeason * beachWeatherMod;
        fromBeach = Math.max(0.25, pmBeachRet) * season52.beachSeason * beachWeatherMod;
      } else {
        // Winter dampening (Nov–Apr)
        toBeach = 0.35 * season52.beachSeason * weather.outdoorMod;
        fromBeach = 0.35 * season52.beachSeason * weather.outdoorMod;
      }
    } else {
      toBeach = (isBeachMonth ? 0.38 : 0.15) * beachWeatherMod;
      fromBeach = (isBeachMonth ? 0.38 : 0.15) * beachWeatherMod;
    }

    // 5. TO_BORDER_NORTH & FROM_BORDER_NORTH (Fri PM & Sat AM northbound; Sun PM & holiday-end southbound)
    let toBorder = 0.35;
    let fromBorder = 0.35;
    const isHolidayEnd = isHoliday && !isEveOfHoliday;
    if (isEveOfHoliday && h >= 17.0 && h <= 22.0) {
      toBorder = 1.82 * season52.borderHolidayWave;
      fromBorder = 0.55;
    } else if (isFriday && h >= 17.0 && h <= 21.5) {
      toBorder = 1.65 * season52.borderHolidayWave;
      fromBorder = 0.50;
    } else if (dayType === 'saturday') {
      if (h >= 8.0 && h <= 12.5) toBorder = 1.75 * season52.borderHolidayWave;
      else if (h > 12.5 && h <= 16.0) toBorder = 1.05;
      else toBorder = 0.45;
      fromBorder = (h >= 18.0 && h <= 21.5) ? 1.20 : 0.45;
    } else if (dayType === 'sunday' || isHolidayEnd) {
      toBorder = (h >= 8.5 && h <= 12.0) ? (isHoliday ? 1.40 : 0.95) : 0.40;
      if (h >= 15.5 && h <= 21.5) fromBorder = 1.85 * season52.borderHolidayWave;
      else if (h > 21.5 && h <= 23.0) fromBorder = 1.15;
      else fromBorder = 0.45;
    } else if (isHoliday) {
      toBorder = (h >= 8.0 && h <= 12.5) ? 1.55 * season52.borderHolidayWave : 0.55;
      fromBorder = (h >= 17.0 && h <= 21.5) ? 1.35 : 0.45;
    }
    if (weather.outdoorMod <= 0.35 && weather.urbanIndoorMod < 0.7) {
      // Active T8+ suspension suppresses border traffic
      toBorder *= 0.35;
      fromBorder *= 0.35;
    }

    // 6. TO_AIRPORT_AWE & FROM_AIRPORT_AWE (Eve-of-holiday PM exodus, weekend travel, optional AWE windows)
    let toAirport = 0.45;
    let fromAirport = 0.45;
    if (dayType === 'weekday') {
      if (h >= 6.25 && h <= 8.5) toAirport = 1.10;
      if (h >= 17.25 && h <= 19.5) fromAirport = 1.10;
    } else {
      if (h >= 7.5 && h <= 12.0) toAirport = 1.25;
      else if (h >= 14.5 && h <= 19.0) toAirport = 1.15;
      if (h >= 16.5 && h <= 22.5) fromAirport = (dayType === 'sunday' || isHolidayEnd) ? 1.55 : 1.15;
    }
    if (isEveOfHoliday && h >= 16.5 && h <= 21.5) {
      toAirport = Math.max(toAirport, 1.80);
    }
    if (isAweDate) {
      // Optional AWE pre-show (16:00–19:00) & post-show (22:30–23:30)
      if (h >= 16.0 && h <= 19.0) toAirport = Math.max(toAirport, 1.85);
      if (h >= 22.5 && h <= 23.5) fromAirport = Math.max(fromAirport, 1.92);
    }

    // 7. ISLAND_OUTBOUND & ISLAND_INBOUND (weekday commuter peaks + Sat/Sun/holiday leisure waves)
    let islandOut = 0.30;
    let islandIn = 0.30;
    if (dayType === 'weekday') {
      const amCommute = _bell(h, 7.8, 0.85);
      const pmCommute = _bell(h, 18.25, 0.95);
      const friStaycation = isFriday ? _bell(h, 19.5, 1.0) * 0.55 : 0;
      islandIn = (0.28 + amCommute * 1.32 + pmCommute * 0.25) * weather.urbanIndoorMod;
      islandOut = (0.28 + pmCommute * 1.28 + friStaycation) * weather.urbanIndoorMod * weather.preTyphoonEvacMod;
    } else {
      const amOut = (h >= 8.5 && h <= 12.0) ? 1.42 : (_bell(h, 10.25, 1.4) * 1.25);
      const pmOut = (isCoolMonth && h >= 13.5 && h <= 16.0) ? 1.35 : 0.45;
      const pmIn = (h >= 16.0 && h <= 20.0) ? 1.52 : (_bell(h, 18.0, 1.4) * 1.30);
      islandOut = Math.max(0.30, amOut, pmOut) * season52.islandFestivalBoost * weather.outdoorMod;
      islandIn = Math.max(0.30, pmIn) * season52.islandFestivalBoost * weather.outdoorMod;
    }

    // 8. SUNDAY_URBAN_HUB (Sunday 08:00–18:00 Central/Admiralty/Causeway Bay/Mong Kok)
    let sundayUrbanHub = 0.0;
    if ((dayType === 'sunday' || hk.dayOfWeek === 0) && h >= 8.0 && h <= 18.0) {
      sundayUrbanHub = 1.55 * Math.max(0.85, weather.urbanIndoorMod);
    }

    // 9. CEMETERY_FESTIVAL (Ching Ming & Chung Yeung windows)
    let cemeteryFestival = 0.0;
    if (_isCemeteryFestivalWindow(hk, isWeekendOrHoliday) && h >= 7.5 && h <= 16.5) {
      cemeteryFestival = 1.72 * Math.max(0.45, weather.outdoorMod);
    }

    return {
      calendar: {
        isoWeek: hk.isoWeek,
        month: hk.month,
        dayType,
        isEveOfHoliday,
        isSchoolDay,
        hourFloat: hk.hourFloat,
        dateStr: hk.dateStr,
        isHoliday,
        isAweEventDate: isAweDate
      },
      weather,
      vectors: {
        CBD_INBOUND: _round3(cbdIn),
        CBD_OUTBOUND: _round3(cbdOut),
        SCHOOL_ZONE: _round3(schoolZone),
        TO_TRAIL_EXPOSED: _round3(toTrail),
        FROM_TRAIL_EXPOSED: _round3(fromTrail),
        TO_BEACH_WATER: _round3(toBeach),
        FROM_BEACH_WATER: _round3(fromBeach),
        TO_BORDER_NORTH: _round3(toBorder),
        FROM_BORDER_NORTH: _round3(fromBorder),
        TO_AIRPORT_AWE: _round3(toAirport),
        FROM_AIRPORT_AWE: _round3(fromAirport),
        ISLAND_OUTBOUND: _round3(islandOut),
        ISLAND_INBOUND: _round3(islandIn),
        SUNDAY_URBAN_HUB: _round3(sundayUrbanHub),
        CEMETERY_FESTIVAL: _round3(cemeteryFestival)
      }
    };
  }

  // ============================================================================
  // MODE-AGNOSTIC CORRIDOR → FLOW VECTOR MAPPER (BUS, MTR & FERRY)
  // ============================================================================
  const ZONE_KEYWORDS = Object.freeze({
    CBD_CORE: [
      'central', 'admiralty', 'wan chai', 'wanchai', 'causeway bay', 'quarry bay',
      'north point', 'tsim sha tsui', 'tst', 'jordan', 'mong kok', 'kwun tong',
      'kowloon bay', 'sheung wan', 'exchange square', 'hong kong station', 'ifc',
      '中環', '金鐘', '灣仔', '銅鑼灣', '鰂魚涌', '北角', '尖沙咀', '佐敦', '旺角', '觀塘', '九龍灣', '上環', '香港站'
    ],
    TRAIL_EXPOSED: [
      'pak kung au', 'nam shan', 'tai mo shan', 'ngong ping', 'po lin', 'sunset peak',
      'lantau peak', 'the peak', 'peak', 'dragon', 'lantau', 'mui wo', 'tai o',
      'sai kung', 'wong shek', 'hoi ha',
      '伯公坳', '南山', '大帽山', '昂坪', '寶蓮', '山頂', '龍脊', '大嶼山', '梅窩', '大澳', '西貢', '黃石'
    ],
    BEACH_WATER: [
      'shek o', 'repulse bay', 'stanley', 'pui o', 'cheung sha', 'tong fuk',
      'silvermine', 'big wave bay', 'clear water bay', 'ng tung chai', "bride's pool",
      'brides pool', 'beach', 'waterfall', 'sai kung',
      '石澳', '淺水灣', '赤柱', '貝澳', '長沙', '塘福', '銀礦灣', '大浪灣', '清水灣', '梧桐寨', '新娘潭', '泳灘', '西貢'
    ],
    SCHOOL_HUB: [
      'kowloon tong', 'ho man tin', 'mid-levels', 'mid levels', 'pok fu lam',
      'waterloo road', 'boundary street', 'oxford road', 'bonham road', 'caine road',
      '九龍塘', '何文田', '半山', '薄扶林', '窩打老道', '界限街', '般咸道', '堅道'
    ],
    BORDER_NORTH: [
      'lo wu', 'lok ma chau', 'shenzhen bay', 'heung yuen wai', 'liantang',
      'hzmb', 'hong kong port', 'huanggang', 'man kam to', 'border', 'boundary',
      '羅湖', '落馬洲', '深圳灣', '香園圍', '港珠澳', '香港口岸', '皇崗', '口岸'
    ],
    AIRPORT_AWE: [
      'airport', 'chek lap kok', 'asiaworld', 'expo', 'gtc', 'cathay city', 'tung chung',
      '機場', '赤鱲角', '博覽館', '亞博', '東涌'
    ],
    ISLAND_PIER: [
      'mui wo', 'cheung chau', 'lamma', 'yung shue wan', 'sok kwu wan', 'peng chau',
      'discovery bay', 'tai o', 'ma wan', 'park island', 'silver mine bay',
      '梅窩', '長洲', '南丫島', '榕樹灣', '索罟灣', '坪洲', '愉景灣', '大澳', '馬灣', '銀礦灣'
    ],
    SUNDAY_HUB: [
      'central', 'admiralty', 'causeway bay', 'mong kok', 'statue square', 'victoria park',
      '中環', '金鐘', '銅鑼灣', '旺角', '皇后像廣場', '維多利亞公園'
    ],
    CEMETERY: [
      'cemetery', 'crematorium', 'cape collinson', 'wo hop shek', 'sandy ridge', 'tsang tsui', 'junk bay',
      '墳場', '火葬場', '歌連臣角', '和合石', '沙嶺', '曾咀', '華人永遠墳場'
    ]
  });

  const SCHOOL_ROUTE_RE = /^(103|113|170|271|281A|208|7|7B|8|17|18|23|23B|40M|45|109|970)$/i;
  const BORDER_ROUTE_RE = /^B\d+[A-Z]?$/i;
  const AIRPORT_ROUTE_RE = /^(A|E|S)\d+[A-Z]?$|^AEL$/i;
  const CEMETERY_ROUTE_RE = /^(14S|32S|34S|38S|56S|76S|388|389)$/i;

  function _hasZone(text, zoneKey) {
    if (!text) return false;
    const list = ZONE_KEYWORDS[zoneKey];
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      if (text.includes(list[i])) return true;
    }
    return false;
  }

  /**
   * Maps any Bus, MTR, or Ferry corridor onto normalized directional Flow Vector keys.
   *
   * @param {Object} params
   * @param {string} [params.originText]
   * @param {string} [params.destText]
   * @param {string} [params.stopText]
   * @param {string} [params.routeCode]
   * @param {'BUS'|'MTR'|'FERRY'|string} [params.mode]
   * @returns {{
   *   mode: string,
   *   primaryVector: string,
   *   vectorKeys: string[],
   *   vectors: Array<{ key: string, weight: number }>
   * }}
   */
  function mapCorridorToFlowVectors(params) {
    const p = params && typeof params === 'object' ? params : {};
    const orig = String(p.originText || '').toLowerCase();
    const dest = String(p.destText || '').toLowerCase();
    const stop = String(p.stopText || '').toLowerCase();
    const combined = `${orig} ${dest} ${stop}`.trim();
    const routeCode = String(p.routeCode || '').trim().toUpperCase();
    const mode = String(p.mode || 'BUS').trim().toUpperCase();

    const scores = new Map();
    const addVec = (key, weight) => {
      const prev = scores.get(key) || 0;
      if (weight > prev) scores.set(key, Number(weight.toFixed(3)));
    };

    const origCbd = _hasZone(orig, 'CBD_CORE');
    const destCbd = _hasZone(dest, 'CBD_CORE');
    const origTrail = _hasZone(orig, 'TRAIL_EXPOSED');
    const destTrail = _hasZone(dest, 'TRAIL_EXPOSED');
    const stopTrail = _hasZone(stop, 'TRAIL_EXPOSED');
    const origBeach = _hasZone(orig, 'BEACH_WATER');
    const destBeach = _hasZone(dest, 'BEACH_WATER');
    const stopBeach = _hasZone(stop, 'BEACH_WATER');
    const origBorder = _hasZone(orig, 'BORDER_NORTH');
    const destBorder = _hasZone(dest, 'BORDER_NORTH');
    const origAirport = _hasZone(orig, 'AIRPORT_AWE');
    const destAirport = _hasZone(dest, 'AIRPORT_AWE');
    const origIsland = _hasZone(orig, 'ISLAND_PIER');
    const destIsland = _hasZone(dest, 'ISLAND_PIER');

    // 1. Cemetery festival corridors (highest specificity)
    if (_hasZone(combined, 'CEMETERY') || CEMETERY_ROUTE_RE.test(routeCode)) {
      addVec('CEMETERY_FESTIVAL', 1.0);
    }

    // 2. Border / Northbound & Southbound GBA corridors (incl. MTR East Rail & B-routes)
    const isBorderRoute = BORDER_ROUTE_RE.test(routeCode);
    if (destBorder && !origBorder) {
      addVec('TO_BORDER_NORTH', 1.0);
    } else if (origBorder && !destBorder) {
      addVec('FROM_BORDER_NORTH', 1.0);
    } else if (isBorderRoute) {
      addVec('TO_BORDER_NORTH', 0.9);
      addVec('FROM_BORDER_NORTH', 0.9);
    }

    // 3. Airport / AsiaWorld-Expo corridors (incl. A/E routes & AEL)
    const isAirportRoute = AIRPORT_ROUTE_RE.test(routeCode);
    const isStrictAirportOrAwe = (txt) => /airport|asiaworld|expo|gtc|機場|博覽館|亞博/i.test(txt);
    if (isStrictAirportOrAwe(dest) || (isAirportRoute && destAirport && !isStrictAirportOrAwe(orig))) {
      addVec('TO_AIRPORT_AWE', 1.0);
    } else if (isStrictAirportOrAwe(orig) || (isAirportRoute && origAirport && !isStrictAirportOrAwe(dest))) {
      addVec('FROM_AIRPORT_AWE', 1.0);
    } else if (isAirportRoute) {
      addVec('TO_AIRPORT_AWE', 0.95);
      addVec('FROM_AIRPORT_AWE', 0.95);
    }

    // 4. Outlying Islands & Ferries (Mui Wo, Cheung Chau, Lamma, Peng Chau, DB, Tai O)
    if (destIsland && !origIsland) {
      addVec('ISLAND_OUTBOUND', mode === 'FERRY' ? 1.0 : 0.85);
    } else if (origIsland && !destIsland) {
      addVec('ISLAND_INBOUND', mode === 'FERRY' ? 1.0 : 0.85);
    } else if (mode === 'FERRY' && (origIsland || destIsland)) {
      addVec('ISLAND_OUTBOUND', 0.9);
      addVec('ISLAND_INBOUND', 0.9);
    }

    // 5. Exposed Hiking Trails (Oct–Apr peak, summer dawn shift)
    if (destTrail && !origTrail) {
      addVec('TO_TRAIL_EXPOSED', 1.0);
      // Outbound trail corridors (e.g. 3M Tung Chung -> Mui Wo via Pak Kung Au) also absorb
      // post-sunset descending hikers heading down to Mui Wo Pier
      if (destIsland || stopTrail) addVec('FROM_TRAIL_EXPOSED', 0.9);
    } else if (origTrail && !destTrail) {
      addVec('FROM_TRAIL_EXPOSED', 1.0);
      if (stopTrail) addVec('TO_TRAIL_EXPOSED', 0.8);
    } else if (origTrail && destTrail) {
      // Inter-Lantau / trail-to-trail corridors (e.g. Mui Wo <-> Tai O)
      addVec('TO_TRAIL_EXPOSED', 0.95);
      addVec('FROM_TRAIL_EXPOSED', 0.95);
    } else if (stopTrail) {
      addVec('TO_TRAIL_EXPOSED', 0.95);
      addVec('FROM_TRAIL_EXPOSED', 0.9);
    }

    // 6. Beaches & Waterfalls (May–Oct peak)
    if (destBeach && !origBeach) {
      addVec('TO_BEACH_WATER', 1.0);
    } else if (origBeach && !destBeach) {
      addVec('FROM_BEACH_WATER', 1.0);
    } else if (stopBeach || (origBeach && destBeach)) {
      addVec('TO_BEACH_WATER', 0.9);
      addVec('FROM_BEACH_WATER', 0.9);
    }

    // 7. School corridors (Kowloon Tong, Ho Man Tin, Mid-Levels, Pok Fu Lam, Waterloo Rd)
    if (_hasZone(combined, 'SCHOOL_HUB') || (mode === 'BUS' && SCHOOL_ROUTE_RE.test(routeCode))) {
      addVec('SCHOOL_ZONE', 1.0);
    }

    // 8. Sunday urban gathering hubs (Central, Admiralty, Causeway Bay, Mong Kok)
    if (_hasZone(combined, 'SUNDAY_HUB')) {
      addVec('SUNDAY_URBAN_HUB', 0.95);
    }

    // 9. CBD directional commuter flows
    if (destCbd && !origCbd) {
      addVec('CBD_INBOUND', 0.9);
    } else if (origCbd && !destCbd) {
      addVec('CBD_OUTBOUND', 0.9);
    } else if (origCbd && destCbd) {
      addVec('CBD_INBOUND', 0.7);
      addVec('CBD_OUTBOUND', 0.7);
    }

    const vectors = Array.from(scores.entries())
      .map(([key, weight]) => ({ key, weight }))
      .sort((a, b) => b.weight - a.weight);

    return {
      mode,
      primaryVector: vectors.length ? vectors[0].key : 'URBAN_GENERAL',
      vectorKeys: vectors.map((v) => v.key),
      vectors
    };
  }

  const HkPeopleFlowSimulator = {
    GAZETTED_HK_HOLIDAYS_2025,
    GAZETTED_HK_HOLIDAYS_2026,
    GAZETTED_HK_HOLIDAYS_2027,
    FALLBACK_HK_HOLIDAY_DATES,
    HK_SCHOOL_HOLIDAY_RANGES,
    FLOW_VECTOR_KEYS,
    AWE_EVENT_DATES,
    HK_HOLIDAYS_STORAGE_KEY,
    setHkPublicHolidays,
    setAweEventDates,
    isHongKongPublicHoliday,
    isEveOfPublicHoliday,
    isAweEventDate,
    isSchoolHolidayDate,
    isHongKongSchoolDay,
    syncHkHolidaysFromWorker,
    simulateCityPeopleFlow,
    mapCorridorToFlowVectors
  };

  if (root) {
    root.HK_SCHOOL_HOLIDAY_RANGES = HK_SCHOOL_HOLIDAY_RANGES;
    root.AWE_EVENT_DATES = AWE_EVENT_DATES;
    root.FLOW_VECTOR_KEYS = FLOW_VECTOR_KEYS;
    root.setHkPublicHolidays = setHkPublicHolidays;
    root.setAweEventDates = setAweEventDates;
    root.isHongKongPublicHoliday = isHongKongPublicHoliday;
    root.isEveOfPublicHoliday = isEveOfPublicHoliday;
    root.isAweEventDate = isAweEventDate;
    root.isSchoolHolidayDate = isSchoolHolidayDate;
    root.isHongKongSchoolDay = isHongKongSchoolDay;
    root.syncHkHolidaysFromWorker = syncHkHolidaysFromWorker;
    root.simulateCityPeopleFlow = simulateCityPeopleFlow;
    root.mapCorridorToFlowVectors = mapCorridorToFlowVectors;
    root.HkPeopleFlowSimulator = HkPeopleFlowSimulator;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...HkPeopleFlowSimulator,
      HkPeopleFlowSimulator
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
