/* Transit HK — Bus Network Load Adapter (bussurge.js)
 * Dual Browser Global + CommonJS module.
 *
 * Pure sensor-fusion adapter sitting on top of the standalone Hong Kong People Flow Simulator
 * (public/hk-people-flow.js). Pulls baseline corridor demand exclusively from
 * simulateCityPeopleFlow() + mapCorridorToFlowVectors(), then fuses live bus kinematics:
 *   1. Headway-gap bunching (wide gaps amplify lead bus load; bunched trailing buses get relief)
 *   2. Stop-position progress curve (stopIdx / totalStops: origin light -> mid peak -> post-dropoff decay)
 *   3. Skip-stop velocity anomaly (fast inter-stop ETA advance under high demand -> HIGH_LOAD)
 *
 * 100% simulation- and telemetry-driven (zero manual rider-reporting overrides).
 * Strictly feeds bus crowding badges — NEVER modifies map road-speed telemetry.
 */
(function (root) {
  'use strict';

  let _flowMod = null;
  if (typeof require === 'function' && typeof root.simulateCityPeopleFlow !== 'function') {
    try {
      _flowMod = require('./hk-people-flow.js');
    } catch (e) {}
  }

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

  let _ferryMod = null;
  if (typeof require === 'function' && !(root && root.FerrySurgeEngine)) {
    try {
      _ferryMod = require('./ferrysurge.js');
    } catch (e) {}
  }

  function _getFlowFn(name) {
    if (typeof root !== 'undefined' && root.HkPeopleFlowSimulator && typeof root.HkPeopleFlowSimulator[name] === 'function') {
      return root.HkPeopleFlowSimulator[name];
    }
    if (_flowMod && typeof _flowMod[name] === 'function') return _flowMod[name];
    return null;
  }

  function _getFerryPulseFn() {
    if (typeof root !== 'undefined' && root.FerrySurgeEngine && typeof root.FerrySurgeEngine.getRecentFerryArrivalPulse === 'function') {
      return root.FerrySurgeEngine.getRecentFerryArrivalPulse;
    }
    if (_ferryMod && typeof _ferryMod.getRecentFerryArrivalPulse === 'function') {
      return _ferryMod.getRecentFerryArrivalPulse;
    }
    return null;
  }

  function _resolveWeatherMultiplier(hkoWeather, nowMs) {
    const fn =
      (typeof root !== 'undefined' && typeof root.getWeatherSurgeMultiplier === 'function'
        ? root.getWeatherSurgeMultiplier
        : null) ||
      (_weatherMod && typeof _weatherMod.getWeatherSurgeMultiplier === 'function'
        ? _weatherMod.getWeatherSurgeMultiplier
        : null);
    return fn ? fn(hkoWeather, nowMs) : 1.0;
  }

  function _resolveSeasonalMultiplier(params) {
    const fn =
      (typeof root !== 'undefined' && typeof root.getSeasonalCorridorMultiplier === 'function'
        ? root.getSeasonalCorridorMultiplier
        : null) ||
      (_monthlyMod && typeof _monthlyMod.getSeasonalCorridorMultiplier === 'function'
        ? _monthlyMod.getSeasonalCorridorMultiplier
        : null);
    return fn ? fn(params) : 1.0;
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

  const AWE_BUS_ROUTE_RE = /^(A|E)\d+[A-Z]?$/i;

  // Delegate calendar & holiday helpers directly to hk-people-flow.js (single source of truth)
  function isHongKongPublicHoliday(nowMs) {
    const fn = _getFlowFn('isHongKongPublicHoliday');
    return fn ? fn(nowMs) : false;
  }

  function isEveOfPublicHoliday(nowMs) {
    const fn = _getFlowFn('isEveOfPublicHoliday');
    return fn ? fn(nowMs) : false;
  }

  function isAweEventDate(nowMs) {
    const fn = _getFlowFn('isAweEventDate');
    return fn ? fn(nowMs) : false;
  }

  function setHkPublicHolidays(dates) {
    const fn = _getFlowFn('setHkPublicHolidays');
    return fn ? fn(dates) : 0;
  }

  function setAweEventDates(dates) {
    const fn = _getFlowFn('setAweEventDates');
    return fn ? fn(dates) : 0;
  }

  function syncHkHolidaysFromWorker(endpoint, opts) {
    const fn = _getFlowFn('syncHkHolidaysFromWorker');
    return fn
      ? fn(endpoint, opts)
      : Promise.resolve({ ok: false, fromCache: false, holidays: [], aweEventDates: [] });
  }

  const FALLBACK_HK_HOLIDAY_DATES =
    (root && root.HkPeopleFlowSimulator && root.HkPeopleFlowSimulator.FALLBACK_HK_HOLIDAY_DATES) ||
    (_flowMod && _flowMod.FALLBACK_HK_HOLIDAY_DATES) ||
    [];

  const AWE_EVENT_DATES =
    (root && root.AWE_EVENT_DATES) ||
    (_flowMod && _flowMod.AWE_EVENT_DATES) ||
    ['2026-11-28', '2026-11-29'];

  const HK_HOLIDAYS_STORAGE_KEY =
    (root && root.HkPeopleFlowSimulator && root.HkPeopleFlowSimulator.HK_HOLIDAYS_STORAGE_KEY) ||
    (_flowMod && _flowMod.HK_HOLIDAYS_STORAGE_KEY) ||
    'hk_transit_holidays_cache_v1';

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

  function _getAweEventMultiplier(routeNo, corridorText, minsOfDay, isAweDate) {
    if (!isAweDate) return 1.0;
    const rNo = String(routeNo || '').trim().toUpperCase();
    const isAeRoute = AWE_BUS_ROUTE_RE.test(rNo) || /asiaworld|expo|博覽館/i.test(String(corridorText || ''));
    if (!isAeRoute) return 1.0;
    // Pre-show ingress: 16:00–19:00 (960..1140)
    if (minsOfDay >= 960 && minsOfDay <= 1140) return 1.65;
    // Post-show egress: 22:30–23:30 (1350..1410)
    if (minsOfDay >= 1350 && minsOfDay <= 1410) return 1.85;
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
   * Stop-Position Progress Curve (stopIdx / totalStops):
   * - Origin / first 15% stops: easier to board (0.65)
   * - Mid-corridor (25%–75%): peak accumulated passenger load (1.15)
   * - Post-dropoff (>85%): lighter remaining load (0.78)
   * Smooth linear transitions between bands.
   */
  function computeStopPositionMod(stopIdx, totalStops) {
    const idx = Number(stopIdx);
    if (!Number.isFinite(idx) || idx < 0) return 1.0;
    let total = Number(totalStops);
    if (!Number.isFinite(total) || total <= 1) {
      if (idx === 0) return 0.65;
      total = Math.max(16, idx + 8);
    }
    const progress = Math.max(0, Math.min(1, idx / Math.max(1, total - 1)));
    if (progress < 0.15) return 0.65;
    if (progress < 0.25) {
      return Number((0.65 + ((progress - 0.15) / 0.10) * 0.50).toFixed(3));
    }
    if (progress <= 0.75) return 1.15;
    if (progress <= 0.85) {
      return Number((1.15 - ((progress - 0.75) / 0.10) * 0.37).toFixed(3));
    }
    return 0.78;
  }

  /**
   * Headway-Gap Bunching Kinematics:
   * - Trailing bus arriving <= 4 min behind lead bus: gets significant load relief (headwayMod < 0.75).
   * - Lead bus after wide gap (>= 18 min on frequent route or >= 1.75x scheduled headway):
   *   amplifies load (headwayMod up to 1.55).
   * - Lead bus with bunched follower <= 4 min behind: surfaces nextBusGapMins decision tip.
   */
  function computeHeadwayBunchingMod(etaEntry, routeGroup) {
    const entry = etaEntry && typeof etaEntry === 'object' ? etaEntry : {};
    const etaIdx = Number.isFinite(Number(entry.etaIdx)) ? Number(entry.etaIdx) : null;
    const prevBusGapSec = Number.isFinite(Number(entry.prevBusGapSec)) ? Number(entry.prevBusGapSec) : null;
    const nextBusGapSec = Number.isFinite(Number(entry.nextBusGapSec)) ? Number(entry.nextBusGapSec) : null;
    const rawGapAhead = entry.gapAheadSec !== undefined ? entry.gapAheadSec : entry.obsHeadwaySec;
    const gapAheadSec = Number.isFinite(Number(rawGapAhead)) && Number(rawGapAhead) > 0 ? Number(rawGapAhead) : null;
    const schedHwSec = Number.isFinite(Number(entry.schedHeadwaySec)) && Number(entry.schedHeadwaySec) > 0
      ? Number(entry.schedHeadwaySec)
      : (Number(routeGroup?.headwayMins) > 0 ? Number(routeGroup.headwayMins) * 60 : 720);

    // Trailing bunched bus (following <= 4 min behind the bus in front)
    const isTrailing = (etaIdx !== null && etaIdx >= 1) || Boolean(entry.isTrailingBunched);
    if (isTrailing && prevBusGapSec !== null && prevBusGapSec > 0 && prevBusGapSec <= 240) {
      return {
        headwayMod: prevBusGapSec <= 120 ? 0.55 : 0.68,
        isBunchedTrailing: true,
        isWideGap: false,
        gapRatio: Number((prevBusGapSec / Math.max(300, schedHwSec)).toFixed(2)),
        nextBusGapMins: null
      };
    }

    let headwayMod = 1.0;
    let isWideGap = false;
    let gapRatio = 1.0;

    if (gapAheadSec !== null) {
      gapRatio = gapAheadSec / Math.max(300, schedHwSec);
      const isFrequentRoute = schedHwSec <= 900;
      if ((isFrequentRoute && gapAheadSec >= 1080) || (gapAheadSec >= 900 && gapRatio >= 1.75)) {
        headwayMod = Number(Math.min(1.55, 1.0 + Math.min(0.55, (gapRatio - 1.0) * 0.45)).toFixed(3));
        isWideGap = true;
      } else if (gapAheadSec >= 900 && gapRatio >= 1.45) {
        headwayMod = Number(Math.min(1.30, 1.0 + (gapRatio - 1.0) * 0.30).toFixed(3));
      }
    }

    let nextBusGapMins = null;
    if ((etaIdx === 0 || etaIdx === null) && nextBusGapSec !== null && nextBusGapSec > 0 && nextBusGapSec <= 240) {
      nextBusGapMins = Math.max(1, Math.round(nextBusGapSec / 60));
    }

    return {
      headwayMod,
      isBunchedTrailing: false,
      isWideGap,
      gapRatio: Number(gapRatio.toFixed(2)),
      nextBusGapMins
    };
  }

  /**
   * Bus Network Adapter: fuses citywide people-flow vectors from hk-people-flow.js
   * with live bus kinematics (headway bunching, stop-position progress, skip-stop speed).
   *
   * @param {Object} routeGroup
   * @param {number} stopIdx
   * @param {Object|null} etaEntry
   * @param {Object|null} hkoWeather
   * @param {number} [nowMs]
   */
  function estimateGlobalBusLoadRisk(routeGroup, stopIdx, etaEntry, hkoWeather, nowMs) {
    const simFn = _getFlowFn('simulateCityPeopleFlow');
    const mapFn = _getFlowFn('mapCorridorToFlowVectors');

    const entry = etaEntry && typeof etaEntry === 'object' ? etaEntry : {};
    const group = routeGroup && typeof routeGroup === 'object' ? routeGroup : {};

    const explicitHol =
      typeof entry.isHoliday === 'boolean' ? entry.isHoliday :
      (typeof group.isHoliday === 'boolean' ? group.isHoliday : undefined);
    const explicitEve = typeof entry.isEveOfHoliday === 'boolean' ? entry.isEveOfHoliday : undefined;
    const explicitAwe = typeof entry.isAweEventDate === 'boolean' ? entry.isAweEventDate : undefined;
    const explicitSchoolHol = typeof entry.isSchoolHoliday === 'boolean' ? entry.isSchoolHoliday : undefined;

    const cityFlow = simFn
      ? simFn(nowMs, hkoWeather, {
          isHoliday: explicitHol,
          isEveOfHoliday: explicitEve,
          isAweEventDate: explicitAwe,
          isSchoolHoliday: explicitSchoolHol
        })
      : {
          calendar: {
            isoWeek: 1,
            month: 0,
            dayType: 'weekday',
            isEveOfHoliday: false,
            isSchoolDay: true,
            hourFloat: 12,
            dateStr: '',
            isHoliday: false,
            isAweEventDate: false
          },
          weather: {
            outdoorMod: _resolveWeatherMultiplier(hkoWeather, nowMs),
            urbanIndoorMod: 1.0,
            preTyphoonEvacMod: 1.0
          },
          vectors: {}
        };

    const originText = [group.orig_en, group.orig_e, group.orig_tc, group.origName].filter(Boolean).join(' ');
    const destText = [group.dest_en, group.dest_e, group.dest_tc, group.destName].filter(Boolean).join(' ');
    const stopText = [entry.stopName, entry.stopName_e, entry.name_tc, entry.corridorText].filter(Boolean).join(' ');
    const routeCode = String(group.routeNo || entry.routeNo || '').trim().toUpperCase();
    const corridorText = `${routeCode} ${originText} ${destText} ${stopText}`.trim();

    const mapping = mapFn
      ? mapFn({ originText, destText, stopText, routeCode, mode: 'BUS' })
      : { mode: 'BUS', primaryVector: 'URBAN_GENERAL', vectorKeys: [], vectors: [] };

    const cal = cityFlow.calendar;
    const minsOfDay = Math.round((Number(cal.hourFloat) || 0) * 60);
    const isLeisureRoute = isLeisureBusRoute(group);
    const isWeekendOrHoliday = cal.dayType !== 'weekday';
    const weatherMultiplier = _resolveWeatherMultiplier(hkoWeather, nowMs);
    const timeMultiplier = (isLeisureRoute && isWeekendOrHoliday)
      ? _getWeekendLeisureTimeMultiplier(minsOfDay)
      : 1.0;
    const seasonalMultiplier = _resolveSeasonalMultiplier({
      month: cal.month,
      dayType: cal.dayType,
      hourFloat: cal.hourFloat,
      corridorText,
      routeNo: routeCode,
      isEveOfHoliday: cal.isEveOfHoliday,
      isSchoolHoliday: !cal.isSchoolDay
    });
    const aweMultiplier = _getAweEventMultiplier(routeCode, corridorText, minsOfDay, cal.isAweEventDate);

    // Pull baseline demand exclusively from People Flow Simulator vectors
    let flowPressure = 0.0;
    let activeVector = mapping.primaryVector || 'URBAN_GENERAL';
    if (mapping.vectors && mapping.vectors.length > 0) {
      for (let i = 0; i < mapping.vectors.length; i++) {
        const v = mapping.vectors[i];
        const rawP = Number(cityFlow.vectors[v.key] || 0) * Number(v.weight || 1.0);
        if (rawP > flowPressure) {
          flowPressure = rawP;
          activeVector = v.key;
        }
      }
      // A/E Airport-AWE routes serve GTC<->AWE loop during AWE concert ingress/egress windows
      if (
        aweMultiplier > 1.0 &&
        (mapping.vectorKeys.includes('TO_AIRPORT_AWE') || mapping.vectorKeys.includes('FROM_AIRPORT_AWE'))
      ) {
        const awePeak = Math.max(
          Number(cityFlow.vectors.TO_AIRPORT_AWE || 0),
          Number(cityFlow.vectors.FROM_AIRPORT_AWE || 0)
        );
        if (awePeak > flowPressure) {
          flowPressure = awePeak;
          activeVector = minsOfDay >= 1320 ? 'FROM_AIRPORT_AWE' : 'TO_AIRPORT_AWE';
        }
      }
    } else {
      // Unspecialized urban corridor fallback
      flowPressure = 0.45 * Number(cityFlow.weather?.urbanIndoorMod || 1.0);
    }
    flowPressure = Number(flowPressure.toFixed(3));

    // Bus kinematics: Stop-Position Progress Curve + Headway-Gap Bunching + Skip-Stop Velocity
    const totalStops = entry.totalStops ?? group.totalStops ?? null;
    const stopPositionMod = computeStopPositionMod(stopIdx, totalStops);
    const bunching = computeHeadwayBunchingMod(entry, group);
    const headwayMod = bunching.headwayMod;

    // Cross-modal Mui Wo Ferry-to-Bus Pulse (NLB 1, 2, 3M departing from Mui Wo Pier right after ferry docks)
    const numStopIdx = Number.isFinite(Number(stopIdx)) ? Number(stopIdx) : 0;
    const isMuiWoPierOriginStop = numStopIdx <= 2 && (
      /mui\s*wo|梅窩/i.test(originText) ||
      /mui\s*wo|梅窩/i.test(stopText)
    );
    const isMuiWoFeederRoute = /^(1|2|3M|4|7S)$/i.test(routeCode) || /mui\s*wo\s*(ferry\s*)?pier|梅窩碼頭/i.test(`${originText} ${stopText}`);
    let ferryPulse = {
      active: false,
      pier: '',
      minsSinceDock: null,
      pulseMultiplier: 1.0,
      ferryPressure: 0,
      tipEn: '',
      tipTc: ''
    };
    if (isMuiWoPierOriginStop && isMuiWoFeederRoute) {
      const pulseFn = _getFerryPulseFn();
      if (pulseFn) {
        ferryPulse = pulseFn({
          pierName: 'Mui Wo',
          nowMs,
          ferryScheduleOrEtas: entry.ferryScheduleOrEtas || entry.recentFerryArrivals || null,
          cityFlow,
          hkoWeather,
          isHoliday: cal.isHoliday,
          ferryLoadState: entry.ferryLoadState || ''
        });
      }
    }

    const etaSpacing = _extractEtaSpacingSec(entry);
    const hasFastSkipStop = etaSpacing !== null && etaSpacing >= 0 && etaSpacing < 60;

    // When a high-load Central -> Mui Wo ferry just docked, origin boarding at Mui Wo Pier
    // bypasses the usual quiet-origin discount (300-400 passengers hit Stop #1 simultaneously)
    const effectiveStopMod = ferryPulse.active ? Math.max(stopPositionMod, 1.0) : stopPositionMod;
    const score = Number((flowPressure * effectiveStopMod * headwayMod * (ferryPulse.active ? ferryPulse.pulseMultiplier : 1.0)).toFixed(3));

    const meta = {
      score,
      flowPressure,
      primaryVector: activeVector,
      vectorKeys: mapping.vectorKeys || [],
      stopPositionMod: effectiveStopMod,
      headwayMod,
      ferryPulse,
      isBunchedTrailing: bunching.isBunchedTrailing,
      isWideGap: bunching.isWideGap,
      nextBusGapMins: bunching.nextBusGapMins,
      weatherMultiplier,
      seasonalMultiplier,
      timeMultiplier,
      aweMultiplier,
      dayType: cal.dayType,
      isHoliday: cal.isHoliday,
      isEveOfHoliday: cal.isEveOfHoliday,
      isSchoolDay: cal.isSchoolDay,
      isLeisureRoute,
      hasFastSkipStop,
      cityFlow
    };

    // 1. Bunched trailing bus relief: cap below HIGH_LOAD and prefer Seats / Standing
    if (bunching.isBunchedTrailing) {
      if (score >= 1.45) {
        return {
          level: 'MODERATE',
          label: 'Standing',
          labelTc: '企位',
          tip: 'Bunched trailing bus — lighter load than bus ahead.',
          tipTc: '緊隨前車班次 — 載客量較前車鬆動。',
          ...meta
        };
      }
      return {
        level: 'NORMAL',
        label: 'Seats',
        labelTc: '有位',
        tip: '',
        tipTc: '',
        ...meta
      };
    }

    // 2. HIGH_LOAD: high people-flow pressure fused with skip-stop velocity, severe headway gap, OR Mui Wo ferry arrival pulse
    if ((score >= 1.35 && hasFastSkipStop) || (bunching.isWideGap && score >= 1.55) || (ferryPulse.active && score >= 1.65)) {
      const tip = bunching.nextBusGapMins
        ? `Next bus ${bunching.nextBusGapMins}m behind likely has space`
        : (ferryPulse.active && ferryPulse.tipEn ? ferryPulse.tipEn : 'Consider boarding upstream.');
      const tipTc = bunching.nextBusGapMins
        ? `下班車${bunching.nextBusGapMins}分鐘後到，較大機會有位`
        : (ferryPulse.active && ferryPulse.tipTc ? ferryPulse.tipTc : '建議改於上游總站上車。');
      return {
        level: 'HIGH_LOAD',
        label: '⚠️ Likely Full',
        labelTc: '⚠️ 易滿座',
        tip,
        tipTc,
        ...meta
      };
    }

    // 3. MODERATE: elevated vector pressure, wide headway gap, or active Mui Wo ferry pulse
    if (score >= 1.15 || (bunching.isWideGap && score >= 0.95) || (ferryPulse.active && score >= 1.05)) {
      let tip = '';
      let tipTc = '';
      if (bunching.nextBusGapMins) {
        tip = `Next bus ${bunching.nextBusGapMins}m behind likely has space`;
        tipTc = `下班車${bunching.nextBusGapMins}分鐘後到，較大機會有位`;
      } else if (ferryPulse.active && ferryPulse.tipEn) {
        tip = ferryPulse.tipEn;
        tipTc = ferryPulse.tipTc;
      } else if (aweMultiplier > 1.0) {
        tip = 'AsiaWorld-Expo event crowd — expect fuller A/E buses.';
        tipTc = '亞博館大型活動人潮 — A/E線班次可能較滿。';
      } else if (cal.isEveOfHoliday && (activeVector === 'TO_AIRPORT_AWE' || activeVector === 'TO_BORDER_NORTH')) {
        tip = 'Holiday eve exodus — heavier airport & border demand.';
        tipTc = '假期前夕出行高峰 — 機場及口岸線需求上升。';
      } else if (activeVector === 'SCHOOL_ZONE') {
        tip = 'School commute window — busy corridor.';
        tipTc = '上放學高峰時段 — 沿線候車人數較多。';
      } else if (bunching.isWideGap) {
        tip = 'Wide live headway gap — heavier boarding likely.';
        tipTc = '班距較寬 — 候車人數可能較多。';
      } else if (score >= 1.35) {
        tip = 'Busy corridor window — expect fuller buses.';
        tipTc = '繁忙時段 — 班次可能較滿。';
      }
      return {
        level: 'MODERATE',
        label: 'Standing',
        labelTc: '企位',
        tip,
        tipTc,
        ...meta
      };
    }

    return {
      level: 'NORMAL',
      label: 'Seats',
      labelTc: '有位',
      tip: '',
      tipTc: '',
      ...meta
    };
  }

  const BusSurgeEngine = {
    LEISURE_KEYWORDS_EN,
    LEISURE_KEYWORDS_TC,
    FALLBACK_HK_HOLIDAY_DATES,
    AWE_EVENT_DATES,
    HK_HOLIDAYS_STORAGE_KEY,
    isLeisureBusRoute,
    isHongKongPublicHoliday,
    isEveOfPublicHoliday,
    isAweEventDate,
    setHkPublicHolidays,
    setAweEventDates,
    syncHkHolidaysFromWorker,
    computeStopPositionMod,
    computeHeadwayBunchingMod,
    estimateGlobalBusLoadRisk
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
    root.computeStopPositionMod = computeStopPositionMod;
    root.computeHeadwayBunchingMod = computeHeadwayBunchingMod;
    root.estimateGlobalBusLoadRisk = estimateGlobalBusLoadRisk;
    root.BusSurgeEngine = BusSurgeEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...BusSurgeEngine,
      BusSurgeEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
