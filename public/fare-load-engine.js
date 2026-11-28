// ============================================================================
// File: fare-load-engine.js (johntjz/Hk-Fleet — MTR Fare, Load Factor & Sectional Fare Engine)
// ============================================================================

if (typeof MTR_STATION_DIRECTORY === 'undefined' && typeof require === 'function') {
  try {
    const _td = require('./transit-data.js');
    if (_td && typeof globalThis !== 'undefined') Object.assign(globalThis, _td);
  } catch (e) {}
}

if (typeof getSeasonalCorridorMultiplier === 'undefined' && typeof require === 'function') {
  try {
    const _ma = require('./monthly_activity.js');
    if (_ma && typeof globalThis !== 'undefined') Object.assign(globalThis, _ma);
  } catch (e) {}
}

if (typeof simulateCityPeopleFlow === 'undefined' && typeof require === 'function') {
  try {
    const _pf = require('./hk-people-flow.js');
    if (_pf && typeof globalThis !== 'undefined') Object.assign(globalThis, _pf);
  } catch (e) {}
}

if (typeof estimateGlobalBusLoadRisk === 'undefined' && typeof require === 'function') {
  try {
    const _bs = require('./bussurge.js');
    if (_bs && typeof globalThis !== 'undefined') Object.assign(globalThis, _bs);
  } catch (e) {}
}

