// ============================================================================
// File: raptor-cost-engine.js (johntjz/Hk-Fleet — RAPTOR Graph, Fare & Disruption Cost Engine)
// ============================================================================

var _raptorGraph = (typeof _raptorGraph !== 'undefined') ? _raptorGraph : null;
var _raptorGraphRouteCount = (typeof _raptorGraphRouteCount !== 'undefined') ? _raptorGraphRouteCount : 0;
var xferTimeMode = (typeof xferTimeMode !== 'undefined') ? xferTimeMode : 'NOW';
var xferPlannedHHMM = (typeof xferPlannedHHMM !== 'undefined') ? xferPlannedHHMM : null;
var xferLocoBikeEnabled = (typeof xferLocoBikeEnabled !== 'undefined') ? xferLocoBikeEnabled : false;
var xferSortPref = (typeof xferSortPref !== 'undefined') ? xferSortPref : 'BULLETPROOF'; // 'BULLETPROOF' | 'FASTEST' | 'EASY' | 'CHEAPEST'

window.invalidateRaptorGraph = function() {
  _raptorGraph = null;
  _raptorGraphRouteCount = 0;
};

// ============================================================================
const GOLDEN_BBI_KEYWORDS = /interchange|bbi|toll plaza|tunnel|terminus|pti|station|pier|轉車站|轉乘站|收費廣場|隧道口|巴士總站|公共運輸交匯處|港鐵站|碼頭|青嶼幹線|屯門公路|大欖隧道|城門隧道|大老山隧道|獅子山隧道|海底隧道|西區海底隧道|東區海底隧道/i;

function isStrategicInterchangeHub(stopObj) {
  if (!stopObj) return false;
  if (stopObj.mode === 'MTR' || stopObj.mode === 'FERRY') return true;
  if (typeof getMajorBbiHubMatch === 'function' && getMajorBbiHubMatch(stopObj)) return true;
  const txt = `${stopObj.stopName_e || ''} ${stopObj.name_tc || ''}`;
  return GOLDEN_BBI_KEYWORDS.test(txt);
}

function isLantauOrAirportZone(lat, lon, nameStr = '') {
  if (typeof isAirportOrPortZone === 'function' && isAirportOrPortZone(lat, lon, nameStr)) return true;
  const la = Number(lat), lo = Number(lon);
  if (Number.isFinite(la) && Number.isFinite(lo) && lo < 114.055 && la < 22.345) return true;
  return /tung chung|lantau|mui wo|tai o|pui o|discovery bay|sunny bay|東涌|大嶼山|梅窩|大澳|貝澳|愉景灣|欣澳/i.test(String(nameStr || ''));
}

function isExternalERoute(group) {
  if (!group || (group.mode && group.mode !== 'BUS')) return false;
  return /^N?E\d+[A-Z]?$/i.test(String(group.routeNo || '').trim());
}

function isInSharedBikeZone(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return false;
  const ZONES = [
    [22.368, 22.482, 113.950, 114.075],
    [22.482, 22.532, 114.100, 114.168],
    [22.415, 22.475, 114.150, 114.225],
    [22.362, 22.442, 114.168, 114.252],
    [22.358, 22.382, 114.098, 114.128],
    [22.288, 22.332, 114.245, 114.282],
    [22.275, 22.305, 113.925, 113.960]
  ];
  return ZONES.some(([minLa, maxLa, minLo, maxLo]) =>
    la >= minLa && la <= maxLa && lo >= minLo && lo <= maxLo
  );
}

// Infers projected Bus/MTR/LRT/Ferry load for Planner legs
function inferPlannerLegLoad(group, boardStopObj, targetDateObj, isHoliday = false, obsHeadwaySec = 0, extra = {}) {
  if (!group || typeof LoadFactorEngine === 'undefined') return null;
  if (group.mode === 'FERRY') {
    return typeof LoadFactorEngine.inferFerryLoad === 'function'
      ? LoadFactorEngine.inferFerryLoad({
          group,
          origName: boardStopObj?.stopName_e || group.orig_e || '',
          destName: extra?.alightStopObj?.stopName_e || group.dest_e || '',
          vesselClass: extra?.vesselClass || group.ferryMeta?._activeVesselClass || '',
          obsHeadwaySec,
          schedHeadwaySec: typeof getPeriodHeadwaySecs === 'function'
            ? getPeriodHeadwaySecs(group, targetDateObj?.getTime?.() || Date.now())
            : ((Number(group.headwayMins) || 35) * 60),
          isSched: Boolean(extra?.isSched),
          dateObj: targetDateObj,
          isHoliday
        })
      : null;
  }
  if (group.mode === 'MTR') {
    const isLrt = group.company === 'LRT';
    return LoadFactorEngine.inferMtrLoad({
      isLrt,
      company: group.company,
      lineCode: group.routeNo,
      staCode: boardStopObj?.mtrCode || boardStopObj?.stopId || '',
      dirCode: extractRouteBoundCode(group),
      destName: extra?.alightStopObj?.stopName_e || group.dest_e || '',
      obsHeadwaySec,
      dateObj: targetDateObj,
      isHoliday
    });
  }
  const rStops = getStopsForGroup(group, boardStopObj?.stopKey);
  const stopIdx = Math.max(0, Number(boardStopObj?.seq || 1) - 1);
  const bLat = Number(boardStopObj?.lat ?? boardStopObj?.latitude);
  const bLon = Number(boardStopObj?.lon ?? boardStopObj?.longitude);
  const corStatus = (typeof getCorridorLiveStatusAt === 'function' && Number.isFinite(bLat) && Number.isFinite(bLon))
    ? (getCorridorLiveStatusAt(bLat, bLon)?.status || 'SMOOTH')
    : 'SMOOTH';
  const schedHw = typeof getPeriodHeadwaySecs === 'function'
    ? getPeriodHeadwaySecs(group, targetDateObj?.getTime?.() || Date.now())
    : ((Number(group.headwayMins) || 12) * 60);
  return LoadFactorEngine.inferBusLoad({
    group,
    stopObj: boardStopObj,
    origName: group.orig_e || rStops[0]?.stopName_e || '',
    destName: extra?.alightStopObj?.stopName_e || group.dest_e || rStops[rStops.length - 1]?.stopName_e || '',
    stopIdx,
    totalStops: rStops.length || 16,
    obsHeadwaySec,
    schedHeadwaySec: schedHw,
    corridorStatus: corStatus,
    isSched: Boolean(extra?.isSched),
    dateObj: targetDateObj,
    isHoliday
  });
}

function getMtrInternalTransferSec(staCode, lineA, lineB, nextStaCode = '') {
  if (typeof MTR_ENGINE !== 'undefined' && typeof MTR_ENGINE.getInterchangeWalkSec === 'function') {
    return MTR_ENGINE.getInterchangeWalkSec(staCode, lineA, lineB, nextStaCode);
  }
  return 150;
}

// Realistic 3D interchange buffer: adds vertical concourse/viaduct/gate ingress on BUS -> MTR transitions
function getInterchangeTransferSec(prevG, nextG, stopMeta, walkSec = 0) {
  const prevHeavy = prevG?.mode === 'MTR' && prevG?.company === 'MTR';
  const nextHeavy = nextG?.mode === 'MTR' && nextG?.company === 'MTR';
  const prevLrt   = prevG?.company === 'LRT';
  const nextLrt   = nextG?.company === 'LRT';

  let baseSec = 150;
  if (prevHeavy && nextHeavy) {
    baseSec = getMtrInternalTransferSec(stopMeta?.mtrCode, prevG.routeNo, nextG.routeNo, stopMeta?.nextMtrCode || '');
  } else if ((prevHeavy && nextLrt) || (prevLrt && nextHeavy)) {
    baseSec = 240;
  } else if (!prevHeavy && nextHeavy) {
    // 3D vertical station climb (viaduct escalators + concourse + fare gates + platform walk) on top of 2D street walk
    const stDepth = typeof MTR_ENGINE !== 'undefined'
      ? MTR_ENGINE.getStationDepthSec(stopMeta?.mtrCode || '')
      : 105;
    baseSec = Math.max(210, (walkSec || 0) + stDepth + 120);
  } else if (prevHeavy && !nextHeavy) {
    // Descending out of heavy rail concourse to street-level bus stop
    const stDepth = typeof MTR_ENGINE !== 'undefined'
      ? MTR_ENGINE.getStationDepthSec(stopMeta?.mtrCode || '')
      : 90;
    baseSec = Math.max(180, (walkSec || 0) + stDepth + 60);
  } else {
    // Enforce a realistic minimum 3-minute (180s) road-to-road bus/GMB transfer buffer to avoid missed paper-only connections
    baseSec = Math.max(stopMeta?.isGoldenHub ? 150 : 180, (walkSec || 0) + 90);
  }

  if (xferSortPref === 'BULLETPROOF' && !(prevHeavy && nextHeavy)) {
    baseSec += nextHeavy ? 150 : 210;
  } else if (xferSortPref === 'FASTEST' && !(prevHeavy && nextHeavy)) {
    baseSec = Math.max(120, Math.round(baseSec * 0.80));
  }

  const nextHw = Number(nextG?.headwayMins) || 15;
  if (nextG?.mode === 'FERRY') {
    baseSec = Math.max(baseSec, 270);
  } else if (nextHw >= 20 && !nextHeavy) {
    baseSec = Math.max(baseSec, 240);
  }
  return baseSec;
}


// ============================================================================
function findNearestMtrExitForPoint(pointLat, pointLon, stationLat, stationLon) {
  const exits = window.MTR_EXITS_DIRECTORY;
  if (!Array.isArray(exits) || !exits.length) return null;
  let bestExit = null;
  let bestPointDistKm = Infinity;

  for (let i = 0; i < exits.length; i++) {
    const ex = exits[i];
    const exLat = Number(ex.lat), exLon = Number(ex.lon);
    if (!Number.isFinite(exLat) || !Number.isFinite(exLon)) continue;
    if (Math.abs(exLat - stationLat) > 0.0045 || Math.abs(exLon - stationLon) > 0.0045) continue;
    const dStnKm = calculateDistanceKm(stationLat, stationLon, exLat, exLon);
    if (dStnKm > 0.42) continue;

    const dPtKm = calculateDistanceKm(pointLat, pointLon, exLat, exLon);
    if (dPtKm < bestPointDistKm) {
      bestPointDistKm = dPtKm;
      bestExit = { ...ex, lat: exLat, lon: exLon, distKm: dPtKm };
    }
  }
  return bestExit;
}

window.findNearestMtrExitForPoint = findNearestMtrExitForPoint;

function resolveMtrTransferExit(prevGroup, prevStop, nextGroup, nextStop) {
  if (!prevStop || !nextStop) return null;
  const prevHeavyMtr = (prevGroup?.mode === 'MTR' && prevGroup?.company === 'MTR');
  const nextHeavyMtr = (nextGroup?.mode === 'MTR' && nextGroup?.company === 'MTR');
  if (prevHeavyMtr === nextHeavyMtr) return null;

  const pLat = Number(prevStop.lat ?? prevStop.latitude);
  const pLon = Number(prevStop.lon ?? prevStop.longitude);
  const nLat = Number(nextStop.lat ?? nextStop.latitude);
  const nLon = Number(nextStop.lon ?? nextStop.longitude);
  if (!isValidRailOrFerryCoord(pLat, pLon) || !isValidRailOrFerryCoord(nLat, nLon)) return null;

  if (prevHeavyMtr) {
    const ex = findNearestMtrExitForPoint(nLat, nLon, pLat, pLon);
    if (!ex) return null;
    const distM = Math.max(15, Math.round(ex.distKm * 1000 * 1.18));
    return { exitObj: ex, side: 'alight', distM, walkSec: Math.round(distM / 1.25) };
  }
  const ex = findNearestMtrExitForPoint(pLat, pLon, nLat, nLon);
  if (!ex) return null;
  const distM = Math.max(15, Math.round(ex.distKm * 1000 * 1.18));
  return { exitObj: ex, side: 'board', distM, walkSec: Math.round(distM / 1.25) };
}

window.resolveMtrTransferExit = resolveMtrTransferExit;

