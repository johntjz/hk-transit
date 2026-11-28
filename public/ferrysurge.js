/* Transit HK — Hybrid Ferry Load Adapter & Cross-Modal Pier Pulse (ferrysurge.js)
 * Dual Browser Global + CommonJS module.
 *
 * Pure sensor-fusion & timetable-simulation adapter sitting on top of the standalone Hong Kong
 * People Flow Simulator (public/hk-people-flow.js).
 * Supports two fusion modes:
 *   1. Sensor-fused mode (hasLiveApi: true — Sun Ferry / HKKF / Fortune Ferry):
 *      Combines city flow pressure, vessel capacity class, sailing interval, and live departure lag.
 *   2. Timetable-only mode (hasLiveApi: false — Star Ferry / Discovery Bay / Kaito):
 *      Pure one-sided simulation combining city flow pressure, vessel capacity class, and interval.
 *
 * Also exports getRecentFerryArrivalPulse() for cross-modal Mui Wo Ferry-to-Bus disembarkation waves.
 * Strictly feeds Ferry pills & Bus pier pulses — NEVER modifies map road-speed telemetry.
 */
(function (root) {
  'use strict';

  let _flowMod = null;
  if (typeof require === 'function' && !(root && root.HkPeopleFlowSimulator)) {
    try {
      _flowMod = require('./hk-people-flow.js');
    } catch (e) {}
  }

  function _getFlowFn(name) {
    if (typeof root !== 'undefined' && root.HkPeopleFlowSimulator && typeof root.HkPeopleFlowSimulator[name] === 'function') {
      return root.HkPeopleFlowSimulator[name];
    }
    if (_flowMod && typeof _flowMod[name] === 'function') return _flowMod[name];
    return null;
  }

  function _clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  // Fallback verified Central -> Mui Wo departure minutes (matching VERIFIED_MAINLINE_FERRIES.central_muiwo, 35m crossing)
  const FALLBACK_CENTRAL_MUIWO_SCHEDULE = Object.freeze({
    dur: 35,
    wk: [30, 180, 370, 420, 460, 510, 540, 590, 630, 670, 710, 750, 790, 830, 870, 910, 950, 990, 1040, 1060, 1080, 1110, 1140, 1170, 1200, 1240, 1280, 1320, 1365, 1410],
    sat: [30, 180, 370, 420, 460, 510, 540, 590, 630, 670, 710, 750, 790, 830, 870, 910, 950, 990, 1040, 1060, 1080, 1110, 1140, 1170, 1200, 1240, 1280, 1320, 1365, 1410],
    hol: [30, 180, 420, 480, 510, 540, 580, 620, 660, 720, 780, 820, 860, 900, 940, 980, 1020, 1060, 1100, 1140, 1180, 1220, 1260, 1300, 1340, 1380, 1420]
  });

  const LIVE_API_OPERATOR_RE = /sun\s*ferry|hkkf|hong\s*kong\s*&?\s*kowloon\s*ferry|fortune\s*ferry|新渡輪|港九小輪|富裕小輪|^SF$|^FF$/i;
  const TIMETABLE_ONLY_OPERATOR_RE = /star\s*ferry|discovery\s*bay|dbtsl|kaito|tsui\s*wah|coral\s*sea|chuen\s*kee|天星|愉景灣|街渡|翠華|珊瑚海/i;

  function _resolveHasLiveApi(hasLiveApi, operator, routeName) {
    if (typeof hasLiveApi === 'boolean') return hasLiveApi;
    const txt = `${operator || ''} ${routeName || ''}`.trim();
    if (TIMETABLE_ONLY_OPERATOR_RE.test(txt)) return false;
    if (LIVE_API_OPERATOR_RE.test(txt)) return true;
    return false;
  }

  function _resolveVesselClass(vesselType, operator, routeName) {
    const raw = String(vesselType || '').trim().toUpperCase();
    const opTxt = `${operator || ''} ${routeName || ''}`.toLowerCase();
    if (raw === 'KAITO' || /kaito|街渡/i.test(raw) || /kaito|tsui wah|chuen kee|街渡|翠華/i.test(opTxt)) return 'KAITO';
    if (raw === 'STAR' || /star\s*ferry|天星/i.test(opTxt)) return 'STAR';
    if (raw === 'ORD' || raw === 'ORDINARY' || /ordinary|3.?deck|slow|普通/i.test(raw)) return 'ORD';
    // Inner-harbour crossings (e.g. Central-Hung Hom, North Point-Hung Hom/Kowloon City/Kwun Tong)
    const isInnerHarbour = /hung\s*hom|north\s*point|kowloon\s*city|kwun\s*tong|sai\s*wan\s*ho|sam\s*ka\s*tsuen|紅磡|北角|九龍城|觀塘|西灣河/i.test(opTxt) &&
      !/mui\s*wo|cheung\s*chau|lamma|peng\s*chau|discovery\s*bay|tai\s*o|ma\s*wan|梅窩|長洲|南丫|坪洲|愉景灣|大澳|馬灣/i.test(opTxt);
    if (isInnerHarbour && raw !== 'FAST_EXPLICIT') return 'HARBOUR';
    if (raw === 'FAST' || /fast|high.?speed|catamaran|高速/i.test(raw)) return 'FAST';
    return 'FAST';
  }

  function _getVesselCapacityMod(vesselClass) {
    // FAST (~350–400 pax) fills faster; ORD (3-deck ~1,000+ pax) absorbs crowds; KAITO (~140 pax) tight
    if (vesselClass === 'FAST') return 1.28;
    if (vesselClass === 'ORD') return 0.70;
    if (vesselClass === 'KAITO') return 1.24;
    if (vesselClass === 'HARBOUR') return 0.95;
    if (vesselClass === 'STAR') return 0.90;
    return 1.0;
  }

  function _getSailingIntervalMod(sailingIntervalMins) {
    const mins = Number(sailingIntervalMins);
    if (!Number.isFinite(mins) || mins <= 0) return 1.0;
    if (mins >= 45) return 1.25;
    if (mins >= 30) return 1.10;
    if (mins > 15) return 1.00;
    return 0.78;
  }

  /**
   * Hybrid Ferry Load Adapter:
   * - Sensor-fused (hasLiveApi: true) fuses city flow pressure + vessel class + interval + live delay lag.
   * - Timetable-only (hasLiveApi: false) combines city flow pressure + vessel class + sailing interval.
   *
   * @param {Object} params
   * @param {string} [params.operator]
   * @param {string} [params.routeName]
   * @param {string} [params.pierOrigin]
   * @param {string} [params.pierDest]
   * @param {string} [params.vesselType]        'FAST' | 'ORD' | 'KAITO' | 'STAR'
   * @param {number} [params.sailingIntervalMins]
   * @param {number} [params.liveDelayMins]
   * @param {boolean} [params.hasLiveApi]
   * @param {Object|null} [params.hkoWeather]
   * @param {number} [params.nowMs]
   */
  function estimateFerryLoadStatus(params) {
    const p = params && typeof params === 'object' ? params : {};
    const simFn = _getFlowFn('simulateCityPeopleFlow');
    const mapFn = _getFlowFn('mapCorridorToFlowVectors');

    const cityFlow = simFn
      ? simFn(p.nowMs, p.hkoWeather, {
          isHoliday: typeof p.isHoliday === 'boolean' ? p.isHoliday : undefined,
          isEveOfHoliday: typeof p.isEveOfHoliday === 'boolean' ? p.isEveOfHoliday : undefined,
          isAweEventDate: typeof p.isAweEventDate === 'boolean' ? p.isAweEventDate : undefined,
          isSchoolHoliday: typeof p.isSchoolHoliday === 'boolean' ? p.isSchoolHoliday : undefined
        })
      : {
          calendar: { isoWeek: 1, month: 0, dayType: 'weekday', isEveOfHoliday: false, isSchoolDay: true, hourFloat: 12, dateStr: '', isHoliday: false, isAweEventDate: false },
          weather: { outdoorMod: 1.0, urbanIndoorMod: 1.0, preTyphoonEvacMod: 1.0 },
          vectors: { ISLAND_OUTBOUND: 0.5, ISLAND_INBOUND: 0.5 }
        };

    const pierOrigin = String(p.pierOrigin || p.origName || '').trim();
    const pierDest = String(p.pierDest || p.destName || '').trim();
    const routeName = String(p.routeName || `${pierOrigin} - ${pierDest}`).trim();
    const operator = String(p.operator || '').trim();
    const hasLiveApi = _resolveHasLiveApi(p.hasLiveApi, operator, routeName);
    const vesselClass = _resolveVesselClass(p.vesselType || p.vesselClass, operator, routeName);
    const vesselMod = _getVesselCapacityMod(vesselClass);
    const intervalMins = Number.isFinite(Number(p.sailingIntervalMins)) && Number(p.sailingIntervalMins) > 0
      ? Number(p.sailingIntervalMins)
      : (vesselClass === 'STAR' ? 10 : 35);
    const intervalMod = _getSailingIntervalMod(intervalMins);

    const mapping = mapFn
      ? mapFn({
          originText: pierOrigin,
          destText: pierDest,
          stopText: routeName,
          routeCode: operator,
          mode: 'FERRY'
        })
      : { mode: 'FERRY', primaryVector: 'ISLAND_OUTBOUND', vectorKeys: ['ISLAND_OUTBOUND'], vectors: [{ key: 'ISLAND_OUTBOUND', weight: 1.0 }] };

    const vec = cityFlow.vectors || {};
    let flowPressure = 0.0;
    let primaryVector = mapping.primaryVector || 'ISLAND_OUTBOUND';

    if (mapping.vectors && mapping.vectors.length > 0) {
      // Outlying island ferries use strictly their directional ISLAND_OUTBOUND / ISLAND_INBOUND vector
      // so hiking-bus return vectors (FROM_TRAIL_EXPOSED) never cross-bleed onto outbound ferries.
      const hasIslandVec = mapping.vectorKeys.includes('ISLAND_OUTBOUND') || mapping.vectorKeys.includes('ISLAND_INBOUND');
      for (let i = 0; i < mapping.vectors.length; i++) {
        const v = mapping.vectors[i];
        if (hasIslandVec && v.key !== 'ISLAND_OUTBOUND' && v.key !== 'ISLAND_INBOUND') {
          continue;
        }
        const rawP = Number(vec[v.key] || 0) * Number(v.weight || 1.0);
        if (rawP > flowPressure) {
          flowPressure = rawP;
          primaryVector = v.key;
        }
      }
      // Fallback if only CBD/urban vectors were matched (e.g. Star Ferry Central <-> TST, North Point <-> Hung Hom)
      if (flowPressure <= 0) {
        for (let i = 0; i < mapping.vectors.length; i++) {
          const v = mapping.vectors[i];
          const rawP = Number(vec[v.key] || 0) * Number(v.weight || 1.0);
          if (rawP > flowPressure) {
            flowPressure = rawP;
            primaryVector = v.key;
          }
        }
      }
    } else {
      flowPressure = Math.max(Number(vec.CBD_INBOUND || 0), Number(vec.CBD_OUTBOUND || 0), 0.35);
    }

    // Active T8+ suspension suppresses marine ferry operations cleanly
    const wx = cityFlow.weather || { outdoorMod: 1.0, urbanIndoorMod: 1.0, preTyphoonEvacMod: 1.0 };
    if (Number(wx.outdoorMod || 1.0) <= 0.35 && Number(wx.urbanIndoorMod || 1.0) < 0.7) {
      flowPressure *= 0.45;
    }
    flowPressure = Number(flowPressure.toFixed(3));

    // Sensor-fused live departure lag amplification (only when hasLiveApi === true)
    const liveDelayMins = Number.isFinite(Number(p.liveDelayMins)) ? Math.max(0, Number(p.liveDelayMins)) : 0;
    let delayMod = 1.0;
    let isLiveDelayAmplified = false;
    if (hasLiveApi && liveDelayMins >= 4) {
      isLiveDelayAmplified = true;
      if (flowPressure >= 0.75) {
        delayMod = Number(_clamp(1.28 + (liveDelayMins - 4) * 0.045, 1.28, 1.55).toFixed(3));
      } else {
        delayMod = Number(_clamp(1.12 + (liveDelayMins - 4) * 0.025, 1.12, 1.28).toFixed(3));
      }
    }

    const score = Number((flowPressure * vesselMod * intervalMod * delayMod).toFixed(3));

    let state = 'SPACE';
    let labelEn = 'Space';
    let labelTc = '充裕';
    let cssClass = 'load-low';
    let pct = _clamp(Math.round(20 + score * 36), 20, 53);
    let tipEn = '';
    let tipTc = '';

    if (score >= 1.38) {
      state = 'QUEUE_EARLY';
      labelEn = 'Queue Early';
      labelTc = '建議早到';
      cssClass = 'load-full';
      pct = _clamp(Math.round(80 + (score - 1.38) * 26), 80, 98);
      if (isLiveDelayAmplified) {
        tipEn = `Live sailing delayed ${Math.round(liveDelayMins)}m — pier queue building fast.`;
        tipTc = `實時航班延誤約${Math.round(liveDelayMins)}分鐘 — 碼頭排隊人流迅速增加。`;
      } else if (vesselClass === 'FAST') {
        tipEn = 'Fast Ferry (~380 seats) — arrive 15–20m early at pier.';
        tipTc = '高速船座位有限 — 建議提早15至20分鐘到碼頭排隊。';
      } else if (vesselClass === 'KAITO') {
        tipEn = 'Small Kaito capacity — queue early at pier.';
        tipTc = '街渡載客量有限 — 建議提早到碼頭候船。';
      } else {
        tipEn = 'Heavy pier boarding wave — queue early.';
        tipTc = '碼頭登船人流高峰 — 建議提早到達排隊。';
      }
    } else if (score >= 0.88) {
      state = 'FILLING';
      labelEn = 'Filling Fast';
      labelTc = '漸滿';
      cssClass = 'load-med';
      pct = _clamp(Math.round(54 + (score - 0.88) * 50), 54, 79);
      if (isLiveDelayAmplified) {
        tipEn = `Sailing delayed ${Math.round(liveDelayMins)}m — boarding queue growing.`;
        tipTc = `航班延誤約${Math.round(liveDelayMins)}分鐘 — 碼頭候船人數增加。`;
      } else if (vesselClass === 'FAST') {
        tipEn = 'Fast Ferry filling quickly — arrive 10m before sailing.';
        tipTc = '高速船座位漸滿 — 建議提早10分鐘到碼頭。';
      } else if (intervalMins >= 45) {
        tipEn = `${Math.round(intervalMins)}m interval — arrive early before gate closes.`;
        tipTc = `班距約${Math.round(intervalMins)}分鐘 — 建議提早入閘候船。`;
      }
    }

    return {
      mode: 'FERRY',
      fusionMode: hasLiveApi ? 'SENSOR_FUSED' : 'TIMETABLE_ONLY',
      hasLiveApi,
      operator,
      routeName,
      pierOrigin,
      pierDest,
      vesselClass,
      state,
      labelEn,
      labelTc,
      cssClass,
      pct,
      score,
      flowPressure,
      vesselMod,
      intervalMod,
      sailingIntervalMins: intervalMins,
      delayMod,
      liveDelayMins,
      isLiveDelayAmplified,
      primaryVector,
      tipEn,
      tipTc,
      cityFlow
    };
  }

  /**
   * Computes elapsed minutes since the most recent Central -> Mui Wo ferry docked at Mui Wo Pier.
   */
  function _findMinsSinceLastCentralMuiWoDock(nowMs, ferryScheduleOrEtas, dayType) {
    const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    let bestMinsAgo = null;

    const considerMinsAgo = (minsAgo) => {
      if (!Number.isFinite(minsAgo) || minsAgo < 0 || minsAgo > 60) return;
      if (bestMinsAgo === null || minsAgo < bestMinsAgo) {
        bestMinsAgo = Number(minsAgo.toFixed(1));
      }
    };

    if (Array.isArray(ferryScheduleOrEtas) && ferryScheduleOrEtas.length > 0) {
      for (let i = 0; i < ferryScheduleOrEtas.length; i++) {
        const item = ferryScheduleOrEtas[i];
        if (typeof item === 'number' && Number.isFinite(item)) {
          if (item > 1e10) {
            considerMinsAgo((ms - item) / 60000);
          } else {
            // Treated as scheduled departure minute-of-day from Central (+35m crossing)
            const hkDate = new Date(ms + 8 * 3600 * 1000);
            const nowMinOfDay = hkDate.getUTCHours() * 60 + hkDate.getUTCMinutes() + hkDate.getUTCSeconds() / 60;
            const dockMin = item + 35;
            considerMinsAgo(nowMinOfDay - dockMin);
          }
        } else if (item && typeof item === 'object') {
          if (Number.isFinite(Number(item.minsAgo))) {
            considerMinsAgo(Number(item.minsAgo));
          } else if (Number.isFinite(Number(item.dockedAtMs ?? item.arrivalMs))) {
            considerMinsAgo((ms - Number(item.dockedAtMs ?? item.arrivalMs)) / 60000);
          } else if (Number.isFinite(Number(item.departMs))) {
            const cross = Number.isFinite(Number(item.crossingMins)) ? Number(item.crossingMins) : 35;
            const dockMs = Number(item.departMs) + cross * 60000;
            considerMinsAgo((ms - dockMs) / 60000);
          } else if (Number.isFinite(Number(item.targetMs))) {
            const cross = item.isArrival ? 0 : (Number.isFinite(Number(item.crossingMins)) ? Number(item.crossingMins) : 35);
            const dockMs = Number(item.targetMs) + cross * 60000;
            considerMinsAgo((ms - dockMs) / 60000);
          }
        }
      }
      return bestMinsAgo;
    }

    // Timetable fallback: explicit schedule object -> VERIFIED_MAINLINE_FERRIES.central_muiwo -> built-in schedule
    const sched =
      (ferryScheduleOrEtas && typeof ferryScheduleOrEtas === 'object' && !Array.isArray(ferryScheduleOrEtas))
        ? ferryScheduleOrEtas
        : ((typeof root !== 'undefined' && root.VERIFIED_MAINLINE_FERRIES && root.VERIFIED_MAINLINE_FERRIES.central_muiwo) ||
           FALLBACK_CENTRAL_MUIWO_SCHEDULE);

    const dayKey = (dayType === 'sunday' || dayType === 'holiday') ? 'hol' : (dayType === 'saturday' ? 'sat' : 'wk');
    const slots = Array.isArray(sched[dayKey]) && sched[dayKey].length ? sched[dayKey] : (sched.wk || []);
    const crossingMins = Number(sched.durFast || sched.dur || 35);

    const hkDate = new Date(ms + 8 * 3600 * 1000);
    const nowMinOfDay = hkDate.getUTCHours() * 60 + hkDate.getUTCMinutes() + hkDate.getUTCSeconds() / 60;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const depMin = Array.isArray(slot) ? Number(slot[0]) : Number(slot);
      if (!Number.isFinite(depMin)) continue;
      const dur = (Array.isArray(slot) && Number(slot[1]) > 0) ? Number(slot[1]) : crossingMins;
      const dockMin = depMin + dur;
      let diff = nowMinOfDay - dockMin;
      if (diff < -720) diff += 1440; // past-midnight wrap
      considerMinsAgo(diff);
    }

    return bestMinsAgo;
  }

  /**
   * Cross-Modal Mui Wo Ferry-to-Bus Pulse:
   * Detects when a high-load Central -> Mui Wo ferry has docked within the last 5–15 minutes
   * (e.g. weekend/holiday mornings discharging 300–400 hikers onto the Mui Wo Pier bus terminus)
   * so bussurge.js can elevate boarding load risk for NLB 1, 2, 3M departures from Mui Wo.
   *
   * @param {Object} params
   * @param {string} params.pierName
   * @param {number} [params.nowMs]
   * @param {Array|Object|null} [params.ferryScheduleOrEtas]
   * @param {Object|null} [params.cityFlow]
   * @param {Object|null} [params.hkoWeather]
   * @param {boolean} [params.isHoliday]
   * @param {string} [params.ferryLoadState]
   */
  function getRecentFerryArrivalPulse(params) {
    const p = params && typeof params === 'object' ? params : {};
    const pierRaw = String(p.pierName || '').toLowerCase();
    const isMuiWoPier = /mui\s*wo|muiwo|梅窩/.test(pierRaw);
    if (!isMuiWoPier) {
      return {
        active: false,
        pier: '',
        minsSinceDock: null,
        pulseMultiplier: 1.0,
        ferryPressure: 0,
        tipEn: '',
        tipTc: ''
      };
    }

    const simFn = _getFlowFn('simulateCityPeopleFlow');
    const cityFlow = p.cityFlow || (simFn
      ? simFn(p.nowMs, p.hkoWeather, {
          isHoliday: typeof p.isHoliday === 'boolean' ? p.isHoliday : undefined
        })
      : {
          calendar: { dayType: 'weekday', hourFloat: 12 },
          weather: { outdoorMod: 1.0 },
          vectors: { ISLAND_OUTBOUND: 0.4, TO_TRAIL_EXPOSED: 0.4 }
        });

    const cal = cityFlow.calendar || { dayType: 'weekday', hourFloat: 12 };
    const vec = cityFlow.vectors || {};
    const ferryPressure = Number(Math.max(
      Number(vec.ISLAND_OUTBOUND || 0),
      Number(vec.TO_TRAIL_EXPOSED || 0) * 0.92
    ).toFixed(3));

    const minsSinceDock = _findMinsSinceLastCentralMuiWoDock(p.nowMs, p.ferryScheduleOrEtas, cal.dayType);
    const isExplicitHighFerry = p.ferryLoadState === 'QUEUE_EARLY' || p.ferryLoadState === 'FILLING';
    const isHighLoadFerry = isExplicitHighFerry || ferryPressure >= 0.95;

    // Active pulse window: ferry docked 0–15 mins ago, peaking in the 5–15 min gangway-to-bus-bay surge
    if (isHighLoadFerry && minsSinceDock !== null && minsSinceDock >= 0 && minsSinceDock <= 15) {
      let pulseMultiplier = 1.38;
      if (minsSinceDock >= 4 && minsSinceDock <= 13) {
        pulseMultiplier = ferryPressure >= 1.40 ? 1.56 : 1.46;
      } else if (minsSinceDock < 4) {
        pulseMultiplier = ferryPressure >= 1.40 ? 1.42 : 1.32;
      } else {
        pulseMultiplier = ferryPressure >= 1.40 ? 1.40 : 1.30;
      }

      return {
        active: true,
        pier: 'MUI_WO',
        minsSinceDock,
        pulseMultiplier: Number(pulseMultiplier.toFixed(3)),
        ferryPressure,
        tipEn: 'Central ferry just docked — Mui Wo pier queue busy',
        tipTc: '中環渡輪剛泊岸 — 梅窩碼頭候車人流較多'
      };
    }

    return {
      active: false,
      pier: 'MUI_WO',
      minsSinceDock,
      pulseMultiplier: 1.0,
      ferryPressure,
      tipEn: '',
      tipTc: ''
    };
  }

  const FerrySurgeEngine = {
    FALLBACK_CENTRAL_MUIWO_SCHEDULE,
    estimateFerryLoadStatus,
    getRecentFerryArrivalPulse
  };

  if (root) {
    root.estimateFerryLoadStatus = estimateFerryLoadStatus;
    root.getRecentFerryArrivalPulse = getRecentFerryArrivalPulse;
    root.FerrySurgeEngine = FerrySurgeEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...FerrySurgeEngine,
      FerrySurgeEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