const MTR_ENGINE = {
  STATION_DEPTH: {
    HKU: 250, SYP: 210, CAB: 180, CEN: 180, HOK: 180, LET: 160, LOW: 160, LMC: 160,
    ADM: 150, HOM: 150, ETS: 150, QUB: 140, MEF: 140, WCH: 140, KOT: 130, SOH: 130,
    TST: 120, EXC: 120, AUS: 120, KOW: 120, HUH: 115, DIH: 110, OCP: 105,
    MOK: 75, PRE: 75, LOP: 75, TAW: 75, TUM: 70, TIS: 70, YUL: 70, TAP: 70, SHS: 70,
    SHT: 65, UNI: 65, TWO: 65, FAN: 65, TUC: 60, SIH: 60, KSR: 60, FOT: 60,
    SUN: 50, DIS: 50
  },

  INTERCHANGE_TIME: {
    MOK_KTL_TWL: 30, PRE_KTL_TWL: 30,
    ADM_ISL_TWL: 45, NOP_ISL_TKL: 45, YAT_KTL_TKL: 45, TIK_KTL_TKL: 45,
    LAK_TCL_TWL: 45, SUN_DRL_TCL: 45,
    NAC_TCL_TML: 55, HOM_KTL_TML: 60,
    TAW_EAL_TML: 135, KOT_EAL_KTL: 150, DIH_KTL_TML: 150, HUH_EAL_TML: 150,
    ADM_EAL_ISL: 240, ADM_EAL_TWL: 240, ADM_ISL_SIL: 240, ADM_SIL_TWL: 240, ADM_EAL_SIL: 240,
    QUB_ISL_TKL: 300, MEF_TML_TWL: 300,
    CEN_ISL_TCL: 330, CEN_TCL_TWL: 330, HOK_ISL_TCL: 330, HOK_TCL_TWL: 330,
    CEN_HOK_WALK: 330,
    TST_ETS_OSI: 240,
    LRT_TML_XFER: 210
  },

  TERMINUS_STATIONS: new Set([
    'KET', 'CHW', 'CEN', 'TSW', 'WHA', 'TIK', 'POA', 'LHP', 'NOP',
    'TUC', 'HOK', 'AIR', 'AWE', 'TUM', 'WKS', 'ADM', 'LOW', 'LMC',
    'SOH', 'SUN', 'DIS'
  ]),

  AEL_FARES: {
    HOK_AIR: 120.0, AIR_HOK: 120.0, HOK_AWE: 120.0, AWE_HOK: 120.0,
    KOW_AIR: 105.0, AIR_KOW: 105.0, KOW_AWE: 105.0, AWE_KOW: 105.0,
    TSY_AIR: 73.0,  AIR_TSY: 73.0,  TSY_AWE: 73.0,  AWE_TSY: 73.0,
    AIR_AWE: 6.5,   AWE_AIR: 6.5
  },

  FARE_SAVERS: [
    { id: 'fs_central_midlevels', lat: 22.2827, lon: 114.1544, targetStations: ['CEN', 'HOK', 'SHW'], discount: 2.0 },
    { id: 'fs_welland',           lat: 22.2869, lon: 114.1502, targetStations: ['SHW'], discount: 2.0 },
    { id: 'fs_worfu',             lat: 22.2916, lon: 114.1945, targetStations: ['FOH', 'NOP'], discount: 2.0 },
    { id: 'fs_harbourcity',       lat: 22.2974, lon: 114.1688, targetStations: ['AUS', 'TST'], discount: 2.0 },
    { id: 'fs_peninsula',         lat: 22.2979, lon: 114.1763, targetStations: ['ETS', 'TST'], discount: 2.0 },
    { id: 'fs_homantin',          lat: 22.3137, lon: 114.1811, targetStations: ['HOM'], discount: 2.0 },
    { id: 'fs_metroharbour',      lat: 22.3237, lon: 114.1605, targetStations: ['NAC', 'OLY'], discount: 2.0 },
    { id: 'fs_citywalk',          lat: 22.3705, lon: 114.1137, targetStations: ['TSW', 'TWW'], discount: 2.0 },
    { id: 'fs_tkospot',           lat: 22.3105, lon: 114.2584, targetStations: ['TKO'], discount: 2.0 },
    { id: 'fs_shatin_galleria',   lat: 22.3983, lon: 114.1950, targetStations: ['FOT'], discount: 2.0 }
  ],

  MTR_FEEDER_BUS_STATIONS: {
    K12:  { stations: ['TAP'], noHolidayFree: true },
    K14:  { stations: ['TAP'] },
    K17:  { stations: ['TAP'] },
    K18:  { stations: ['TAP'] },
    K51:  { stations: ['TUM', 'SIH'] },
    K51A: { stations: ['TUM', 'SIH'] },
    K52:  { stations: ['TUM'] },
    K52A: { stations: ['TUM'] },
    K52P: { stations: ['TUM'] },
    K53:  { stations: ['TUM'] },
    K53S: { stations: ['TUM'] },
    K54:  { stations: ['SIH'] },
    K54A: { stations: ['SIH'] },
    K58:  { stations: ['TUM', 'SIH'] },
    K65:  { stations: ['TIS', 'YUL'] },
    K65A: { stations: ['TIS'] },
    K66:  { stations: ['LOP'] },
    K68:  { stations: ['LOP'] },
    K73:  { stations: ['LOP'] },
    K74:  { stations: ['LOP', 'YUL'] },
    K75A: { stations: ['TIS'] },
    K75P: { stations: ['TIS'] },
    K75S: { stations: ['TIS'] },
    K76:  { stations: ['TIS'] },
    K76S: { stations: ['TIS'] },
    '506': { stations: ['TUM'] }
  },

  RULES: {
    osi: {
      tstEtsLimitMins: 30,
      paidLinkPairs: [['CEN', 'HOK']]
    },
    lrtInterchange: {
      stations: new Set(['TUM', 'SIH', 'TIS', 'YUL']),
      timeLimitMins: 30,
      roundTripLimitMins: 120,
      maxDeductionHkd: 6.0
    },
    bylaws: {
      maxPaidAreaSecs: 9000,
      maxOverstayFareHkd: 64.0,
      sameStationShortSecs: 1200,
      sameStationLongPenaltyHkd: 10.0
    },
    exclusions: {
      crossBoundary: new Set(['LOW', 'LMC']),
      airportExpress: new Set(['AIR', 'AWE'])
    },
    operatingHours: {
      closedStartMin: 60,
      closedEndMin: 350
    }
  },

  isClosedAt(dateOrTimeStr, isOvernightHoliday = false) {
    if (isOvernightHoliday) return false;
    let mins = -1;
    if (dateOrTimeStr instanceof Date) {
      mins = dateOrTimeStr.getHours() * 60 + dateOrTimeStr.getMinutes();
    } else if (typeof dateOrTimeStr === 'string' && dateOrTimeStr.includes(':')) {
      const [h, m] = dateOrTimeStr.split(':').map(Number);
      if (Number.isFinite(h) && Number.isFinite(m)) mins = (h % 24) * 60 + m;
    }
    if (mins < 0) return false;
    return mins >= this.RULES.operatingHours.closedStartMin && mins <= this.RULES.operatingHours.closedEndMin;
  },

  getStationDepthSec(staCode) {
    const c = resolveMtrStationCode(staCode) || String(staCode || '').trim().toUpperCase();
    return this.STATION_DEPTH[c] || 90;
  },

  getInterchangeWalkSec(staCode, lineA, lineB, nextStaCode = '') {
    const c1 = resolveMtrStationCode(staCode) || String(staCode || '').trim().toUpperCase();
    const c2 = resolveMtrStationCode(nextStaCode) || String(nextStaCode || '').trim().toUpperCase();
    if ((c1 === 'TST' && c2 === 'ETS') || (c1 === 'ETS' && c2 === 'TST')) {
      return this.INTERCHANGE_TIME.TST_ETS_OSI;
    }
    if ((c1 === 'CEN' && c2 === 'HOK') || (c1 === 'HOK' && c2 === 'CEN')) {
      return this.INTERCHANGE_TIME.CEN_HOK_WALK;
    }
    const lA = String(lineA || '').trim().toUpperCase();
    const lB = String(lineB || '').trim().toUpperCase();
    if (lA === 'LRT' || lB === 'LRT') return this.INTERCHANGE_TIME.LRT_TML_XFER;
    const pair = [lA, lB].sort().join('_');
    const exact = this.INTERCHANGE_TIME[`${c1}_${pair}`];
    if (exact) return exact;
    if (c1 === 'MEF' || c1 === 'QUB' || c1 === 'CEN' || c1 === 'HOK') return 300;
    if (c1 === 'KOT' || c1 === 'DIH' || c1 === 'HUH' || c1 === 'TAW') return 150;
    return 120;
  },

  getAdjacentRunningTimeSec(fromCode, toCode) {
    const a = resolveMtrStationCode(fromCode) || String(fromCode || '').trim().toUpperCase();
    const b = resolveMtrStationCode(toCode) || String(toCode || '').trim().toUpperCase();
    if (!a || !b || a === b) return 0;
    const mapped = MTR_ADJACENT_RUNNING_TIME[`${a}_${b}`];
    if (mapped) return mapped;
    const stA = MTR_STATION_DIRECTORY[a], stB = MTR_STATION_DIRECTORY[b];
    if (stA && stB) {
      const dKm = _haversineKm(stA.lat, stA.lon, stB.lat, stB.lon);
      if (Number.isFinite(dKm) && dKm < 30) {
        const speedMps = dKm >= 2.5 ? 21.5 : (dKm >= 1.4 ? 17.5 : 14.0);
        return Math.max(75, Math.round((dKm * 1000 * 1.05) / speedMps) + 25);
      }
    }
    return 150;
  },

  isTerminusStation(staCode) {
    const c = resolveMtrStationCode(staCode) || String(staCode || '').trim().toUpperCase();
    return this.TERMINUS_STATIONS.has(c);
  },

  isFreeMtrFeederBus(routeNo, mtrStationCode = '', isHoliday = false) {
    const r = String(routeNo || '').trim().toUpperCase();
    const rule = this.MTR_FEEDER_BUS_STATIONS[r];
    if (!rule) return false;
    if (isHoliday && rule.noHolidayFree) return false;
    if (!mtrStationCode) return true;
    const st = resolveMtrStationCode(mtrStationCode) || String(mtrStationCode || '').trim().toUpperCase();
    if (!st) return true;
    return rule.stations.includes(st);
  },

  // Official MTR–GMB Octopus PTFSS Interchange Discounts (90-min transfer window, both directions)
  GMB_INTERCHANGE_DISCOUNTS: {
    // New Territories feeders (Yuen Long / Long Ping / Tuen Mun / Tseung Kwan O / Sha Tin / Tai Po)
    '74':   { stations: ['LOP', 'YUL'], discount: 0.5 },
    '74A':  { stations: ['LOP', 'YUL'], discount: 0.5 },
    '77':   { stations: ['LOP', 'YUL', 'TIS'], discount: 0.5 },
    '77A':  { stations: ['LOP', 'YUL', 'TIS'], discount: 0.5 },
    '77B':  { stations: ['LOP', 'YUL'], discount: 0.5 },
    '79S':  { stations: ['YUL', 'TIS'], discount: 0.5 },
    '601':  { stations: ['YUL', 'LOP'], discount: 0.5 },
    '602':  { stations: ['YUL', 'LOP'], discount: 0.5 },
    '603':  { stations: ['YUL', 'LOP'], discount: 0.5 },
    '604':  { stations: ['YUL', 'LOP'], discount: 0.5 },
    '608':  { stations: ['YUL'], discount: 0.5 },
    '609':  { stations: ['YUL'], discount: 0.5 },
    '20C':  { stations: ['TAP'], discount: 0.5 },
    '20K':  { stations: ['TAP'], discount: 0.5 },
    '44':   { stations: ['TUM', 'SIH'], discount: 0.5 },
    '44A':  { stations: ['SHS', 'TUM'], discount: 0.5 },
    '101M': { stations: ['HAH'], discount: 0.5 },
    '102':  { stations: ['HAH', 'POA'], discount: 0.5 },
    '108M': { stations: ['TKO'], discount: 0.5 },
    '113':  { stations: ['HAH', 'LHP'], discount: 0.5 },
    '407':  { stations: ['TSY', 'KWF'], discount: 0.5 },
    '409':  { stations: ['TSY', 'TWW'], discount: 0.5 },
    '807A': { stations: ['UNI', 'MOS'], discount: 0.5 },
    '807B': { stations: ['UNI', 'MOS'], discount: 0.5 },
    // Hong Kong Island feeders (Central / HK / Admiralty / Kennedy Town / Cyberport / Southern)
    '8':    { stations: ['CEN', 'HOK'], discount: 0.5 },
    '8X':   { stations: ['CEN', 'HOK'], discount: 0.5 },
    '10':   { stations: ['CEN', 'HOK', 'ADM'], discount: 0.5 },
    '28':   { stations: ['CEN', 'HOK', 'ADM', 'CAB'], discount: 0.5 },
    '31':   { stations: ['CEN', 'HOK', 'ADM'], discount: 0.5 },
    '39M':  { stations: ['WCH', 'SOH'], discount: 0.5 },
    '54M':  { stations: ['KET'], discount: 0.5 },
    '55':   { stations: ['CEN', 'HOK'], discount: 0.5 },
    '56':   { stations: ['CEN', 'HOK', 'ADM', 'CAB'], discount: 0.5 },
    '58':   { stations: ['KET'], discount: 0.5 },
    '59A':  { stations: ['SOH', 'WCH'], discount: 0.5 },
    // Kowloon feeders
    '27M':  { stations: ['MOK', 'PRE'], discount: 0.5 },
    '85':   { stations: ['SHT', 'DIH'], discount: 0.5 },
    '86':   { stations: ['KOT', 'WHA'], discount: 0.5 }
  },

  getMtrGmbInterchangeDiscount(company, routeNo, mtrStationCode = '') {
    if (!String(company || '').toUpperCase().startsWith('GMB')) return 0;
    const r = String(routeNo || '').trim().toUpperCase();
    const st = resolveMtrStationCode(mtrStationCode) || String(mtrStationCode || '').trim().toUpperCase();
    const rule = this.GMB_INTERCHANGE_DISCOUNTS[r];
    if (rule) {
      if (!st || !Array.isArray(rule.stations) || rule.stations.includes(st)) {
        return Number(rule.discount) || 0.5;
      }
    }
    // Baseline Hong Kong PTFSS MTR–GMB Octopus interchange discount ($0.30)
    return 0.3;
  },

  checkFareSaverAtOrigin(lat, lon, entryStaCode, destStaCode = '') {
    const la = Number(lat), lo = Number(lon);
    const entry = resolveMtrStationCode(entryStaCode) || String(entryStaCode || '').trim().toUpperCase();
    const dest = resolveMtrStationCode(destStaCode) || String(destStaCode || '').trim().toUpperCase();
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !entry) return null;
    if (this.RULES.exclusions.crossBoundary.has(dest) || this.RULES.exclusions.airportExpress.has(dest) || this.RULES.exclusions.airportExpress.has(entry)) {
      return null;
    }
    for (const fs of this.FARE_SAVERS) {
      if (!fs.targetStations.includes(entry)) continue;
      if (_haversineKm(la, lo, fs.lat, fs.lon) <= 0.14) return fs;
    }
    return null;
  },

  lookupExactHeavyRailFare(origCode, destCode, matrixLookupFn = null) {
    const a = resolveMtrStationCode(origCode) || String(origCode || '').trim().toUpperCase();
    const b = resolveMtrStationCode(destCode) || String(destCode || '').trim().toUpperCase();
    if (!a || !b) return 0;
    if (a === b) return 5.0;

    const aelFare = this.AEL_FARES[`${a}_${b}`];
    if (aelFare > 0) return aelFare;

    if (typeof matrixLookupFn === 'function') {
      const exact = Number(matrixLookupFn(a, b) || 0);
      if (exact > 0) return Number(exact.toFixed(1));
    } else if (typeof window !== 'undefined' && typeof window.getExactMtrFare === 'function') {
      const exact = Number(window.getExactMtrFare(a, b) || 0);
      if (exact > 0) return Number(exact.toFixed(1));
    }

    const stA = MTR_STATION_DIRECTORY[a], stB = MTR_STATION_DIRECTORY[b];
    if (!stA || !stB) return 0;
    const dKm = _haversineKm(stA.lat, stA.lon, stB.lat, stB.lon);
    const isCrossBoundary = this.RULES.exclusions.crossBoundary.has(a) || this.RULES.exclusions.crossBoundary.has(b);
    const isIslandA = stA.lat < 22.293 && stA.lon >= 114.115 && stA.lon <= 114.265;
    const isIslandB = stB.lat < 22.293 && stB.lon >= 114.115 && stB.lon <= 114.265;
    const crossesHarbour = (isIslandA !== isIslandB);

    if (isCrossBoundary) {
      return Number(Math.min(65.4, Math.max(26.5, 25.0 + dKm * 1.15 + (crossesHarbour ? 6.5 : 0))).toFixed(1));
    }
    let est = 4.9 + dKm * 0.92 + (crossesHarbour ? 4.8 : 0);
    if (a === 'TUC' || b === 'TUC') est = Math.max(est, 16.5 + (crossesHarbour ? 6.5 : 0));
    if (a === 'DIS' || b === 'DIS') est = Math.max(est, 14.5 + (crossesHarbour ? 6.5 : 0));
    return Number(Math.min(34.0, Math.max(4.9, est)).toFixed(1));
  },

  calculateFirstClassSurcharge(ealFromCode, ealToCode, matrixLookupFn = null) {
    const a = resolveMtrStationCode(ealFromCode) || String(ealFromCode || '').trim().toUpperCase();
    const b = resolveMtrStationCode(ealToCode) || String(ealToCode || '').trim().toUpperCase();
    if (!a || !b || a === b) return 0;
    const ealStd = this.lookupExactHeavyRailFare(a, b, matrixLookupFn);
    return Number(Math.max(4.9, ealStd).toFixed(1));
  },

  evaluateRailChain(railLegs, options = {}) {
    if (!Array.isArray(railLegs) || !railLegs.length) {
      return { status: 'EMPTY', totalFare: 0, totalTimeSec: 0 };
    }
    if (options.searchDate && this.isClosedAt(options.searchDate, Boolean(options.isOvernightHoliday))) {
      return { status: 'CLOSED', error: 'MTR is not operating at this time.', totalFare: 0, totalTimeSec: 0 };
    }

    const matrixFn = options.matrixLookupFn || null;
    const isHeavy = (l) => l && l.company !== 'LRT' && l.line !== 'LRT';
    const heavyLegs = railLegs.filter(isHeavy);
    const lrtLegs = railLegs.filter(l => !isHeavy(l));

    let totalTimeSec = 0;
    const firstLeg = railLegs[0];
    const lastLeg = railLegs[railLegs.length - 1];
    if (isHeavy(firstLeg)) totalTimeSec += this.getStationDepthSec(firstLeg.from);

    for (let i = 0; i < railLegs.length; i++) {
      const leg = railLegs[i];
      if (Number.isFinite(leg.driveSec) && leg.driveSec > 0) {
        totalTimeSec += leg.driveSec;
      } else if (Array.isArray(leg.stopsSeq) && leg.stopsSeq.length >= 2) {
        for (let k = 0; k < leg.stopsSeq.length - 1; k++) {
          totalTimeSec += this.getAdjacentRunningTimeSec(leg.stopsSeq[k], leg.stopsSeq[k + 1]);
        }
      } else {
        totalTimeSec += this.getAdjacentRunningTimeSec(leg.from, leg.to);
      }

      const hwSec = (leg.line === 'AEL' || leg.line === 'DRL') ? 600 : (leg.company === 'LRT' ? 420 : 210);
      totalTimeSec += Math.round(hwSec / 2);

      if (i < railLegs.length - 1) {
        const nextLeg = railLegs[i + 1];
        const xferSec = Number.isFinite(leg.walkAfterSec) && leg.walkAfterSec > 0
          ? leg.walkAfterSec
          : this.getInterchangeWalkSec(leg.to, leg.line, nextLeg.line, nextLeg.from);
        totalTimeSec += xferSec;
      }
    }
    if (isHeavy(lastLeg)) totalTimeSec += this.getStationDepthSec(lastLeg.to);

    let totalFare = 0;
    let fareSaverApplied = null;
    let osiSplitApplied = false;

    if (heavyLegs.length > 0) {
      const absOrigin = resolveMtrStationCode(heavyLegs[0].from) || String(heavyLegs[0].from || '').toUpperCase();
      const absDest = resolveMtrStationCode(heavyLegs[heavyLegs.length - 1].to) || String(heavyLegs[heavyLegs.length - 1].to || '').toUpperCase();

      let splitIdx = -1;
      for (let i = 0; i < heavyLegs.length - 1; i++) {
        const a = resolveMtrStationCode(heavyLegs[i].to) || String(heavyLegs[i].to || '').toUpperCase();
        const b = resolveMtrStationCode(heavyLegs[i + 1].from) || String(heavyLegs[i + 1].from || '').toUpperCase();
        if ((a === 'TST' && b === 'ETS') || (a === 'ETS' && b === 'TST')) {
          const walkMins = ((heavyLegs[i].walkAfterSec || this.INTERCHANGE_TIME.TST_ETS_OSI) / 60);
          if (walkMins > this.RULES.osi.tstEtsLimitMins) {
            splitIdx = i;
            osiSplitApplied = true;
            break;
          }
        }
      }

      if (splitIdx >= 0) {
        const f1 = this.lookupExactHeavyRailFare(absOrigin, heavyLegs[splitIdx].to, matrixFn);
        const f2 = this.lookupExactHeavyRailFare(heavyLegs[splitIdx + 1].from, absDest, matrixFn);
        totalFare = f1 + f2;
      } else if (absOrigin === absDest) {
        totalFare = totalTimeSec <= this.RULES.bylaws.sameStationShortSecs
          ? 5.0
          : this.RULES.bylaws.sameStationLongPenaltyHkd;
      } else {
        totalFare = this.lookupExactHeavyRailFare(absOrigin, absDest, matrixFn);
      }

      if (totalTimeSec > this.RULES.bylaws.maxPaidAreaSecs && totalFare < this.RULES.bylaws.maxOverstayFareHkd) {
        totalFare = this.RULES.bylaws.maxOverstayFareHkd;
      }

      if (options.isFirstClass) {
        const ealLeg = heavyLegs.find(l => String(l.line || '').toUpperCase() === 'EAL');
        if (ealLeg) {
          totalFare += this.calculateFirstClassSurcharge(ealLeg.from, ealLeg.to, matrixFn);
        }
      }

      if (Number.isFinite(options.originLat) && Number.isFinite(options.originLon)) {
        const fs = this.checkFareSaverAtOrigin(options.originLat, options.originLon, absOrigin, absDest);
        if (fs) {
          fareSaverApplied = fs;
          totalFare = Math.max(0, totalFare - fs.discount);
        }
      }
    }

    if (lrtLegs.length > 0) {
      let lrtRawFare = 0;
      for (const ll of lrtLegs) {
        lrtRawFare += Number(ll.lrtFareHkd || 5.2);
      }
      if (heavyLegs.length > 0) {
        const touchesNwntHub = heavyLegs.some(hl =>
          this.RULES.lrtInterchange.stations.has(resolveMtrStationCode(hl.from) || hl.from) ||
          this.RULES.lrtInterchange.stations.has(resolveMtrStationCode(hl.to) || hl.to)
        );
        if (touchesNwntHub) {
          const deduction = Math.min(lrtRawFare, this.RULES.lrtInterchange.maxDeductionHkd);
          totalFare += Math.max(0, lrtRawFare - deduction);
        } else {
          totalFare += lrtRawFare;
        }
      } else {
        totalFare += lrtRawFare;
      }
    }

    return {
      status: 'OK',
      totalFare: Number(totalFare.toFixed(1)),
      totalTimeSec: Math.round(totalTimeSec),
      totalTimeMins: Math.ceil(totalTimeSec / 60),
      fareSaverApplied: fareSaverApplied ? fareSaverApplied.id : null,
      osiSplitApplied
    };
  }
};