// DETERMINISTIC 4-ROUND RAPTOR GRAPH
// ============================================================================
function getRaptorGraph() {
  if (_raptorGraph && _raptorGraphRouteCount === groupedRoutes.length) return _raptorGraph;
  _raptorGraphRouteCount = groupedRoutes.length;

  const stops = [];
  const stopKeyToIdx = new Map();
  const routes = [];
  const stopRoutes = [];

  const getOrCreateStopIdx = (s, gMode, gCo) => {
    const la = parseFloat(s.latitude), lo = parseFloat(s.longitude);
    if (!isValidRailOrFerryCoord(la, lo)) return -1;
    const isHeavyMtr = (gMode === 'MTR' && gCo !== 'LRT' && !s.lrtCode);
    const stCode = String(s.mtrCode || s.stopId || '').trim().toUpperCase();
    const pierCanon = normStationLookupKey(s.stopName_e) || getBaseStopNameKey(s.stopName_e);
    const uKey = (isHeavyMtr && stCode)
      ? `MTR_HUB_${stCode}`
      : (gMode === 'FERRY' ? `FERRY_PIER_${pierCanon}` : (s.stopKey || getGlobalStopKey(s)));

    let idx = stopKeyToIdx.get(uKey);
    if (idx === undefined) {
      idx = stops.length;
      stopKeyToIdx.set(uKey, idx);
      stops.push({
        idx,
        uKey,
        stopKey: s.stopKey || uKey,
        stopId: s.stopId,
        stopName_e: s.stopName_e,
        name_tc: s.name_tc || s.stopName_e,
        lat: la,
        lon: lo,
        mode: gMode,
        company: gCo,
        mtrCode: isHeavyMtr ? stCode : (s.mtrCode || ''),
        isGoldenHub: isStrategicInterchangeHub({ stopName_e: s.stopName_e, name_tc: s.name_tc, mode: gMode, lat: la, lon: lo }),
        fare: s.fare,
        fareHol: s.fareHol
      });
      stopRoutes.push([]);
    }
    if (s.stopKey && !stopKeyToIdx.has(s.stopKey)) {
      stopKeyToIdx.set(s.stopKey, idx);
    }
    return idx;
  };

  const addStopSeqToRaptor = (g, stopSequence) => {
    const stIndices = [];
    const stObjs = [];
    const cumSecs = [0];
    const isHeavyMtr = (g.mode === 'MTR' && g.company !== 'LRT');

    for (let j = 0; j < stopSequence.length; j++) {
      const s = stopSequence[j];
      const sIdx = getOrCreateStopIdx(s, g.mode || 'BUS', g.company || '');
      if (sIdx === -1) continue;
      if (stIndices.length > 0 && stIndices[stIndices.length - 1] === sIdx) continue;
      if (stObjs.length > 0) {
        const prevS = stObjs[stObjs.length - 1];
        let stepSec;
        if (isHeavyMtr && typeof MTR_ENGINE !== 'undefined') {
          stepSec = MTR_ENGINE.getAdjacentRunningTimeSec(prevS.mtrCode || prevS.stopId, s.mtrCode || s.stopId);
        } else if (g.mode === 'FERRY' && (g.ferryMeta?.durFast || g.ferryMeta?.dur)) {
          stepSec = Math.round(((g.ferryMeta.durFast || g.ferryMeta.dur) * 60) / Math.max(1, stopSequence.length - 1));
        } else {
          const pLa = parseFloat(prevS.latitude), pLo = parseFloat(prevS.longitude);
          const sLa = parseFloat(s.latitude), sLo = parseFloat(s.longitude);
          const dKm = calculateDistanceKm(pLa, pLo, sLa, sLo);
          stepSec = computeSegmentStepSeconds(g.mode || 'BUS', g.company || '', dKm, j === stopSequence.length - 1, (pLa + sLa) / 2, (pLo + sLo) / 2);
          // Account for realistic Tung Chung North urban-loop dwell & traffic lights on non-local E-routes (e.g. E36A)
          if ((!g.mode || g.mode === 'BUS') && isExternalERoute(g) && isTungChungNorthLoopStop(s)) {
            stepSec += 70;
          }
        }
        cumSecs.push(cumSecs[cumSecs.length - 1] + stepSec);
      }
      stIndices.push(sIdx);
      stObjs.push({ ...s, lat: parseFloat(s.latitude), lon: parseFloat(s.longitude), seq: s.seq || (j + 1) });
    }
    if (stIndices.length < 2) return;
    const rIdx = routes.length;
    routes.push({ rIdx, group: g, stIndices, stObjs, cumSecs });
    stIndices.forEach((sIdx, seq) => {
      if (seq < stIndices.length - 1) stopRoutes[sIdx].push({ rIdx, seq });
    });
  };

  for (let i = 0; i < groupedRoutes.length; i++) {
    const g = groupedRoutes[i];
    const gStops = getStopsForGroup(g);
    if (gStops.length < 2) continue;

    if (g.mode === 'MTR' && gStops.length >= 4 && isParallelRailTerminusPair(gStops[gStops.length - 2]?.stopId, gStops[gStops.length - 1]?.stopId)) {
      const codeA = gStops[gStops.length - 2].stopId;
      const codeB = gStops[gStops.length - 1].stopId;
      addStopSeqToRaptor(g, gStops.filter(s => s.stopId !== codeB));
      addStopSeqToRaptor(g, gStops.filter(s => s.stopId !== codeA && !(g.routeNo === 'TKL' && s.stopId === 'HAH')));
    } else if (g.mode === 'MTR' && gStops.length >= 4 && isParallelRailTerminusPair(gStops[0]?.stopId, gStops[1]?.stopId)) {
      const codeA = gStops[0].stopId;
      const codeB = gStops[1].stopId;
      addStopSeqToRaptor(g, gStops.filter(s => s.stopId !== codeB));
      addStopSeqToRaptor(g, gStops.filter(s => s.stopId !== codeA && !(g.routeNo === 'TKL' && s.stopId === 'HAH')));
    } else {
      addStopSeqToRaptor(g, gStops);
    }
  }

  for (let i = 0; i < stops.length; i++) {
    stops[i].routeDensity = stopRoutes[i].length;
    stops[i].isGmbStop = stopRoutes[i].some(sr =>
      String(routes[sr.rIdx]?.group?.company || '').toUpperCase().startsWith('GMB')
    );
  }

  const cellMap = new Map();
  stops.forEach(st => {
    const ck = `${Math.floor(st.lat * 100)}_${Math.floor(st.lon * 100)}`;
    if (!cellMap.has(ck)) cellMap.set(ck, []);
    cellMap.get(ck).push(st);
  });

  const transfers = stops.map(() => []);
  for (let i = 0; i < stops.length; i++) {
    const sA = stops[i];
    const bLa = Math.floor(sA.lat * 100), bLo = Math.floor(sA.lon * 100);
    const candGeneral = [];
    const candMtrGmb = [];
    for (let dLa = -1; dLa <= 1; dLa++) {
      for (let dLo = -1; dLo <= 1; dLo++) {
        const bucket = cellMap.get(`${bLa + dLa}_${bLo + dLo}`);
        if (!bucket) continue;
        for (const sB of bucket) {
          if (sB.idx === i) continue;
          const isMtrGmbPair = (sA.mode === 'MTR' && sB.isGmbStop) || (sA.isGmbStop && sB.mode === 'MTR');
          const isRailOrFerry = (sA.mode === 'MTR' || sB.mode === 'MTR' || sA.mode === 'FERRY' || sB.mode === 'FERRY');
          const centerKm = calculateDistanceKm(sA.lat, sA.lon, sB.lat, sB.lon);

          // Targeted 450m MTR-Exit -> GMB feeder walk radius without widening dense urban bus-to-bus radii
          let effKm = centerKm;
          if (isMtrGmbPair) {
            if (centerKm > 0.62) continue;
            const mtrS = (sA.mode === 'MTR') ? sA : sB;
            const gmbS = (sA.mode === 'MTR') ? sB : sA;
            const nearEx = (typeof findNearestMtrExitForPoint === 'function')
              ? findNearestMtrExitForPoint(gmbS.lat, gmbS.lon, mtrS.lat, mtrS.lon)
              : null;
            if (nearEx && Number.isFinite(nearEx.distM)) {
              effKm = nearEx.distM / 1000;
            }
            if (effKm > 0.45) continue;
          } else {
            const maxNonGmbKm = isRailOrFerry ? 0.40 : 0.30;
            if (centerKm > maxNonGmbKm) continue;
          }

          if (window.crossesWaterBarrier(sA.lat, sA.lon, sB.lat, sB.lon)) continue;
          const distM = Math.round(effKm * 1000);
          let walkSec = Math.max(45, Math.round((distM * 1.22) / 1.25));
          if ((sA.mtrCode === 'TST' && sB.mtrCode === 'ETS') || (sA.mtrCode === 'ETS' && sB.mtrCode === 'TST')) {
            walkSec = 240;
          } else if ((sA.mtrCode === 'CEN' && sB.mtrCode === 'HOK') || (sA.mtrCode === 'HOK' && sB.mtrCode === 'CEN')) {
            walkSec = 330;
          }
          const edge = { toIdx: sB.idx, walkSec, distM, isMtrGmb: isMtrGmbPair };
          if (isMtrGmbPair) candMtrGmb.push(edge);
          else candGeneral.push(edge);
        }
      }
    }
    candGeneral.sort((a, b) => a.walkSec - b.walkSec);
    candMtrGmb.sort((a, b) => a.walkSec - b.walkSec);
    // Keep up to 15 dedicated MTR<->GMB feeder links so dense stations (Long Ping / Yuen Long) never drop GMB 74
    const mergedEdges = [...candGeneral.slice(0, 40), ...candMtrGmb.slice(0, 15)];
    mergedEdges.sort((a, b) => a.walkSec - b.walkSec);
    transfers[i] = mergedEdges;
  }

  _raptorGraph = { stops, stopKeyToIdx, routes, stopRoutes, transfers };
  return _raptorGraph;
}

// ============================================================================
// UNIFIED MULTI-MODAL FARE ENGINE
// ============================================================================
function getSharedBikeLegFareHkd(distM = 0) {
  const dM = Math.max(0, Number(distM) || 0);
  if (dM <= 0) return 0;
  const rideSecs = Math.round(dM / 4.16);
  if (typeof computeSharedBikeFareHkd === 'function') {
    return computeSharedBikeFareHkd(rideSecs, dM);
  }
  const blocks = Math.max(1, Math.ceil(Math.max(1, rideSecs / 60) / 30));
  return Number((blocks * 5.0).toFixed(1));
}

