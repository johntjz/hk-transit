/* Transit HK — MTR & Light Rail Load Adapter (mtrsurge.js)
 * Dual Browser Global + CommonJS module.
 *
 * Pure sensor-fusion adapter sitting on top of the standalone Hong Kong People Flow Simulator
 * (public/hk-people-flow.js). Maps MTR lines, directions, and Hong Kong's directional choke links
 * onto citywide people-flow vectors, then fuses live MTR Next-Train headway spacing and HKO weather
 * modifiers (urbanIndoorMod for rainstorms, preTyphoonEvacMod for Pre-T8 homebound rushes).
 *
 * Strictly feeds Rail crowding pills — NEVER modifies map road-speed telemetry.
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

  // Hong Kong MTR directional choke stations & line metadata
  const TWL_CORE_STATIONS = new Set(['CEN', 'ADM', 'TST', 'JOR', 'YMT', 'MOK', 'PRE', 'SSP', 'CSW', 'LCK', 'MEF', 'LAK']);
  const KTL_CORE_STATIONS = new Set(['WHA', 'HOM', 'YMT', 'MOK', 'PRE', 'SKM', 'KOT', 'LOF', 'WTS', 'DIH', 'CHH', 'KOB', 'NTK', 'KWT', 'LAT', 'YAT']);
  const TKL_CHOKE_STATIONS = new Set(['NOP', 'QUB', 'YAT', 'TIK', 'TKO', 'HAH', 'POA', 'LHP']);
  const EAL_CHOKE_STATIONS = new Set(['ADM', 'EXC', 'HUH', 'MKK', 'KOT', 'TAW', 'SHT', 'FOT', 'UNI', 'TAP', 'TWO', 'FAN', 'SHS', 'LOW', 'LMC']);
  const TCL_AEL_STATIONS = new Set(['HOK', 'KOW', 'OLY', 'NAC', 'LAK', 'TSY', 'SUN', 'TUC', 'AIR', 'AWE']);
  const ISL_CORE_STATIONS = new Set(['SHW', 'CEN', 'ADM', 'WAC', 'CAB', 'TIH', 'FOH', 'NOP', 'QUB', 'TAK']);
  const SCHOOL_MTR_STATIONS = new Set(['KOT', 'HOM', 'TAW', 'MKK', 'SKM', 'HKU', 'SYP']);
  const SUNDAY_HUB_MTR_STATIONS = new Set(['CEN', 'ADM', 'CAB', 'MOK', 'PRE', 'TST', 'HOK']);

  // Expected scheduled cadence in seconds (peak vs off-peak) per line
  const LINE_EXPECTED_CADENCE_SEC = Object.freeze({
    TWL: { peak: 135, offPeak: 240 },
    KTL: { peak: 140, offPeak: 250 },
    ISL: { peak: 135, offPeak: 240 },
    TKL: { peak: 150, offPeak: 270 },
    EAL: { peak: 165, offPeak: 280 },
    TML: { peak: 180, offPeak: 300 },
    SIL: { peak: 195, offPeak: 300 },
    TCL: { peak: 300, offPeak: 420 },
    AEL: { peak: 600, offPeak: 600 },
    DRL: { peak: 300, offPeak: 600 },
    LRT: { peak: 300, offPeak: 420 }
  });

  function _normalizeDirection(lineCode, rawDir, destCode, destName) {
    const dir = String(rawDir || '').trim().toUpperCase();
    const dCode = String(destCode || '').trim().toUpperCase();
    const dName = String(destName || '').trim().toLowerCase();

    if (dir === 'SB' || dir === 'SOUTHBOUND' || dir === 'INBOUND') return 'DOWN';
    if (dir === 'NB' || dir === 'NORTHBOUND' || dir === 'OUTBOUND') return 'UP';

    if (lineCode === 'TWL') {
      if (dCode === 'CEN' || dCode === 'ADM' || /central|admiralty|中環|金鐘/.test(dName)) return 'DOWN';
      if (dCode === 'TSW' || /tsuen wan|荃灣/.test(dName)) return 'UP';
      if (dir === 'I' || dir === 'DOWN') return 'DOWN';
      if (dir === 'O' || dir === 'UP') return 'UP';
    } else if (lineCode === 'TKL') {
      if (dCode === 'NOP' || dCode === 'QUB' || /north point|quarry bay|北角|鰂魚涌/.test(dName)) return 'DOWN';
      if (dCode === 'POA' || dCode === 'LHP' || dCode === 'TKO' || /po lam|lohas|tseung kwan o|寶琳|康城|將軍澳/.test(dName)) return 'UP';
      if (dir === 'I' || dir === 'DOWN') return 'DOWN';
      if (dir === 'O' || dir === 'UP') return 'UP';
    } else if (lineCode === 'EAL') {
      if (dCode === 'LOW' || dCode === 'LMC' || dCode === 'SHS' || dCode === 'FAN' || dCode === 'TAP' || dCode === 'SHT' ||
          /lo wu|lok ma chau|sheung shui|tai po|fanling|sha tin|羅湖|落馬洲|上水|大埔|粉嶺|沙田/.test(dName)) return 'UP';
      if (dCode === 'ADM' || dCode === 'HUH' || dCode === 'EXC' || /admiralty|hung hom|exhibition|金鐘|紅磡|會展/.test(dName)) return 'DOWN';
      if (dir === 'O' || dir === 'UP') return 'UP';
      if (dir === 'I' || dir === 'DOWN') return 'DOWN';
    } else if (lineCode === 'TCL' || lineCode === 'AEL') {
      if (dCode === 'TUC' || dCode === 'AIR' || dCode === 'AWE' || /tung chung|airport|asiaworld|expo|東涌|機場|博覽館/.test(dName)) return 'DOWN';
      if (dCode === 'HOK' || dCode === 'KOW' || /hong kong|kowloon|香港|九龍/.test(dName)) return 'UP';
      if (dir === 'O' || dir === 'DOWN') return 'DOWN';
      if (dir === 'I' || dir === 'UP') return 'UP';
    } else if (lineCode === 'KTL') {
      if (dCode === 'TIK' || dCode === 'YAT' || dCode === 'KWT' || /tiu keng leng|kwun tong|調景嶺|觀塘/.test(dName)) return 'UP';
      if (dCode === 'WHA' || dCode === 'HOM' || /whampoa|ho man tin|黃埔|何文田/.test(dName)) return 'DOWN';
    } else if (lineCode === 'ISL') {
      if (dCode === 'CHW' || /chai wan|柴灣/.test(dName)) return 'UP';
      if (dCode === 'KET' || /kennedy town|堅尼地城/.test(dName)) return 'DOWN';
    }

    if (dir === 'UP' || dir === 'O' || dir === 'EB') return 'UP';
    if (dir === 'DOWN' || dir === 'I' || dir === 'WB') return 'DOWN';
    return 'UP';
  }

  /**
   * Extract live gap in seconds between consecutive trains in nextTrains (or fallback obsHeadwaySec).
   */
  function _extractLiveHeadwaySec(nextTrains, obsHeadwaySec, nowMs) {
    if (Array.isArray(nextTrains) && nextTrains.length >= 2) {
      const timesMs = [];
      const refMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
      for (let i = 0; i < nextTrains.length; i++) {
        const t = nextTrains[i];
        if (typeof t === 'number' && Number.isFinite(t)) {
          // Small numbers (<= 120) treated as minutes until train; large numbers as epoch ms
          timesMs.push(t > 1e10 ? t : refMs + t * 60000);
        } else if (typeof t === 'string') {
          const parsed = Date.parse(t.includes('T') ? t : t.replace(' ', 'T') + '+08:00');
          if (Number.isFinite(parsed)) timesMs.push(parsed);
          else if (Number.isFinite(Number(t))) timesMs.push(refMs + Number(t) * 60000);
        } else if (t && typeof t === 'object') {
          const rawMs = Number(t.targetMs ?? t.rawTargetMs);
          if (Number.isFinite(rawMs) && rawMs > 1e10) {
            timesMs.push(rawMs);
          } else if (t.time) {
            const parsed = Date.parse(String(t.time).includes('T') ? t.time : String(t.time).replace(' ', 'T') + '+08:00');
            if (Number.isFinite(parsed)) timesMs.push(parsed);
          } else {
            const ttnt = Number(t.ttnt ?? t.mins ?? t.minutes);
            if (Number.isFinite(ttnt)) timesMs.push(refMs + ttnt * 60000);
          }
        }
      }
      if (timesMs.length >= 2) {
        timesMs.sort((a, b) => a - b);
        const gapSec = Math.round((timesMs[1] - timesMs[0]) / 1000);
        if (gapSec > 0 && gapSec <= 3600) return gapSec;
      }
    }
    const obs = Number(obsHeadwaySec);
    if (Number.isFinite(obs) && obs > 0) return Math.round(obs);
    return null;
  }

  /**
   * Estimates MTR / Light Rail crowding by fusing Hong Kong People Flow Simulator vectors,
   * line-specific directional choke links, live Next-Train headway gaps, and HKO weather modifiers.
   *
   * @param {Object} params
   * @param {string} params.lineCode
   * @param {string} [params.stationCode]
   * @param {string} [params.direction]
   * @param {string} [params.destCode]
   * @param {string} [params.destName]
   * @param {Array}  [params.nextTrains]
   * @param {number} [params.obsHeadwaySec]
   * @param {boolean} [params.isLrt]
   * @param {boolean} [params.isDelay]
   * @param {Object|null} [params.hkoWeather]
   * @param {number} [params.nowMs]
   */
  function estimateMtrLoadStatus(params) {
    const p = params && typeof params === 'object' ? params : {};
    const simFn = _getFlowFn('simulateCityPeopleFlow');
    const mapFn = _getFlowFn('mapCorridorToFlowVectors');

    const rawLine = String(p.lineCode || '').trim().toUpperCase();
    const isLrt = Boolean(p.isLrt || rawLine === 'LRT' || /^\d{3}[A-Z]?$/.test(rawLine));
    const lineCode = isLrt ? 'LRT' : (rawLine || 'TWL');
    const staCode = String(p.stationCode || p.staCode || '').trim().toUpperCase();
    const dir = _normalizeDirection(lineCode, p.direction || p.dirCode, p.destCode, p.destName);

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
          vectors: { CBD_INBOUND: 0.5, CBD_OUTBOUND: 0.5 }
        };

    const cal = cityFlow.calendar;
    const vec = cityFlow.vectors || {};
    const wx = cityFlow.weather || { outdoorMod: 1.0, urbanIndoorMod: 1.0, preTyphoonEvacMod: 1.0 };
    const h = Number(cal.hourFloat) || 12;
    const isWeekday = cal.dayType === 'weekday';
    const isAmPeak = isWeekday && h >= 7.25 && h <= 9.75;
    const isPmPeak = isWeekday && h >= 17.25 && h <= 20.25;
    const isPeakWindow = isAmPeak || isPmPeak;
    const isPreTyphoon = Number(wx.preTyphoonEvacMod || 1.0) > 1.1;

    // 1. Corridor vector mapping via hk-people-flow.js + line-specific directional choke links
    const corridorMap = mapFn
      ? mapFn({
          originText: p.originName || staCode,
          destText: p.destName || p.destCode || '',
          stopText: `${lineCode} ${staCode}`,
          routeCode: lineCode,
          mode: 'MTR'
        })
      : { primaryVector: 'CBD_INBOUND', vectorKeys: [], vectors: [] };

    let basePressure = 0.35;
    let primaryVector = corridorMap.primaryVector || 'CBD_INBOUND';
    let chokeBoost = 1.0;
    let isHomeboundLine = false;
    let corridorAlreadyIndoorWeighted = false;

    let matchedVectors = [];
    const pickMax = (candidates) => {
      let bestVal = 0;
      let bestKey = primaryVector;
      const list = [];
      for (let i = 0; i < candidates.length; i++) {
        const [k, w] = candidates[i];
        const v = Number(vec[k] || 0) * w;
        if (w > 0) list.push({ key: k, value: Number(v.toFixed(2)) });
        if (v > bestVal) {
          bestVal = v;
          bestKey = k;
        }
      }
      list.sort((a, b) => b.value - a.value);
      matchedVectors = list.slice(0, 4);
      basePressure = bestVal;
      primaryVector = bestKey;
    };

    if (lineCode === 'TWL') {
      if (dir === 'DOWN') {
        // Southbound toward Admiralty / Central
        pickMax([
          ['CBD_INBOUND', 1.0],
          ['SUNDAY_URBAN_HUB', SUNDAY_HUB_MTR_STATIONS.has(staCode) ? 0.72 : 0.45]
        ]);
        corridorAlreadyIndoorWeighted = true;
        if (isAmPeak) {
          chokeBoost = TWL_CORE_STATIONS.has(staCode) ? 1.28 : 1.18;
        } else if (isPmPeak) {
          chokeBoost = 0.88; // counter-peak southbound
        }
      } else {
        // Northbound out of Central / Admiralty / TST / Mong Kok toward Tsuen Wan
        isHomeboundLine = true;
        pickMax([
          ['CBD_OUTBOUND', 1.0],
          ['SUNDAY_URBAN_HUB', SUNDAY_HUB_MTR_STATIONS.has(staCode) ? 0.72 : 0.45]
        ]);
        corridorAlreadyIndoorWeighted = true;
        if (isPmPeak || isPreTyphoon) {
          chokeBoost = TWL_CORE_STATIONS.has(staCode) ? 1.28 : 1.16;
        } else if (isAmPeak) {
          chokeBoost = 0.85; // counter-peak northbound
        }
      }
    } else if (lineCode === 'KTL') {
      // Kowloon East–West core (KOT, MOK, PRE, DIH, KOB, KWT, YAT)
      const isCore = KTL_CORE_STATIONS.has(staCode) || !staCode;
      if (dir === 'UP') {
        // Eastbound toward Kwun Tong / Tiu Keng Leng (AM into Kowloon Bay/Kwun Tong CBD + PM homebound)
        isHomeboundLine = !isAmPeak;
        pickMax([
          ['CBD_INBOUND', isAmPeak ? 0.96 : 0.60],
          ['CBD_OUTBOUND', isPmPeak || isPreTyphoon ? 0.98 : 0.65],
          ['SCHOOL_ZONE', SCHOOL_MTR_STATIONS.has(staCode) ? 0.85 : 0.40],
          ['SUNDAY_URBAN_HUB', SUNDAY_HUB_MTR_STATIONS.has(staCode) ? 0.70 : 0.40]
        ]);
      } else {
        // Westbound toward Mong Kok / Whampoa
        isHomeboundLine = isPmPeak || isPreTyphoon;
        pickMax([
          ['CBD_INBOUND', isAmPeak ? 0.98 : 0.65],
          ['CBD_OUTBOUND', isPmPeak || isPreTyphoon ? 0.94 : 0.60],
          ['SCHOOL_ZONE', SCHOOL_MTR_STATIONS.has(staCode) ? 0.85 : 0.40],
          ['SUNDAY_URBAN_HUB', SUNDAY_HUB_MTR_STATIONS.has(staCode) ? 0.72 : 0.40]
        ]);
      }
      corridorAlreadyIndoorWeighted = true;
      if (isCore && (isPeakWindow || isPreTyphoon)) {
        chokeBoost = 1.22;
      }
    } else if (lineCode === 'TKL') {
      // Tseung Kwan O Line: Yau Tong – Quarry Bay harbour bottleneck
      const isHarbourChoke = TKL_CHOKE_STATIONS.has(staCode) || !staCode;
      if (dir === 'DOWN') {
        // Westbound across harbour (YAT -> QUB -> NOP)
        pickMax([
          ['CBD_INBOUND', 1.0],
          ['CBD_OUTBOUND', 0.35]
        ]);
        corridorAlreadyIndoorWeighted = true;
        if (isAmPeak) {
          chokeBoost = (staCode === 'YAT' || staCode === 'TIK' || staCode === 'TKO' || staCode === 'QUB') ? 1.32 : (isHarbourChoke ? 1.22 : 1.12);
        } else if (isPmPeak) {
          chokeBoost = 0.84;
        }
      } else {
        // Eastbound homebound (NOP -> QUB -> YAT -> TKO/POA/LHP)
        isHomeboundLine = true;
        pickMax([
          ['CBD_OUTBOUND', 1.0],
          ['CBD_INBOUND', 0.35]
        ]);
        corridorAlreadyIndoorWeighted = true;
        if (isPmPeak || isPreTyphoon) {
          chokeBoost = (staCode === 'NOP' || staCode === 'QUB' || staCode === 'YAT' || staCode === 'TIK') ? 1.32 : (isHarbourChoke ? 1.22 : 1.12);
        } else if (isAmPeak) {
          chokeBoost = 0.84;
        }
      }
    } else if (lineCode === 'EAL') {
      // East Rail Line: 9-car cross-harbour + Fri PM / Sat AM northbound border + Sun PM / holiday-end southbound return
      if (dir === 'UP') {
        // Northbound toward Sha Tin / Lo Wu / Lok Ma Chau
        isHomeboundLine = true;
        pickMax([
          ['TO_BORDER_NORTH', 1.0],
          ['CBD_OUTBOUND', 1.0],
          ['SCHOOL_ZONE', SCHOOL_MTR_STATIONS.has(staCode) ? 0.78 : 0.30]
        ]);
        corridorAlreadyIndoorWeighted = primaryVector === 'CBD_OUTBOUND' || primaryVector === 'SCHOOL_ZONE';
        if (primaryVector === 'TO_BORDER_NORTH' && Number(vec.TO_BORDER_NORTH || 0) >= 1.25) {
          chokeBoost = 1.24;
        } else if (isPmPeak || isPreTyphoon) {
          chokeBoost = EAL_CHOKE_STATIONS.has(staCode) ? 1.28 : 1.18;
        } else if (isAmPeak) {
          chokeBoost = 0.85;
        }
      } else {
        // Southbound toward Kowloon Tong / Hung Hom / Exhibition / Admiralty
        pickMax([
          ['FROM_BORDER_NORTH', 1.0],
          ['CBD_INBOUND', 1.0],
          ['SCHOOL_ZONE', SCHOOL_MTR_STATIONS.has(staCode) ? 0.78 : 0.30],
          ['SUNDAY_URBAN_HUB', SUNDAY_HUB_MTR_STATIONS.has(staCode) ? 0.72 : 0.40]
        ]);
        corridorAlreadyIndoorWeighted = primaryVector === 'CBD_INBOUND' || primaryVector === 'SCHOOL_ZONE' || primaryVector === 'SUNDAY_URBAN_HUB';
        if (primaryVector === 'FROM_BORDER_NORTH' && Number(vec.FROM_BORDER_NORTH || 0) >= 1.25) {
          chokeBoost = 1.24;
        } else if (isAmPeak) {
          chokeBoost = EAL_CHOKE_STATIONS.has(staCode) ? 1.30 : 1.18;
        } else if (isPmPeak) {
          chokeBoost = 0.85;
        }
      }
    } else if (lineCode === 'TCL' || lineCode === 'AEL') {
      // Tung Chung Line & Airport Express: Airport / AWE / weekend & holiday Lantau flows
      const isAel = lineCode === 'AEL';
      const trailWt = isAel ? 0.0 : 0.88;
      const cbdWt = isAel ? 0.45 : 0.92;
      if (dir === 'DOWN') {
        // Westbound toward Tsing Yi / Tung Chung / Airport / AWE
        isHomeboundLine = !isAel;
        pickMax([
          ['TO_AIRPORT_AWE', 1.0],
          ['TO_TRAIL_EXPOSED', trailWt],
          ['CBD_OUTBOUND', cbdWt]
        ]);
        corridorAlreadyIndoorWeighted = primaryVector === 'CBD_OUTBOUND';
        if (cal.dayType !== 'weekday' || cal.isEveOfHoliday || cal.isAweEventDate) {
          chokeBoost = TCL_AEL_STATIONS.has(staCode) ? (isAel ? 1.10 : 1.22) : 1.12;
        } else if (!isAel && (isPmPeak || isPreTyphoon)) {
          chokeBoost = 1.18;
        } else if (isAel) {
          chokeBoost = 0.88;
        }
      } else {
        // Eastbound toward Kowloon / Hong Kong
        pickMax([
          ['FROM_AIRPORT_AWE', 1.0],
          ['FROM_TRAIL_EXPOSED', trailWt],
          ['CBD_INBOUND', cbdWt]
        ]);
        corridorAlreadyIndoorWeighted = primaryVector === 'CBD_INBOUND';
        if (cal.dayType !== 'weekday' || cal.isAweEventDate) {
          chokeBoost = TCL_AEL_STATIONS.has(staCode) ? (isAel ? 1.10 : 1.20) : 1.10;
        } else if (!isAel && isAmPeak) {
          chokeBoost = 1.18;
        } else if (isAel) {
          chokeBoost = 0.88;
        }
      }
    } else if (lineCode === 'ISL') {
      isHomeboundLine = isPmPeak || isPreTyphoon;
      pickMax([
        ['CBD_INBOUND', isAmPeak ? 1.0 : 0.75],
        ['CBD_OUTBOUND', isPmPeak || isPreTyphoon ? 1.0 : 0.75],
        ['SUNDAY_URBAN_HUB', SUNDAY_HUB_MTR_STATIONS.has(staCode) ? 0.82 : 0.50]
      ]);
      corridorAlreadyIndoorWeighted = true;
      if (ISL_CORE_STATIONS.has(staCode) && (isPeakWindow || isPreTyphoon)) chokeBoost = 1.20;
    } else if (lineCode === 'TML') {
      isHomeboundLine = isPmPeak || isPreTyphoon;
      pickMax([
        ['CBD_INBOUND', isAmPeak ? 1.0 : 0.65],
        ['CBD_OUTBOUND', isPmPeak || isPreTyphoon ? 1.0 : 0.65],
        ['TO_BORDER_NORTH', 0.65],
        ['FROM_BORDER_NORTH', 0.65]
      ]);
      corridorAlreadyIndoorWeighted = primaryVector === 'CBD_INBOUND' || primaryVector === 'CBD_OUTBOUND';
      if (isPeakWindow || isPreTyphoon) chokeBoost = 1.16;
    } else if (lineCode === 'SIL') {
      isHomeboundLine = dir === 'DOWN';
      pickMax([
        ['CBD_INBOUND', dir === 'UP' ? 1.0 : 0.45],
        ['CBD_OUTBOUND', dir === 'DOWN' ? 1.0 : 0.45],
        ['TO_BEACH_WATER', dir === 'DOWN' ? 0.75 : 0.25],
        ['FROM_BEACH_WATER', dir === 'UP' ? 0.75 : 0.25]
      ]);
      corridorAlreadyIndoorWeighted = primaryVector === 'CBD_INBOUND' || primaryVector === 'CBD_OUTBOUND';
      if (isPeakWindow || isPreTyphoon) chokeBoost = 1.15;
    } else if (lineCode === 'DRL') {
      const isFireworksExit = dir === 'UP' && h >= 20.25 && h <= 22.25;
      pickMax([
        ['TO_TRAIL_EXPOSED', dir === 'DOWN' ? 0.85 : 0.35],
        ['FROM_TRAIL_EXPOSED', dir === 'UP' ? 0.85 : 0.35]
      ]);
      if (isFireworksExit) {
        basePressure = Math.max(basePressure, 1.45);
        chokeBoost = 1.15;
      }
    } else {
      // LRT / generic rail feeder
      isHomeboundLine = isPmPeak || isPreTyphoon;
      pickMax([
        ['CBD_INBOUND', isAmPeak ? 0.92 : 0.55],
        ['CBD_OUTBOUND', isPmPeak || isPreTyphoon ? 0.92 : 0.55],
        ['SCHOOL_ZONE', 0.85]
      ]);
      corridorAlreadyIndoorWeighted = true;
      if (isPeakWindow || isPreTyphoon) chokeBoost = 1.12;
    }

    // 2. Apply HKO Weather Modifiers:
    //    - urbanIndoorMod boosts underground MTR demand during rain/rainstorms
    //    - preTyphoonEvacMod spikes homebound lines during Pre-T8 warnings
    let weatherMod = 1.0;
    const indoorMod = Number(wx.urbanIndoorMod || 1.0);
    if (indoorMod > 1.0 && !corridorAlreadyIndoorWeighted) {
      weatherMod *= indoorMod;
    } else if (indoorMod > 1.0 && corridorAlreadyIndoorWeighted) {
      // Underground MTR receives an additional shift from rain-exposed bus/walk trips
      weatherMod *= (1.0 + (indoorMod - 1.0) * 0.45);
    }
    const preT8Mod = Number(wx.preTyphoonEvacMod || 1.0);
    if (preT8Mod > 1.05 && isHomeboundLine) {
      // Ensure homebound lines always reflect strong Pre-T8 evacuation spike
      weatherMod *= (primaryVector === 'CBD_OUTBOUND' ? 1.18 : preT8Mod);
    }

    // 3. Fuse Live MTR Next-Train Headway Spacing
    const cadenceCfg = LINE_EXPECTED_CADENCE_SEC[lineCode] || LINE_EXPECTED_CADENCE_SEC.TWL;
    const expectedCadenceSec = isPeakWindow ? cadenceCfg.peak : cadenceCfg.offPeak;
    const headwayGapSec = _extractLiveHeadwaySec(p.nextTrains, p.obsHeadwaySec, p.nowMs);
    const headwayGapMins = headwayGapSec !== null ? Number((headwayGapSec / 60).toFixed(1)) : null;

    let headwayMod = 1.0;
    let isHeadwayStretched = false;
    const isUrbanHeavyRail = ['TWL', 'KTL', 'ISL', 'TKL', 'EAL', 'TML', 'SIL'].includes(lineCode);

    if (headwayGapSec !== null) {
      const gapRatio = headwayGapSec / Math.max(120, expectedCadenceSec);
      const isFiveMinGap = isUrbanHeavyRail && headwayGapSec >= 300;
      if (isFiveMinGap || gapRatio >= 1.8) {
        isHeadwayStretched = true;
        if (basePressure >= 0.72 || isPeakWindow || isPreTyphoon) {
          headwayMod = Number(_clamp(1.28 + Math.max(0, gapRatio - 1.5) * 0.25, 1.30, 1.65).toFixed(3));
        } else {
          headwayMod = Number(_clamp(1.12 + Math.max(0, gapRatio - 1.5) * 0.14, 1.14, 1.32).toFixed(3));
        }
      } else if (gapRatio >= 1.35) {
        headwayMod = Number(_clamp(1.0 + (gapRatio - 1.2) * 0.25, 1.05, 1.22).toFixed(3));
      } else if (gapRatio <= 0.75 && headwayGapSec <= 135 && !isPeakWindow) {
        headwayMod = 0.90;
      }
    }
    if (p.isDelay) {
      isHeadwayStretched = true;
      headwayMod = Math.max(headwayMod, 1.45);
    }

    const score = Number((basePressure * chokeBoost * weatherMod * headwayMod).toFixed(3));

    let state = 'COMFORTABLE';
    let labelEn = 'Space';
    let labelTc = '寬敞';
    let cssClass = 'load-low';
    let pct = _clamp(Math.round(18 + score * 34), 18, 51);
    let tipEn = '';
    let tipTc = '';

    if (score >= 1.45) {
      state = 'CRUSH';
      labelEn = 'Crowded';
      labelTc = '擠迫';
      cssClass = 'load-high';
      pct = _clamp(Math.round(78 + (score - 1.45) * 28), 78, 98);
      if (isPreTyphoon && isHomeboundLine) {
        tipEn = 'Pre-T8 homebound surge — platforms very crowded.';
        tipTc = '八號風球前下班人潮 — 月台非常擠迫。';
      } else if (isHeadwayStretched && headwayGapMins !== null) {
        tipEn = `${headwayGapMins}m train gap — heavy platform buildup.`;
        tipTc = `列車班距達${headwayGapMins}分鐘 — 月台候車人流擠迫。`;
      } else if (lineCode === 'TKL') {
        tipEn = 'Yau Tong–Quarry Bay peak bottleneck — expect tight cabins.';
        tipTc = '油塘至鰂魚涌繁忙瓶頸 — 車廂較為擠迫。';
      } else if (lineCode === 'EAL' && (primaryVector === 'TO_BORDER_NORTH' || primaryVector === 'FROM_BORDER_NORTH')) {
        tipEn = 'Heavy border corridor wave — expect crowded cars.';
        tipTc = '口岸跨境客流高峰 — 車廂較為擠迫。';
      } else {
        tipEn = 'Peak rail demand — expect crowded platforms.';
        tipTc = '鐵路繁忙高峰 — 月台及車廂較擠迫。';
      }
    } else if (score >= 0.92) {
      state = 'BUSY';
      labelEn = 'Busy';
      labelTc = '繁忙';
      cssClass = 'load-med';
      pct = _clamp(Math.round(52 + (score - 0.92) * 48), 52, 77);
      if (isHeadwayStretched && headwayGapMins !== null) {
        tipEn = `${headwayGapMins}m train gap — busier platforms.`;
        tipTc = `列車班距達${headwayGapMins}分鐘 — 月台較繁忙。`;
      } else if (indoorMod > 1.1) {
        tipEn = 'Rain shifting commuters underground — busier cabins.';
        tipTc = '天雨帶動鐵路人流 — 車廂較繁忙。';
      } else if (lineCode === 'TCL' || lineCode === 'AEL') {
        tipEn = 'Elevated airport & Lantau rail flow.';
        tipTc = '機場及大嶼山鐵路客流較多。';
      }
    }

    const wxSummaryParts = [];
    if (p.hkoWeather) {
      if (Number.isFinite(Number(p.hkoWeather.temp))) wxSummaryParts.push(`${Math.round(Number(p.hkoWeather.temp))}°C`);
      if (p.hkoWeather.typhoon || p.hkoWeather.tcSignal) wxSummaryParts.push(String(p.hkoWeather.tcSignal || 'Typhoon'));
      else if (p.hkoWeather.preTyphoon || p.hkoWeather.preT8) wxSummaryParts.push('Pre-T8');
      else if (p.hkoWeather.heavyRain) wxSummaryParts.push('Heavy Rain');
      else if (p.hkoWeather.rain || p.hkoWeather.rainAdvisory) wxSummaryParts.push('Rain');
      else wxSummaryParts.push('Dry');
    }
    const breakdown = {
      mode: 'fused',
      matchedVectors: matchedVectors.length ? matchedVectors : [{ key: primaryVector, value: Number(basePressure.toFixed(2)) }],
      calendar: {
        isoWeek: cal.isoWeek || 1,
        dayType: cal.dayType || 'weekday',
        isSchoolDay: Boolean(cal.isSchoolDay),
        isEveOfHoliday: Boolean(cal.isEveOfHoliday),
        hourFloat: cal.hourFloat ?? 12,
        dateStr: cal.dateStr || ''
      },
      weather: {
        source: p.hkoWeather ? 'Live' : 'Fallback',
        outdoorMod: Number(wx.outdoorMod || 1.0),
        urbanIndoorMod: Number(wx.urbanIndoorMod || 1.0),
        preTyphoonEvacMod: Number(wx.preTyphoonEvacMod || 1.0),
        summary: p.hkoWeather ? wxSummaryParts.join(' · ') : 'Seasonal baseline (no live HKO)'
      },
      liveFactors: {
        lineCode,
        stationCode: staCode,
        direction: dir,
        chokeBoost: Number(chokeBoost.toFixed(2)),
        headwayGapMins,
        expectedCadenceMins: Number((expectedCadenceSec / 60).toFixed(1)),
        headwayMod: Number(headwayMod.toFixed(2)),
        isHeadwayStretched,
        isDelay: Boolean(p.isDelay)
      },
      rawScore: score,
      tier: state
    };

    return {
      mode: 'MTR',
      lineCode,
      stationCode: staCode,
      direction: dir,
      state,
      labelEn,
      labelTc,
      cssClass,
      pct,
      score,
      basePressure: Number(basePressure.toFixed(3)),
      chokeBoost: Number(chokeBoost.toFixed(3)),
      weatherMod: Number(weatherMod.toFixed(3)),
      headwayMod: Number(headwayMod.toFixed(3)),
      headwayGapSec,
      headwayGapMins,
      expectedCadenceSec,
      isHeadwayStretched,
      isHomeboundLine,
      primaryVector,
      tipEn,
      tipTc,
      cityFlow,
      breakdown
    };
  }

  const MtrSurgeEngine = {
    LINE_EXPECTED_CADENCE_SEC,
    estimateMtrLoadStatus
  };

  if (root) {
    root.estimateMtrLoadStatus = estimateMtrLoadStatus;
    root.MtrSurgeEngine = MtrSurgeEngine;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ...MtrSurgeEngine,
      MtrSurgeEngine
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