function computeSharedBikeFareHkd(rideSecs = 0, distM = 0) {
  const dM = Math.max(0, Number(distM) || 0);
  const secs = Number(rideSecs) > 0
    ? Number(rideSecs)
    : (dM > 0 ? Math.round(dM / SHARED_BIKE_PRICING.speedMps) : 0);
  if (secs <= 0 && dM <= 0) return 0;
  const rideMins = Math.max(1, secs / 60);
  const blocks = Math.max(1, Math.ceil(rideMins / SHARED_BIKE_PRICING.blockMins));
  return Number((blocks * SHARED_BIKE_PRICING.ratePerBlockHkd).toFixed(1));
}

const LoadFactorEngine = {
  _toBand(pct, mode = 'BUS') {
    const p = Math.max(8, Math.min(99, Math.round(pct)));
    if (p < 48) {
      return {
        pct: p,
        tier: 'LOW',
        cssClass: 'load-low',
        labelEn: 'Seats',
        labelTc: mode === 'MTR' ? '寬鬆' : '有位',
        isSkipRisk: false,
        isStandingOrWorse: false
      };
    }
    if (p < 75) {
      return {
        pct: p,
        tier: 'MED',
        cssClass: 'load-med',
        labelEn: mode === 'FERRY' ? 'Busy' : 'Standing',
        labelTc: mode === 'FERRY' ? '適中' : (mode === 'MTR' ? '一般' : '企位'),
        isSkipRisk: false,
        isStandingOrWorse: mode !== 'FERRY'
      };
    }
    if (p < 90) {
      return {
        pct: p,
        tier: 'HIGH',
        cssClass: 'load-high',
        labelEn: 'Packed',
        labelTc: '擠迫',
        isSkipRisk: false,
        isStandingOrWorse: true
      };
    }
    return {
      pct: p,
      tier: 'FULL',
      cssClass: 'load-full',
      labelEn: mode === 'MTR' ? 'Very Crowded' : 'Near Full',
      labelTc: mode === 'MTR' ? '非常擠迫' : '近乎客滿',
      isSkipRisk: true,
      isStandingOrWorse: true
    };
  },

  _getPeriodProfile(dateObj, isHoliday = false) {
    const d = (dateObj && typeof dateObj.getHours === 'function' && typeof dateObj.getDay === 'function')
      ? dateObj
      : new Date();
    const mins = d.getHours() * 60 + d.getMinutes();
    const day = d.getDay();
    const isHolOrSun = Boolean(isHoliday) || day === 0;
    const isSat = !isHolOrSun && day === 6;
    const dayType = isHolOrSun ? 'HOLIDAY' : (isSat ? 'SATURDAY' : 'WEEKDAY');

    const bell = (centerMin, halfWidthMin) => {
      const z = (mins - centerMin) / Math.max(1, halfWidthMin);
      return Math.exp(-0.5 * z * z);
    };

    // Tourist outing window: zero tourists before 08:30 or from 19:00 onward
    const isTouristWindow = mins >= 510 && mins < 1140;
    const touristWave = isTouristWindow
      ? bell(795, 135) * (dayType === 'HOLIDAY' ? 1.0 : (dayType === 'SATURDAY' ? 0.92 : 0.38))
      : 0;
    const isEveningQuiet = mins >= 1170 || mins < 390; // >=19:30 or <06:30

    if (mins >= 1350 || mins < 360) {
      return {
        period: 'LATE',
        dayType,
        mins,
        baseBusPct: isHolOrSun ? 15 : 17,
        baseMtrPct: isHolOrSun ? 17 : 19,
        baseFerryPct: isHolOrSun ? 14 : 16,
        isPeak: false,
        isAmPeak: false,
        isPmPeak: false,
        isEveningQuiet: true,
        touristWave: 0,
        peakWave: 0
      };
    }

    if (dayType === 'WEEKDAY') {
      const amWave = bell(505, 45);      // 08:25 AM peak (07:40–09:10)
      const lunchWave = bell(785, 50);   // 13:05 lunch wave
      const pmWave = bell(1100, 50);     // 18:20 PM peak (17:30–19:10)
      const eveSocial = (mins >= 1140 && mins < 1350) ? bell(1170, 50) * 0.45 : 0;
      const peakWave = Math.max(amWave, pmWave);
      const isAmPeak = amWave >= 0.48;
      const isPmPeak = pmWave >= 0.48;
      const isPeak = isAmPeak || isPmPeak;

      const baseBusPct = Math.round(22 + amWave * 32 + pmWave * 33 + lunchWave * 13 + eveSocial * 9);
      const baseMtrPct = Math.round(26 + amWave * 36 + pmWave * 37 + lunchWave * 14 + eveSocial * 11);
      const baseFerryPct = Math.round(18 + amWave * 24 + pmWave * 25 + lunchWave * 8);
      const period = isPeak ? 'PEAK' : (lunchWave >= 0.5 ? 'BUSY' : 'OFF_PEAK');
      return {
        period,
        dayType,
        mins,
        baseBusPct,
        baseMtrPct,
        baseFerryPct,
        isPeak,
        isAmPeak,
        isPmPeak,
        isEveningQuiet,
        touristWave,
        peakWave
      };
    }

    if (dayType === 'SATURDAY') {
      const midWave = bell(855, 130);    // 14:15 shopping & outing plateau
      const eveWave = bell(1110, 75);    // 18:30 dining/evening, tapers sharply after 20:00
      const baseBusPct = Math.max(17, Math.round(20 + Math.max(midWave * 24, eveWave * 21) - (mins >= 1200 ? 2 : 0)));
      const baseMtrPct = Math.max(20, Math.round(24 + Math.max(midWave * 27, eveWave * 24) - (mins >= 1200 ? 2 : 0)));
      const baseFerryPct = Math.max(15, Math.round(18 + Math.max(midWave * 23, eveWave * 16) - (mins >= 1200 ? 3 : 0)));
      const isBusy = Math.max(midWave, eveWave) >= 0.55;
      return {
        period: isBusy ? 'BUSY' : 'OFF_PEAK',
        dayType,
        mins,
        baseBusPct,
        baseMtrPct,
        baseFerryPct,
        isPeak: false,
        isAmPeak: false,
        isPmPeak: false,
        isEveningQuiet,
        touristWave,
        peakWave: Math.max(midWave, eveWave) * 0.6
      };
    }

    // Sunday / Public Holiday: very quiet <09:00 and >=19:30; focused midday–late afternoon outing wave
    const holWave = bell(865, 130);      // 14:25 afternoon leisure wave (~0.02 at 08:00 & ~0.04 at 20:00)
    const holReturn = bell(1045, 70);    // 17:25 return wave (~0.11 at 20:00)
    const eveWindDown = mins >= 1170 ? 3 : 0;
    const baseBusPct = Math.max(15, Math.round(18 + Math.max(holWave * 24, holReturn * 16) - eveWindDown));
    const baseMtrPct = Math.max(17, Math.round(21 + Math.max(holWave * 26, holReturn * 18) - Math.min(2, eveWindDown)));
    const baseFerryPct = Math.max(14, Math.round(16 + Math.max(holWave * 24, holReturn * 17) - eveWindDown));
    const isBusy = Math.max(holWave, holReturn) >= 0.55;
    return {
      period: isBusy ? 'BUSY' : 'OFF_PEAK',
      dayType,
      mins,
      baseBusPct,
      baseMtrPct,
      baseFerryPct,
      isPeak: false,
      isAmPeak: false,
      isPmPeak: false,
      isEveningQuiet,
      touristWave,
      peakWave: Math.max(holWave, holReturn) * 0.55
    };
  },

  _inferMtrPeakDirectionBias(lineCode, opts, prof) {
    const destC = String(opts.destCode || '').toUpperCase();
    const destStr = String(opts.destName || '').toLowerCase();
    const dirC = String(opts.dirCode || '').toUpperCase();

    if (lineCode === 'DRL') {
      const toDis = destC === 'DIS' || /disneyland|迪士尼/i.test(destStr) || dirC === 'O';
      const toSun = destC === 'SUN' || /sunny bay|欣澳/i.test(destStr) || dirC === 'I';
      if (toDis && prof.mins >= 555 && prof.mins <= 705) return 18; // 09:15–11:45 park opening
      if (toSun && prof.mins >= 1215 && prof.mins <= 1305) return 26; // 20:15–21:45 post-fireworks exit
      return -10;
    }

    if (!prof.isPeak) return 0;

    const isInboundCbd = (
      (lineCode === 'TCL' && (destC === 'HOK' || /hong kong|香港/.test(destStr) || dirC === 'I')) ||
      (lineCode === 'TML' && (destC === 'WKS' || /wu kai sha|hung hom|mei foo|nam cheong|紅磡|烏溪沙/.test(destStr)) && !/tuen mun|屯門/.test(destStr)) ||
      (lineCode === 'EAL' && (destC === 'ADM' || destC === 'EXC' || destC === 'HUH' || /admiralty|hung hom|金鐘|紅磡/.test(destStr) || dirC === 'I')) ||
      (lineCode === 'TWL' && (destC === 'CEN' || /central|中環/.test(destStr) || dirC === 'I')) ||
      (lineCode === 'KTL' && (destC === 'WHA' || /whampoa|ho man tin|黃埔/.test(destStr))) ||
      (lineCode === 'TKL' && (destC === 'NOP' || /north point|北角/.test(destStr) || dirC === 'I')) ||
      (lineCode === 'ISL' && (destC === 'KET' || destC === 'CEN' || /kennedy town|central|堅尼地城|中環/.test(destStr))) ||
      (lineCode === 'SIL' && (destC === 'ADM' || /admiralty|金鐘/.test(destStr)))
    );
    const isOutboundSuburb = (
      (lineCode === 'TCL' && (destC === 'TUC' || /tung chung|東涌/.test(destStr) || dirC === 'O')) ||
      (lineCode === 'TML' && (destC === 'TUM' || /tuen mun|屯門/.test(destStr))) ||
      (lineCode === 'EAL' && (destC === 'LOW' || destC === 'LMC' || /lo wu|lok ma chau|羅湖|落馬洲/.test(destStr) || dirC === 'O')) ||
      (lineCode === 'TWL' && (destC === 'TSW' || /tsuen wan|荃灣/.test(destStr) || dirC === 'O')) ||
      (lineCode === 'TKL' && (destC === 'POA' || destC === 'LHP' || /po lam|lohas|寶琳|康城/.test(destStr) || dirC === 'O')) ||
      (lineCode === 'SIL' && (destC === 'SOH' || /south horizons|海怡/.test(destStr)))
    );

    if (prof.isAmPeak) {
      if (isInboundCbd) return 10;
      if (isOutboundSuburb) return -8;
    } else if (prof.isPmPeak) {
      if (isOutboundSuburb) return 10;
      if (isInboundCbd) return -7;
    }
    return 0;
  },

  inferBusLoad(opts = {}) {
    const g = opts.group;
    if (!g || g.mode === 'FERRY' || g.mode === 'MTR') return null;

    const co = String(g.company || '').toUpperCase();
    const rNo = String(g.routeNo || '').toUpperCase();
    const isGmb = co.startsWith('GMB');
    const isLantauRural = (co === 'NLB' && /^(1|2|3M|4|11|11A|21|23|34|36)$/.test(rNo));
    const isLantauTrunk = (co === 'NLB' && /^(3M|11|11A)$/.test(rNo));
    const isLantauVillage = isLantauRural && !isLantauTrunk;
    const isTouristLeisure = isLantauRural || /^(6|6A|6X|15|X15|65|73|91|91R|92|94|96R|99|260|289R|973|1A|101M)$/.test(rNo);
    const isAirportLink = /^(A\d+|E\d+|S\d+|B\d+)[A-Z]?$/.test(rNo);
    const isNightRoute = /^N\d+/.test(rNo);
    const isSingleDeck = isGmb || isLantauRural;
    const isHighwayTrunk = /^(1\d{2}|6\d{2}|9\d{2}|E\d{2}|A\d{2}|268|269|277|278|960|968|978)/.test(rNo);
    const isIndustrialFeeder = /^(74|74A|K66|K68|K73|K74|268A|611)$/.test(rNo);

    const prof = this._getPeriodProfile(opts.dateObj, opts.isHoliday);
    let score = prof.baseBusPct;
    if (isLantauVillage) {
      // Rural South Lantau buses (1, 2, 4, 21, 23, 34, 36) stay calm on weekday mornings and do not mirror urban crush peaks
      score = Math.round(18 + Math.max(0, prof.baseBusPct - 18) * 0.25);
    } else if (isLantauTrunk) {
      // NLB 3M / 11 connecting Tung Chung MTR see modest weekday rush, still well below urban double-deck crush levels
      score = Math.round(20 + Math.max(0, prof.baseBusPct - 20) * 0.45);
    }

    // Night routes peak gently around 00:00–01:45 and thin out pre-dawn
    if (isNightRoute) {
      score += (prof.mins < 110) ? 10 : -4;
    }

    // Demand-scaled capacity effect (19-seat GMB fills fast at high demand, stays light when quiet)
    if (isGmb) {
      score += Math.round(Math.max(4, (prof.baseBusPct - 10) * 0.50));
    } else if (isSingleDeck && !isLantauRural && prof.baseBusPct > 26) {
      score += Math.round((prof.baseBusPct - 26) * 0.28);
    }

    // Tourist & rural leisure directionality — strictly zero tourists <08:30 or >=19:00
    const origStr = String(opts.origName || g.orig_e || '').toLowerCase();
    const destStr = String(opts.destName || g.dest_e || '').toLowerCase();
    const isToTouristSpot = /tai o|ngong ping|po lin|big buddha|stanley|repulse|peak|sai kung|wong shek|hoi ha|cheung sha|pui o|tong fuk|shui hau|大澳|昂坪|寶蓮|赤柱|淺水灣|山頂|西貢|長沙|貝澳|塘福|水口/.test(destStr);
    const isToUrbanHub = /tung chung|mui wo|central|admiralty|exchange|diamond hill|hang hau|choi hung|東涌|梅窩|中環|金鐘|鑽石山|坑口|彩虹/.test(destStr);
    const isFromTouristSpot = isToUrbanHub && /tai o|ngong ping|stanley|repulse|peak|sai kung|tong fuk|shui hau|pui o|cheung sha|大澳|昂坪|赤柱|淺水灣|山頂|西貢|塘福|水口|貝澳|長沙/.test(origStr);

    if (isTouristLeisure) {
      if (prof.touristWave > 0.08) {
        if (prof.mins < 870) {
          score += isToTouristSpot ? Math.round(prof.touristWave * 22) : (isFromTouristSpot ? -5 : Math.round(prof.touristWave * 8));
        } else {
          score += isFromTouristSpot ? Math.round(prof.touristWave * 22) : (isToTouristSpot ? -7 : Math.round(prof.touristWave * 8));
        }
      } else {
        // Non-tourist window (<08:30 or >=19:00)
        if (isLantauRural) {
          if (prof.dayType === 'WEEKDAY' && prof.mins >= 440 && prof.mins <= 550) {
            score += isLantauVillage ? (isToUrbanHub ? 3 : -6) : (isToUrbanHub ? 6 : -6);
          } else {
            score -= (prof.isEveningQuiet || prof.dayType === 'HOLIDAY') ? 4 : 2;
          }
        }
      }
    }

    if (isAirportLink && co === 'NLB' && (prof.isEveningQuiet || (prof.dayType === 'HOLIDAY' && prof.mins < 540))) {
      score -= 5;
    }

    // Industrial estate feeders peak during Mon–Fri commute, light on Sundays/Holidays
    if (isIndustrialFeeder) {
      if (prof.isPeak) score += 11;
      else if (prof.dayType === 'HOLIDAY') score -= 9;
    }

    // 1. Stop-sequence progression curve scaled by period demand wave
    const stopIdx = Number.isFinite(opts.stopIdx) ? opts.stopIdx : 0;
    const totalStops = Math.max(2, Number(opts.totalStops) || 12);
    const ratio = stopIdx / Math.max(1, totalStops - 1);
    const effectiveBase = isLantauRural ? Math.max(18, score) : prof.baseBusPct;
    const demandWaveMult = Math.max(0.25, Math.min(1.25, (effectiveBase - 12) / 34));
    if (stopIdx <= 1) {
      score -= 16;
    } else if (ratio >= 0.24 && ratio <= 0.78) {
      const midBump = isLantauVillage
        ? 4
        : (isLantauTrunk
          ? (prof.isPeak ? 6 : 3)
          : (prof.isPeak ? 12 : ((isLantauRural && (prof.isEveningQuiet || prof.mins < 540)) ? 2 : 7)));
      score += Math.round(midBump * demandWaveMult);
    } else if (ratio > 0.85) {
      score -= 11;
    }

    const stopLabel = `${opts.stopObj?.stopName_e || ''} ${opts.stopObj?.name_tc || ''}`;
    const isMajorBbi = Boolean(opts.stopObj && typeof getMajorBbiHubMatch === 'function' && getMajorBbiHubMatch(opts.stopObj));
    const isHubBoard = isMajorBbi || /\bmtr\b|station|ferry\s*pier|bus\s*terminus|站|碼頭|轉車站/i.test(stopLabel);
    if (isMajorBbi) {
      score += Math.round((prof.isPeak ? 12 : 7) * demandWaveMult);
    } else if (isHubBoard && stopIdx > 0) {
      score += Math.round((prof.isPeak ? 7 : 4) * demandWaveMult);
    }

    if (isHighwayTrunk && prof.isPeak) {
      score += 8;
    }

    // 2. Period-calibrated Headway Expansion Ratio (prevents normal sparse evening/rural headways from looking like delayed surges)
    const corStatus = String(opts.corridorStatus || 'SMOOTH').toUpperCase();
    const isSchedOnly = Boolean(opts.isSched);
    const obsHw = Number(opts.obsHeadwaySec || 0);
    const minRuralHwSec = isLantauVillage ? 1800 : (isLantauTrunk ? 1500 : 180);
    const rawSchedHw = Math.max(
      minRuralHwSec,
      Number(opts.expectedHeadwaySec || 0),
      Number(opts.medianHeadwaySec || 0),
      Number(opts.schedHeadwaySec || ((Number(g.headwayMins) || (isLantauRural ? 25 : 12)) * 60))
    );
    const periodHwMult = prof.isEveningQuiet
      ? (isLantauRural ? 1.35 : 1.35)
      : (!prof.isPeak ? (isLantauRural ? 1.15 : 1.10) : 1.0);
    const trailingHw = Number(opts.trailingHeadwaySec || 0);
    const schedHw = Math.max(rawSchedHw * periodHwMult, trailingHw > 180 ? trailingHw * 0.85 : 0);
    const wideGapFloorSec = Math.max(1200, schedHw * 1.6);

    const hasLiveGapSignal = (obsHw > 60 && schedHw > 0 && !(isSchedOnly && corStatus === 'INCIDENT') && !isSchedOnly);
    if (hasLiveGapSignal) {
      const hwRatio = obsHw / schedHw;
      const gapScale = Math.max(0.28, Math.min(1.15, (isLantauRural ? effectiveBase : prof.baseBusPct) / 42));
      if (obsHw >= wideGapFloorSec && hwRatio >= 2.0) score += Math.round(27 * gapScale);
      else if (obsHw >= wideGapFloorSec) score += Math.round(19 * gapScale);
      else if (!isLantauRural && obsHw >= 1080 && hwRatio >= 1.45) score += Math.round(10 * gapScale);
      else if (hwRatio <= 0.62) score -= 14;
      else if (hwRatio <= 0.78) score -= 7;
    }

    // 3. Live ETA-Drift Residual Dwell normalized by corridor road speed
    const driftSec = Number(opts.etaDriftSec || 0);
    if (driftSec >= 40 && !isSchedOnly) {
      if (corStatus === 'SMOOTH') {
        score += Math.min(20, Math.round((driftSec - 30) * 0.26));
      } else {
        score += Math.min(7, Math.round((driftSec - 30) * 0.08));
      }
    }

    // 4. Live HKO Weather Demand Surge (typhoon/heavy rain dampens rural holiday leisure, boosts urban buses)
    const wx = opts.weather || (typeof window !== 'undefined' ? window.__HKO_WEATHER__ : null);
    if (wx?.typhoon) score += 22;
    else if (wx?.heavyRain) score += (isLantauRural && prof.dayType === 'HOLIDAY' ? 4 : 18);
    else if (wx?.rainAdvisory) score += (isLantauRural && prof.dayType === 'HOLIDAY' ? 2 : 10);

    const band = this._toBand(score, 'BUS');
    const basis = (hasLiveGapSignal || (driftSec >= 40 && !isSchedOnly)) ? 'LIVE_GAP' : 'SCHEDULE_PROFILE';
    const confidence = hasLiveGapSignal ? 'HIGH' : (driftSec >= 40 && !isSchedOnly ? 'MEDIUM' : 'BASELINE');

    let tipEn = '', tipTc = '';
    if (stopIdx > 0) {
      if (isGmb && band.pct >= 75) {
        tipEn = '19-seat GMB — high chance of full/skip';
        tipTc = '19座小巴 — 較大機會客滿飛站';
      } else if (band.isSkipRisk) {
        tipEn = 'High load inferred — check next departure';
        tipTc = '推算載客率偏高 — 可留意下一班車';
      } else if (basis === 'LIVE_GAP' && obsHw >= wideGapFloorSec && band.pct >= 55) {
        tipEn = 'Wider live gap than scheduled — heavier boarding likely';
        tipTc = '實時班距較正常寬 — 候車人數可能較多';
      }
    }

    const baseResult = {
      ...band,
      mode: 'BUS',
      capacityPax: isGmb ? 19 : (isSingleDeck ? 65 : 130),
      basis,
      confidence,
      dayType: prof.dayType,
      tipEn,
      tipTc,
      firstClassWarning: false
    };

    if (opts.skipGlobalSurge) {
      return baseResult;
    }

    const baseEtaEntry = opts.etaEntry && typeof opts.etaEntry === 'object'
      ? { ...opts.etaEntry }
      : {};
    if (baseEtaEntry.etaSpacing === undefined && (Number.isFinite(Number(opts.etaSpacing)) || Number.isFinite(Number(opts.etaSpacingSec)))) {
      baseEtaEntry.etaSpacing = opts.etaSpacing ?? opts.etaSpacingSec;
    }
    if (baseEtaEntry.isHoliday === undefined && typeof opts.isHoliday === 'boolean') {
      baseEtaEntry.isHoliday = opts.isHoliday;
    }
    if (baseEtaEntry.isSchoolHoliday === undefined && typeof opts.isSchoolHoliday === 'boolean') {
      baseEtaEntry.isSchoolHoliday = opts.isSchoolHoliday;
    }
    if (!baseEtaEntry.stopName && opts.stopObj?.stopName_e) {
      baseEtaEntry.stopName = opts.stopObj.stopName_e;
    }
    if (!baseEtaEntry.name_tc && opts.stopObj?.name_tc) {
      baseEtaEntry.name_tc = opts.stopObj.name_tc;
    }
    if (baseEtaEntry.totalStops === undefined && Number.isFinite(Number(opts.totalStops))) {
      baseEtaEntry.totalStops = Number(opts.totalStops);
    }
    if (baseEtaEntry.obsHeadwaySec === undefined && Number.isFinite(Number(opts.obsHeadwaySec)) && Number(opts.obsHeadwaySec) > 0) {
      baseEtaEntry.obsHeadwaySec = Number(opts.obsHeadwaySec);
    }
    if (baseEtaEntry.schedHeadwaySec === undefined && Number.isFinite(Number(opts.schedHeadwaySec)) && Number(opts.schedHeadwaySec) > 0) {
      baseEtaEntry.schedHeadwaySec = Number(opts.schedHeadwaySec);
    }
    if (baseEtaEntry.expectedHeadwaySec === undefined && Number.isFinite(Number(opts.expectedHeadwaySec)) && Number(opts.expectedHeadwaySec) > 0) {
      baseEtaEntry.expectedHeadwaySec = Number(opts.expectedHeadwaySec);
    }
    if (baseEtaEntry.medianHeadwaySec === undefined && Number.isFinite(Number(opts.medianHeadwaySec)) && Number(opts.medianHeadwaySec) > 0) {
      baseEtaEntry.medianHeadwaySec = Number(opts.medianHeadwaySec);
    }
    if (baseEtaEntry.etaIdx === undefined && Number.isFinite(Number(opts.etaIdx))) {
      baseEtaEntry.etaIdx = Number(opts.etaIdx);
    }
    if (baseEtaEntry.prevBusGapSec === undefined && Number.isFinite(Number(opts.prevBusGapSec))) {
      baseEtaEntry.prevBusGapSec = Number(opts.prevBusGapSec);
    }
    if (baseEtaEntry.nextBusGapSec === undefined && Number.isFinite(Number(opts.nextBusGapSec))) {
      baseEtaEntry.nextBusGapSec = Number(opts.nextBusGapSec);
    }
    const etaEntry = Object.keys(baseEtaEntry).length > 0 ? baseEtaEntry : null;
    const nowMs = Number.isFinite(Number(opts.nowMs))
      ? Number(opts.nowMs)
      : (opts.dateObj instanceof Date && !Number.isNaN(opts.dateObj.getTime())
        ? opts.dateObj.getTime()
        : Date.now());

    return estimateBusSeatStatus(g, stopIdx, etaEntry, {
      baseLoad: baseResult,
      weather: wx,
      nowMs,
      stopKey: opts.stopKey || opts.stopObj?.stopKey || '',
      stopObj: opts.stopObj
    });
  },

  inferMtrLoad(opts = {}) {
    const isLrt = Boolean(opts.isLrt || opts.company === 'LRT');
    const lineCode = isLrt ? 'LRT' : String(opts.lineCode || '').trim().toUpperCase();
    const fleet = MTR_FLEET_CONFIG[lineCode] || MTR_FLEET_CONFIG.TWL;
    const staCode = resolveMtrStationCode(opts.staCode) || String(opts.staCode || '').trim().toUpperCase();
    const prof = this._getPeriodProfile(opts.dateObj, opts.isHoliday);

    let score = lineCode === 'DRL' ? (prof.mins >= 1350 || prof.mins < 480 ? 14 : 24) : prof.baseMtrPct;
    if (fleet.allSeated) score = Math.min(score, 32); // AEL dedicated seated express

    // 1. Directional & line-specific demand asymmetry (incl. DRL Disney waves)
    if (!isLrt && !fleet.allSeated) {
      score += this._inferMtrPeakDirectionBias(lineCode, opts, prof);
    }

    // 2. EAL 9-Car First Class isolation (8 standard cars + cross-border weekend wave)
    if (lineCode === 'EAL') {
      score += prof.isPeak ? 11 : (prof.baseMtrPct >= 38 ? 6 : 3);
      if (prof.dayType !== 'WEEKDAY' && prof.mins >= 510 && prof.mins <= 1140 && /^(LOW|LMC|SHS|FAN|TAP|SHT|TAW|KOT)$/.test(staCode)) {
        score += 5;
      }
    }

    // 3. LRT 1-Car vs 2-Car live formation denominator
    const lrtCars = Number(opts.lrtTrainLength || 0);
    if (isLrt) {
      const lrtScale = prof.isPeak ? 1.0 : (prof.isEveningQuiet ? 0.35 : 0.55);
      if (lrtCars === 1) score += Math.round(16 * lrtScale);
      else if (lrtCars >= 2) score -= 12;
    }

    // 4. Weekend shopping & outing core hubs (MOK/TST/CAB/CEN/SHT/KOT), strictly faded by 20:00
    if (prof.dayType !== 'WEEKDAY' && prof.mins >= 720 && prof.mins <= 1140 && /^(MOK|TST|CAB|CEN|SHT|KOT|PRE)$/.test(staCode)) {
      score += 6;
    }

    // 5. Terminus vs. Bottleneck & Interchange Surge (off-peak boost scaled smoothly by time-of-day demand)
    const INTERCHANGE_SURGE = {
      NAC: { boostPeak: 14, boostOff: 6 },
      LAK: { boostPeak: 12, boostOff: 5 },
      MEF: { boostPeak: 13, boostOff: 5 },
      QUB: { boostPeak: 12, boostOff: 4 },
      NOP: { boostPeak: 11, boostOff: 4 },
      HUH: { boostPeak: 10, boostOff: 4 },
      YUL: { boostPeak: 9,  boostOff: 4 },
      LOP: { boostPeak: 6,  boostOff: 2 }
    };
    const offScale = Math.max(0.22, Math.min(1.15, (prof.baseMtrPct - 15) / 28));
    const isDrlFireworksExit = (lineCode === 'DRL' && staCode === 'DIS' && prof.mins >= 1215 && prof.mins <= 1305);
    if (!isLrt && staCode) {
      if (MTR_ENGINE.isTerminusStation(staCode) && !isDrlFireworksExit) {
        score -= 22;
      } else {
        const bp = MTR_BOTTLENECK_STATIONS[staCode] || INTERCHANGE_SURGE[staCode];
        if (bp && (!bp.lines || bp.lines.includes(lineCode))) {
          score += prof.isPeak ? bp.boostPeak : Math.round(bp.boostOff * offScale);
        }
      }
    }

    // 6. Live Next Train API Headway Expansion (Platform Accumulation Proxy)
    const obsHw = Number(opts.obsHeadwaySec || 0);
    const baseHw = prof.isPeak ? fleet.peakBaseHwSec : (prof.isEveningQuiet ? Math.round(fleet.offPeakHwSec * 1.25) : fleet.offPeakHwSec);
    const hasLiveGap = obsHw > 60 && baseHw > 0;
    if (hasLiveGap) {
      const hwRatio = obsHw / baseHw;
      const gapScale = Math.max(0.35, Math.min(1.1, prof.baseMtrPct / 45));
      if (hwRatio >= 1.85) score += Math.round(25 * gapScale);
      else if (hwRatio >= 1.40) score += Math.round(13 * gapScale);
      else if (hwRatio <= 0.75) score -= 8;
    }

    // 7. EAL Arrival-to-Departure Dwell Delta (timetype "A" -> "D")
    const ealDwellSec = Number(opts.ealDwellDeltaSec || 0);
    if (lineCode === 'EAL' && ealDwellSec >= 45) {
      score = Math.max(score + 14, 86);
    }

    // 8. Live MTR isdelay === 'Y' flag -> immediate maximum downstream accumulation
    const isDelayed = String(opts.isDelay || '').toUpperCase() === 'Y' || opts.isDelay === true;
    if (isDelayed) {
      score = Math.max(score + 24, 92);
    }

    // 9. Rain / typhoon surge into underground stations
    const wx = opts.weather || (typeof window !== 'undefined' ? window.__HKO_WEATHER__ : null);
    if (wx?.typhoon) score += 18;
    else if (wx?.heavyRain) score += 12;
    else if (wx?.rainAdvisory) score += 6;

    const band = this._toBand(score, 'MTR');
    const basis = (hasLiveGap || isDelayed || ealDwellSec >= 45) ? 'LIVE_GAP' : 'SCHEDULE_PROFILE';
    const confidence = (hasLiveGap || isDelayed) ? 'HIGH' : (ealDwellSec >= 45 ? 'MEDIUM' : 'BASELINE');

    let firstClassWarning = false;
    let firstClassCarNo = 0;
    let tipEn = '', tipTc = '';

    if (lineCode === 'EAL') {
      firstClassWarning = true;
      const destC = String(opts.destCode || '').toUpperCase();
      const destStr = String(opts.destName || '').toLowerCase();
      const isSouthbound = (destC === 'ADM' || destC === 'EXC' || destC === 'HUH' || /admiralty|hung hom|金鐘|紅磡/.test(destStr))
        || (!destC && !destStr && opts.dirCode === 'I');
      firstClassCarNo = isSouthbound ? 4 : 6;

      if (band.pct >= 75) {
        tipEn = `9-car train (8 std cars) · Car ${firstClassCarNo} is 1st Class ($1,000 surcharge) — Cars 3/5/7 bottleneck, try Cars 1–2 or 8–9`;
        tipTc = `9卡車（僅8卡普通等）· 第${firstClassCarNo}卡為頭等（未拍卡罰$1,000）— 第3/5/7卡最迫，建議上第1–2或8–9卡`;
      } else {
        tipEn = `9-car train · Car ${firstClassCarNo} is 1st Class (tap platform processor or $1,000 surcharge)`;
        tipTc = `9卡車 · 第${firstClassCarNo}卡為頭等車廂（上車前須於月台核准機拍卡，否則罰$1,000）`;
      }
    } else if (!isLrt && fleet.totalCars >= 8 && !fleet.allSeated && band.pct >= 72) {
      tipEn = `8-car train · Middle/escalator cars crowded — try Car 1 or Car ${fleet.totalCars} (~10–15% lighter)`;
      tipTc = `8卡車 · 中間及扶手電梯口車廂較擠迫 — 建議移步第1或第${fleet.totalCars}卡（較鬆動約10–15%）`;
    } else if (isLrt && lrtCars === 1 && band.pct >= 75) {
      tipEn = 'Single-car LRT — expect tighter standing room';
      tipTc = '單卡輕鐵 — 較為擠迫';
    }

    return {
      ...band,
      mode: 'MTR',
      lineCode,
      totalCars: isLrt ? (lrtCars || 1) : fleet.totalCars,
      standardCars: isLrt ? (lrtCars || 1) : fleet.standardCars,
      firstClassWarning,
      firstClassCarNo,
      isDelayed,
      basis,
      confidence,
      dayType: prof.dayType,
      tipEn,
      tipTc
    };
  },

  inferFerryLoad(opts = {}) {
    const g = opts.group || {};
    const origStr = String(opts.origName || g.orig_e || '').toLowerCase();
    const destStr = String(opts.destName || g.dest_e || '').toLowerCase();
    const routeCtx = `${origStr} ${destStr} ${g.routeNo || ''} ${g.ferryMeta?.key || ''}`.toLowerCase();

    const isStarFerry = /star|tsim sha tsui.*central|central.*tsim sha tsui|tsim sha tsui.*wan chai|wan chai.*tsim sha tsui/.test(routeCtx);
    const isCheungChau = /cheung chau|長洲/.test(routeCtx);
    const isTaiOKaito = /tai o|sha lo wan|tuen mun.*tai o|tung chung.*tai o|peng chau.*chi ma wan|inter.?island/.test(routeCtx);
    const isOutlyingIsland = isCheungChau || isTaiOKaito || /mui wo|peng chau|yung shue wan|sok kwu wan|discovery bay|ma wan|chi ma wan/.test(routeCtx);

    const fMeta = g.ferryMeta || {};
    const rawVClass = String(opts.vesselClass || fMeta._activeVesselClass || '').toUpperCase();
    const vClass = rawVClass || ((fMeta.durOrd >= 50 && (!fMeta.durFast || fMeta.dur >= 50)) ? 'ORD' : 'FAST');

    const prof = this._getPeriodProfile(opts.dateObj, opts.isHoliday);
    let score = prof.baseFerryPct;

    // Directional flow for Outlying Islands (Commuter AM to city, PM to island; Weekend tourists AM/midday out, 15:30-19:00 back)
    const isIslandOrigin = /cheung chau|mui wo|peng chau|yung shue wan|sok kwu wan|discovery bay|ma wan|tai o/.test(origStr);
    const isHubDest = /central|tsim sha tsui|wan chai|hung hom|north point|tuen mun|tung chung/.test(destStr);
    const isToUrban = isIslandOrigin && isHubDest;
    const isToIsland = !isIslandOrigin && /cheung chau|mui wo|peng chau|yung shue wan|sok kwu wan|discovery bay|ma wan|tai o/.test(destStr);

    if (isOutlyingIsland) {
      if (prof.dayType === 'WEEKDAY') {
        if (prof.mins >= 405 && prof.mins <= 555) { // 06:45–09:15 AM
          score += isToUrban ? 24 : (isToIsland ? -9 : 0);
        } else if (prof.mins >= 1035 && prof.mins <= 1170) { // 17:15–19:30 PM
          score += isToIsland ? 25 : (isToUrban ? -9 : 0);
        } else if (prof.isEveningQuiet) {
          score -= 5;
        }
      } else {
        // Saturday / Sunday / Public Holiday island visitor curve
        if (prof.mins >= 555 && prof.mins <= 870) { // 09:15–14:30 island bound
          const islandBoost = isCheungChau ? 30 : (/yung shue wan|sok kwu wan|tai o/.test(routeCtx) ? 26 : 19);
          score += isToIsland ? islandBoost : (prof.mins < 780 ? -7 : 4);
        } else if (prof.mins >= 930 && prof.mins <= 1140) { // 15:30–19:00 return wave
          const returnBoost = isCheungChau ? 32 : (/yung shue wan|sok kwu wan|tai o/.test(routeCtx) ? 28 : 20);
          score += isToUrban ? returnBoost : -9;
        } else if (prof.mins >= 1170) { // >=19:30 Sunday/Sat evening — no tourists, light sailings both ways
          score -= (prof.mins >= 1230 ? 9 : 4);
        } else {
          score -= 4; // Early weekend morning
        }
      }

      // Vessel capacity differentiation (Ordinary triple-deckers ~850 pax vs Fast catamarans ~320 pax vs Kaito ~140 pax)
      if (isTaiOKaito) {
        if (prof.dayType !== 'WEEKDAY' && prof.mins >= 600 && prof.mins <= 1050) score += 10;
      } else if (vClass === 'ORD') {
        score -= 14;
      } else if (vClass === 'FAST' && (score >= 38 || prof.isPeak || prof.touristWave > 0.25)) {
        score += 10;
      }
    } else if (isStarFerry) {
      // High-capacity iconic harbour crossing (~450 pax)
      if (prof.isPeak) score += 12;
      else if (prof.dayType !== 'WEEKDAY' && prof.mins >= 840 && prof.mins <= 1200) score += 11; // Harbour sunset/evening sightseeing
      else if (prof.mins < 540 || prof.mins >= 1290) score -= 5;
    } else {
      // Inner harbour ferries (North Point / Hung Hom / Kowloon City / Kwun Tong / Sai Wan Ho)
      if (prof.isPeak) score += 18;
      else if (prof.isEveningQuiet || prof.dayType === 'HOLIDAY') score -= 5;
    }

    // Sailing gap proxy (e.g. cancelled sailing due to rough weather or mechanical issue)
    const obsHw = Number(opts.obsHeadwaySec || 0);
    const schedHw = Math.max(600, Number(opts.schedHeadwaySec || ((Number(g.headwayMins) || (isStarFerry ? 8 : 30)) * 60)));
    const isSchedOnly = Boolean(opts.isSched);
    const hasLiveGap = obsHw > 180 && schedHw > 0 && !isSchedOnly;
    if (hasLiveGap) {
      const hwRatio = obsHw / schedHw;
      if (hwRatio >= 1.85) score += 16;
      else if (hwRatio >= 1.45) score += 9;
    }

    // Weather sensitivity (Typhoon disrupts/suspends, weekend heavy rain reduces island leisure visitors)
    const wx = opts.weather || (typeof window !== 'undefined' ? window.__HKO_WEATHER__ : null);
    if (wx?.typhoon) score += 22;
    else if (wx?.heavyRain) score += (isOutlyingIsland && prof.dayType !== 'WEEKDAY' ? -12 : 4);
    else if (wx?.rainAdvisory && isOutlyingIsland && prof.dayType !== 'WEEKDAY') score -= 6;

    const capacityPax = isStarFerry
      ? 450
      : (isTaiOKaito ? 140 : (isOutlyingIsland ? (vClass === 'ORD' ? 850 : 320) : 300));

    const band = this._toBand(score, 'FERRY');
    const basis = hasLiveGap ? 'LIVE_GAP' : 'SCHEDULE_PROFILE';
    const confidence = hasLiveGap ? 'HIGH' : 'BASELINE';

    let tipEn = '', tipTc = '';
    if (isCheungChau && vClass === 'FAST' && band.pct >= 72) {
      tipEn = 'Fast Ferry busy (~320 seats) — Ordinary Ferry carries 3× more pax & costs less';
      tipTc = '高速船載客率偏高（約320座）— 普通渡輪載客量多3倍且船費較平';
    } else if (isOutlyingIsland && band.pct >= 75) {
      tipEn = 'High island sailing demand — arrive at pier 10–15m early to queue';
      tipTc = '離島渡輪客流較多 — 建議提早10–15分鐘到碼頭排隊登船';
    }

    return {
      ...band,
      mode: 'FERRY',
      vesselClass: isTaiOKaito ? 'KAITO' : vClass,
      capacityPax,
      basis,
      confidence,
      dayType: prof.dayType,
      tipEn,
      tipTc,
      firstClassWarning: false
    };
  }
};