function computeLegChainFareHkd(legs, isHoliday = isHongKongHolidayFareDay(), metaOut = null, originLat = null, originLon = null, bikeSpec = null) {
  if (!Array.isArray(legs) || !legs.length) return 0;
  let totalFare = 0;
  let railBuffer = [];
  let prevBusGroup = null;
  let prevBusFare = 0;
  let prevHeavyMtrEndCode = '';
  const notices = [];

  const flushRailBuffer = () => {
    if (!railBuffer.length) return;
    if (typeof MTR_ENGINE !== 'undefined' && typeof MTR_ENGINE.evaluateRailChain === 'function') {
      const res = MTR_ENGINE.evaluateRailChain(railBuffer, {
        originLat,
        originLon,
        matrixLookupFn: window.getExactMtrFare
      });
      totalFare += Number(res.totalFare || 0);
      if (res.fareSaverApplied) {
        notices.push({
          type: 'fare_saver',
          en: '💡 -$2.0 MTR Fare Saver available near origin',
          tc: '💡 起點附近設有港鐵特惠站可減 $2.0'
        });
      }
    } else {
      const firstH = railBuffer.find(x => x.company !== 'LRT');
      const lastH = [...railBuffer].reverse().find(x => x.company !== 'LRT');
      if (firstH && lastH) {
        totalFare += (window.getExactMtrFare?.(firstH.from, lastH.to) || 12.0);
      }
    }
    const lastHeavy = [...railBuffer].reverse().find(x => x.company !== 'LRT');
    prevHeavyMtrEndCode = lastHeavy ? lastHeavy.to : '';
    railBuffer = [];
  };

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const g = leg.group;
    if (!g) continue;

    if (g.mode === 'MTR') {
      const isLrt = (g.company === 'LRT');
      railBuffer.push({
        line: isLrt ? 'LRT' : String(g.routeNo || '').toUpperCase(),
        company: g.company || 'MTR',
        from: leg.boardStopObj?.mtrCode || leg.boardStopObj?.stopId || '',
        to: leg.alightStopObj?.mtrCode || leg.alightStopObj?.stopId || '',
        driveSec: leg.driveSec || 0,
        walkAfterSec: leg.walkAfterSec || 0,
        lrtFareHkd: isLrt ? computeLrtZoneFare(leg.boardStopObj, leg.alightStopObj) : 0
      });
      prevBusGroup = null;
      prevBusFare = 0;
      continue;
    }

    const nextLeg = legs[i + 1];
    const nextIsHeavyMtr = Boolean(nextLeg?.group?.mode === 'MTR' && nextLeg?.group?.company !== 'LRT');
    const nextMtrEntryCode = nextIsHeavyMtr ? (nextLeg.boardStopObj?.mtrCode || nextLeg.boardStopObj?.stopId || '') : '';

    const hadHeavyMtr = railBuffer.some(x => x.company !== 'LRT');
    flushRailBuffer();

    let legFare = 0;
    if (g.mode === 'FERRY') {
      legFare = getEffectiveStopFare(g, leg.boardStopObj, leg.alightStopObj, isHoliday, leg.vesselClass || null);
      prevBusGroup = null;
      prevBusFare = 0;
      prevHeavyMtrEndCode = '';
    } else {
      const secRes = (typeof resolveBusLegNetFare === 'function')
        ? resolveBusLegNetFare(g, leg.boardStopObj, leg.alightStopObj, isHoliday)
        : { upfrontFare: getEffectiveStopFare(g, leg.boardStopObj, leg.alightStopObj, isHoliday), netFare: getEffectiveStopFare(g, leg.boardStopObj, leg.alightStopObj, isHoliday), rebateAmount: 0, rebateType: null, noticeEn: '', noticeTc: '' };

      legFare = secRes.netFare;
      leg.sectionalMeta = secRes;
      if (secRes.noticeEn) {
        notices.push({
          type: secRes.rebateType || 'sectional',
          routeNo: g.routeNo,
          upfrontFare: secRes.upfrontFare,
          netFare: secRes.netFare,
          rebateAmount: secRes.rebateAmount,
          en: secRes.noticeEn,
          tc: secRes.noticeTc
        });
      }

      const isFreeAfterMtr = hadHeavyMtr && typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isFreeMtrFeederBus(g.routeNo, prevHeavyMtrEndCode, isHoliday);
      const isFreeBeforeMtr = nextIsHeavyMtr && typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isFreeMtrFeederBus(g.routeNo, nextMtrEntryCode, isHoliday);
      const isGmbLeg = String(g.company || '').toUpperCase().startsWith('GMB');

      if (isFreeAfterMtr || isFreeBeforeMtr) {
        const saved = legFare;
        legFare = 0;
        leg.isFreeMtrFeeder = true;
        if (saved > 0) {
          notices.push({
            type: 'mtr_interchange',
            routeNo: g.routeNo,
            en: `Octopus free MTR feeder transfer (-$${saved.toFixed(1)})`,
            tc: `八達通免費港鐵接駁轉乘（-$${saved.toFixed(1)}）`
          });
        }
      } else if ((hadHeavyMtr || nextIsHeavyMtr) && isGmbLeg && legFare > 0) {
        const mtrStaCode = hadHeavyMtr ? prevHeavyMtrEndCode : nextMtrEntryCode;
        const gmbDisc = (typeof MTR_ENGINE !== 'undefined' && typeof MTR_ENGINE.getMtrGmbInterchangeDiscount === 'function')
          ? MTR_ENGINE.getMtrGmbInterchangeDiscount(g.company, g.routeNo, mtrStaCode)
          : 0.5;
        if (gmbDisc > 0) {
          const applied = Math.min(legFare, gmbDisc);
          legFare = Number(Math.max(0, legFare - applied).toFixed(1));
          leg.mtrGmbDiscount = applied;
          notices.push({
            type: 'mtr_interchange',
            routeNo: g.routeNo,
            en: `Octopus MTR–GMB interchange discount (-$${applied.toFixed(1)})`,
            tc: `八達通港鐵轉乘專線小巴優惠（-$${applied.toFixed(1)}）`
          });
        }
      } else if (prevBusGroup) {
        const hub = typeof getMajorBbiHubMatch === 'function' ? getMajorBbiHubMatch(leg.boardStopObj) : null;
        const samePool = (prevBusGroup.company === g.company) ||
          (['KMB', 'LWB'].includes(prevBusGroup.company) && ['KMB', 'LWB'].includes(g.company));
        if (hub && samePool && prevBusFare > 0 && legFare > 0) {
          if (hub.payDiff) {
            const topUp = Math.max(0, legFare - prevBusFare);
            const saved = Math.min(legFare - topUp, hub.maxDiscount);
            legFare = Math.max(0, legFare - saved);
          } else {
            legFare = Math.max(0, legFare - Math.min(prevBusFare, legFare, hub.maxDiscount));
          }
          leg.bbiHubApplied = hub.name;
        }
      }

      prevBusGroup = g;
      prevBusFare = legFare;
      prevHeavyMtrEndCode = '';
    }

    totalFare += legFare;
  }

  flushRailBuffer();

  if (bikeSpec && typeof bikeSpec === 'object') {
    let bikeFareTotal = 0;
    if (bikeSpec.accessByBike) {
      bikeFareTotal += getSharedBikeLegFareHkd(bikeSpec.accessWalkDistM || bikeSpec.accessDistM || 500);
    }
    if (bikeSpec.egressByBike) {
      bikeFareTotal += getSharedBikeLegFareHkd(bikeSpec.egressWalkDistM || bikeSpec.egressDistM || 500);
    }
    bikeFareTotal = Number(bikeFareTotal.toFixed(1));
    if (bikeFareTotal > 0) {
      totalFare += bikeFareTotal;
      notices.push({
        type: 'shared_bike',
        routeNo: '🚲',
        en: `Includes LocoBike rental ~$${bikeFareTotal.toFixed(1)} ($5.0/30m wallet rate)`,
        tc: `已計入 LocoBike 共享單車費 ~$${bikeFareTotal.toFixed(1)}（錢包標準價 $5.0/30分鐘）`
      });
    }
  }

  if (metaOut && typeof metaOut === 'object') {
    metaOut.notices = notices;
  }
  return Number(totalFare.toFixed(1));
}

// ============================================================================
// GENERALIZED COST FUNCTION (4 MODES + 1-STOP MTR MICRO-HOP + LOAD + WEATHER)
// ============================================================================
function computeFirstLegDirectionPenalty(fromMeta, toMeta, leg1Board, leg1Alight) {
  if (!fromMeta || !toMeta || !leg1Board || !leg1Alight) return 0;
  const odKm = calculateDistanceKm(fromMeta.lat, fromMeta.lon, toMeta.lat, toMeta.lon);
  const l1Km = calculateDistanceKm(leg1Board.lat, leg1Board.lon, leg1Alight.lat, leg1Alight.lon);
  if (odKm < 1.0 || l1Km < 0.45) return 0;

  const cosLat = Math.cos(fromMeta.lat * Math.PI / 180);
  const vx = (toMeta.lon - fromMeta.lon) * cosLat;
  const vy = (toMeta.lat - fromMeta.lat);
  const lx = (leg1Alight.lon - leg1Board.lon) * cosLat;
  const ly = (leg1Alight.lat - leg1Board.lat);
  const magV = Math.hypot(vx, vy);
  const magL = Math.hypot(lx, ly);
  if (magV < 1e-6 || magL < 1e-6) return 0;

  const cosSim = (vx * lx + vy * ly) / (magV * magL);
  if (cosSim < 0.0) return 14.0;
  if (cosSim < 0.707) return 6.5;
  return 0;
}

const TUNG_CHUNG_NORTH_LOOP_STOP_RE = /ying\s*hei\s*rd|man\s*tung\s*rd|wai\s*tung\s*rd|caribbean\s*coast|century\s*link|visionary|seaview\s*crescent|coastal\s*skyline|yu\s*nga|sheraton\s*hong\s*kong\s*tung\s*chung|tung\s*chung\s*north|迎禧路|文東路|惠東路|映灣園|昇薈|東環|藍天海岸|海堤灣畔|裕雅|東涌北/i;
const TUNG_CHUNG_NORTH_LOOP_ROUTES = new Set(['E36A', 'E32A', 'E37C', 'E42P']);

