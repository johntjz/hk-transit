/* ============================================================================
 * HK Transit (通) — Dedicated Bus Speed Inference & Ground-Truth Traffic Engine
 * ============================================================================
 * Resolves segment-by-segment traffic speeds across Hong Kong bus corridors:
 *   Tier 1 (Ground Truth): HKSAR Transport Department (TD) Speed Detectors + Cameras
 *   Tier 2 (Gap-Filler):   Calibrated live Bus API ETA inference (KMB/LWB/CTB/NLB/GMB)
 *                          with minute-quantization safety, terminus layover guards,
 *                          dwell/signal compensation, GPS vs Scheduled separation,
 *                          multi-bus upper-percentile consensus, and 2-stop smoothing.
 *   Tier 3 (Visual Only):  Matched TD Traffic Camera along unmonitored stretches.
 *
 * Conflict Resolution Rule:
 *   Whenever a same-direction TD speed detector covers a stop-to-stop stretch
 *   (<= 150 m, <= 55°), TD Ground Truth ALWAYS takes priority over Bus API inference.
 * ============================================================================ */

(function (globalScope) {
  'use strict';

  function _haversineKmLocal(lat1, lon1, lat2, lon2) {
    if (typeof globalScope._haversineKm === 'function') {
      return globalScope._haversineKm(lat1, lon1, lat2, lon2);
    }
    if (typeof globalScope.calculateDistanceKm === 'function') {
      return globalScope.calculateDistanceKm(lat1, lon1, lat2, lon2);
    }
    const R = 6371;
    const dLat = (Number(lat2) - Number(lat1)) * Math.PI / 180;
    const dLon = (Number(lon2) - Number(lon1)) * Math.PI / 180;
    const la1 = Number(lat1) * Math.PI / 180;
    const la2 = Number(lat2) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function _bearingDegLocal(lat1, lon1, lat2, lon2) {
    if (typeof globalScope.computeBearingDeg === 'function') {
      return globalScope.computeBearingDeg(lat1, lon1, lat2, lon2);
    }
    const la1 = Number(lat1) * Math.PI / 180;
    const la2 = Number(lat2) * Math.PI / 180;
    const dLon = (Number(lon2) - Number(lon1)) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }

  function _angDiffLocal(a, b) {
    if (typeof globalScope.angularDiffDeg === 'function') {
      return globalScope.angularDiffDeg(a, b);
    }
    return Math.abs((((Number(a) || 0) - (Number(b) || 0) + 540) % 360) - 180);
  }

  function _pointToSegKmLocal(pLat, pLon, aLat, aLon, bLat, bLon) {
    if (typeof globalScope.pointToSegmentDistanceKm === 'function') {
      return globalScope.pointToSegmentDistanceKm(pLat, pLon, aLat, aLon, bLat, bLon);
    }
    const latRef = ((aLat + bLat) * 0.5) * Math.PI / 180;
    const kx = 111.32 * Math.cos(latRef);
    const ky = 110.574;
    const ax = aLon * kx, ay = aLat * ky;
    const bx = bLon * kx, by = bLat * ky;
    const px = pLon * kx, py = pLat * ky;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 1e-9) {
      return { distKm: Math.hypot(px - ax, py - ay), t: 0 };
    }
    const rawT = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    const t = Math.max(0, Math.min(1, rawT));
    return { distKm: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t: rawT };
  }

  function _stripPlatformLabel(name) {
    return String(name || '')
      .replace(/\s*\([A-Z]{1,3}\d{2,4}\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _polylineLengthKm(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      total += _haversineKmLocal(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
    }
    return total;
  }

  function getBusSpeedColorHex(tier, speedKmh = null) {
    const t = String(tier || '').toUpperCase();
    if (t === 'CONGESTED' || t === 'JAMMED') return '#dc2626';
    if (t === 'MODERATE' || t === 'SLOW') return '#f59e0b';
    if (t === 'SMOOTH') return '#16a34a';
    const spd = Number(speedKmh);
    if (!Number.isFinite(spd)) return '#64748b';
    if (spd < 15) return '#dc2626';
    if (spd < 28) return '#f59e0b';
    return '#16a34a';
  }

  function normalizeTrafficTier(rawTier, speedKmh = null) {
    const t = String(rawTier || '').toUpperCase();
    if (t === 'CONGESTED' || t === 'JAMMED') return 'CONGESTED';
    if (t === 'MODERATE' || t === 'SLOW') return 'MODERATE';
    if (t === 'SMOOTH') return 'SMOOTH';
    const spd = Number(speedKmh);
    if (!Number.isFinite(spd)) return 'SMOOTH';
    if (spd < 20) return 'CONGESTED';
    if (spd <= 40) return 'MODERATE';
    return 'SMOOTH';
  }

  // Detect scheduled / timetable-only ETA entries so timetable padding is never misread as a live road jam.
  function isScheduledBusEtaEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.isScheduled === true || entry.isSchedule === true || entry.scheduled === true) return true;
    if (entry.gps === false || entry.isLive === false) return true;
    const rmk = `${entry.rmk_en || ''} ${entry.rmk_tc || ''} ${entry.rmk || ''} ${entry.remark || ''}`;
    if (/scheduled|schedule\s*bus|原定班次|預定班次|時間表/i.test(rmk)) return true;
    return false;
  }

  function isTerminusLikeStop(stopObj, stopIdx = -1) {
    if (stopIdx === 0) return true;
    const nm = `${stopObj?.stopName_e || ''} ${stopObj?.name_tc || ''}`;
    return /\b(?:terminus|b\/t|pti|interchange|pier|ferry\s*pier|estate\s*bus\s*terminus)\b|總站|公共運輸交匯處|碼頭/i.test(nm);
  }

  // Calibrated HK road-class model (urban local street vs rural/arterial vs expressway)
  function classifyBusRoadClass(roadDistKm, fromStop = null, toStop = null) {
    const km = Math.max(0.05, Number(roadDistKm) || 0.4);
    const names = `${fromStop?.stopName_e || ''} ${toStop?.stopName_e || ''} ${fromStop?.name_tc || ''} ${toStop?.name_tc || ''}`;
    const isRuralMountain = /south\s*lantau|pui\s*o|mui\s*wo|cheung\s*sha|tong\s*fuk|shui\s*hau|shek\s*pik|ngong\s*ping|tai\s*o|tung\s*chung\s*road|pak\s*kung\s*au|sai\s*kung|clear\s*water\s*bay|shek\s*o|stanley|repulse\s*bay|貝澳|梅窩|長沙|塘福|水口|石壁|昂坪|大澳|東涌道|伯公坳|嶼南道|西貢|清水灣|石澳|赤柱/i.test(names);
    const isNewTownOpen = /waterfront|yu\s*tung|ying\s*hei|man\s*tung|tung\s*chung\s*north|yat\s*tung|迎禧|海濱|裕東|文東|逸東/i.test(names);

    if (km >= 1.65 && !isRuralMountain) {
      return {
        roadClass: 'EXPRESSWAY',
        expectedKmh: 56,
        smoothMinKmh: 38,
        moderateMinKmh: 21,
        maxRealisticKmh: 85,
        baseDwellSec: 14
      };
    }
    if (km >= 0.78 || isRuralMountain) {
      return {
        roadClass: isRuralMountain ? 'RURAL_ARTERIAL' : 'ARTERIAL',
        expectedKmh: isRuralMountain ? 32 : 35,
        smoothMinKmh: isRuralMountain ? 20 : 23,
        moderateMinKmh: isRuralMountain ? 12 : 14,
        maxRealisticKmh: isRuralMountain ? 50 : 55,
        baseDwellSec: isRuralMountain ? 22 : 26
      };
    }
    return {
      roadClass: isNewTownOpen ? 'NEW_TOWN_LOCAL' : 'URBAN_LOCAL',
      expectedKmh: isNewTownOpen ? 26 : 22,
      smoothMinKmh: 17,
      moderateMinKmh: 10.5,
      maxRealisticKmh: isNewTownOpen ? 44 : 38,
      baseDwellSec: km < 0.45 ? 38 : 32
    };
  }

  // Monotonically slice road-snapped polyline between consecutive stops so U-turns / loops never snap backwards.
  function sliceStopSpanPolyline(roadPolylinePoints, aLat, aLon, bLat, bLon, minPolyCursor = 0) {
    const fallback = [[aLat, aLon], [bLat, bLon]];
    if (!Array.isArray(roadPolylinePoints) || roadPolylinePoints.length < 2) {
      return { coords: fallback, nextCursor: minPolyCursor, isRoadSnapped: false };
    }

    const n = roadPolylinePoints.length;
    const startSearch = Math.max(0, Math.min(n - 2, minPolyCursor));
    let idxA = -1, bestA = Infinity;
    for (let p = startSearch; p < n; p++) {
      const pt = roadPolylinePoints[p];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const d = _haversineKmLocal(aLat, aLon, pt[0], pt[1]);
      if (d < bestA) {
        bestA = d;
        idxA = p;
      }
      // Once we found a close snap (< 90m) and start moving far away (> 350m), stop early so loops don't match return pass
      if (bestA < 0.09 && d > 0.35 && p > idxA + 2) break;
    }

    if (idxA < 0 || bestA > 0.45) {
      return { coords: fallback, nextCursor: minPolyCursor, isRoadSnapped: false };
    }

    let idxB = -1, bestB = Infinity;
    for (let p = idxA; p < n; p++) {
      const pt = roadPolylinePoints[p];
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const d = _haversineKmLocal(bLat, bLon, pt[0], pt[1]);
      if (d < bestB) {
        bestB = d;
        idxB = p;
      }
      if (bestB < 0.09 && d > 0.35 && p > idxB + 2) break;
    }

    if (idxB > idxA && bestB <= 0.45) {
      const sliced = roadPolylinePoints.slice(idxA, idxB + 1);
      const straightKm = _haversineKmLocal(aLat, aLon, bLat, bLon);
      const polyKm = _polylineLengthKm(sliced);
      // Guard against runaway loop wraps (> 4.5x straight distance & > 2.5km extra)
      if (sliced.length >= 2 && (polyKm <= Math.max(0.8, straightKm * 4.5 + 0.8))) {
        return { coords: sliced, nextCursor: idxB, isRoadSnapped: sliced.length >= 3 };
      }
    }

    return { coords: fallback, nextCursor: idxA, isRoadSnapped: false };
  }

  // Tier 1 Ground-Truth Matcher: spatially matches same-direction TD detectors & TD cameras along a stop-to-stop polyline.
  function matchTdGroundTruthForSpan(segCoords, tdDetectors = [], tdCameras = [], opts = {}) {
    const empty = {
      hasTd: false,
      tdSpeedKmh: null,
      tdTier: null,
      tdStatus: null,
      tdColor: null,
      tdOcc: 0,
      tdDetId: '',
      tdRoadEn: '',
      tdRoadTc: '',
      tdDet: null,
      tdMatchCount: 0,
      cam: null
    };
    if (!Array.isArray(segCoords) || segCoords.length < 2) return empty;

    const maxDetDistKm = Number(opts.maxDetDistKm) || 0.15; // 150 m corridor match
    const maxDetAngDeg = Number(opts.maxDetAngDeg) || 55;
    const maxCamDistKm = Number(opts.maxCamDistKm) || 0.14; // 140 m camera match
    const maxCamAngDeg = Number(opts.maxCamAngDeg) || 58;

    // Precompute bounding box + sub-segments of this stop span
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    const subSegs = [];
    for (let i = 0; i < segCoords.length - 1; i++) {
      const a = segCoords[i], b = segCoords[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const aLat = Number(a[0]), aLon = Number(a[1]), bLat = Number(b[0]), bLon = Number(b[1]);
      if (!Number.isFinite(aLat) || !Number.isFinite(bLat)) continue;
      if (aLat < minLat) minLat = aLat;
      if (aLat > maxLat) maxLat = aLat;
      if (bLat < minLat) minLat = bLat;
      if (bLat > maxLat) maxLat = bLat;
      if (aLon < minLon) minLon = aLon;
      if (aLon > maxLon) maxLon = aLon;
      if (bLon < minLon) minLon = bLon;
      if (bLon > maxLon) maxLon = bLon;
      const lenKm = _haversineKmLocal(aLat, aLon, bLat, bLon);
      if (lenKm < 0.004) continue;
      subSegs.push({
        aLat, aLon, bLat, bLon,
        brg: _bearingDegLocal(aLat, aLon, bLat, bLon)
      });
    }
    if (!subSegs.length) return empty;

    const padDeg = 0.003; // ~330m bbox prefilter
    const matchedDets = [];
    if (Array.isArray(tdDetectors) && tdDetectors.length) {
      for (let i = 0; i < tdDetectors.length; i++) {
        const d = tdDetectors[i];
        if (!d) continue;
        const dLat = Number(d.lat), dLon = Number(d.lon);
        const spd = Number(d.spd);
        if (!Number.isFinite(dLat) || !Number.isFinite(dLon) || !Number.isFinite(spd)) continue;
        if (dLat < minLat - padDeg || dLat > maxLat + padDeg || dLon < minLon - padDeg || dLon > maxLon + padDeg) continue;

        let bestKm = Infinity;
        let bestBrg = null;
        for (let s = 0; s < subSegs.length; s++) {
          const ss = subSegs[s];
          const proj = _pointToSegKmLocal(dLat, dLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon);
          if (proj.distKm < bestKm) {
            bestKm = proj.distKm;
            bestBrg = ss.brg;
          }
        }
        if (bestKm > maxDetDistKm || bestBrg === null) continue;
        if (Number.isFinite(Number(d.rot))) {
          const diff = _angDiffLocal(Number(d.rot), bestBrg);
          if (diff > maxDetAngDeg) continue;
        }
        matchedDets.push({ det: d, distKm: bestKm, spd, occ: Number(d.occ) || 0 });
      }
    }

    // Match nearest same-direction TD camera along this span
    let bestCam = null;
    if (Array.isArray(tdCameras) && tdCameras.length) {
      let bestCamScore = Infinity;
      for (let i = 0; i < tdCameras.length; i++) {
        const c = tdCameras[i];
        if (!c || !c.key) continue;
        const cLat = Number(c.lat), cLon = Number(c.lon);
        if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
        if (cLat < minLat - padDeg || cLat > maxLat + padDeg || cLon < minLon - padDeg || cLon > maxLon + padDeg) continue;

        let bestKm = Infinity;
        let bestBrg = null;
        for (let s = 0; s < subSegs.length; s++) {
          const ss = subSegs[s];
          const proj = _pointToSegKmLocal(cLat, cLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon);
          if (proj.distKm < bestKm) {
            bestKm = proj.distKm;
            bestBrg = ss.brg;
          }
        }
        if (bestKm > maxCamDistKm || bestBrg === null) continue;
        if (Number.isFinite(Number(c.bearingDeg))) {
          if (_angDiffLocal(Number(c.bearingDeg), bestBrg) > maxCamAngDeg) continue;
        }
        if (bestKm < bestCamScore) {
          bestCamScore = bestKm;
          bestCam = {
            key: c.key,
            camKey: c.key,
            desc: c.desc || c.key,
            meters: Math.round(bestKm * 1000),
            lat: cLat,
            lon: cLon,
            dir: c.dir || '',
            bearingDeg: Number.isFinite(Number(c.bearingDeg)) ? Number(c.bearingDeg) : bestBrg
          };
        }
      }
    }

    if (!matchedDets.length) {
      return { ...empty, cam: bestCam };
    }

    // Summarize TD ground-truth detectors on this span
    const activeSlow = matchedDets.filter(x => {
      const tr = normalizeTrafficTier(x.det.tier, x.spd);
      return tr === 'CONGESTED' || tr === 'MODERATE';
    });
    let focus = matchedDets[0];
    let resolvedSpd = 0;
    if (activeSlow.length) {
      activeSlow.sort((a, b) => a.spd - b.spd);
      focus = activeSlow[0];
      resolvedSpd = Math.round(focus.spd);
    } else {
      matchedDets.sort((a, b) => a.distKm - b.distKm);
      focus = matchedDets[0];
      resolvedSpd = Math.round(matchedDets.reduce((acc, x) => acc + x.spd, 0) / matchedDets.length);
    }
    const tdTier = normalizeTrafficTier(activeSlow.length ? focus.det.tier : 'SMOOTH', resolvedSpd);
    const tdStatus = tdTier === 'CONGESTED' ? 'JAMMED' : (tdTier === 'MODERATE' ? 'SLOW' : 'SMOOTH');

    // If detector itself links a camKey and we didn't find a closer directional camera, attach that camera metadata
    if (!bestCam && focus.det?.camKey) {
      const linked = Array.isArray(tdCameras) ? tdCameras.find(c => c.key === focus.det.camKey) : null;
      bestCam = {
        key: focus.det.camKey,
        camKey: focus.det.camKey,
        desc: linked?.desc || focus.det.roadEn || focus.det.roadTc || focus.det.camKey,
        meters: Math.round(focus.distKm * 1000),
        lat: Number(linked?.lat ?? focus.det.lat),
        lon: Number(linked?.lon ?? focus.det.lon),
        dir: linked?.dir || '',
        bearingDeg: linked?.bearingDeg ?? focus.det.rot
      };
    }

    return {
      hasTd: true,
      tdSpeedKmh: resolvedSpd,
      tdTier,
      tdStatus,
      tdColor: getBusSpeedColorHex(tdTier, resolvedSpd),
      tdOcc: Math.round(focus.occ || 0),
      tdDetId: focus.det.id || '',
      tdRoadEn: focus.det.roadEn || focus.det.roadTc || '',
      tdRoadTc: focus.det.roadTc || focus.det.roadEn || '',
      tdDet: focus.det,
      tdMatchCount: matchedDets.length,
      cam: bestCam
    };
  }

  function _parseStopEtaEntries(rawList, nowMs) {
    if (!Array.isArray(rawList)) return [];
    const parsed = [];
    for (let i = 0; i < rawList.length; i++) {
      const e = rawList[i];
      if (!e) continue;
      let ms = NaN;
      let rawStr = '';
      if (typeof e === 'string') {
        rawStr = e;
        ms = Date.parse(e);
      } else if (typeof e === 'number') {
        ms = e;
      } else if (e.eta) {
        rawStr = String(e.eta);
        ms = typeof e.eta === 'number' ? e.eta : Date.parse(rawStr);
      } else if (e.timestamp) {
        rawStr = String(e.timestamp);
        ms = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(rawStr);
      } else if (Number.isFinite(Number(e.mins))) {
        ms = nowMs + Number(e.mins) * 60000;
      }
      if (!Number.isFinite(ms)) continue;
      if (ms < nowMs - 180000 || ms > nowMs + 95 * 60000) continue;
      const secPart = new Date(ms).getUTCSeconds();
      parsed.push({
        ms,
        seq: Number(e.eta_seq ?? e.seq ?? (i + 1)) || (i + 1),
        isScheduled: isScheduledBusEtaEntry(e),
        isMinuteRounded: (secPart === 0)
      });
    }
    parsed.sort((a, b) => a.ms - b.ms);
    return parsed;
  }

  function _matchDeltaSecBetweenLists(arrA, arrB, minSec, maxSec, preferLiveOnly = true) {
    const pick = (listA, listB) => {
      const usedB = new Set();
      const deltas = [];
      let allRounded = true;
      for (let ai = 0; ai < listA.length; ai++) {
        const ea = listA[ai];
        let bestIdx = -1;
        let bestScore = Infinity;
        for (let bi = 0; bi < listB.length; bi++) {
          if (usedB.has(bi)) continue;
          const eb = listB[bi];
          const dSec = (eb.ms - ea.ms) / 1000;
          if (dSec < minSec || dSec > maxSec) continue;
          const seqBonus = (ea.seq > 0 && eb.seq === ea.seq) ? -20 : 0;
          if (dSec + seqBonus < bestScore) {
            bestScore = dSec + seqBonus;
            bestIdx = bi;
          }
        }
        if (bestIdx >= 0) {
          usedB.add(bestIdx);
          const dSec = (listB[bestIdx].ms - ea.ms) / 1000;
          deltas.push(dSec);
          if (!ea.isMinuteRounded || !listB[bestIdx].isMinuteRounded || (Math.round(dSec) % 60 !== 0)) {
            allRounded = false;
          }
        }
      }
      return { deltas, allRounded: deltas.length > 0 && allRounded };
    };

    if (preferLiveOnly) {
      const liveA = arrA.filter(x => !x.isScheduled);
      const liveB = arrB.filter(x => !x.isScheduled);
      if (liveA.length && liveB.length) {
        const liveRes = pick(liveA, liveB);
        if (liveRes.deltas.length) {
          return { ...liveRes, isScheduledOnly: false };
        }
      }
    }
    const allRes = pick(arrA, arrB);
    const anyLive = arrA.some(x => !x.isScheduled) && arrB.some(x => !x.isScheduled);
    return { ...allRes, isScheduledOnly: !anyLive };
  }

  // Calibrated HK Bus API Speed Inference Engine (replaces naive stop-to-stop division)
  function inferBusApiSegmentSpeeds(stops, etaByStopIdx, roadPolylinePoints = null, opts = {}) {
    if (!Array.isArray(stops) || stops.length < 2 || !etaByStopIdx) return [];
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const tdDetectors = Array.isArray(opts.tdDetectors)
      ? opts.tdDetectors
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_DETECTORS__) ? globalScope.__LIVE_TRAFFIC_DETECTORS__ : []);
    const tdCameras = Array.isArray(opts.tdCameras)
      ? opts.tdCameras
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_CAMERAS__) ? globalScope.__LIVE_TRAFFIC_CAMERAS__ : []);
    const tdCoveredPairs = opts.tdCoveredStopPairs instanceof Set ? opts.tdCoveredStopPairs : null;
    const routeNo = opts.routeNo || '';
    const company = opts.company || '';

    const parsedByIdx = new Array(stops.length);
    for (let i = 0; i < stops.length; i++) {
      const raw = (etaByStopIdx instanceof Map) ? etaByStopIdx.get(i) : etaByStopIdx[i];
      parsedByIdx[i] = _parseStopEtaEntries(raw, nowMs);
    }

    // Pass 1: Build raw stop-to-stop geometry, TD ground truth, and dwell/quantization-corrected bus speeds
    const rawSegs = [];
    let polyCursor = 0;

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      const aLat = parseFloat(a?.latitude ?? a?.lat), aLon = parseFloat(a?.longitude ?? a?.lon);
      const bLat = parseFloat(b?.latitude ?? b?.lat), bLon = parseFloat(b?.longitude ?? b?.lon);
      if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) continue;

      const sliced = sliceStopSpanPolyline(roadPolylinePoints, aLat, aLon, bLat, bLon, polyCursor);
      polyCursor = sliced.nextCursor;
      const segCoords = sliced.coords;

      const straightKm = _haversineKmLocal(aLat, aLon, bLat, bLon);
      const polyKm = _polylineLengthKm(segCoords);
      const roadDistKm = Math.max(0.08, sliced.isRoadSnapped ? polyKm : straightKm * 1.18);
      if (roadDistKm < 0.08 || roadDistKm > 28) continue;

      // Ground Truth Check: TD ALWAYS has priority when covering this span
      const tdTruth = matchTdGroundTruthForSpan(segCoords, tdDetectors, tdCameras);
      const pairFlaggedTd = Boolean(tdCoveredPairs && tdCoveredPairs.has(`${i + 1}_${i + 2}`));
      const coveredByTd = tdTruth.hasTd || pairFlaggedTd;

      const arrA = parsedByIdx[i];
      const arrB = parsedByIdx[i + 1];
      if (!arrA || !arrA.length || !arrB || !arrB.length) continue;

      const minSec = Math.max(15, (roadDistKm / 92) * 3600);
      const maxSec = Math.min(2400, Math.max(360, (roadDistKm / 3.0) * 3600));
      const matched = _matchDeltaSecBetweenLists(arrA, arrB, minSec, maxSec, true);
      if (!matched.deltas.length) continue;

      // Upper-percentile consensus (35th percentile of deltaSec = 65th percentile speed):
      // One slow bus loading a wheelchair doesn't mean the road is jammed if another bus flowed smoothly!
      matched.deltas.sort((x, y) => x - y);
      const pIdx = Math.floor((matched.deltas.length - 1) * 0.35);
      const deltaSec = matched.deltas[pIdx];

      const roadProfile = classifyBusRoadClass(roadDistKm, a, b);
      const isTerminusDep = isTerminusLikeStop(a, i);

      // Realistic HK stop dwell + traffic signal + acceleration + minute-quantization + terminus slack compensation
      let dwellSec = roadProfile.baseDwellSec;
      if (isTerminusDep && roadDistKm < 1.2) {
        // Terminus departures (e.g. Yat Tung -> Yu Tung Rd, Tung Chung Pier -> Waterfront Rd) carry departure padding!
        dwellSec += (i === 0 ? 45 : 22);
      }
      // Minute-granularity rounding correction: only apply when delta >= 90s (prevents inflating 60s 1-min urban hops to 70+ km/h!)
      const quantAdjSec = (matched.allRounded && deltaSec >= 90)
        ? (roadDistKm < 0.78 ? 25 : 14)
        : 0;
      const maxAllowanceFrac = deltaSec <= 75 ? 0.35 : 0.62;
      const maxAllowance = Math.min(deltaSec * maxAllowanceFrac, dwellSec + quantAdjSec);
      const movingSec = Math.max(20, deltaSec - maxAllowance);
      const maxCapKmh = Number(roadProfile.maxRealisticKmh) || 85;
      let busSpeedKmh = Math.max(4, Math.min(maxCapKmh, Number((roadDistKm / (movingSec / 3600)).toFixed(1))));

      // Classify Bus API tier using calibrated HK road-class thresholds
      const ratio = busSpeedKmh / Math.max(15, roadProfile.expectedKmh);
      let busTier = 'SMOOTH';
      if (busSpeedKmh < roadProfile.moderateMinKmh || ratio < 0.44) {
        busTier = 'CONGESTED';
      } else if (busSpeedKmh < roadProfile.smoothMinKmh || ratio < 0.72) {
        busTier = 'MODERATE';
      }

      // Guard 1: Short urban/new-town hop (<= 2 min rounded ETA) is normal bus pacing — NEVER false RED!
      if (roadDistKm < 0.78 && deltaSec <= 125 && busTier === 'CONGESTED') {
        busTier = 'SMOOTH';
        busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
      }
      // Guard 2: Terminus departure (stop 0 -> 1) <= 3 min is normal departure padding — NEVER false RED!
      if (i === 0 && roadDistKm < 1.2 && deltaSec <= 185 && busTier === 'CONGESTED') {
        busTier = 'SMOOTH';
        busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
      }
      // Guard 3: Scheduled timetable-only ETAs (no live GPS bus) must NEVER fabricate red/amber road jams!
      if (matched.isScheduledOnly && busTier !== 'SMOOTH') {
        busTier = 'SMOOTH';
        busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
      }

      rawSegs.push({
        fromIdx: i,
        toIdx: i + 1,
        fromSeq: i + 1,
        toSeq: i + 2,
        fromNameEn: _stripPlatformLabel(a?.stopName_e || a?.name_tc || ''),
        fromNameTc: _stripPlatformLabel(a?.name_tc || a?.stopName_e || ''),
        toNameEn: _stripPlatformLabel(b?.stopName_e || b?.name_tc || ''),
        toNameTc: _stripPlatformLabel(b?.name_tc || b?.stopName_e || ''),
        routeNo,
        company,
        roadClass: roadProfile.roadClass,
        roadDistKm: Number(roadDistKm.toFixed(2)),
        deltaSec: Math.round(deltaSec),
        busInferredSpeedKmh: busSpeedKmh,
        busInferredTier: busTier,
        speedKmh: busSpeedKmh,
        expectedKmh: roadProfile.expectedKmh,
        tier: busTier,
        isBottleneck: busTier === 'CONGESTED' || busTier === 'MODERATE',
        color: getBusSpeedColorHex(busTier, busSpeedKmh),
        source: 'BUS_API',
        confidence: matched.isScheduledOnly ? 'LOW' : (matched.deltas.length >= 2 ? 'HIGH' : 'MEDIUM'),
        isScheduledOnly: matched.isScheduledOnly,
        coveredByTd,
        tdCovered: coveredByTd,
        tdTruth,
        coords: segCoords
      });
    }

    // Pass 2: 2-Stop Sliding-Window Smoothing for short urban hops (< 0.65 km)
    // Eliminates single-intersection traffic-light luck / minute-rounding spikes on empty roads!
    for (let k = 0; k < rawSegs.length; k++) {
      const seg = rawSegs[k];
      if (seg.coveredByTd || seg.tier === 'SMOOTH' || seg.roadDistKm >= 0.70) continue;
      const prev = (k > 0 && rawSegs[k - 1].toIdx === seg.fromIdx) ? rawSegs[k - 1] : null;
      const next = (k + 1 < rawSegs.length && rawSegs[k + 1].fromIdx === seg.toIdx) ? rawSegs[k + 1] : null;
      const neighbors = [prev, next].filter(Boolean);
      if (!neighbors.length) continue;

      const combinedDistKm = seg.roadDistKm + neighbors.reduce((acc, n) => acc + n.roadDistKm, 0);
      const combinedSec = seg.deltaSec + neighbors.reduce((acc, n) => acc + n.deltaSec, 0);
      const macroDwell = (neighbors.length + 1) * 28;
      const macroMovingSec = Math.max(30, combinedSec - Math.min(combinedSec * 0.5, macroDwell));
      const macroKmh = combinedDistKm / (macroMovingSec / 3600);

      // If surrounding multi-stop corridor flows smoothly (>= 20 km/h urban), downgrade isolated single-hop spike
      if (macroKmh >= 20) {
        const blended = Number((seg.speedKmh * 0.4 + macroKmh * 0.6).toFixed(1));
        seg.speedKmh = blended;
        seg.busInferredSpeedKmh = blended;
        seg.tier = blended >= 17 ? 'SMOOTH' : 'MODERATE';
        seg.busInferredTier = seg.tier;
        seg.isBottleneck = seg.tier !== 'SMOOTH';
        seg.color = getBusSpeedColorHex(seg.tier, seg.speedKmh);
      }
    }

    // Pass 3: Apply Strict TD Ground-Truth Priority when a TD speed detector covers the stretch!
    // (e.g., Castle Peak Rd-Ping Shan: TD 70 km/h GREEN overrides slower local bus ETA inference)
    return rawSegs.map((seg) => {
      const td = seg.tdTruth;
      if (td && td.hasTd) {
        const conflict = (seg.busInferredTier !== td.tdTier);
        return {
          ...seg,
          speedKmh: td.tdSpeedKmh,
          tier: td.tdTier,
          isBottleneck: td.tdTier === 'CONGESTED' || td.tdTier === 'MODERATE',
          color: td.tdColor,
          source: 'TD',
          tdConflictResolved: conflict,
          detId: td.tdDetId,
          detectorId: td.tdDetId,
          occ: td.tdOcc,
          roadEn: td.tdRoadEn,
          roadTc: td.tdRoadTc,
          cam: td.cam,
          camKey: td.cam?.camKey || td.cam?.key || '',
          camDesc: td.cam?.desc || ''
        };
      }
      return {
        ...seg,
        detId: '',
        detectorId: '',
        occ: 0,
        roadEn: `${seg.fromNameEn} → ${seg.toNameEn}`.trim(),
        roadTc: `${seg.fromNameTc || seg.fromNameEn} → ${seg.toNameTc || seg.toNameEn}`.trim(),
        cam: td?.cam || null,
        camKey: td?.cam?.camKey || td?.cam?.key || '',
        camDesc: td?.cam?.desc || ''
      };
    });
  }

  // Unified Stop-by-Stop Traffic Timeline Builder (for every single stop row on the route card!)
  // Strictly enforces 3-tier priority per stop-to-stop span:
  //   1) TD Speed Detector (+ TD Camera if present)
  //   2) Calibrated Bus Speed Inference (+ TD Camera if present)
  //   3) TD Camera only (if no speed data yet)
  function buildStopByStopSegmentTraffic(stops, roadPolylinePoints = null, tdDetectors = [], tdCameras = [], busSpeedSegments = [], opts = {}) {
    if (!Array.isArray(stops) || stops.length < 2) return [];
    const detList = Array.isArray(tdDetectors)
      ? tdDetectors
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_DETECTORS__) ? globalScope.__LIVE_TRAFFIC_DETECTORS__ : []);
    const camList = Array.isArray(tdCameras)
      ? tdCameras
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_CAMERAS__) ? globalScope.__LIVE_TRAFFIC_CAMERAS__ : []);
    const busMap = new Map();
    if (Array.isArray(busSpeedSegments)) {
      for (let i = 0; i < busSpeedSegments.length; i++) {
        const b = busSpeedSegments[i];
        if (b && Number.isFinite(Number(b.fromIdx))) {
          busMap.set(Number(b.fromIdx), b);
        }
      }
    }

    const out = [];
    let polyCursor = 0;
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      const aLat = parseFloat(a?.latitude ?? a?.lat), aLon = parseFloat(a?.longitude ?? a?.lon);
      const bLat = parseFloat(b?.latitude ?? b?.lat), bLon = parseFloat(b?.longitude ?? b?.lon);
      const fromNameEn = _stripPlatformLabel(a?.stopName_e || a?.name_tc || '');
      const fromNameTc = _stripPlatformLabel(a?.name_tc || a?.stopName_e || '');
      const toNameEn = _stripPlatformLabel(b?.stopName_e || b?.name_tc || '');
      const toNameTc = _stripPlatformLabel(b?.name_tc || b?.stopName_e || '');

      if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) {
        out.push({
          fromIdx: i, toIdx: i + 1, fromSeq: i + 1, toSeq: i + 2,
          fromNameEn, fromNameTc, toNameEn, toNameTc,
          source: 'NONE', tier: 'NONE', speedKmh: null, color: '#94a3b8',
          detId: '', camKey: '', camDesc: '', cam: null, roadDistKm: 0, coords: []
        });
        continue;
      }

      const sliced = sliceStopSpanPolyline(roadPolylinePoints, aLat, aLon, bLat, bLon, polyCursor);
      polyCursor = sliced.nextCursor;
      const segCoords = sliced.coords;
      const straightKm = _haversineKmLocal(aLat, aLon, bLat, bLon);
      const roadDistKm = Number(Math.max(0.06, sliced.isRoadSnapped ? _polylineLengthKm(segCoords) : straightKm * 1.15).toFixed(2));

      const tdTruth = matchTdGroundTruthForSpan(segCoords, detList, camList);
      const busSeg = busMap.get(i) || null;

      // Tier 1: TD Speed Detector Ground Truth ALWAYS wins
      if (tdTruth.hasTd) {
        out.push({
          fromIdx: i,
          toIdx: i + 1,
          fromSeq: i + 1,
          toSeq: i + 2,
          fromNameEn,
          fromNameTc,
          toNameEn,
          toNameTc,
          source: 'TD',
          tier: tdTruth.tdTier,
          speedKmh: tdTruth.tdSpeedKmh,
          color: tdTruth.tdColor,
          occ: tdTruth.tdOcc,
          detId: tdTruth.tdDetId,
          roadEn: tdTruth.tdRoadEn,
          roadTc: tdTruth.tdRoadTc,
          cam: tdTruth.cam,
          camKey: tdTruth.cam?.camKey || tdTruth.cam?.key || '',
          camDesc: tdTruth.cam?.desc || '',
          roadDistKm,
          deltaSec: busSeg?.deltaSec || null,
          expectedKmh: busSeg?.expectedKmh || null,
          busInferredSpeedKmh: busSeg?.busInferredSpeedKmh ?? null,
          coords: segCoords
        });
        continue;
      }

      // Tier 2: Calibrated Bus Speed Inference (only when no TD detector covers this stretch)
      if (busSeg && Number.isFinite(Number(busSeg.speedKmh))) {
        const tier = normalizeTrafficTier(busSeg.tier, busSeg.speedKmh);
        const matchedCam = tdTruth.cam || busSeg.cam || null;
        out.push({
          fromIdx: i,
          toIdx: i + 1,
          fromSeq: i + 1,
          toSeq: i + 2,
          fromNameEn,
          fromNameTc,
          toNameEn,
          toNameTc,
          source: 'BUS_API',
          tier,
          speedKmh: Math.round(Number(busSeg.speedKmh)),
          color: getBusSpeedColorHex(tier, busSeg.speedKmh),
          occ: 0,
          detId: '',
          roadEn: `${fromNameEn} → ${toNameEn}`.trim(),
          roadTc: `${fromNameTc || fromNameEn} → ${toNameTc || toNameEn}`.trim(),
          cam: matchedCam,
          camKey: matchedCam?.camKey || matchedCam?.key || '',
          camDesc: matchedCam?.desc || '',
          roadDistKm: busSeg.roadDistKm || roadDistKm,
          deltaSec: busSeg.deltaSec || null,
          expectedKmh: busSeg.expectedKmh || null,
          confidence: busSeg.confidence || 'MEDIUM',
          isScheduledOnly: Boolean(busSeg.isScheduledOnly),
          coords: segCoords
        });
        continue;
      }

      // Tier 3: TD Camera only (if present along unmonitored span)
      if (tdTruth.cam) {
        out.push({
          fromIdx: i,
          toIdx: i + 1,
          fromSeq: i + 1,
          toSeq: i + 2,
          fromNameEn,
          fromNameTc,
          toNameEn,
          toNameTc,
          source: 'CAM_ONLY',
          tier: 'NONE',
          speedKmh: null,
          color: '#64748b',
          occ: 0,
          detId: '',
          roadEn: tdTruth.cam.desc || `${fromNameEn} → ${toNameEn}`.trim(),
          roadTc: tdTruth.cam.desc || `${fromNameTc || fromNameEn} → ${toNameTc || toNameEn}`.trim(),
          cam: tdTruth.cam,
          camKey: tdTruth.cam.camKey || tdTruth.cam.key || '',
          camDesc: tdTruth.cam.desc || '',
          roadDistKm,
          deltaSec: null,
          expectedKmh: null,
          coords: segCoords
        });
        continue;
      }

      out.push({
        fromIdx: i,
        toIdx: i + 1,
        fromSeq: i + 1,
        toSeq: i + 2,
        fromNameEn,
        fromNameTc,
        toNameEn,
        toNameTc,
        source: 'NONE',
        tier: 'NONE',
        speedKmh: null,
        color: '#94a3b8',
        occ: 0,
        detId: '',
        roadEn: `${fromNameEn} → ${toNameEn}`.trim(),
        roadTc: `${fromNameTc || fromNameEn} → ${toNameTc || toNameEn}`.trim(),
        cam: null,
        camKey: '',
        camDesc: '',
        roadDistKm,
        deltaSec: null,
        expectedKmh: null,
        coords: segCoords
      });
    }

    return out;
  }

  // Multi-operator route selector for Global Bus Speed Overlay (supports KMB, LWB, NLB, CTB, GMB!)
  // Ensures South Lantau Rd (NLB 3M/1/11/23 to Mui Wo & Pui O), HK Island (CTB), and local GMB roads are covered!
  function selectGlobalBusSpeedRoutes(routePool, bounds, getStopsForGroupFn, maxRoutes = 8) {
    if (!Array.isArray(routePool) || !routePool.length || !bounds || typeof bounds.contains !== 'function') return [];
    const candidates = [];
    const seenRouteFamily = new Set();

    for (let i = 0; i < routePool.length; i++) {
      const g = routePool[i];
      if (!g || (g.mode && g.mode !== 'BUS')) continue;
      const rId = g.routeIds?.[0] || '';
      const co = String(g.company || '').toUpperCase();
      const isKmbLwb = co === 'KMB' || co === 'LWB' || rId.startsWith('KMB_') || rId.startsWith('LWB_');
      const isNlb = co === 'NLB' || rId.startsWith('NLB_');
      const isCtb = co === 'CTB' || rId.startsWith('CTB_');
      const isGmb = co.startsWith('GMB') || rId.startsWith('GMB_');
      if (!isKmbLwb && !isNlb && !isCtb && !isGmb) continue;

      const stops = typeof getStopsForGroupFn === 'function' ? getStopsForGroupFn(g, null) : (g.stops || []);
      if (!Array.isArray(stops) || stops.length < 3) continue;

      const inBoundsIndices = [];
      for (let s = 0; s < stops.length; s++) {
        const la = parseFloat(stops[s]?.latitude ?? stops[s]?.lat);
        const lo = parseFloat(stops[s]?.longitude ?? stops[s]?.lon);
        if (Number.isFinite(la) && Number.isFinite(lo) && bounds.contains([la, lo])) {
          inBoundsIndices.push(s);
        }
      }
      if (inBoundsIndices.length < 2) continue;

      // Avoid duplicating 4 variants of the exact same route number + direction
      const famKey = `${co}|${g.routeNo || ''}|${g.bound || ''}`;
      if (seenRouteFamily.has(famKey)) continue;
      seenRouteFamily.add(famKey);

      // Prioritize trunk routes covering many stops in viewport + NLB/CTB when in Lantau/HKI
      const operatorBonus = isKmbLwb ? 3 : (isNlb ? 4 : (isCtb ? 2 : 0));
      candidates.push({
        group: g,
        stops,
        operator: isKmbLwb ? 'KMB' : (isNlb ? 'NLB' : (isCtb ? 'CTB' : 'GMB')),
        inBoundsIndices,
        score: inBoundsIndices.length * 2 + operatorBonus
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    // Keep operator diversity: pick top candidates while ensuring NLB/CTB aren't starved out by KMB
    const picked = [];
    const perOpCount = { KMB: 0, NLB: 0, CTB: 0, GMB: 0 };
    const maxPerOp = Math.max(3, Math.ceil(maxRoutes * 0.65));
    for (let i = 0; i < candidates.length && picked.length < maxRoutes; i++) {
      const c = candidates[i];
      if (perOpCount[c.operator] >= maxPerOp && candidates.some(x => !picked.includes(x) && perOpCount[x.operator] < 2)) {
        continue;
      }
      picked.push(c);
      perOpCount[c.operator]++;
    }
    return picked;
  }

  const BusSpeedEngine = {
    getBusSpeedColorHex,
    normalizeTrafficTier,
    isScheduledBusEtaEntry,
    isTerminusLikeStop,
    classifyBusRoadClass,
    sliceStopSpanPolyline,
    matchTdGroundTruthForSpan,
    inferBusApiSegmentSpeeds,
    buildStopByStopSegmentTraffic,
    selectGlobalBusSpeedRoutes
  };

  globalScope.BusSpeedEngine = BusSpeedEngine;
  globalScope.getBusSpeedLayerColorHex = getBusSpeedColorHex;
  globalScope.inferBusApiSegmentSpeeds = inferBusApiSegmentSpeeds;
  globalScope.buildStopByStopSegmentTraffic = buildStopByStopSegmentTraffic;
  globalScope.selectGlobalBusSpeedRoutes = selectGlobalBusSpeedRoutes;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BusSpeedEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