function getSectionalFareMeta(company, routeNo) {
  const co = String(company || '').trim().toUpperCase();
  const rNo = String(routeNo || '').trim().toUpperCase();
  return SECTIONAL_FARE_REGISTRY[`${co}_${rNo}`] || null;
}

function resolveBusLegNetFare(group, boardStop, alightStop = null, isHoliday = false) {
  if (!group || !boardStop) {
    return { upfrontFare: 0, netFare: 0, rebateAmount: 0, rebateType: null, noticeEn: '', noticeTc: '' };
  }
  const co = String(group.company || '').trim().toUpperCase();
  const rNo = String(group.routeNo || '').trim().toUpperCase();
  const meta = getSectionalFareMeta(co, rNo);

  const rawUpfrontStr = (isHoliday && boardStop.fareHol && parseFloat(boardStop.fareHol) > 0)
    ? boardStop.fareHol
    : boardStop.fare;
  let upfrontFare = parseFloat(rawUpfrontStr || '0');
  if (!Number.isFinite(upfrontFare) || upfrontFare <= 0) {
    upfrontFare = Number(group.maxFare || 0);
  }
  let netFare = upfrontFare;
  let rebateAmount = 0;
  let noticeEn = '';
  let noticeTc = '';

  if (!meta) {
    return { upfrontFare, netFare, rebateAmount: 0, rebateType: null, noticeEn: '', noticeTc: '' };
  }

  const rId = String(group.routeIds?.[0] || group.key || '');
  const destStr = `${group.dest_e || ''} ${group.dest_tc || ''}`;
  let dir = (rId.includes('_I') || String(group.key || '').endsWith('_I')) ? 'I' : 'O';

  if (co === 'NLB' && rNo === '3M') {
    if (/tung\s*chung|東涌/i.test(destStr)) dir = 'I';
    else if (/mui\s*wo|梅窩/i.test(destStr)) dir = 'O';
  }

  const bSeq = Number(boardStop.seq || 0);
  const aSeq = Number(alightStop?.seq || 0);
  const boardName  = `${boardStop.stopName_e || ''} ${boardStop.name_tc || ''}`;
  const alightName = `${alightStop?.stopName_e || ''} ${alightStop?.name_tc || ''}`;
  const bLat = parseFloat(boardStop.lat ?? boardStop.latitude);
  const bLon = parseFloat(boardStop.lon ?? boardStop.longitude);
  const aLat = parseFloat(alightStop?.lat ?? alightStop?.latitude);
  const aLon = parseFloat(alightStop?.lon ?? alightStop?.longitude);
  const hopKm = (Number.isFinite(bLat) && Number.isFinite(aLat)) ? _haversineKm(bLat, bLon, aLat, aLon) : 99;

  if (meta.rebateType === 'strict_boarding_only') {
    const isTungChungBoard = /tung\s*chung|東涌/i.test(boardName) && (bSeq === 0 || bSeq <= 4);
    const isToTaiO = /tai\s*o|大澳/i.test(destStr);
    if (isTungChungBoard && isToTaiO) {
      const locked = isHoliday ? meta.lockedOutboundFareHol : meta.lockedOutboundFareWk;
      if (locked > 0) {
        upfrontFare = Math.max(upfrontFare, locked);
        netFare = upfrontFare;
      }
      if (alightStop && hopKm < 7.5) {
        noticeEn = meta.noticeEn;
        noticeTc = meta.noticeTc;
      }
    }
    return { upfrontFare: Number(upfrontFare.toFixed(1)), netFare: Number(netFare.toFixed(1)), rebateAmount: 0, rebateType: meta.rebateType, noticeEn, noticeTc };
  }

  if (meta.twoWayTiers && alightStop) {
    const tiers = meta.twoWayTiers[dir] || [];
    for (const tier of tiers) {
      if (tier.excludeBoardRe && tier.excludeBoardRe.test(boardName)) continue;
      if (tier.excludeAlightRe && tier.excludeAlightRe.test(alightName)) continue;
      if (tier.maxBoardSeq && bSeq > 0 && bSeq > tier.maxBoardSeq) continue;

      const seqHit = (aSeq > 0 && bSeq > 0 && bSeq < aSeq && aSeq <= tier.maxAlightSeq);
      const nameHit = (aSeq === 0 && tier.alightRe && tier.alightRe.test(alightName));
      if (seqHit || nameHit) {
        const candNet = isHoliday ? tier.hol : tier.wk;
        if (candNet > 0 && candNet < upfrontFare - 0.1) {
          netFare = candNet;
          rebateAmount = Number((upfrontFare - netFare).toFixed(1));
          noticeEn = meta.noticeEn;
          noticeTc = meta.noticeTc;
        }
        break;
      }
    }
  } else if (meta.rebateType === 'driver_override' && alightStop && hopKm < 6.5 && upfrontFare > 6.5) {
    const isNlb1ToMuiWoFinalLeg = co === 'NLB' && rNo === '1' && /mui\s*wo|梅窩/i.test(destStr) &&
      (/lo\s*uk\s*tsuen|sun\s*wai\s*tsuen|lo\s*wai\s*tsuen|pui\s*o|swire|nam\s*shan|lai\s*chi\s*yuen|mui\s*wo|羅屋村|新圍村|老圍村|貝澳|太古|南山|荔枝園|梅窩/i.test(boardName) || bSeq >= 38);
    if (!isNlb1ToMuiWoFinalLeg) {
      const ratio = isHoliday ? (meta.shortHopRatioHol || 0.5) : (meta.shortHopRatioWk || 0.45);
      const floor = isHoliday ? (meta.minShortHol || 6.1) : (meta.minShortWk || 3.7);
      const candNet = Number(Math.max(floor, upfrontFare * ratio).toFixed(1));
      if (candNet < upfrontFare - 0.5) {
        netFare = candNet;
        rebateAmount = Number((upfrontFare - netFare).toFixed(1));
        noticeEn = meta.noticeEn;
        noticeTc = meta.noticeTc;
      }
    }
  } else if ((meta.rebateType === 'front_door_tap' || meta.rebateType === 'rear_door_tap') && alightStop) {
    const stopsRidden = (aSeq > bSeq && bSeq > 0) ? (aSeq - bSeq) : 99;
    const isShortHop = (hopKm <= 6.5 || stopsRidden <= 10);
    if (isShortHop && upfrontFare > (meta.shortHopNetFare || 6.5) + 0.5) {
      const targetNet = (hopKm <= 3.0 && meta.veryShortHopNetFare) ? meta.veryShortHopNetFare : meta.shortHopNetFare;
      netFare = Number(targetNet.toFixed(1));
      rebateAmount = Number((upfrontFare - netFare).toFixed(1));
      noticeEn = meta.noticeEn;
      noticeTc = meta.noticeTc;
    }
  }

  return {
    upfrontFare: Number(upfrontFare.toFixed(1)),
    netFare: Number(netFare.toFixed(1)),
    rebateAmount: Number(Math.max(0, rebateAmount).toFixed(1)),
    rebateType: rebateAmount > 0 ? meta.rebateType : null,
    noticeEn,
    noticeTc
  };
}