function isTungChungNorthLoopStop(stopObj) {
  if (!stopObj) return false;
  const txt = `${stopObj.stopName_e || ''} ${stopObj.name_tc || ''}`;
  if (TUNG_CHUNG_NORTH_LOOP_STOP_RE.test(txt)) return true;
  const la = Number(stopObj.lat ?? stopObj.latitude);
  const lo = Number(stopObj.lon ?? stopObj.longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && la >= 22.2908 && la <= 22.2995 && lo >= 113.9430 && lo <= 113.9565;
}

function detectTungChungNorthLoopPenalty(leg, fromMeta = null, toMeta = null) {
  const g = leg?.group;
  if (!g || (g.mode && g.mode !== 'BUS')) return { isLoop: false, penaltyMins: 0 };
  const rNo = String(g.routeNo || '').toUpperCase();
  const origInTcn = fromMeta && isTungChungNorthLoopStop({ stopName_e: fromMeta.name_en, name_tc: fromMeta.name_tc, lat: fromMeta.lat, lon: fromMeta.lon });
  const destInTcn = toMeta && isTungChungNorthLoopStop({ stopName_e: toMeta.name_en, name_tc: toMeta.name_tc, lat: toMeta.lat, lon: toMeta.lon });
  if (origInTcn || destInTcn) return { isLoop: false, penaltyMins: 0 };

  if (TUNG_CHUNG_NORTH_LOOP_ROUTES.has(rNo)) {
    return { isLoop: true, penaltyMins: 7.5 };
  }
  if (isExternalERoute(g)) {
    if (isTungChungNorthLoopStop(leg.boardStopObj) || isTungChungNorthLoopStop(leg.alightStopObj)) {
      return { isLoop: true, penaltyMins: 6.0 };
    }
    const rStops = getStopsForGroup(g, leg.boardStopObj?.stopKey);
    const bSeq = Math.max(0, Number(leg.boardStopObj?.seq || 1) - 1);
    const aSeq = Math.max(bSeq, Number(leg.alightStopObj?.seq || rStops.length) - 1);
    if (rStops.length > 0 && aSeq > bSeq) {
      let tcnHits = 0;
      for (let i = bSeq; i <= Math.min(aSeq, rStops.length - 1); i++) {
        if (isTungChungNorthLoopStop(rStops[i])) tcnHits++;
      }
      if (tcnHits >= 2) return { isLoop: true, penaltyMins: 6.5 };
    }
  }
  return { isLoop: false, penaltyMins: 0 };
}

function computeBusPeakCongestionBufferMins(leg, qDate, isHol, mode = 'BULLETPROOF') {
  const g = leg?.group;
  if (!g || (g.mode && g.mode !== 'BUS')) return 0;
  const bLa = Number(leg.boardStopObj?.lat ?? leg.boardStopObj?.latitude);
  const bLo = Number(leg.boardStopObj?.lon ?? leg.boardStopObj?.longitude);
  const aLa = Number(leg.alightStopObj?.lat ?? leg.alightStopObj?.latitude);
  const aLo = Number(leg.alightStopObj?.lon ?? leg.alightStopObj?.longitude);
  const hopKm = (Number.isFinite(bLa) && Number.isFinite(aLa)) ? calculateDistanceKm(bLa, bLo, aLa, aLo) : 0;
  const driveSec = Number(leg.driveSec || 0);
  if (driveSec < 1200 && hopKm < 8.0) return 0;

  const minsOfDay = qDate.getHours() * 60 + qDate.getMinutes();
  const isAmPeak = !isHol && minsOfDay >= 450 && minsOfDay <= 570;   // 07:30–09:30
  const isPmPeak = !isHol && minsOfDay >= 1050 && minsOfDay <= 1185; // 17:30–19:45
  let buf = 0;
  if (isAmPeak || isPmPeak) {
    const scale = hopKm >= 14 ? 1.25 : 1.0;
    const basePeak = mode === 'BULLETPROOF' ? 7.0 : (mode === 'FASTEST' ? 5.5 : (mode === 'EASY' ? 3.5 : 2.0));
    buf += basePeak * scale;
  }

  // Live corridor congestion / incident check on long highway bus legs
  let corStatus = 'SMOOTH';
  if (typeof resolveRelevantCorridorForTrip === 'function' && Number.isFinite(bLa) && Number.isFinite(aLa)) {
    const cor = resolveRelevantCorridorForTrip(bLa, bLo, aLa, aLo);
    const liveMap = (typeof window !== 'undefined' && window.__LIVE_TRAFFIC_CORRIDORS__) ? window.__LIVE_TRAFFIC_CORRIDORS__ : null;
    if (cor && liveMap && liveMap[cor.id]?.status) {
      corStatus = String(liveMap[cor.id].status).toUpperCase();
    }
  }
  if (corStatus === 'SMOOTH' && typeof getCorridorLiveStatusAt === 'function' && Number.isFinite(bLa) && Number.isFinite(aLa)) {
    const midStat = getCorridorLiveStatusAt((bLa + aLa) / 2, (bLo + aLo) / 2);
    if (midStat?.status) corStatus = String(midStat.status).toUpperCase();
  }
  if (corStatus === 'INCIDENT') buf += (mode === 'CHEAPEST' ? 5.0 : 12.0);
  else if (corStatus === 'SLOW') buf += (mode === 'CHEAPEST' ? 2.5 : 5.5);

  return Number(buf.toFixed(1));
}

function isShortLastMileFeederLeg(leg, idx, totalLegs, finalEgressDistM) {
  if (!leg || idx !== totalLegs - 1 || idx === 0) return false;
  const g = leg.group;
  if (!g || (g.mode && g.mode !== 'BUS')) return false;
  const co = String(g.company || '').toUpperCase();
  const rNo = String(g.routeNo || '').toUpperCase();
  const isFeederType = co.startsWith('GMB') || /^(74|74A|K66|K68|K73|K74|268A|611)$/.test(rNo);
  const driveSec = Number(leg.driveSec || 0);
  return isFeederType && driveSec > 0 && driveSec <= 840 && finalEgressDistM <= 280;
}

function computeDisruptionAdjustedScore(totalTravelMins, legs, accessWalkSec = 0, egressWalkSec = 0, xferMtrCodes = [], optionFareHkd = 0, xferStopObjs = [], transferWalkSec = 0, ctx = {}) {
  const mode = xferSortPref; // 'BULLETPROOF' | 'FASTEST' | 'EASY' | 'CHEAPEST'
  const qDate = ctx.queryDate || getHongKongNow();
  const h = qDate.getHours(), m = qDate.getMinutes();
  const minsOfDay = h * 60 + m;
  const isHol = isHongKongHolidayFareDay(qDate);

  const isMidnightRule = (minsOfDay >= 22 * 60 + 30) || (minsOfDay < 5 * 60 + 30);
  const isPeakCrush    = !isHol && (minsOfDay >= 17 * 60 + 30) && (minsOfDay <= 19 * 60);
  const wx = window.__HKO_WEATHER__ || null;
  const weatherWalkMult = wx?.heavyRain ? 3.0 : (wx?.rainAdvisory ? 1.5 : 1.0);

  const baseWalkW = mode === 'EASY' ? 2.40 : (mode === 'BULLETPROOF' ? 0.60 : (mode === 'CHEAPEST' ? 0.55 : 0.40));
  const W_walk = baseWalkW * weatherWalkMult;
  const W_fare = mode === 'CHEAPEST' ? 1.55 : (mode === 'BULLETPROOF' ? 0.22 : (mode === 'EASY' ? 0.20 : 0.15));
  const fareCap = mode === 'CHEAPEST' ? 110.0 : 28.0;

  const totalWalkSec = accessWalkSec + egressWalkSec + transferWalkSec;
  const overhangThresholdSec = mode === 'BULLETPROOF' ? 720 : 510;
  const overhangWeight = mode === 'EASY' ? 1.65 : (mode === 'BULLETPROOF' ? 0.75 : 1.05);
  const longWalkOverhangMins = (!xferLocoBikeEnabled && totalWalkSec > overhangThresholdSec)
    ? ((totalWalkSec - overhangThresholdSec) / 60) * overhangWeight * weatherWalkMult
    : 0;

  let penaltyMins = (totalWalkSec / 60) * W_walk + longWalkOverhangMins;

  // Prefer true door-to-door / direct terminus arrivals (<=120m final walk) over nearby bus/GMB stops requiring 300m-450m+ walks,
  // while keeping normal ~8-11m station egress walks from Heavy MTR competitive against slower multi-bus chains.
  const lastLegGroup = legs && legs.length ? legs[legs.length - 1]?.group : null;
  const lastLegIsHeavyMtr = Boolean(lastLegGroup?.mode === 'MTR' && lastLegGroup?.company === 'MTR');
  const finalEgressDistM = Number.isFinite(Number(ctx.egressWalkDistM))
    ? Number(ctx.egressWalkDistM)
    : Math.round((Number(egressWalkSec) || 0) * (ctx.egressByBike ? 4.16 : 1.25));
  if (!ctx.egressByBike) {
    if (finalEgressDistM <= 120) {
      penaltyMins -= (mode === 'EASY' ? 5.0 : (mode === 'BULLETPROOF' ? 4.5 : (mode === 'CHEAPEST' ? 2.0 : 1.5)));
    } else if (finalEgressDistM >= 300) {
      const extra100m = (finalEgressDistM - 250) / 100;
      const bpFinalW = lastLegIsHeavyMtr ? 0.65 : 1.25;
      const finalWalkW = mode === 'EASY' ? 2.8 : (mode === 'BULLETPROOF' ? bpFinalW : (mode === 'CHEAPEST' ? 0.85 : 0.65));
      penaltyMins += extra100m * finalWalkW * weatherWalkMult;
    }
  }

  let nonRailTransfers = 0;
  let rewardedMtrBonus = false;
  const isDomesticNonLantau = ctx.isLantauTrip === false;

  for (let idx = 0; idx < legs.length; idx++) {
    const leg = legs[idx];
    const g = leg.group;
    const isHeavyMtr = (g?.mode === 'MTR' && g?.company === 'MTR');
    const isLrt = (g?.company === 'LRT');
    const isFerry = (g?.mode === 'FERRY');
    const isBus = (!g?.mode || g?.mode === 'BUS');
    const hw = Number(g?.headwayMins) || (isHeavyMtr ? 4 : (isFerry ? 30 : 15));
    const ld = leg.loadEstimate || null;
    const isShortFeeder = isShortLastMileFeederLeg(leg, idx, legs.length, finalEgressDistM);

    if (isBus && isDomesticNonLantau && isExternalERoute(g)) {
      const legFare = Number(leg.sectionalMeta?.netFare || g.maxFare || 0);
      if (legFare >= 12.0) penaltyMins += 28.0;
    }

    if (isBus) {
      const tcnLoop = detectTungChungNorthLoopPenalty(leg, ctx.fromMeta, ctx.toMeta);
      if (tcnLoop.isLoop) {
        const loopMult = (mode === 'BULLETPROOF' || mode === 'FASTEST') ? 1.0 : 0.6;
        penaltyMins += tcnLoop.penaltyMins * loopMult;
      }
      penaltyMins += computeBusPeakCongestionBufferMins(leg, qDate, isHol, mode);
    }

    if (isLrt && (leg.driveSec || 0) > 1200) {
      penaltyMins += ((leg.driveSec - 1200) / 60) * 1.4 + 10.0;
    }

    // Load-factor penalties (Bus, MTR & Ferry)
    if (ld) {
      if (isBus) {
        if (ld.isSkipRisk) {
          penaltyMins += (mode === 'BULLETPROOF' ? 14.0 : (mode === 'EASY' ? 16.0 : 5.0));
        } else if (mode === 'EASY' && ld.isStandingOrWorse) {
          penaltyMins += (ld.tier === 'HIGH' ? 10.0 : 5.0);
        }
      } else if (isHeavyMtr || isLrt) {
        if (ld.isDelayed) {
          penaltyMins += (mode === 'BULLETPROOF' ? 10.0 : 4.0);
        } else if (mode === 'EASY' && ld.pct >= 75) {
          penaltyMins += 5.0;
        }
      } else if (isFerry) {
        if (ld.isSkipRisk) {
          penaltyMins += (mode === 'EASY' ? 8.0 : (mode === 'BULLETPROOF' ? 6.0 : 2.5));
        } else if (mode === 'EASY' && ld.pct >= 75) {
          penaltyMins += 4.0;
        }
      }
    }

    if (isHeavyMtr) {
      const boardCode = leg.boardStopObj?.mtrCode || leg.boardStopObj?.stopId || '';
      const boardDepth = typeof MTR_ENGINE !== 'undefined' ? MTR_ENGINE.getStationDepthSec(boardCode) : 90;
      const mtrStopsRidden = Number(leg.stopsCount || 0);
      const prevWasBus = idx >= 1 && (!legs[idx - 1].group?.mode || legs[idx - 1].group?.mode === 'BUS');

      // 1-stop MTR micro-hop penalty after a bus (viaduct climb + gates + wait exceeds rail time saved)
      if (prevWasBus && mtrStopsRidden > 0 && mtrStopsRidden <= 1) {
        penaltyMins += (mode === 'FASTEST' ? 4.5 : 8.5);
      }

      if (wx?.heavyRain && !rewardedMtrBonus) {
        penaltyMins -= 5.0;
      }
      // Reliability preference for heavy rail trunk (>= 2 stops, stronger for multi-stop rail trunks that bypass road traffic)
      const totalHeavyMtrStops = legs.reduce((acc, l) => acc + ((l.group?.mode === 'MTR' && l.group?.company === 'MTR') ? Math.max(1, Number(l.stopsCount) || 0) : 0), 0);
      if (mode === 'BULLETPROOF' && hw <= 6 && (mtrStopsRidden >= 2 || totalHeavyMtrStops >= 3) && !rewardedMtrBonus) {
        penaltyMins -= (totalHeavyMtrStops >= 4 ? 6.0 : 3.5);
        rewardedMtrBonus = true;
      } else if (mode === 'FASTEST' && hw <= 6 && mtrStopsRidden >= 2 && !rewardedMtrBonus) {
        penaltyMins -= 1.2;
        rewardedMtrBonus = true;
      } else if (mode === 'EASY') {
        const isTerminus = typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isTerminusStation(boardCode);
        if (!isTerminus) penaltyMins += 18.0;
        if (boardDepth >= 180) penaltyMins += 8.0;
      }
    } else if (isFerry) {
      if (wx?.typhoon) {
        penaltyMins += 60.0;
      } else if (mode === 'EASY') {
        penaltyMins -= 6.0;
      } else if (mode === 'BULLETPROOF' && hw >= 25) {
        penaltyMins += 8.0;
      }
    } else if (isBus) {
      if (isShortFeeder) {
        // Short last-mile GMB / industrial feeder (e.g., GMB 74 from Long Ping MTR to Wang Lee St) should not be crushed by trunk bus headway penalties
        if (hw > 14 && mode === 'BULLETPROOF') {
          penaltyMins += (hw - 12) * 0.25;
        }
      } else if (mode === 'BULLETPROOF' && idx >= 1) {
        const stopDensity = Number(leg.boardStopObj?.routeDensity || 1);
        const redundancyMult = stopDensity >= 5 ? 0.45 : (stopDensity >= 3 ? 0.70 : 1.0);
        if (hw > 10) penaltyMins += (hw * 0.85) * redundancyMult;
      } else if (mode !== 'EASY' && hw >= 15) {
        penaltyMins += (hw - 12) * 0.45;
      }

      const bSeq = Number(leg.boardStopObj?.seq || 0);
      const aSeq = Number(leg.alightStopObj?.seq || 0);
      const stopsRidden = (leg.stopsCount > 0) ? leg.stopsCount : (aSeq > bSeq ? (aSeq - bSeq) : 0);
      if (stopsRidden > 14) {
        penaltyMins += (stopsRidden - 14) * (mode === 'EASY' ? 0.25 : 0.65);
      }

      // Slight town-center crawl preference when Bike Last-Mile is ON so earlier corridor stops win over deeper town-center stops
      if (ctx.egressByBike && idx === legs.length - 1 && (leg.driveSec || 0) > 0) {
        penaltyMins += (leg.driveSec / 60) * 0.12;
      }
    }

    if (idx >= 1) {
      const prevG = legs[idx - 1].group;
      const isSameRail = (prevG?.mode === 'MTR' && prevG?.company === 'MTR' && isHeavyMtr);
      const isMtrLrt = (prevG?.mode === 'MTR' && g?.mode === 'MTR' && prevG?.company !== g?.company);
      const stCode = xferMtrCodes[idx - 1] || '';
      const xferSec = isSameRail
        ? getMtrInternalTransferSec(stCode, prevG.routeNo, g.routeNo)
        : (isMtrLrt ? 210 : 165);
      const isLongWalkStn = xferSec >= 240;
      const xferStop = xferStopObjs[idx - 1] || leg.boardStopObj;
      const isGoldenHub = isStrategicInterchangeHub(xferStop);

      if (isPeakCrush && isSameRail && (stCode === 'ADM' || stCode === 'KOT')) {
        penaltyMins += 3.5;
      }

      if (isSameRail && !isLongWalkStn) {
        const isCrossPlatform = xferSec <= 90;
        if (isCrossPlatform) {
          penaltyMins += (mode === 'EASY' ? 3.5 : (mode === 'FASTEST' ? 1.0 : 2.0));
        } else {
          penaltyMins += (mode === 'EASY' ? 5.5 : (mode === 'FASTEST' ? 1.5 : 3.2));
        }
      } else if (isShortFeeder) {
        // Gentle last-mile feeder transfer (e.g., Long Ping MTR -> GMB 74) without exponential compounding
        penaltyMins += (mode === 'EASY' ? 4.5 : (mode === 'FASTEST' ? 1.8 : (mode === 'CHEAPEST' ? 2.0 : 3.5)));
      } else {
        nonRailTransfers++;
        if (mode === 'BULLETPROOF') {
          const baseTx = isGoldenHub ? 5.0 : 7.5;
          penaltyMins += baseTx * Math.pow(1.65, nonRailTransfers - 1) + (isLongWalkStn ? 4.0 : 0);
        } else if (mode === 'EASY') {
          penaltyMins += (isGoldenHub ? 7.0 : 10.0) * nonRailTransfers + (isLongWalkStn ? 6.0 : 0);
        } else if (mode === 'FASTEST') {
          penaltyMins += 2.5 + (isLongWalkStn ? 2.5 : 0);
        } else {
          penaltyMins += (isGoldenHub ? 3.0 : 5.0) + (isLongWalkStn ? 2.5 : 0);
        }

        const density = Number(xferStop?.routeDensity || 2);
        const isIsolatedNode = (!isGoldenHub && !isHeavyMtr && density <= 2 && hw > 15);
        if (isIsolatedNode) {
          if (mode === 'BULLETPROOF') penaltyMins += 24.0;
          else if (isMidnightRule) penaltyMins += 30.0;
          else if (mode === 'EASY') penaltyMins += 10.0;
        } else if (isMidnightRule && !isHeavyMtr && hw >= 20) {
          penaltyMins += 14.0;
        }
      }
    }
  }

  if (ctx.fromMeta && ctx.toMeta && legs[0]) {
    penaltyMins += computeFirstLegDirectionPenalty(ctx.fromMeta, ctx.toMeta, legs[0].boardStopObj, legs[0].alightStopObj);
  }

  const farePenaltyMins = Math.min(fareCap, Math.max(0, (Number(optionFareHkd) || 0) * W_fare));
  return Number((totalTravelMins + penaltyMins + farePenaltyMins).toFixed(1));
}

function corridorHasRailOrFerryTrunk(cor) {
  if (!cor) return false;
  const groups = [cor.leg1Group, cor.leg2Group, ...(cor.leg3Options || []).map(l => l.group)];
  return groups.some(g => g && (g.mode === 'FERRY' || (g.mode === 'MTR' && g.company === 'MTR')));
}

function corridorHasHeavyMtrTrunk(cor) {
  if (!cor) return false;
  const groups = [cor.leg1Group, cor.leg2Group, ...(cor.leg3Options || []).map(l => l.group)];
  return groups.some(g => g && g.mode === 'MTR' && g.company === 'MTR');
}

function runRaptorCorridorPass(G, originAccess, destEgress, queryDateObj, isAirportTrip, isLantauTrip, isHoliday, fromMeta, toMeta, opts = {}) {
  const K = opts.maxRounds || 4;
  const suppressLongHaulBusKm = Number(opts.suppressLongHaulBusKm || 0);
  const requireRailOrFerryTrunk = Boolean(opts.requireRailOrFerryTrunk);
  const mtrClosedNow = typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isClosedAt(queryDateObj);
  const INF = 1e9;
  const tau = Array.from({ length: K + 1 }, () => new Float64Array(G.stops.length).fill(INF));
  const bestRound = Array.from({ length: K + 1 }, () => new Int8Array(G.stops.length).fill(-1));
  const parent = Array.from({ length: K + 1 }, () => new Array(G.stops.length).fill(null));
  // Keep pure RIDE arrivals per round separate from WALK relaxations so a nearby-stop walk never overwrites a direct-to-destination ride
  const rideTau = Array.from({ length: K + 1 }, () => new Float64Array(G.stops.length).fill(INF));
  const rideParent = Array.from({ length: K + 1 }, () => new Array(G.stops.length).fill(null));
  let marked = new Set();

  for (const [sIdx, acc] of originAccess.entries()) {
    tau[0][sIdx] = acc.sec;
    bestRound[0][sIdx] = 0;
    marked.add(sIdx);
  }

  for (let k = 1; k <= K; k++) {
    for (let s = 0; s < G.stops.length; s++) {
      tau[k][s] = tau[k - 1][s];
      bestRound[k][s] = bestRound[k - 1][s];
    }
    const Q = new Map();
    for (const sIdx of marked) {
      for (const { rIdx, seq } of G.stopRoutes[sIdx]) {
        if (!Q.has(rIdx) || seq < Q.get(rIdx)) Q.set(rIdx, seq);
      }
    }
    marked = new Set();

    for (const [rIdx, startSeq] of Q.entries()) {
      const rt = G.routes[rIdx];
      if (!isAirportTrip && isAirportPremiumRoute(rt.group)) continue;
      if (mtrClosedNow && rt.group.mode === 'MTR') continue;

      const isBusRoute = (!rt.group.mode || rt.group.mode === 'BUS');
      if (!isLantauTrip && isExternalERoute(rt.group) && (Number(rt.group.maxFare) || 0) >= 15) continue;

      const waitMult = xferSortPref === 'EASY' ? 0.35 : (xferSortPref === 'BULLETPROOF' ? 0.55 : 0.45);
      const waitPenaltySec = Math.min(900, Math.max(75, ((Number(rt.group.headwayMins) || 12) * 60) * waitMult));
      let boardSeq = -1;
      let boardTime = INF;
      let boardPrevRound = -1;

      for (let seq = startSeq; seq < rt.stIndices.length; seq++) {
        const u = rt.stIndices[seq];
        if (boardSeq !== -1) {
          const rideSec = rt.cumSecs[seq] - rt.cumSecs[boardSeq];
          const isMicroBusHop = isBusRoute && (seq - boardSeq < 2) && rideSec < 95;
          const bObj = rt.stObjs[boardSeq], aObj = rt.stObjs[seq];
          const dBoardToDestKm = calculateDistanceKm(bObj.lat, bObj.lon, toMeta.lat, toMeta.lon);
          const dAlightToDestKm = calculateDistanceKm(aObj.lat, aObj.lon, toMeta.lat, toMeta.lon);
          // Never board a leg already near destination (<= 0.45km) that carries the rider farther away (e.g. AIR -> AWE + 14m walk back)
          const isAwayOvershoot = dBoardToDestKm <= 0.45 && dAlightToDestKm > dBoardToDestKm + 0.08;

          let isSuppressedLongBus = false;
          if (suppressLongHaulBusKm > 0 && isBusRoute) {
            const hopKm = calculateDistanceKm(bObj.lat, bObj.lon, aObj.lat, aObj.lon);
            if (hopKm > suppressLongHaulBusKm) isSuppressedLongBus = true;
          }

          if (!isMicroBusHop && !isSuppressedLongBus && !isAwayOvershoot) {
            let xferBufSec = 0;
            if (boardPrevRound > 0) {
              const prevStep = parent[boardPrevRound][rt.stIndices[boardSeq]];
              const prevRIdx = prevStep?.type === 'RIDE' ? prevStep.rIdx : (prevStep?.prevRIdx ?? -1);
              const prevG = prevRIdx >= 0 ? G.routes[prevRIdx]?.group : null;
              const bStopMeta = G.stops[rt.stIndices[boardSeq]];
              xferBufSec = getInterchangeTransferSec(prevG, rt.group, bStopMeta, prevStep?.walkSec || 0);
            }
            const arrTime = boardTime + waitPenaltySec + xferBufSec + rideSec;
            const rideStep = (arrTime < rideTau[k][u] || arrTime < tau[k][u])
              ? {
                  type: 'RIDE',
                  rIdx,
                  boardStopIdx: rt.stIndices[boardSeq],
                  alightStopIdx: u,
                  boardSeq,
                  alightSeq: seq,
                  driveSec: rideSec,
                  prevRound: boardPrevRound
                }
              : null;
            if (rideStep && arrTime < rideTau[k][u]) {
              rideTau[k][u] = arrTime;
              rideParent[k][u] = rideStep;
              if (rt.group.mode === 'MTR' && rt.group.company === 'MTR') {
                marked.add(u);
              }
            }
            if (rideStep && arrTime < tau[k][u]) {
              tau[k][u] = arrTime;
              bestRound[k][u] = k;
              parent[k][u] = rideStep;
              marked.add(u);
            }
          }
        }
        const candArrSec = tau[k - 1][u];
        const prevCandRound = bestRound[k - 1][u];
        const uStopObj = rt.stObjs[seq];
        const alreadyArrivedNearDest = prevCandRound > 0 && uStopObj &&
          calculateDistanceKm(uStopObj.lat, uStopObj.lon, toMeta.lat, toMeta.lon) <= 0.35;
        const canBoardBetter = !alreadyArrivedNearDest && candArrSec < INF && (
          boardSeq === -1 ||
          candArrSec < boardTime + (rt.cumSecs[seq] - rt.cumSecs[boardSeq])
        );
        if (canBoardBetter) {
          const candBoardDate = new Date(queryDateObj.getTime() + (candArrSec + waitPenaltySec) * 1000);
          if (isRouteActiveAtPlannerTime(rt.group, candBoardDate)) {
            boardSeq = seq;
            boardTime = candArrSec;
            boardPrevRound = prevCandRound;
          }
        }
      }
    }

    const walkMarked = Array.from(marked);
    for (const u of walkMarked) {
      const prevStep = rideParent[k][u];
      const baseRideSec = rideTau[k][u];
      if (!prevStep || prevStep.type !== 'RIDE' || baseRideSec >= INF) continue;
      for (const tr of G.transfers[u]) {
        const nt = baseRideSec + tr.walkSec;
        if (nt < tau[k][tr.toIdx]) {
          tau[k][tr.toIdx] = nt;
          bestRound[k][tr.toIdx] = k;
          parent[k][tr.toIdx] = {
            type: 'WALK',
            fromStopIdx: u,
            toStopIdx: tr.toIdx,
            walkSec: tr.walkSec,
            walkDistM: tr.distM,
            prevRIdx: prevStep.rIdx
          };
          marked.add(tr.toIdx);
        }
      }
    }
  }

  // Keep the optimal alighting stop per route chain instead of first-come-first-served (fixes E36 Yuen Long Plaza vs Yoho Mall II)
  const bestByChainKey = new Map();

  for (let k = 2; k <= K; k++) {
    for (const [destStopIdx, egr] of destEgress.entries()) {
      const finalRideArrSec = rideTau[k][destStopIdx];
      const finalRideP = rideParent[k][destStopIdx];
      if (finalRideArrSec >= INF || !finalRideP || finalRideP.type !== 'RIDE') continue;

      const rideSteps = [{ ...finalRideP, walkAfterSec: 0, walkAfterDistM: 0 }];
      const finalG = G.routes[finalRideP.rIdx].group;
      const visitedRoutes = new Set([finalRideP.rIdx]);
      const visitedRouteLineSigs = new Set([`${finalG.company}:${finalG.routeNo}`]);
      let curS = finalRideP.boardStopIdx;
      let ck = Number.isInteger(finalRideP.prevRound) ? finalRideP.prevRound : (k - 1);
      let hasCycle = false;

      while (ck > 0 && curS !== undefined) {
        while (ck > 0 && !parent[ck][curS] && !rideParent[ck][curS]) ck--;
        if (ck <= 0) break;
        const p = parent[ck][curS] || rideParent[ck][curS];
        if (!p) { hasCycle = true; break; }
        let rideP = p;
        let walkAfterSec = 0;
        let walkAfterDistM = 0;
        if (p.type === 'WALK') {
          walkAfterSec = p.walkSec;
          walkAfterDistM = p.walkDistM || 0;
          rideP = rideParent[ck][p.fromStopIdx] || parent[ck][p.fromStopIdx];
        }
        if (!rideP || rideP.type !== 'RIDE') { hasCycle = true; break; }
        const g = G.routes[rideP.rIdx].group;
        const lineSig = `${g.company}:${g.routeNo}`;
        if (visitedRoutes.has(rideP.rIdx) || visitedRouteLineSigs.has(lineSig)) {
          hasCycle = true;
          break;
        }
        visitedRoutes.add(rideP.rIdx);
        visitedRouteLineSigs.add(lineSig);
        rideSteps.unshift({ ...rideP, walkAfterSec, walkAfterDistM });
        curS = rideP.boardStopIdx;
        ck = Number.isInteger(rideP.prevRound) ? rideP.prevRound : (ck - 1);
      }

      if (hasCycle || rideSteps.length < 2) continue;

      if (rideSteps.length >= 4) {
        let hasInternalMtrXfer = false;
        for (let m = 0; m < rideSteps.length - 1; m++) {
          const gA = G.routes[rideSteps[m].rIdx].group;
          const gB = G.routes[rideSteps[m + 1].rIdx].group;
          if (gA?.mode === 'MTR' && gA?.company === 'MTR' && gB?.mode === 'MTR' && gB?.company === 'MTR') {
            hasInternalMtrXfer = true;
            break;
          }
        }
        if (!hasInternalMtrXfer) continue;
      }

      const acc = originAccess.get(curS);
      if (!acc) continue;

      const chainRoutes = rideSteps.map(s => G.routes[s.rIdx]);
      // Reject chains where an earlier leg already landed at or closer to the destination than the final alighting stop
      const finalAlightCheck = chainRoutes[chainRoutes.length - 1].stObjs[rideSteps[rideSteps.length - 1].alightSeq];
      const dFinalDestKm = calculateDistanceKm(finalAlightCheck.lat, finalAlightCheck.lon, toMeta.lat, toMeta.lon);
      let hasDestinationOvershoot = false;
      for (let m = 0; m < rideSteps.length - 1; m++) {
        const interAlight = chainRoutes[m].stObjs[rideSteps[m].alightSeq];
        const dInterDestKm = calculateDistanceKm(interAlight.lat, interAlight.lon, toMeta.lat, toMeta.lon);
        if (dInterDestKm <= 0.35 || dInterDestKm <= dFinalDestKm + 0.05) {
          hasDestinationOvershoot = true;
          break;
        }
      }
      if (hasDestinationOvershoot) continue;

      const chainKey = chainRoutes.map(r => `${r.group.company}_${r.group.routeNo}`).join('>');

      const leg1Rt = chainRoutes[0], leg2Rt = chainRoutes[1];
      const s1 = rideSteps[0], s2 = rideSteps[1];
      const b1Obj = { ...leg1Rt.stObjs[s1.boardSeq], routeDensity: G.stops[s1.boardStopIdx]?.routeDensity || 2 };
      const a1Obj = leg1Rt.stObjs[s1.alightSeq];
      const b2Obj = { ...leg2Rt.stObjs[s2.boardSeq], routeDensity: G.stops[s2.boardStopIdx]?.routeDensity || 2 };
      const a2Obj = leg2Rt.stObjs[s2.alightSeq];

      const xferMtrCodes = [];
      const xferStopObjs = [b2Obj];
      for (let m = 0; m < rideSteps.length - 1; m++) {
        const stMtr = G.stops[rideSteps[m + 1].boardStopIdx]?.mtrCode || G.stops[rideSteps[m].alightStopIdx]?.mtrCode || '';
        xferMtrCodes.push(stMtr);
      }

      const xfer1ExitSnap = resolveMtrTransferExit(leg1Rt.group, a1Obj, leg2Rt.group, b2Obj);
      const xfer1WalkDistM = xfer1ExitSnap ? xfer1ExitSnap.distM : (s1.walkAfterDistM || 0);
      const xfer1WalkSec = xfer1ExitSnap ? Math.min(s1.walkAfterSec || xfer1ExitSnap.walkSec, xfer1ExitSnap.walkSec) : (s1.walkAfterSec || 0);

      const leg3Options = rideSteps.slice(2).map((s3, idx3) => {
        const rt3 = chainRoutes[idx3 + 2];
        const b3Obj = { ...rt3.stObjs[s3.boardSeq], routeDensity: G.stops[s3.boardStopIdx]?.routeDensity || 2 };
        const a3Obj = rt3.stObjs[s3.alightSeq];
        const prevRt = chainRoutes[idx3 + 1];
        const prevStep = rideSteps[idx3 + 1];
        const prevAObj = prevRt.stObjs[prevStep.alightSeq];
        const l3ExitSnap = resolveMtrTransferExit(prevRt.group, prevAObj, rt3.group, b3Obj);
        xferStopObjs.push(b3Obj);
        return {
          group: rt3.group,
          routeNo: rt3.group.routeNo,
          boardStopKey: b3Obj.stopKey,
          boardStopObj: b3Obj,
          alightStopObj: a3Obj,
          prevAlightStopObj: prevAObj,
          driveSec: s3.driveSec,
          stopsCount: Math.max(1, s3.alightSeq - s3.boardSeq),
          walkSec: l3ExitSnap ? Math.min(prevStep.walkAfterSec || l3ExitSnap.walkSec, l3ExitSnap.walkSec) : (prevStep.walkAfterSec || 0),
          walkDistM: l3ExitSnap ? l3ExitSnap.distM : (prevStep.walkAfterDistM || 0),
          xferExitObj: l3ExitSnap ? l3ExitSnap.exitObj : null,
          xferExitSide: l3ExitSnap ? l3ExitSnap.side : null,
          loadEstimate: inferPlannerLegLoad(rt3.group, b3Obj, queryDateObj, isHoliday)
        };
      });

      const load1 = inferPlannerLegLoad(leg1Rt.group, b1Obj, queryDateObj, isHoliday);
      const load2 = inferPlannerLegLoad(leg2Rt.group, b2Obj, queryDateObj, isHoliday);

      const finalAlightObj = leg3Options.length ? leg3Options[leg3Options.length - 1].alightStopObj : a2Obj;
      const finalPinLat = Number(egr.exitObj?.lat ?? finalAlightObj?.lat);
      const finalPinLon = Number(egr.exitObj?.lon ?? finalAlightObj?.lon);
      let effEgressDistM = egr.distM || 0;
      let effEgressSec = egr.sec || 0;
      if (isValidRailOrFerryCoord(finalPinLat, finalPinLon) && isValidRailOrFerryCoord(toMeta.lat, toMeta.lon)) {
        const trueFinalKm = calculateDistanceKm(finalPinLat, finalPinLon, toMeta.lat, toMeta.lon);
        if (trueFinalKm >= 0.035) {
          const minGeomDistM = Math.round(trueFinalKm * 1000 * (egr.byBike ? 1.35 : 1.18));
          effEgressDistM = Math.max(effEgressDistM, minGeomDistM);
          effEgressSec = Math.max(effEgressSec, Math.round(effEgressDistM / (egr.byBike ? 4.16 : 1.25)));
        }
      }

      const corObj = {
        chainKey,
        leg1Group: leg1Rt.group,
        leg2Group: leg2Rt.group,
        leg1Mode: leg1Rt.group.mode || 'BUS',
        leg2Mode: leg2Rt.group.mode || 'BUS',
        board1StopKey: b1Obj.stopKey,
        board1StopObj: b1Obj,
        alight2StopObj: finalAlightObj,
        load1,
        load2,
        xferStopNodes: [{
          alight1StopObj: a1Obj,
          board2StopKey: b2Obj.stopKey,
          board2StopObj: b2Obj,
          lat: b2Obj.lat,
          lon: b2Obj.lon,
          walkSec: xfer1WalkSec,
          walkDistM: xfer1WalkDistM,
          xferExitObj: xfer1ExitSnap ? xfer1ExitSnap.exitObj : null,
          xferExitSide: xfer1ExitSnap ? xfer1ExitSnap.side : null,
          leg1DriveSec: s1.driveSec,
          leg2DriveSec: s2.driveSec,
          leg1StopsCount: Math.max(1, s1.alightSeq - s1.boardSeq),
          leg2StopsCount: Math.max(1, s2.alightSeq - s2.boardSeq)
        }],
        xferMtrCodes,
        xferStopObjs,
        leg3Options,
        accessWalkSec: acc.sec,
        accessWalkDistM: acc.distM,
        accessByBike: acc.byBike,
        accessExitObj: acc.exitObj || null,
        egressWalkSec: effEgressSec,
        egressWalkDistM: effEgressDistM,
        egressByBike: egr.byBike,
        egressExitObj: egr.exitObj || null
      };

      if (requireRailOrFerryTrunk && !corridorHasRailOrFerryTrunk(corObj)) continue;

      const allLegSpecs = [
        { group: leg1Rt.group, boardStopObj: b1Obj, alightStopObj: a1Obj, driveSec: s1.driveSec, walkAfterSec: s1.walkAfterSec || 0, stopsCount: Math.max(1, s1.alightSeq - s1.boardSeq), loadEstimate: load1 },
        { group: leg2Rt.group, boardStopObj: b2Obj, alightStopObj: a2Obj, driveSec: s2.driveSec, walkAfterSec: s2.walkAfterSec || 0, stopsCount: Math.max(1, s2.alightSeq - s2.boardSeq), loadEstimate: load2 },
        ...leg3Options.map(l3 => ({ group: l3.group, boardStopObj: l3.boardStopObj, alightStopObj: l3.alightStopObj, driveSec: l3.driveSec, walkAfterSec: l3.walkSec || 0, stopsCount: l3.stopsCount, loadEstimate: l3.loadEstimate }))
      ];

      const totalTransferWalkSec = (s1.walkAfterSec || 0) + leg3Options.reduce((sum, l3) => sum + (l3.walkSec || 0), 0);
      const totalTravelSec = finalRideArrSec + effEgressSec;
      const totalMins = Math.max(5, Math.round(totalTravelSec / 60));
      const fareMeta = {};
      const bikeSpec = (acc.byBike || egr.byBike)
        ? { accessByBike: acc.byBike, accessWalkDistM: acc.distM, egressByBike: egr.byBike, egressWalkDistM: effEgressDistM }
        : null;
      const fareHkd = computeLegChainFareHkd(allLegSpecs, isHoliday, fareMeta, fromMeta.lat, fromMeta.lon, bikeSpec);
      const score = computeDisruptionAdjustedScore(totalMins, allLegSpecs, acc.sec, effEgressSec, xferMtrCodes, fareHkd, xferStopObjs, totalTransferWalkSec, {
        queryDate: queryDateObj,
        isLantauTrip,
        fromMeta,
        toMeta,
        egressByBike: egr.byBike,
        egressWalkDistM: effEgressDistM
      });

      corObj.totalTransferWalkSec = totalTransferWalkSec;
      corObj.totalMins = totalMins;
      corObj.fareHkd = fareHkd;
      corObj.fareNotices = fareMeta.notices || [];
      corObj.disruptionScore = score;

      const existing = bestByChainKey.get(chainKey);
      if (!existing || score < existing.disruptionScore || (score === existing.disruptionScore && totalTravelSec < (existing._totalTravelSec || 1e9))) {
        corObj._totalTravelSec = totalTravelSec;
        bestByChainKey.set(chainKey, corObj);
      }
    }
  }

  const outCorridors = Array.from(bestByChainKey.values());
  outCorridors.sort((a, b) => a.disruptionScore - b.disruptionScore);
  return outCorridors;
}

function buildFromToEdgeRequestSpec(queryDateObj = getHongKongNow()) {
  if (!routeMapIndex.size) initRouteMapFast();
  const h = userCommuteProfile.home, w = userCommuteProfile.work;
  if (!h || !w) return null;

  const G = getRaptorGraph();
  const fromMeta = { name_en: h.stopName_e, name_tc: h.name_tc || h.stopName_e, lat: Number(h.lat), lon: Number(h.lon), stopKey: h.stopKey };
  const toMeta   = { name_en: w.stopName_e, name_tc: w.name_tc || w.stopName_e, lat: Number(w.lat), lon: Number(w.lon), stopKey: w.stopKey };
  if (!isValidRailOrFerryCoord(fromMeta.lat, fromMeta.lon) || !isValidRailOrFerryCoord(toMeta.lat, toMeta.lon)) return null;

  const isHoliday = isHongKongHolidayFareDay(queryDateObj);
  const mtrClosedNow = typeof MTR_ENGINE !== 'undefined' && MTR_ENGINE.isClosedAt(queryDateObj);
  const isAirportTrip = isAirportOrPortZone(fromMeta.lat, fromMeta.lon, fromMeta.name_en) ||
                        isAirportOrPortZone(toMeta.lat, toMeta.lon, toMeta.name_en);
  const isLantauTrip  = isLantauOrAirportZone(fromMeta.lat, fromMeta.lon, fromMeta.name_en) ||
                        isLantauOrAirportZone(toMeta.lat, toMeta.lon, toMeta.name_en);

  const canBikeOrigin = xferLocoBikeEnabled && isInSharedBikeZone(fromMeta.lat, fromMeta.lon);
  const canBikeDest   = xferLocoBikeEnabled && isInSharedBikeZone(toMeta.lat, toMeta.lon);
  const spdOrigin = canBikeOrigin ? 4.16 : 1.25;
  const spdDest   = canBikeDest ? 4.16 : 1.25;
  const maxOriginKm = canBikeOrigin ? 3.50 : 0.95;
  const maxDestKm   = canBikeDest ? 3.50 : 1.15;

  const originAccess = new Map();
  const destEgress = new Map();

  for (let i = 0; i < G.stops.length; i++) {
    const st = G.stops[i];
    const isHeavyMtr = (st.mode === 'MTR' && st.company !== 'LRT');
    const concourseSec = isHeavyMtr
      ? (typeof MTR_ENGINE !== 'undefined' ? MTR_ENGINE.getStationDepthSec(st.mtrCode) : 90)
      : 0;

    const dOrigPinKm = calculateDistanceKm(fromMeta.lat, fromMeta.lon, st.lat, st.lon);
    if (dOrigPinKm <= (isHeavyMtr ? maxOriginKm + 0.35 : maxOriginKm) && !window.crossesWaterBarrier(fromMeta.lat, fromMeta.lon, st.lat, st.lon)) {
      let effKm = dOrigPinKm;
      let exitObj = null;
      if (isHeavyMtr) {
        const nearEx = findNearestMtrExitForPoint(fromMeta.lat, fromMeta.lon, st.lat, st.lon);
        if (nearEx) {
          effKm = nearEx.distKm;
          exitObj = nearEx;
        }
      }
      if (effKm <= maxOriginKm) {
        const byBike = canBikeOrigin && effKm > 0.35;
        const roadFactor = byBike ? 1.35 : 1.18;
        const distM = Math.round(effKm * 1000 * roadFactor);
        // Street-level bike unlock = 90s; elevated/underground MTR station bike parking + exit walk = +150s on top of concourseSec
        const bikePickupSec = byBike ? (isHeavyMtr ? 150 : 90) : 0;
        const sec = Math.round(distM / (byBike ? 4.16 : 1.25)) + concourseSec + bikePickupSec;
        originAccess.set(i, { sec, distM, byBike, exitObj });
      }
    }

    const dDestPinKm = calculateDistanceKm(toMeta.lat, toMeta.lon, st.lat, st.lon);
    if (dDestPinKm <= (isHeavyMtr ? maxDestKm + 0.35 : maxDestKm) && !window.crossesWaterBarrier(toMeta.lat, toMeta.lon, st.lat, st.lon)) {
      let effKm = dDestPinKm;
      let exitObj = null;
      if (isHeavyMtr) {
        const nearEx = findNearestMtrExitForPoint(toMeta.lat, toMeta.lon, st.lat, st.lon);
        if (nearEx) {
          effKm = nearEx.distKm;
          exitObj = nearEx;
        }
      }
      if (effKm <= maxDestKm) {
        const byBike = canBikeDest && effKm > 0.35;
        const roadFactor = byBike ? 1.35 : 1.18;
        const distM = Math.round(effKm * 1000 * roadFactor);
        const bikePickupSec = byBike ? (isHeavyMtr ? 150 : 90) : 0;
        const sec = Math.round(distM / (byBike ? 4.16 : 1.25)) + concourseSec + bikePickupSec;
        destEgress.set(i, { sec, distM, byBike, exitObj });
      }
    }
  }

  if (originAccess.size === 0) {
    G.stops
      .map((st, idx) => ({ idx, dKm: calculateDistanceKm(fromMeta.lat, fromMeta.lon, st.lat, st.lon) }))
      .sort((a, b) => a.dKm - b.dKm)
      .slice(0, 3)
      .forEach(x => {
        const distM = Math.round(x.dKm * 1000 * (canBikeOrigin ? 1.35 : 1.2));
        originAccess.set(x.idx, { sec: Math.round(distM / spdOrigin) + (canBikeOrigin ? 90 : 0), distM, byBike: canBikeOrigin, exitObj: null });
      });
  }
  if (destEgress.size === 0) {
    G.stops
      .map((st, idx) => ({ idx, dKm: calculateDistanceKm(toMeta.lat, toMeta.lon, st.lat, st.lon) }))
      .sort((a, b) => a.dKm - b.dKm)
      .slice(0, 3)
      .forEach(x => {
        const distM = Math.round(x.dKm * 1000 * (canBikeDest ? 1.35 : 1.2));
        destEgress.set(x.idx, { sec: Math.round(distM / spdDest) + (canBikeDest ? 90 : 0), distM, byBike: canBikeDest, exitObj: null });
      });
  }

  let walkBikeDirectCard = null;
  const directKm = calculateDistanceKm(fromMeta.lat, fromMeta.lon, toMeta.lat, toMeta.lon);
  if (directKm < 0.02) {
    return {
      fromMeta,
      toMeta,
      queryDate: queryDateObj,
      isAirportTrip,
      isLantauTrip,
      mtrClosedNow,
      walkBikeDirectCard: {
        isBike: false,
        distM: Math.round(directKm * 1000),
        totalMins: 1,
        fareHkd: 0,
        disruptionScore: 1.0
      },
      directRoutes: [],
      transferCorridors: []
    };
  }
  const maxDirectKm = canBikeOrigin ? 3.5 : 1.35;
  if (directKm <= maxDirectKm && !window.crossesWaterBarrier(fromMeta.lat, fromMeta.lon, toMeta.lat, toMeta.lon)) {
    const useBike = canBikeOrigin && directKm > 0.35;
    const roadM = Math.round(directKm * 1000 * (useBike ? 1.35 : 1.22));
    const durMins = Math.max(2, Math.round((roadM / (useBike ? 4.16 : 1.25) + (useBike ? 90 : 0)) / 60));
    const bikeFareHkd = useBike ? getSharedBikeLegFareHkd(roadM) : 0;
    const fareWeight = xferSortPref === 'CHEAPEST' ? 1.55 : (xferSortPref === 'BULLETPROOF' ? 0.25 : 0.15);
    const rainPen = window.__HKO_WEATHER__?.heavyRain ? 18 : 0;
    walkBikeDirectCard = {
      isBike: useBike,
      distM: roadM,
      totalMins: durMins,
      fareHkd: bikeFareHkd,
      disruptionScore: Number((durMins + rainPen + bikeFareHkd * fareWeight + (useBike ? 1.5 : (xferSortPref === 'EASY' ? 14 : 2.5))).toFixed(1))
    };
  }

  const bestDirectBySig = new Map();
  for (let rIdx = 0; rIdx < G.routes.length; rIdx++) {
    const rt = G.routes[rIdx];
    if (!isAirportTrip && isAirportPremiumRoute(rt.group)) continue;
    if (mtrClosedNow && rt.group.mode === 'MTR') continue;
    if (!isLantauTrip && isExternalERoute(rt.group) && (Number(rt.group.maxFare) || 0) >= 15) continue;

    let bestPair = null;
    for (let i = 0; i < rt.stIndices.length - 1; i++) {
      const acc = originAccess.get(rt.stIndices[i]);
      if (!acc) continue;
      const waitSec = Math.min(900, ((Number(rt.group.headwayMins) || 12) * 60) * 0.45);
      const boardDate = new Date(queryDateObj.getTime() + (acc.sec + waitSec) * 1000);
      if (!isRouteActiveAtPlannerTime(rt.group, boardDate)) continue;

      for (let j = i + 1; j < rt.stIndices.length; j++) {
        const egr = destEgress.get(rt.stIndices[j]);
        if (!egr) continue;
        const bSt = rt.stObjs[i], aSt = rt.stObjs[j];
        const dB = calculateDistanceKm(bSt.lat, bSt.lon, toMeta.lat, toMeta.lon);
        const dA = calculateDistanceKm(aSt.lat, aSt.lon, toMeta.lat, toMeta.lon);
        if (dB < 0.30 && dA > dB + 0.08) continue;
        const driveSec = rt.cumSecs[j] - rt.cumSecs[i];
        const effDriveSec = egr.byBike && (!rt.group.mode || rt.group.mode === 'BUS') ? driveSec * 1.12 : driveSec;
        const rankSec = acc.sec + waitSec + effDriveSec + egr.sec;
        if (!bestPair || rankSec < bestPair.rankSec) {
          bestPair = { bSeq: i, aSeq: j, driveSec, acc, egr, totalSec: acc.sec + waitSec + driveSec + egr.sec, rankSec };
        }
      }
    }
    if (bestPair) {
      const sig = `${rt.group.company}_${rt.group.routeNo}`;
      const bObj = { ...rt.stObjs[bestPair.bSeq], routeDensity: G.stops[rt.stIndices[bestPair.bSeq]]?.routeDensity || 2 };
      const aObj = rt.stObjs[bestPair.aSeq];
      const stopsCount = Math.max(1, bestPair.aSeq - bestPair.bSeq);
      let effEgressDistM = bestPair.egr.distM || 0;
      let effEgressSec = bestPair.egr.sec || 0;
      const dPinLat = Number(bestPair.egr.exitObj?.lat ?? aObj?.lat);
      const dPinLon = Number(bestPair.egr.exitObj?.lon ?? aObj?.lon);
      if (isValidRailOrFerryCoord(dPinLat, dPinLon) && isValidRailOrFerryCoord(toMeta.lat, toMeta.lon)) {
        const trueFinalKm = calculateDistanceKm(dPinLat, dPinLon, toMeta.lat, toMeta.lon);
        if (trueFinalKm >= 0.035) {
          const minGeomDistM = Math.round(trueFinalKm * 1000 * (bestPair.egr.byBike ? 1.35 : 1.18));
          effEgressDistM = Math.max(effEgressDistM, minGeomDistM);
          effEgressSec = Math.max(effEgressSec, Math.round(effEgressDistM / (bestPair.egr.byBike ? 4.16 : 1.25)));
        }
      }
      const effTotalSec = bestPair.totalSec - (bestPair.egr.sec || 0) + effEgressSec;
      const totalMins = Math.max(3, Math.round(effTotalSec / 60));
      const load1 = inferPlannerLegLoad(rt.group, bObj, queryDateObj, isHoliday, 0, { alightStopObj: aObj });
      const fareMeta = {};
      const legSpec = { group: rt.group, boardStopObj: bObj, alightStopObj: aObj, driveSec: bestPair.driveSec, stopsCount, loadEstimate: load1 };
      const directBikeSpec = (bestPair.acc.byBike || bestPair.egr.byBike)
        ? { accessByBike: bestPair.acc.byBike, accessWalkDistM: bestPair.acc.distM, egressByBike: bestPair.egr.byBike, egressWalkDistM: effEgressDistM }
        : null;
      const fareHkd = computeLegChainFareHkd([legSpec], isHoliday, fareMeta, fromMeta.lat, fromMeta.lon, directBikeSpec);
      const score = computeDisruptionAdjustedScore(
        totalMins,
        [legSpec],
        bestPair.acc.sec,
        effEgressSec,
        [],
        fareHkd,
        [],
        0,
        { queryDate: queryDateObj, isLantauTrip, fromMeta, toMeta, egressByBike: bestPair.egr.byBike, egressWalkDistM: effEgressDistM }
      );
      const cand = {
        group: rt.group,
        boardStopKey: bObj.stopKey,
        boardStopObj: bObj,
        alightStopObj: aObj,
        stopsCount,
        driveSec: bestPair.driveSec,
        load1,
        accessWalkSec: bestPair.acc.sec,
        accessWalkDistM: bestPair.acc.distM,
        accessByBike: bestPair.acc.byBike,
        accessExitObj: bestPair.acc.exitObj || null,
        egressWalkSec: effEgressSec,
        egressWalkDistM: effEgressDistM,
        egressByBike: bestPair.egr.byBike,
        egressExitObj: bestPair.egr.exitObj || null,
        totalMins,
        fareHkd,
        fareNotices: fareMeta.notices || [],
        disruptionScore: score,
        _rankSec: bestPair.rankSec,
        parallelRoutes: []
      };
      const prevBest = bestDirectBySig.get(sig);
      if (!prevBest || cand.disruptionScore < prevBest.disruptionScore || (cand.disruptionScore === prevBest.disruptionScore && cand._rankSec < prevBest._rankSec)) {
        bestDirectBySig.set(sig, cand);
      }
    }
  }
  const rawDirectRoutes = Array.from(bestDirectBySig.values()).sort((a, b) => a.disruptionScore - b.disruptionScore);

  const primaryCorridors = runRaptorCorridorPass(G, originAccess, destEgress, queryDateObj, isAirportTrip, isLantauTrip, isHoliday, fromMeta, toMeta, {
    maxRounds: 4,
    suppressLongHaulBusKm: 0,
    requireRailOrFerryTrunk: false
  });

  const heavyMtrInPrimary = primaryCorridors.filter(corridorHasHeavyMtrTrunk);
  let extraRailFerryCorridors = [];
  if (!mtrClosedNow && (directKm >= 6.0 || (directKm >= 3.0 && heavyMtrInPrimary.length < 3))) {
    extraRailFerryCorridors = runRaptorCorridorPass(G, originAccess, destEgress, queryDateObj, isAirportTrip, isLantauTrip, isHoliday, fromMeta, toMeta, {
      maxRounds: 4,
      suppressLongHaulBusKm: 9.0,
      requireRailOrFerryTrunk: true
    });
  }

  const mergedByChain = new Map();
  for (const cor of [...primaryCorridors, ...extraRailFerryCorridors]) {
    if (!mergedByChain.has(cor.chainKey) || cor.disruptionScore < mergedByChain.get(cor.chainKey).disruptionScore) {
      mergedByChain.set(cor.chainKey, cor);
    }
  }
  const allSortedCorridors = Array.from(mergedByChain.values()).sort((a, b) => a.disruptionScore - b.disruptionScore);

  const selectedCorridors = [];
  const pickedKeys = new Set();
  const pushCor = (cor) => {
    if (!cor || pickedKeys.has(cor.chainKey)) return;
    pickedKeys.add(cor.chainKey);
    selectedCorridors.push(cor);
  };

  allSortedCorridors.slice(0, 5).forEach(pushCor);
  allSortedCorridors.filter(corridorHasHeavyMtrTrunk).slice(0, 3).forEach(pushCor);
  allSortedCorridors.filter(corridorHasRailOrFerryTrunk).slice(0, 2).forEach(pushCor);
  for (const cor of allSortedCorridors) {
    if (selectedCorridors.length >= 10) break;
    pushCor(cor);
  }

  return {
    fromMeta,
    toMeta,
    queryDate: queryDateObj,
    isAirportTrip,
    isLantauTrip,
    mtrClosedNow,
    walkBikeDirectCard,
    directRoutes: rawDirectRoutes.slice(0, 12),
    transferCorridors: selectedCorridors
  };
}

// Collapse parallel direct bus routes sharing the same boarding & alighting stop ONLY if
// pre-ETA (static render) or within 5m arrival & $2.5 fare of the winner (e.g. 3M 19m beats 1 59m without merging).
function collapseParallelDirectRoutes(
  directList,
  isLiveResolved = false,
  timeMode = (typeof xferTimeMode !== 'undefined' ? xferTimeMode : 'NOW'),
  sortPref = (typeof xferSortPref !== 'undefined' ? xferSortPref : 'BEST')
) {
  if (!Array.isArray(directList) || !directList.length) return [];
  const alive = directList
    .filter(dp => dp && !dp.isDeadGhost)
    .map(dp => ({ ...dp, parallelRoutes: [] }));

  alive.sort((a, b) => {
    const sDiff = (Number(a.disruptionScore) || 0) - (Number(b.disruptionScore) || 0);
    if (Math.abs(sDiff) > 0.25) return sDiff;
    const mDiff = (Number(a.totalMins) || 999) - (Number(b.totalMins) || 999);
    if (mDiff !== 0) return mDiff;
    return (Number(a.fareHkd) || 0) - (Number(b.fareHkd) || 0);
  });

  const out = [];
  const parallelGroupMap = new Map();
  for (const dp of alive) {
    const isBus = (!dp.group?.mode || dp.group.mode === 'BUS');
    if (isBus && dp.boardStopObj && dp.alightStopObj) {
      const pKey = `${getBaseStopNameKey(dp.boardStopObj.stopName_e)}_${getBaseStopNameKey(dp.alightStopObj.stopName_e)}`;
      if (parallelGroupMap.has(pKey)) {
        const primary = parallelGroupMap.get(pKey);
        const canMerge = !isLiveResolved || timeMode !== 'NOW' || (
          Math.abs((Number(dp.totalMins) || 0) - (Number(primary.totalMins) || 0)) <= 5 &&
          Math.abs((Number(dp.fareHkd) || 0) - (Number(primary.fareHkd) || 0)) <= 2.5
        );
        if (canMerge) {
          if (primary.parallelRoutes.length < 3) {
            primary.parallelRoutes.push(dp.group.routeNo);
            if (sortPref === 'BULLETPROOF') {
              primary.disruptionScore = Number(Math.max(1, primary.disruptionScore - 2.2).toFixed(1));
            }
          }
          continue;
        }
      } else {
        parallelGroupMap.set(pKey, dp);
      }
    }
    out.push(dp);
  }
  out.sort((a, b) => (Number(a.disruptionScore) || 0) - (Number(b.disruptionScore) || 0));
  return out;
}

if (typeof window !== 'undefined') {
  window.collapseParallelDirectRoutes = collapseParallelDirectRoutes;
}


// PARETO DOMINANCE PRUNING, CPMS FILTER & CARD RENDER HELPERS
// ============================================================================
function extractCardMetrics(card, refStartMs = 0) {
  const item = card?.item || {};
  if (card?.type === 'WALK_BIKE') {
    const mins = Math.max(1, Number(item.totalMins) || 1);
    return {
      mins,
      fareHkd: Number(item.fareHkd) || 0,
      transfers: 0,
      walkM: Number(item.distM) || 0,
      legIds: ['WALK_BIKE'],
      modes: [item.isBike ? 'BIKE' : 'WALK'],
      isWalkBike: true
    };
  }
  if (card?.type === 'DIRECT') {
    const legId = `${item.group?.company || ''}_${item.group?.routeNo || ''}`;
    const mode = item.group?.mode || 'BUS';
    let mins = Math.max(2, Number(item.totalMins) || 2);
    if (refStartMs && item.liveArrMs && xferTimeMode === 'NOW') {
      mins = Math.max(2, Math.round((item.liveArrMs - refStartMs) / 60000));
    }
    return {
      mins,
      fareHkd: Number(item.fareHkd) || 0,
      transfers: 0,
      walkM: (Number(item.accessWalkDistM) || 0) + (Number(item.egressWalkDistM) || 0),
      legIds: [legId],
      modes: [mode],
      hasHeavyMtr: mode === 'MTR' && item.group?.company === 'MTR',
      isWalkBike: false
    };
  }
  // XFER
  const node = item.xferStopNodes?.[0] || {};
  const l3s = item.leg3Options || [];
  const legGroups = [item.leg1Group, item.leg2Group, ...l3s.map(l3 => l3.group)];
  const legIds = [
    `${item.leg1Group?.company || ''}_${item.leg1Group?.routeNo || ''}`,
    `${item.leg2Group?.company || ''}_${item.leg2Group?.routeNo || ''}`,
    ...l3s.map(l3 => `${l3.group?.company || ''}_${l3.group?.routeNo || l3.routeNo || ''}`)
  ];
  const modes = [
    item.leg1Group?.mode || item.leg1Mode || 'BUS',
    item.leg2Group?.mode || item.leg2Mode || 'BUS',
    ...l3s.map(l3 => l3.group?.mode || 'BUS')
  ];
  const hasHeavyMtr = legGroups.some(g => g && g.mode === 'MTR' && g.company === 'MTR');
  let mins = Math.max(4, Number(item.totalMins) || 4);
  if (refStartMs && item.liveArrMs && xferTimeMode === 'NOW') {
    mins = Math.max(4, Math.round((item.liveArrMs - refStartMs) / 60000));
  }
  const xferWalkM = (Number(node.walkDistM) || 0) + l3s.reduce((s, l3) => s + (Number(l3.walkDistM) || 0), 0);
  return {
    mins,
    fareHkd: Number(item.fareHkd) || 0,
    transfers: 1 + l3s.length,
    walkM: (Number(item.accessWalkDistM) || 0) + (Number(item.egressWalkDistM) || 0) + xferWalkM,
    legIds,
    modes,
    hasHeavyMtr,
    isWalkBike: false
  };
}

function pruneDominatedPlannerCards(unifiedCards, pref = xferSortPref, refStartMs = 0) {
  if (!Array.isArray(unifiedCards) || !unifiedCards.length) return [];

  const decorated = unifiedCards.map(c => ({
    card: c,
    m: extractCardMetrics(c, refStartMs)
  }));

  // Sort by preference-weighted score, then faster arrival, fewer transfers, cheaper fare
  decorated.sort((a, b) => {
    const sDiff = (Number(a.card.score) || 0) - (Number(b.card.score) || 0);
    if (Math.abs(sDiff) > 0.25) return sDiff;
    if (a.m.mins !== b.m.mins) return a.m.mins - b.m.mins;
    if (a.m.transfers !== b.m.transfers) return a.m.transfers - b.m.transfers;
    return a.m.fareHkd - b.m.fareHkd;
  });

  // Collect best direct route metrics by canonical route ID (e.g. MTR_TCL)
  const directByLegId = new Map();
  for (const d of decorated) {
    if (d.card.type === 'DIRECT' && d.m.legIds[0]) {
      const id = d.m.legIds[0];
      const prev = directByLegId.get(id);
      if (!prev || d.m.mins < prev.m.mins) directByLegId.set(id, d);
    }
  }

  const transitEntries = decorated.filter(d => !d.m.isWalkBike);
  const fastestTransitMins = transitEntries.length
    ? Math.min(...transitEntries.map(d => d.m.mins))
    : Infinity;
  const walkEntry = decorated.find(d => d.m.isWalkBike);

  const kept = [];

  for (const cand of decorated) {
    const cm = cand.m;

    // 1. Walk/Bike sanity: if direct walk/bike takes <= 8m, skip slower paid transit (unless EASY mode)
    if (!cm.isWalkBike && walkEntry && walkEntry.m.mins <= 8 && cm.mins > walkEntry.m.mins + 2 && pref !== 'EASY') {
      continue;
    }
    // If direct walk takes > 18m and transit is much faster, only keep walk in CHEAPEST mode
    if (cm.isWalkBike && Number.isFinite(fastestTransitMins) && cm.mins > fastestTransitMins + 10 && cm.mins > 18 && pref !== 'CHEAPEST') {
      continue;
    }

    // 2. Redundant Super-Chain Pruning:
    // If Direct route X (e.g., MTR_TCL) exists, drop X -> Y or Y -> X unless it arrives >= 4m faster OR saves >= 350m walk without being > 3m slower
    if (cand.card.type === 'XFER') {
      let isRedundantSuperChain = false;
      for (const legId of cm.legIds) {
        const directMatch = directByLegId.get(legId);
        if (!directMatch) continue;
        const dm = directMatch.m;
        const fasterBy = dm.mins - cm.mins;
        const walkSaved = dm.walkM - cm.walkM;
        const savesMeaningfulWalk = walkSaved >= 350 && cm.mins <= dm.mins + 3;
        if (fasterBy < 4 && !savesMeaningfulWalk) {
          isRedundantSuperChain = true;
          break;
        }
      }
      if (isRedundantSuperChain) continue;
    }

    // 3. Practicality cap against fastest transit option (no uselessly slow alternatives)
    if (!cm.isWalkBike && Number.isFinite(fastestTransitMins)) {
      const fastestFare = transitEntries.reduce((minF, d) => (d.m.mins <= fastestTransitMins + 2 ? Math.min(minF, d.m.fareHkd) : minF), Infinity);
      const fareSaved = Number.isFinite(fastestFare) ? (fastestFare - cm.fareHkd) : 0;
      const normalCap = Math.max(fastestTransitMins + 15, Math.round(fastestTransitMins * 1.42));
      const cheapCap = Math.max(fastestTransitMins + 26, Math.round(fastestTransitMins * 1.72));
      if (cm.mins > normalCap && !(fareSaved >= 4.0 && cm.mins <= cheapCap)) {
        continue;
      }
    }

    // 4. Strict Pareto Dominance Pruning against every already-kept card
    const keptHasHeavyMtr = kept.some(x => x.m.hasHeavyMtr);
    const preserveBestRailAlternative = cm.hasHeavyMtr && !keptHasHeavyMtr &&
      (!Number.isFinite(fastestTransitMins) || cm.mins <= Math.max(fastestTransitMins + 24, Math.round(fastestTransitMins * 1.40)));
    let dominated = false;
    for (const k of kept) {
      const km = k.m;
      if (km.isWalkBike && !cm.isWalkBike) continue;
      // Preserve mode diversity: never let a bus-only trunk dominate or dedup the top jam-free heavy-MTR alternative
      if (preserveBestRailAlternative && !km.hasHeavyMtr) continue;

      const fasterOrTie = km.mins <= cm.mins + 2;
      const cheaperOrTie = km.fareHkd <= cm.fareHkd + 1.5;
      const fewerOrEqXfers = km.transfers <= cm.transfers;
      const lessOrEqWalk = km.walkM <= cm.walkM + 200;

      if (fasterOrTie && cheaperOrTie && fewerOrEqXfers && lessOrEqWalk) {
        dominated = true;
        break;
      }

      // Same-trunk transfer dedup: if two XFER cards share leg1 or leg2 and same/more transfers, drop if >= 3m slower without meaningful fare/walk advantage
      if (cand.card.type === 'XFER' && k.card.type === 'XFER') {
        const sharesLeg = cm.legIds[0] === km.legIds[0] || cm.legIds[cm.legIds.length - 1] === km.legIds[km.legIds.length - 1];
        if (sharesLeg && km.transfers <= cm.transfers && km.mins <= cm.mins - 3 && km.fareHkd <= cm.fareHkd + 3.0 && km.walkM <= cm.walkM + 250) {
          dominated = true;
          break;
        }
      }
    }
    if (dominated) continue;

    kept.push(cand);
    if (kept.length >= 4) break;
  }

  return kept.map(k => k.card);
}

window.pruneDominatedPlannerCards = pruneDominatedPlannerCards;

if (typeof window !== 'undefined') {
  window.GOLDEN_BBI_KEYWORDS = GOLDEN_BBI_KEYWORDS;
  window.isStrategicInterchangeHub = isStrategicInterchangeHub;
  window.isLantauOrAirportZone = isLantauOrAirportZone;
  window.isExternalERoute = isExternalERoute;
  window.isInSharedBikeZone = isInSharedBikeZone;
  window.inferPlannerLegLoad = inferPlannerLegLoad;
  window.getMtrInternalTransferSec = getMtrInternalTransferSec;
  window.getInterchangeTransferSec = getInterchangeTransferSec;
  window.findNearestMtrExitForPoint = findNearestMtrExitForPoint;
  window.resolveMtrTransferExit = resolveMtrTransferExit;
  window.getRaptorGraph = getRaptorGraph;
  window.getSharedBikeLegFareHkd = getSharedBikeLegFareHkd;
  window.computeLegChainFareHkd = computeLegChainFareHkd;
  window.computeFirstLegDirectionPenalty = computeFirstLegDirectionPenalty;
  window.isTungChungNorthLoopStop = isTungChungNorthLoopStop;
  window.detectTungChungNorthLoopPenalty = detectTungChungNorthLoopPenalty;
  window.computeBusPeakCongestionBufferMins = computeBusPeakCongestionBufferMins;
  window.isShortLastMileFeederLeg = isShortLastMileFeederLeg;
  window.computeDisruptionAdjustedScore = computeDisruptionAdjustedScore;
  window.corridorHasRailOrFerryTrunk = corridorHasRailOrFerryTrunk;
  window.corridorHasHeavyMtrTrunk = corridorHasHeavyMtrTrunk;
  window.runRaptorCorridorPass = runRaptorCorridorPass;
  window.buildFromToEdgeRequestSpec = buildFromToEdgeRequestSpec;
  window.collapseParallelDirectRoutes = collapseParallelDirectRoutes;
  window.extractCardMetrics = extractCardMetrics;
  window.pruneDominatedPlannerCards = pruneDominatedPlannerCards;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GOLDEN_BBI_KEYWORDS,
    isStrategicInterchangeHub,
    isLantauOrAirportZone,
    isExternalERoute,
    isInSharedBikeZone,
    inferPlannerLegLoad,
    getMtrInternalTransferSec,
    getInterchangeTransferSec,
    findNearestMtrExitForPoint,
    resolveMtrTransferExit,
    getRaptorGraph,
    getSharedBikeLegFareHkd,
    computeLegChainFareHkd,
    computeFirstLegDirectionPenalty,
    isTungChungNorthLoopStop,
    detectTungChungNorthLoopPenalty,
    computeBusPeakCongestionBufferMins,
    isShortLastMileFeederLeg,
    computeDisruptionAdjustedScore,
    corridorHasRailOrFerryTrunk,
    corridorHasHeavyMtrTrunk,
    runRaptorCorridorPass,
    buildFromToEdgeRequestSpec,
    collapseParallelDirectRoutes,
    extractCardMetrics,
    pruneDominatedPlannerCards
  };
}