function hasStopTwoWaySectionalFare(group, stops, stopIdx, isHoliday = false) {
  if (!group || (group.mode && group.mode !== 'BUS')) return false;
  if (!Array.isArray(stops) || stopIdx < 0 || stopIdx >= stops.length - 1) return false;
  const meta = getSectionalFareMeta(group.company, group.routeNo);
  if (!meta || !meta.hasSectionalFare) return false;

  const co = String(group.company || '').trim().toUpperCase();
  const rNo = String(group.routeNo || '').trim().toUpperCase();
  const destStr = `${group.dest_e || ''} ${group.dest_tc || ''}`;
  const boardStop = stops[stopIdx];
  if (!boardStop) return false;

  // Tail legs & auto-stepping directions where drivers never need destination notification:
  // 1) NLB 1 -> Mui Wo: from Lo Uk Tsuen onward (already on final leg into Mui Wo)
  if (co === 'NLB' && rNo === '1' && /mui\s*wo|梅窩/i.test(destStr)) {
    const loUkIdx = stops.findIndex(s => /lo\s*uk\s*tsuen|羅屋村/i.test(`${s?.stopName_e || ''} ${s?.name_tc || ''}`));
    if (loUkIdx >= 0 && stopIdx >= loUkIdx) return false;
  }
  // 2) NLB 3M -> Tung Chung: fares auto-reduce along the way — no driver notification needed in this direction
  if (co === 'NLB' && rNo === '3M' && /tung\s*chung|東涌/i.test(destStr)) {
    return false;
  }
  // 3) NLB 3M -> Mui Wo: only from Tung Chung up to & including Shek Mun Kap (after Shek Mun Kap, auto one-way section)
  if (co === 'NLB' && rNo === '3M' && /mui\s*wo|梅窩/i.test(destStr)) {
    const smkIdx = stops.findIndex(s => /shek\s*mun\s*kap|石門甲/i.test(`${s?.stopName_e || ''} ${s?.name_tc || ''}`));
    if (smkIdx >= 0 && stopIdx > smkIdx) return false;
  }

  for (let j = stopIdx + 1; j < stops.length; j++) {
    const res = resolveBusLegNetFare(group, boardStop, stops[j], isHoliday);
    if (res && res.rebateAmount > 0) return true;
  }
  return false;
}

// Enrich generic ferry pier stop names with explicit berth/pier numbers (e.g. Central Pier 6 for Mui Wo)
function getFerryPierBerthLabel(group, stopObj, isZh = false) {
  const rawName = isZh
    ? (stopObj?.name_tc || stopObj?.stopName_e || '')
    : (stopObj?.stopName_e || stopObj?.name_tc || '');
  if (!group || group.mode !== 'FERRY' || !rawName) return rawName;
  if (/pier\s*(?:no\.?\s*)?\d+|碼頭\s*\d+|\d+號碼頭/i.test(rawName)) return rawName;

  const nm = String(rawName).toLowerCase();
  const routeCtx = `${group.routeNo || ''} ${group.orig_en || ''} ${group.dest_en || ''} ${group.ferryMeta?.key || ''}`.toLowerCase();

  if (nm.includes('central') || rawName.includes('中環')) {
    if (routeCtx.includes('mui wo') || routeCtx.includes('peng chau') || routeCtx.includes('central_mw') || routeCtx.includes('central_pc')) {
      return isZh ? '中環6號碼頭' : 'Central Pier 6';
    }
    if (routeCtx.includes('cheung chau') || routeCtx.includes('central_cc')) {
      return isZh ? '中環5號碼頭' : 'Central Pier 5';
    }
    if (routeCtx.includes('yung shue wan') || routeCtx.includes('sok kwu wan') || routeCtx.includes('lamma') || routeCtx.includes('central_ysw') || routeCtx.includes('central_skw')) {
      return isZh ? '中環4號碼頭' : 'Central Pier 4';
    }
    if (routeCtx.includes('discovery bay') || routeCtx.includes('central_db')) {
      return isZh ? '中環3號碼頭' : 'Central Pier 3';
    }
    if (routeCtx.includes('ma wan') || routeCtx.includes('park island') || routeCtx.includes('central_mw_pi')) {
      return isZh ? '中環2號碼頭' : 'Central Pier 2';
    }
    if (routeCtx.includes('tsim sha tsui') || routeCtx.includes('star') || routeCtx.includes('sf_')) {
      return isZh ? '中環7號碼頭（天星）' : 'Central Pier 7 (Star Ferry)';
    }
    if (routeCtx.includes('hung hom')) {
      return isZh ? '中環8號碼頭' : 'Central Pier 8';
    }
  }
  if (nm.includes('north point') || rawName.includes('北角')) {
    if (routeCtx.includes('hung hom') || routeCtx.includes('kowloon city')) {
      return isZh ? '北角（西）渡輪碼頭' : 'North Point (West) Pier';
    }
    if (routeCtx.includes('kwun tong')) {
      return isZh ? '北角（東）渡輪碼頭' : 'North Point (East) Pier';
    }
  }
  return rawName;
}

const SECTIONAL_FARE_ACK_KEY = 'hk_transit_sectional_fare_ack';

function _resolveSectionalStorage(storageOverride) {
  if (storageOverride && typeof storageOverride.getItem === 'function') return storageOverride;
  if (typeof window !== 'undefined' && window.SafeStorage && typeof window.SafeStorage.getItem === 'function') {
    return window.SafeStorage;
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (e) {}
  return null;
}

function hasAcknowledgedTwoWaySectionalFare(storageOverride = null) {
  const store = _resolveSectionalStorage(storageOverride);
  if (!store) return false;
  try {
    return store.getItem(SECTIONAL_FARE_ACK_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function acknowledgeTwoWaySectionalFare(storageOverride = null) {
  const store = _resolveSectionalStorage(storageOverride);
  try {
    if (store && typeof store.setItem === 'function') {
      store.setItem(SECTIONAL_FARE_ACK_KEY, '1');
    }
    if (!storageOverride && typeof localStorage !== 'undefined' && localStorage && store !== localStorage) {
      localStorage.setItem(SECTIONAL_FARE_ACK_KEY, '1');
    }
    return true;
  } catch (e) {
    return false;
  }
}

function shouldShowTwoWaySectionalFareNotice(group, stops, stopIdx, isHoliday = false, storageOverride = null) {
  if (!hasStopTwoWaySectionalFare(group, stops, stopIdx, isHoliday)) return false;
  return !hasAcknowledgedTwoWaySectionalFare(storageOverride);
}

/**
 * Evaluates final bus seat/load badge status by fusing:
 * 1) Citywide People Flow Simulator + Bus Kinematics (`estimateGlobalBusLoadRisk`),
 * 2) Baseline schedule/headway LoadFactorEngine estimate.
 * 100% simulation- and telemetry-driven (no manual user-reporting overrides).
 */
function estimateBusSeatStatus(routeGroup, stopIdx, etaEntry = null, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const hkoWeather = opts.weather !== undefined
    ? opts.weather
    : (typeof window !== 'undefined' ? (window.__HKO_WEATHER__ || null) : null);

  const baseLoad = opts.baseLoad || LoadFactorEngine.inferBusLoad({
    ...opts,
    group: routeGroup,
    stopIdx,
    weather: hkoWeather,
    nowMs,
    skipGlobalSurge: true
  }) || {
    pct: 25,
    band: 'LOW',
    labelEn: 'Seats',
    labelTc: '有位',
    cssClass: 'load-low',
    isSkipRisk: false,
    mode: 'BUS',
    tipEn: '',
    tipTc: ''
  };

  const riskFn =
    (typeof estimateGlobalBusLoadRisk === 'function' ? estimateGlobalBusLoadRisk : null) ||
    (typeof window !== 'undefined' && typeof window.estimateGlobalBusLoadRisk === 'function'
      ? window.estimateGlobalBusLoadRisk
      : null);

  const enrichedEtaEntry = (etaEntry && typeof etaEntry === 'object')
    ? {
        ...etaEntry,
        stopName: etaEntry.stopName || opts.stopObj?.stopName_e || '',
        name_tc: etaEntry.name_tc || opts.stopObj?.name_tc || ''
      }
    : (opts.stopObj?.stopName_e || opts.stopObj?.name_tc
      ? { stopName: opts.stopObj?.stopName_e || '', name_tc: opts.stopObj?.name_tc || '' }
      : etaEntry);

  const surgeRisk = riskFn
    ? riskFn(routeGroup, stopIdx, enrichedEtaEntry, hkoWeather, nowMs)
    : null;

  const isOriginTerminus = Number.isFinite(Number(stopIdx)) && Number(stopIdx) <= 0;
  const surgeBreakdown = surgeRisk?.breakdown || null;

  // 1. Bunched trailing bus relief overrides crowded lead-bus bias downward
  if (surgeRisk && surgeRisk.isBunchedTrailing && surgeRisk.level === 'NORMAL') {
    return {
      ...baseLoad,
      pct: Math.min(Number(baseLoad.pct) || 30, 32),
      band: 'LOW',
      labelEn: 'Seats',
      labelTc: '有位',
      cssClass: 'load-low',
      isSkipRisk: false,
      basis: 'PEOPLE_FLOW_BUNCH_RELIEF',
      confidence: 'HIGH',
      tipEn: isOriginTerminus ? '' : (baseLoad.tipEn || ''),
      tipTc: isOriginTerminus ? '' : (baseLoad.tipTc || ''),
      surgeRisk,
      breakdown: surgeBreakdown
    };
  }

  // 2. High people-flow + kinematic surge (skip-stop / wide gap / ferry pulse) flags Likely Full
  if (surgeRisk && surgeRisk.level === 'HIGH_LOAD') {
    const highTipEn = isOriginTerminus
      ? (surgeRisk.tip && !/upstream/i.test(surgeRisk.tip) ? surgeRisk.tip : 'Queue early at terminus.')
      : (surgeRisk.tip || 'Consider boarding upstream.');
    const highTipTc = isOriginTerminus
      ? (surgeRisk.tipTc && !/上游/.test(surgeRisk.tipTc) ? surgeRisk.tipTc : '總站候車人數較多，建議提早排隊。')
      : (surgeRisk.tipTc || '建議改於上游總站上車。');
    return {
      ...baseLoad,
      pct: Math.max(Number(baseLoad.pct) || 0, 88),
      band: 'FULL',
      labelEn: surgeRisk.label || '⚠️ Likely Full',
      labelTc: surgeRisk.labelTc || '⚠️ 易滿座',
      cssClass: 'load-full',
      isSkipRisk: true,
      basis: 'PEOPLE_FLOW_KINEMATICS',
      confidence: 'HIGH',
      tipEn: highTipEn,
      tipTc: highTipTc,
      surgeRisk,
      breakdown: surgeBreakdown
    };
  }

  // 3. Moderate pressure with actionable bunching/corridor decision tip
  if (surgeRisk && surgeRisk.level === 'MODERATE') {
    const nextPct = Math.max(Number(baseLoad.pct) || 0, surgeRisk.isWideGap ? 68 : 60);
    const modTipEn = isOriginTerminus
      ? (surgeRisk.ferryPulse?.active ? (surgeRisk.tip || '') : (surgeRisk.tip && /terminus/i.test(surgeRisk.tip) ? surgeRisk.tip : ''))
      : (surgeRisk.tip || baseLoad.tipEn || '');
    const modTipTc = isOriginTerminus
      ? (surgeRisk.ferryPulse?.active ? (surgeRisk.tipTc || '') : (surgeRisk.tipTc && /總站/.test(surgeRisk.tipTc) ? surgeRisk.tipTc : ''))
      : (surgeRisk.tipTc || baseLoad.tipTc || '');
    return {
      ...baseLoad,
      pct: nextPct,
      band: baseLoad.band === 'LOW' ? 'MED' : baseLoad.band,
      labelEn: baseLoad.band === 'LOW' ? 'Standing' : baseLoad.labelEn,
      labelTc: baseLoad.band === 'LOW' ? '企位' : baseLoad.labelTc,
      cssClass: baseLoad.band === 'LOW' ? 'load-med' : baseLoad.cssClass,
      tipEn: modTipEn,
      tipTc: modTipTc,
      surgeRisk,
      breakdown: surgeBreakdown
    };
  }

  // Normal: ensure origin terminus never leaks an upstream boarding tip
  return {
    ...baseLoad,
    tipEn: isOriginTerminus ? '' : (baseLoad.tipEn || ''),
    tipTc: isOriginTerminus ? '' : (baseLoad.tipTc || ''),
    surgeRisk,
    breakdown: surgeBreakdown
  };
}

LoadFactorEngine.estimateBusSeatStatus = estimateBusSeatStatus;

if (typeof window !== 'undefined') {
  window.MTR_ENGINE = MTR_ENGINE;
  window.computeSharedBikeFareHkd = computeSharedBikeFareHkd;
  window.LoadFactorEngine = LoadFactorEngine;
  window.estimateBusSeatStatus = estimateBusSeatStatus;
  window.SECTIONAL_FARE_ACK_KEY = SECTIONAL_FARE_ACK_KEY;
  window.hasAcknowledgedTwoWaySectionalFare = hasAcknowledgedTwoWaySectionalFare;
  window.acknowledgeTwoWaySectionalFare = acknowledgeTwoWaySectionalFare;
  window.shouldShowTwoWaySectionalFareNotice = shouldShowTwoWaySectionalFareNotice;
  window.getSectionalFareMeta = getSectionalFareMeta;
  window.resolveBusLegNetFare = resolveBusLegNetFare;
  window.hasStopTwoWaySectionalFare = hasStopTwoWaySectionalFare;
  window.getFerryPierBerthLabel = getFerryPierBerthLabel;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MTR_ENGINE,
    computeSharedBikeFareHkd,
    LoadFactorEngine,
    estimateBusSeatStatus,
    SECTIONAL_FARE_ACK_KEY,
    hasAcknowledgedTwoWaySectionalFare,
    acknowledgeTwoWaySectionalFare,
    shouldShowTwoWaySectionalFareNotice,
    getSectionalFareMeta,
    resolveBusLegNetFare,
    hasStopTwoWaySectionalFare,
    getFerryPierBerthLabel
  };
}
