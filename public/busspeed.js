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

  function _sanitizeDirectionTypos(raw) {
    return String(raw || '')
      .replace(/\bSouththbound\b/gi, 'Southbound')
      .replace(/\bNorththbound\b/gi, 'Northbound')
      .replace(/\bEastthbound\b/gi, 'Eastbound')
      .replace(/\bWestthbound\b/gi, 'Westbound');
  }

  function normalizeTrafficTier(rawTier, speedKmh = null) {
    const spd = Number(speedKmh);
    const hasSpd = speedKmh !== null && speedKmh !== undefined && Number.isFinite(spd);
    // Expressways / trunk roads at >= 40 km/h are ALWAYS Flowing (SMOOTH / Green), never Slow (Amber)
    if (hasSpd && Math.abs(spd) >= 40) return 'SMOOTH';
    const t = String(rawTier || '').toUpperCase();
    if (t === 'CONGESTED' || t === 'JAMMED') return 'CONGESTED';
    if (t === 'MODERATE' || t === 'SLOW') return 'MODERATE';
    if (t === 'SMOOTH') return 'SMOOTH';
    if (!hasSpd) return 'SMOOTH';
    const absSpd = Math.abs(spd);
    if (absSpd < 20) return 'CONGESTED';
    if (absSpd < 40) return 'MODERATE';
    return 'SMOOTH';
  }

  // Detect scheduled / timetable-only ETA entries so timetable padding is never misread as a live road jam.
  function isScheduledBusEtaEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.isScheduled === true || entry.isSchedule === true || entry.scheduled === true || entry.isSched === true) return true;
    if (entry.kinematicState === 'SCHED_GHOST') return true;
    if (entry.gps === false || entry.isLive === false) return true;
    if ((entry.noGPS === 1 || entry.noGPS === '1') && !entry.isTempGpsBlind) return true;
    const rmk = `${entry.rmk_en || ''} ${entry.rmk_tc || ''} ${entry.rmk || ''} ${entry.remark || ''}`;
    if (/scheduled|schedule\s*bus|原定班次|預定班次|時間表/i.test(rmk)) return true;
    return false;
  }

  function isTerminusLikeStop(stopObj, stopIdx = -1) {
    if (stopIdx === 0) return true;
    const nm = `${stopObj?.stopName_e || ''} ${stopObj?.name_tc || ''}`;
    return /\b(?:terminus|b\/t|pti|interchange|pier|ferry\s*pier|estate\s*bus\s*terminus)\b|總站|公共運輸交匯處|碼頭/i.test(nm);
  }

  function isRuralWindingCorridor(fromStop = null, toStop = null) {
    const names = `${fromStop?.stopName_e || ''} ${toStop?.stopName_e || ''} ${fromStop?.name_tc || ''} ${toStop?.name_tc || ''}`;
    return /south\s*lantau|pui\s*o|mui\s*wo|cheung\s*sha|tong\s*fuk|shui\s*hau|shek\s*pik|ngong\s*ping|tai\s*o|tung\s*chung\s*road|pak\s*kung\s*au|san\s*shek\s*wan|nam\s*shan|lai\s*chi\s*yuen|sai\s*kung|clear\s*water\s*bay|hiram'?s\s*highway|shek\s*o|stanley|repulse\s*bay|tai\s*tam|peak\s*road|route\s*twisk|lam\s*kam|bride'?s\s*pool|貝澳|梅窩|長沙|塘福|水口|石壁|昂坪|大澳|東涌道|伯公坳|嶼南道|散石灣|南山|荔枝園|西貢|清水灣|西貢公路|石澳|赤柱|淺水灣|大潭|山頂道|荃錦公路|林錦公路|新娘潭/i.test(names);
  }

  // Airport perimeter / cargo service roads operate as 30–40 km/h zones where 22–35 km/h is Flowing (Green)
  function isAirportPerimeterZone(fromStop = null, toStop = null, extraRoad = '') {
    const names = `${fromStop?.stopName_e || ''} ${toStop?.stopName_e || ''} ${fromStop?.name_tc || ''} ${toStop?.name_tc || ''} ${extraRoad || ''}`;
    return /south\s*perimeter|north\s*perimeter|chek\s*lap\s*kok|airport\s*south\s*interchange|cathay\s*pacific\s*cargo|cathay\s*city|airfreight|air\s*mail\s*centre|chun\s*wan\s*r(?:oa)?d|cargo\s*terminal|hactl|airport\s*freight|cheong\s*lin\s*r(?:oa)?d|南環路|北環路|赤鱲角|機場南|國泰.*貨運|國泰城|亞洲空運|空郵中心|駿運路|超級一號貨站/i.test(names);
  }

  // Narrow two-way / undivided village & local roads where opposite bearings (0° vs 180°) merge into one centered line
  function isNarrowTwoWayLocalRoad(textEn = '', textTc = '') {
    const names = `${textEn || ''} ${textTc || ''}`;
    if (!names.trim()) return false;
    return /ngan\s*wan\s*r(?:oa)?d|ngan\s*kwong\s*wan\s*r(?:oa)?d|ngan\s*shek\s*st(?:reet)?|ngan\s*shu\s*st(?:reet)?|mui\s*wo\s*rural\s*committee|mui\s*wo\s*ferry\s*pier|mui\s*wo\s*market|south\s*lantau\s*r(?:oa)?d|tung\s*chung\s*r(?:oa)?d|tai\s*o\s*r(?:oa)?d|keung\s*shan\s*r(?:oa)?d|kam\s*ho\s*r(?:oa)?d|pat\s*heung\s*r(?:oa)?d|銀灣路|銀礦灣路|銀石街|銀樹街|梅窩鄉事會路|梅窩碼頭|梅窩街市|嶼南道|東涌道|大澳道|羗山道|錦河路|八鄉路/i.test(names);
  }

  // Calibrated HK road-class model (airport perimeter vs urban local street vs rural/arterial vs expressway)
  function classifyBusRoadClass(roadDistKm, fromStop = null, toStop = null) {
    const km = Math.max(0.05, Number(roadDistKm) || 0.4);
    const names = `${fromStop?.stopName_e || ''} ${toStop?.stopName_e || ''} ${fromStop?.name_tc || ''} ${toStop?.name_tc || ''}`;
    const isRuralMountain = isRuralWindingCorridor(fromStop, toStop);
    const isAirportZone = isAirportPerimeterZone(fromStop, toStop);
    const isNewTownOpen = /waterfront|yu\s*tung|ying\s*hei|man\s*tung|tung\s*chung\s*north|yat\s*tung|迎禧|海濱|裕東|文東|逸東/i.test(names);

    if (isAirportZone && !/north\s*lantau\s*hwy|lantau\s*link|tm[\s-]*clk|tunnel\s*bbi|北大嶼山公路|青嶼幹線|屯赤/i.test(names)) {
      return {
        roadClass: 'AIRPORT_PERIMETER',
        expectedKmh: 34,
        smoothMinKmh: 20, // 22–35 km/h operational speeds ALWAYS Flowing (Green)
        moderateMinKmh: 8, // Never Red unless < 8 km/h across >= 2 consecutive non-terminus spans
        maxRealisticKmh: 50,
        baseDwellSec: 28
      };
    }
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
        // Never mark a bare 2-point > 120 m straight chord as road-snapped (prevents water/building shortcuts!)
        const snappedOk = sliced.length >= 3 || (n >= 3 && polyKm <= 0.12 && bestA <= 0.20 && bestB <= 0.20);
        return { coords: sliced, nextCursor: idxB, isRoadSnapped: snappedOk };
      }
    }

    return { coords: fallback, nextCursor: idxA, isRoadSnapped: false };
  }

  // Tier 1 Ground-Truth Matcher: spatially matches same-direction TD detectors & TD cameras along a stop-to-stop polyline.
  function _extractSpeedLinkCoords(feat) {
    const raw = feat?.properties?.rawCoords;
    if (Array.isArray(raw) && raw.length >= 2) return raw;
    const geom = feat?.geometry?.coordinates;
    if (Array.isArray(geom) && geom.length >= 2) return geom;
    return null;
  }

  function _buildSpanSubSegs(segCoords) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    const subSegs = [];
    for (let i = 0; i < segCoords.length - 1; i++) {
      const a = segCoords[i], b = segCoords[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const aLat = Number(a[0]), aLon = Number(a[1]), bLat = Number(b[0]), bLon = Number(b[1]);
      if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) continue;
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
        midLat: (aLat + bLat) * 0.5,
        midLon: (aLon + bLon) * 0.5,
        brg: _bearingDegLocal(aLat, aLon, bLat, bLon)
      });
    }
    return { subSegs, minLat, maxLat, minLon, maxLon };
  }

  function _matchTdSpeedLinksForSubSegs(subSegs, minLat, maxLat, minLon, maxLon, tdSpeedGeoJson, maxDistKm = 0.10, maxAngDeg = 45) {
    const feats = Array.isArray(tdSpeedGeoJson)
      ? tdSpeedGeoJson
      : (Array.isArray(tdSpeedGeoJson?.features) ? tdSpeedGeoJson.features : []);
    if (!feats.length || !subSegs.length) return [];
    const padDeg = 0.004; // ~440m bbox prefilter
    const matches = [];

    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const p = f?.properties || {};
      if (p.hasSpeedData === false) continue;
      const spdRaw = p.spd ?? p.speedKmh;
      const spd = Number(spdRaw);
      if (spdRaw === null || spdRaw === undefined || !Number.isFinite(spd) || spd <= 0) continue;
      const rc = _extractSpeedLinkCoords(f);
      if (!rc || rc.length < 2) continue;

      let lMinLat = Infinity, lMaxLat = -Infinity, lMinLon = Infinity, lMaxLon = -Infinity;
      for (let k = 0; k < rc.length; k++) {
        const pt = rc[k];
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const la = Number(pt[1]), lo = Number(pt[0]);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
        if (la < lMinLat) lMinLat = la;
        if (la > lMaxLat) lMaxLat = la;
        if (lo < lMinLon) lMinLon = lo;
        if (lo > lMaxLon) lMaxLon = lo;
      }
      if (lMaxLat < minLat - padDeg || lMinLat > maxLat + padDeg || lMaxLon < minLon - padDeg || lMinLon > maxLon + padDeg) {
        continue;
      }

      let bestKm = Infinity;
      let matchedLink = false;
      for (let k = 0; k < rc.length - 1; k++) {
        const p1 = rc[k], p2 = rc[k + 1];
        if (!Array.isArray(p1) || !Array.isArray(p2)) continue;
        const la1 = Number(p1[1]), lo1 = Number(p1[0]);
        const la2 = Number(p2[1]), lo2 = Number(p2[0]);
        if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
        const segLenKm = _haversineKmLocal(la1, lo1, la2, lo2);
        const linkBrg = segLenKm >= 0.004
          ? _bearingDegLocal(la1, lo1, la2, lo2)
          : (Number.isFinite(Number(p.rot)) ? Number(p.rot) : null);
        const linkMidLat = (la1 + la2) * 0.5;
        const linkMidLon = (lo1 + lo2) * 0.5;

        for (let s = 0; s < subSegs.length; s++) {
          const ss = subSegs[s];
          if (linkBrg !== null && _angDiffLocal(linkBrg, ss.brg) > maxAngDeg) continue;
          const dMidToBus = _pointToSegKmLocal(linkMidLat, linkMidLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon).distKm;
          const dBusMidToLink = _pointToSegKmLocal(ss.midLat, ss.midLon, la1, lo1, la2, lo2).distKm;
          const dA = _pointToSegKmLocal(la1, lo1, ss.aLat, ss.aLon, ss.bLat, ss.bLon).distKm;
          const dB = _pointToSegKmLocal(la2, lo2, ss.aLat, ss.aLon, ss.bLat, ss.bLon).distKm;
          const dMin = Math.min(dMidToBus, dBusMidToLink, dA, dB);
          if (dMin < bestKm) {
            bestKm = dMin;
          }
          if (dMin <= maxDistKm) {
            matchedLink = true;
          }
        }
      }

      if (matchedLink && bestKm <= maxDistKm) {
        matches.push({
          feat: f,
          props: p,
          distKm: bestKm,
          spd: Math.abs(spd),
          occ: Math.abs(Number(p.occ) || 0),
          id: p.id || p.detectorId || '',
          roadEn: _sanitizeDirectionTypos(p.roadEn || p.roadTc || ''),
          roadTc: _sanitizeDirectionTypos(p.roadTc || p.roadEn || ''),
          tier: p.tier || '',
          camKey: p.camKey || '',
          rot: Number.isFinite(Number(p.rot)) ? Number(p.rot) : null
        });
      }
    }
    return matches;
  }

  const NLB_PRIORITY_CORRIDOR_ROUTES = new Set(['1', '2', '3M', '4', '11', '23', 'A35']);
  const HISTORIC_LOCAL_GONGLU_RE = /castle\s*peak\s*r(?:oa)?d|\bcpr\b|tdscpr|fan\s*kam\s*r(?:oa)?d|lam\s*kam\s*r(?:oa)?d|青山公路|粉錦公路|林錦公路|清水灣道/i;
  const EXPLICIT_EXPRESSWAY_RE = /tuen\s*mun\s*r(?:oa)?d|\btmr\b|yuen\s*long\s*hwy|\bylh\b|tsing\s*long|\btlh\b|tai\s*lam\s*tunnel|north\s*lantau|tolo|fanling\s*hwy|san\s*tin\s*hwy|屯門公路|元朗公路|青朗公路|大欖隧道|北大嶼山公路|吐露港公路|粉嶺公路|新田公路/i;
  const EXPRESSWAY_OR_TUNNEL_RE = /highway|expressway|bypass|tunnel|bridge|west\s*kowloon\s*corridor|island\s*eastern\s*corridor|trunk\s*road|tsing\s*ma|ting\s*kau|lantau\s*link|north\s*lantau|tuen\s*mun\s*r(?:oa)?d|\btmr\b|tolo|fanling|san\s*tin|yuen\s*long\s*hwy|\bylh\b|tsing\s*long|\btlh\b|kong\s*sham|penny'?s\s*bay|tsing\s*sha|west\s*kowloon|island\s*eastern|tseung\s*kwan\s*o|route\s*\d|公路|幹線|繞道|隧道|大橋|走廊|青馬|汀九|北大嶼山|吐露港|元朗公路|屯門公路|青朗/i;
  const DIVIDED_MAJOR_BOULEVARD_RE = /nathan\s*r(?:oa)?d|connaught\s*r(?:oa)?d|gloucester\s*r(?:oa)?d|chatham\s*r(?:oa)?d|kwun\s*tong\s*r(?:oa)?d|lung\s*cheung\s*r(?:oa)?d|ching\s*cheung\s*r(?:oa)?d|princess\s*margaret|waterloo\s*r(?:oa)?d|argyle\s*st(?:reet)?|prince\s*edward\s*r(?:oa)?d|cheung\s*sha\s*wan\s*r(?:oa)?d|lai\s*chi\s*kok\s*r(?:oa)?d|wong\s*chu\s*r(?:oa)?d|彌敦道|干諾道|告士打道|漆咸道|觀塘道|龍翔道|呈祥道|公主道|窩打老道|亞皆老街|太子道|長沙灣道|荔枝角道|皇珠路/i;
  const BBI_OR_HIGHWAY_STOP_RE = /tunnel|toll\s*plaza|\bbbi\b|highway|expressway|interchange|tsing\s*ma|lantau\s*link|轉車站|隧道|收費廣場|高速公路|元朗公路|屯門公路|青朗公路|北大嶼山公路|吐露港公路|粉嶺公路|新田公路/i;

  function _isExpresswayOrTunnelRoad(text = '', id = '') {
    const combined = `${id || ''} ${text || ''}`;
    if (!combined.trim()) return false;
    if (HISTORIC_LOCAL_GONGLU_RE.test(combined) && !EXPLICIT_EXPRESSWAY_RE.test(combined)) {
      return false;
    }
    return EXPRESSWAY_OR_TUNNEL_RE.test(combined);
  }

  function _isDividedMajorRoad(text = '', id = '') {
    const combined = `${id || ''} ${text || ''}`;
    if (!combined.trim()) return false;
    return _isExpresswayOrTunnelRoad(text, id) || DIVIDED_MAJOR_BOULEVARD_RE.test(combined);
  }

  function isUndividedUrbanRoad(roadEn = '', roadTc = '', id = '') {
    const txt = `${roadEn || ''} ${roadTc || ''}`.trim();
    if (!txt && !id) return false;
    return !_isDividedMajorRoad(txt, id);
  }

  const EN_TC_ROAD_SYNONYMS = [
    ['castle peak road', '青山公路'],
    ['tsing long highway', '青朗公路'],
    ['tuen mun road', '屯門公路'],
    ['yuen long highway', '元朗公路'],
    ['kam ho road', '錦河路'],
    ['pat heung road', '八鄉路'],
    ['hoi wing road', '海榮路'],
    ['siu lun street', '兆麟街'],
    ['ping ha road', '屏廈路'],
    ['pui to road', '杯渡路'],
    ['wong chu road', '皇珠路'],
    ['south lantau road', '嶼南道'],
    ['tung chung road', '東涌道'],
    ['north lantau highway', '北大嶼山公路'],
    ['shun long road', '順朗路'],
    ['yu tung road', '裕東路'],
    ['tai lam tunnel', '大欖隧道']
  ];

  function _normalizeEnRoadStem(raw) {
    let s = String(raw || '').toLowerCase();
    s = s.replace(/\([^)]*\)/g, ' ');
    s = s.split(/\s+near\s+|\s+opposite\s+|\s+opp\.?\s+|\s+outside\s+|\s+at\s+|\s*[-–—]\s*(?:northbound|southbound|eastbound|westbound|nb|sb|eb|wb|ping\s*shan|yuen\s*long|castle\s*peak\s*bay|sam\s*shing|hung\s*shui\s*kiu|lam\s*tei|san\s*hui|so\s*kwun\s*wat|ting\s*kau|tsuen\s*wan|kwai\s*chung|tam\s*mi|mai\s*po|san\s*tin|chau\s*tau|lingnan|tai\s*lam|s\.\s*l\.|section)/i)[0];
    s = s.replace(/\b(?:northbound|southbound|eastbound|westbound|nb|sb|eb|wb)\b/gi, ' ');
    s = s.replace(/\brd\.?\b/g, 'road')
      .replace(/\bst\.?\b/g, 'street')
      .replace(/\bhwy\.?\b/g, 'highway')
      .replace(/\bexpwy\.?\b/g, 'expressway')
      .replace(/\bave\.?\b/g, 'avenue')
      .replace(/\bblvd\.?\b/g, 'boulevard')
      .replace(/\bdr\.?\b/g, 'drive')
      .replace(/[^a-z0-9\s']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  function extractExplicitRoadStems(textEn = '', textTc = '') {
    const enStems = new Set();
    const tcStems = new Set();
    const enSrc = String(textEn || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(?:bus\s*terminus|terminus|b\/t|pti|interchange|playground|station|estate|court|garden|plaza|centre|center|hospital|village|tsuen|pier|market|school|park|block\s*\d+)\b/gi, ', ');

    const enParts = enSrc.split(/[,;/|→]+/);
    const roadTypeRe = /([a-z][a-z'\s]{1,36}?\b(?:road|rd\.?|street|st\.?|highway|hwy\.?|expressway|expwy\.?|bypass|tunnel|bridge|corridor|avenue|ave\.?|drive|dr\.?|lane|way|boulevard|blvd\.?|praya|circuit|terrace|path))/gi;
    for (let i = 0; i < enParts.length; i++) {
      const part = enParts[i].trim();
      if (!part) continue;
      let m;
      roadTypeRe.lastIndex = 0;
      while ((m = roadTypeRe.exec(part)) !== null) {
        const stem = _normalizeEnRoadStem(m[1]);
        if (stem && stem.length >= 5 && !/^(?:the|new|old|main|bus|local|corridor|road|street|highway)$/i.test(stem)) {
          enStems.add(stem);
        }
      }
    }

    const tcSrc = String(textTc || '').replace(/[（(][^）)]*[）)]/g, ' ');
    const tcRe = /([\u4e00-\u9fa5]{2,10}?(?:公路|大道|幹線|繞道|隧道|大橋|走廊|馬路|道|路|街))/g;
    let tm;
    while ((tm = tcRe.exec(tcSrc)) !== null) {
      const tcStem = tm[1].replace(/[－\-–—].*$/, '').trim();
      if (tcStem.length >= 3) tcStems.add(tcStem);
    }

    // Add cross-language synonyms so EN-only stop names match TC detectors and vice versa
    for (let i = 0; i < EN_TC_ROAD_SYNONYMS.length; i++) {
      const [enK, tcK] = EN_TC_ROAD_SYNONYMS[i];
      for (const s of enStems) {
        if (s === enK || s.includes(enK) || enK.includes(s)) tcStems.add(tcK);
      }
      for (const s of tcStems) {
        if (s === tcK || s.includes(tcK) || tcK.includes(s)) enStems.add(enK);
      }
    }

    return { en: Array.from(enStems), tc: Array.from(tcStems) };
  }

  function areRoadNamesCompatible(spanTextEn = '', spanTextTc = '', detRoadEn = '', detRoadTc = '', opts = {}) {
    // On genuine long highway/BBI spans (> 1.25 km), intermediate trunk roads (e.g. Wong Chu Rd, TM-CLK Link,
    // Tuen Mun Rd) connect endpoints — allow unless both stops explicitly name the same non-highway local road.
    if (opts.isHighwaySpan && !opts.bothStopsSameLocalRoad) {
      return true;
    }
    const spanStems = extractExplicitRoadStems(spanTextEn, spanTextTc);
    const detStems = extractExplicitRoadStems(detRoadEn, detRoadTc);
    const spanHasRoad = spanStems.en.length > 0 || spanStems.tc.length > 0;
    const detHasRoad = detStems.en.length > 0 || detStems.tc.length > 0;
    if (!spanHasRoad || !detHasRoad) return true;

    for (let i = 0; i < spanStems.en.length; i++) {
      const a = spanStems.en[i];
      for (let j = 0; j < detStems.en.length; j++) {
        const b = detStems.en[j];
        if (a === b || a.includes(b) || b.includes(a)) return true;
      }
    }
    for (let i = 0; i < spanStems.tc.length; i++) {
      const a = spanStems.tc[i];
      for (let j = 0; j < detStems.tc.length; j++) {
        const b = detStems.tc[j];
        if (a === b || a.includes(b) || b.includes(a)) return true;
      }
    }
    return false;
  }

  function _ensureBusSpeedDebugState() {
    if (!globalScope.__BUS_SPEED_DEBUG__ || typeof globalScope.__BUS_SPEED_DEBUG__ !== 'object') {
      globalScope.__BUS_SPEED_DEBUG__ = {
        updatedAt: '',
        zoom: null,
        bounds: null,
        trafficEnabled: false,
        selectedRoutes: [],
        computedSegments: [],
        renderedCorridors: [],
        routeDiagnostics: {},
        skipReasons: [],
        skipReasonCounts: {},
        viewportCounts: {
          activeTdSegments: 0,
          activeBusApiSegments: 0,
          activeBusApiMicroSteps: 0,
          suppressedByTdMicroSteps: 0
        }
      };
    }
    return globalScope.__BUS_SPEED_DEBUG__;
  }

  function _recordDebugSkip(list, entry) {
    if (!Array.isArray(list) || !entry) return;
    if (list.length < 400) list.push(entry);
  }

  function _tallySkipReasons(skipList) {
    const counts = {};
    if (!Array.isArray(skipList)) return counts;
    for (let i = 0; i < skipList.length; i++) {
      const r = skipList[i]?.reason;
      if (!r) continue;
      counts[r] = (counts[r] || 0) + 1;
    }
    return counts;
  }

  function _extractBoundsBox(bounds) {
    if (!bounds) return null;
    if (typeof bounds.getSouth === 'function' && typeof bounds.getNorth === 'function' &&
        typeof bounds.getWest === 'function' && typeof bounds.getEast === 'function') {
      const south = Number(bounds.getSouth());
      const north = Number(bounds.getNorth());
      const west = Number(bounds.getWest());
      const east = Number(bounds.getEast());
      if (Number.isFinite(south) && Number.isFinite(north) && Number.isFinite(west) && Number.isFinite(east)) {
        return { south, west, north, east };
      }
    }
    if (Number.isFinite(Number(bounds.south)) && Number.isFinite(Number(bounds.north)) &&
        Number.isFinite(Number(bounds.west)) && Number.isFinite(Number(bounds.east))) {
      return {
        south: Number(bounds.south),
        west: Number(bounds.west),
        north: Number(bounds.north),
        east: Number(bounds.east)
      };
    }
    return null;
  }

  function _padBoundsBox(box, padFrac = 0.2) {
    if (!box) return null;
    const dLat = Math.max(0.002, (box.north - box.south) * padFrac);
    const dLon = Math.max(0.002, (box.east - box.west) * padFrac);
    return {
      south: box.south - dLat,
      north: box.north + dLat,
      west: box.west - dLon,
      east: box.east + dLon
    };
  }

  // Exact Liang-Barsky segment-vs-box intersection so zoomed-in z14-16 viewports
  // NEVER drop corridors whose stop endpoints extend outside the viewport box!
  function _segmentIntersectsBounds(la1, lo1, la2, lo2, bounds) {
    if (!bounds) return true;
    const box = _extractBoundsBox(bounds);
    if (box) {
      // Quick inside check
      if (la1 >= box.south && la1 <= box.north && lo1 >= box.west && lo1 <= box.east) return true;
      if (la2 >= box.south && la2 <= box.north && lo2 >= box.west && lo2 <= box.east) return true;
      // Quick bbox reject
      if (Math.max(la1, la2) < box.south || Math.min(la1, la2) > box.north) return false;
      if (Math.max(lo1, lo2) < box.west || Math.min(lo1, lo2) > box.east) return false;
      // Liang-Barsky
      const dx = lo2 - lo1;
      const dy = la2 - la1;
      const p = [-dx, dx, -dy, dy];
      const q = [lo1 - box.west, box.east - lo1, la1 - box.south, box.north - la1];
      let t0 = 0, t1 = 1;
      for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-12) {
          if (q[i] < 0) return false;
        } else {
          const r = q[i] / p[i];
          if (p[i] < 0) {
            if (r > t1) return false;
            if (r > t0) t0 = r;
          } else {
            if (r < t0) return false;
            if (r < t1) t1 = r;
          }
        }
      }
      return t0 <= t1;
    }
    if (typeof bounds.contains === 'function') {
      if (bounds.contains([la1, lo1]) || bounds.contains([la2, lo2])) return true;
      for (let k = 1; k <= 7; k++) {
        const f = k / 8;
        if (bounds.contains([la1 + (la2 - la1) * f, lo1 + (lo2 - lo1) * f])) return true;
      }
      return false;
    }
    return true;
  }

  function _polylineIntersectsBounds(coords, bounds, isGeoJsonLonLat = false) {
    if (!Array.isArray(coords) || coords.length < 2) return false;
    if (!bounds) return true;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const la1 = isGeoJsonLonLat ? Number(a[1]) : Number(a[0]);
      const lo1 = isGeoJsonLonLat ? Number(a[0]) : Number(a[1]);
      const la2 = isGeoJsonLonLat ? Number(b[1]) : Number(b[0]);
      const lo2 = isGeoJsonLonLat ? Number(b[0]) : Number(b[1]);
      if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
      if (_segmentIntersectsBounds(la1, lo1, la2, lo2, bounds)) return true;
    }
    return false;
  }

  // Subdivide any polyline into ~40–60 m micro-steps preserving all road bends (never cutting corners).
  // When opts.maxRawHopM > 0 (e.g. 120 m), splits/rejects raw vertex-to-vertex hops exceeding maxRawHopM
  // that lack intermediate road shape points so straight chords never cut across buildings, rivers, or bus bays.
  function subdividePolylineMicroSteps(coords, targetStepM = 50, opts = {}) {
    if (!Array.isArray(coords) || coords.length < 2) return [];
    const stepM = Math.max(40, Math.min(60, Number(targetStepM) || 50));
    const maxRawHopM = Number(opts?.maxRawHopM) > 0 ? Number(opts.maxRawHopM) : 0;
    const microSteps = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      if (!Array.isArray(a) || !Array.isArray(b)) continue;
      const la1 = Number(a[0]), lo1 = Number(a[1]), la2 = Number(b[0]), lo2 = Number(b[1]);
      if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
      const lenM = _haversineKmLocal(la1, lo1, la2, lo2) * 1000;
      if (lenM < 2) continue;
      if (maxRawHopM > 0 && lenM > maxRawHopM) {
        continue; // Reject straight shortcut hop lacking intermediate road shape points
      }
      const count = lenM > stepM ? Math.ceil(lenM / stepM) : 1;
      const brg = _bearingDegLocal(la1, lo1, la2, lo2);
      const pieceM = lenM / count;
      for (let s = 0; s < count; s++) {
        const f0 = s / count;
        const f1 = (s + 1) / count;
        const pLat1 = la1 + (la2 - la1) * f0;
        const pLon1 = lo1 + (lo2 - lo1) * f0;
        const pLat2 = la1 + (la2 - la1) * f1;
        const pLon2 = lo1 + (lo2 - lo1) * f1;
        microSteps.push({
          a: [pLat1, pLon1],
          b: [pLat2, pLon2],
          midLat: (pLat1 + pLat2) * 0.5,
          midLon: (pLon1 + pLon2) * 0.5,
          lenM: pieceM,
          brg
        });
      }
    }
    return microSteps;
  }

  // Spatial hash (~150 m cells) of RENDERED TD Speed Map GeoJSON links and rendered TD detector polylines
  // for O(1) Point-to-Segment TD suppression on micro-steps.
  // Never suppresses Bus-API based on an unrendered camera/detector point alone unless opts.includeUnrenderedDetectors is explicitly true.
  function buildTdSpatialIndex(tdDetectors = [], tdSpeedGeoJson = null, opts = {}) {
    const CELL_LAT = 740; // ~150m
    const CELL_LON = 690; // ~150m
    const linkBuckets = new Map();
    const detBuckets = new Map();
    let linkEdgeCount = 0;
    let detectorCount = 0;

    const addBucketItem = (map, lat, lon, item) => {
      const k = `${Math.floor(lat * CELL_LAT)}_${Math.floor(lon * CELL_LON)}`;
      let arr = map.get(k);
      if (!arr) {
        arr = [];
        map.set(k, arr);
      }
      arr.push(item);
    };

    const includeUnrenderedDetectors = Boolean(opts?.includeUnrenderedDetectors);
    if (includeUnrenderedDetectors) {
      const detList = Array.isArray(tdDetectors)
        ? tdDetectors
        : (Array.isArray(globalScope.__LIVE_TRAFFIC_DETECTORS__) ? globalScope.__LIVE_TRAFFIC_DETECTORS__ : []);
      for (let i = 0; i < detList.length; i++) {
        const d = detList[i];
        if (!d) continue;
        const dLat = Number(d.lat), dLon = Number(d.lon), spd = Number(d.spd);
        if (!Number.isFinite(dLat) || !Number.isFinite(dLon) || !Number.isFinite(spd) || spd <= 0) continue;
        const rot = Number.isFinite(Number(d.rot)) ? ((Number(d.rot) % 360) + 360) % 360 : null;
        const isUndiv = isUndividedUrbanRoad(d.roadEn || '', d.roadTc || '', d.id || '');
        addBucketItem(detBuckets, dLat, dLon, {
          lat: dLat,
          lon: dLon,
          rot,
          spd,
          id: d.id || '',
          roadEn: _sanitizeDirectionTypos(d.roadEn || ''),
          roadTc: d.roadTc || '',
          isUndividedUrban: isUndiv
        });
        detectorCount++;
      }
    }

    const feats = Array.isArray(tdSpeedGeoJson)
      ? tdSpeedGeoJson
      : (Array.isArray(tdSpeedGeoJson?.features) ? tdSpeedGeoJson.features : []);
    for (let i = 0; i < feats.length; i++) {
      const f = feats[i];
      const p = f?.properties || {};
      if (p.hasSpeedData === false) continue;
      const spdRaw = p.spd ?? p.speedKmh;
      const spd = Number(spdRaw);
      // Guard against null / stale / <= 0 speeds so unmonitored or stale viaduct links never paint or suppress ground roads
      if (spdRaw === null || spdRaw === undefined || !Number.isFinite(spd) || spd <= 0) continue;

      const isUndiv = isUndividedUrbanRoad(p.roadEn || '', p.roadTc || '', p.id || p.detectorId || '');
      const coordSets = [];
      if (Array.isArray(p.rawCoords) && p.rawCoords.length >= 2) coordSets.push(p.rawCoords);
      if (Array.isArray(f?.geometry?.coordinates) && f.geometry.coordinates.length >= 2 && f.geometry.coordinates !== p.rawCoords) {
        coordSets.push(f.geometry.coordinates);
      }

      for (let cs = 0; cs < coordSets.length; cs++) {
        const rc = coordSets[cs];
        for (let k = 0; k < rc.length - 1; k++) {
          const p1 = rc[k], p2 = rc[k + 1];
          if (!Array.isArray(p1) || !Array.isArray(p2)) continue;
          const la1 = Number(p1[1]), lo1 = Number(p1[0]);
          const la2 = Number(p2[1]), lo2 = Number(p2[0]);
          if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
          const segKm = _haversineKmLocal(la1, lo1, la2, lo2);
          const brg = segKm >= 0.004
            ? _bearingDegLocal(la1, lo1, la2, lo2)
            : (Number.isFinite(Number(p.rot)) ? ((Number(p.rot) % 360) + 360) % 360 : null);
          const edge = {
            la1, lo1, la2, lo2,
            midLat: (la1 + la2) * 0.5,
            midLon: (lo1 + lo2) * 0.5,
            brg,
            spd,
            id: p.id || p.detectorId || '',
            roadEn: _sanitizeDirectionTypos(p.roadEn || ''),
            roadTc: p.roadTc || '',
            isUndividedUrban: isUndiv,
            isViaductOrLink: /\bhzmb\b|hong\s*kong\s*link\s*r(?:oa)?d|viaduct|flyover|skyway|bridge|港珠澳大橋|香港連接路|高架|天橋|大橋/i.test(`${p.roadEn || ''} ${p.roadTc || ''}`)
          };
          const cLatMin = Math.floor(Math.min(la1, la2) * CELL_LAT);
          const cLatMax = Math.floor(Math.max(la1, la2) * CELL_LAT);
          const cLonMin = Math.floor(Math.min(lo1, lo2) * CELL_LON);
          const cLonMax = Math.floor(Math.max(lo1, lo2) * CELL_LON);
          for (let cl = cLatMin; cl <= cLatMax; cl++) {
            for (let co = cLonMin; co <= cLonMax; co++) {
              const bk = `${cl}_${co}`;
              let arr = linkBuckets.get(bk);
              if (!arr) {
                arr = [];
                linkBuckets.set(bk, arr);
              }
              arr.push(edge);
            }
          }
          linkEdgeCount++;
        }
      }
    }

    return {
      CELL_LAT,
      CELL_LON,
      linkBuckets,
      detBuckets,
      linkEdgeCount,
      detectorCount,
      hasAny: linkEdgeCount > 0 || detectorCount > 0
    };
  }

  // Point-to-Segment TD Suppression: returns true ONLY if a ~40–60 m BUS_API micro-step falls within
  // maxDistKm (default 100 m) of an actual RENDERED TD Speed Map GeoJSON link or rendered TD detector polyline
  // matching bearing within ±45° (or either direction on undivided urban roads) AND road-name compatible (blocking viaduct bleed).
  function isMicroStepCoveredByTd(step, tdIndex, opts = {}) {
    if (!step || !tdIndex || !tdIndex.hasAny) return false;
    const maxDistKm = Number(opts.maxDistKm) || 0.10; // 100 m
    const maxAngDeg = Number(opts.maxAngDeg) || 45;   // ±45°
    const allowUndividedOpp = opts.allowUndividedOpposite !== false;
    const stepRoadEn = String(opts.stepRoadEn || step.roadEn || '');
    const stepRoadTc = String(opts.stepRoadTc || step.roadTc || '');
    const stepIsAirportGround = isAirportPerimeterZone(null, null, `${stepRoadEn} ${stepRoadTc}`);

    const cLat = Math.floor(step.midLat * tdIndex.CELL_LAT);
    const cLon = Math.floor(step.midLon * tdIndex.CELL_LON);

    const bearingMatches = (tdBrg, isUndiv) => {
      if (tdBrg === null || tdBrg === undefined || !Number.isFinite(Number(tdBrg))) return true;
      const diff = _angDiffLocal(step.brg, Number(tdBrg));
      if (diff <= maxAngDeg) return true;
      if (allowUndividedOpp && isUndiv && diff >= (180 - maxAngDeg)) return true;
      return false;
    };

    const roadCompatible = (tdRoadEn, tdRoadTc, isViaduct) => {
      // Never let elevated viaducts (e.g. HZMB Hong Kong Link Road) suppress parallel ground roads (e.g. South Perimeter Rd)
      if (isViaduct && stepIsAirportGround) return false;
      if (!stepRoadEn && !stepRoadTc) return true;
      if (!tdRoadEn && !tdRoadTc) return true;
      return areRoadNamesCompatible(stepRoadEn, stepRoadTc, tdRoadEn, tdRoadTc, { isHighwaySpan: false });
    };

    for (let dl = -1; dl <= 1; dl++) {
      for (let dox = -1; dox <= 1; dox++) {
        const bk = `${cLat + dl}_${cLon + dox}`;

        const dets = tdIndex.detBuckets.get(bk);
        if (dets) {
          for (let i = 0; i < dets.length; i++) {
            const d = dets[i];
            if (!bearingMatches(d.rot, d.isUndividedUrban)) continue;
            if (!roadCompatible(d.roadEn, d.roadTc, false)) continue;
            const proj = _pointToSegKmLocal(d.lat, d.lon, step.a[0], step.a[1], step.b[0], step.b[1]);
            if (proj.distKm <= maxDistKm) return true;
          }
        }

        const edges = tdIndex.linkBuckets.get(bk);
        if (edges) {
          for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (!bearingMatches(e.brg, e.isUndividedUrban)) continue;
            if (!roadCompatible(e.roadEn, e.roadTc, e.isViaductOrLink)) continue;
            const dMid = _pointToSegKmLocal(step.midLat, step.midLon, e.la1, e.lo1, e.la2, e.lo2).distKm;
            if (dMid <= maxDistKm) return true;
            const dA = _pointToSegKmLocal(step.a[0], step.a[1], e.la1, e.lo1, e.la2, e.lo2).distKm;
            if (dA <= maxDistKm) return true;
            const dB = _pointToSegKmLocal(step.b[0], step.b[1], e.la1, e.lo1, e.la2, e.lo2).distKm;
            if (dB <= maxDistKm) return true;
            const dEMid = _pointToSegKmLocal(e.midLat, e.midLon, step.a[0], step.a[1], step.b[0], step.b[1]).distKm;
            if (dEMid <= maxDistKm) return true;
          }
        }
      }
    }
    return false;
  }

  function _medianNumber(arr) {
    if (!Array.isArray(arr) || !arr.length) return NaN;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return (sorted.length % 2 === 1) ? sorted[mid] : ((sorted[mid - 1] + sorted[mid]) * 0.5);
  }

  // Directional Road-Cell Occupancy Grid (~60 m spatial cells + 45° bearing buckets):
  // - Subdivides every BUS_API polyline into ~40–60 m micro-steps
  // - Applies Point-to-Segment TD Suppression (100 m, ±45° or either direction on undivided urban roads)
  // - Preserves HK keep-left opposite carriageways while merging same-direction overlapping routes
  // - Aggregates overlapping routes per cell/direction via median speed + >= 2 consecutive slow spans Red gate
  // - Emits ONE clean continuous polyline per directional road stretch (zero brown/stacked multi-color lines)
  function aggregateBusMicroStepsToCorridors(segments, tdDetectors = [], tdSpeedGeoJson = null, opts = {}) {
    const emptyOut = {
      corridors: [],
      stats: {
        totalMicroSteps: 0,
        suppressedByTdMicroSteps: 0,
        outsideViewportMicroSteps: 0,
        survivingMicroSteps: 0,
        occupiedCells: 0,
        mergedDuplicateMicroSteps: 0,
        renderedCorridors: 0
      },
      skipReasons: []
    };
    if (!Array.isArray(segments) || !segments.length) return emptyOut;

    const targetStepM = Math.max(40, Math.min(60, Number(opts.targetStepM) || 50));
    const tdMaxDistKm = Number(opts.tdMaxDistKm) || 0.10;
    const tdMaxAngDeg = Number(opts.tdMaxAngDeg) || 45;
    const allowUndividedOpposite = opts.allowUndividedOpposite !== false;
    const allowNlbScheduledFallback = opts.allowNlbScheduledFallback !== false;
    const bounds = opts.bounds || null;
    const paddedBox = bounds ? _padBoundsBox(_extractBoundsBox(bounds), Number(opts.boundsPadFrac) || 0.25) : null;
    const clipBounds = paddedBox || bounds;

    const tdIndex = opts.tdIndex || buildTdSpatialIndex(tdDetectors, tdSpeedGeoJson, {
      includeUnrenderedDetectors: Boolean(opts.includeUnrenderedDetectors)
    });

    // ~60 m spatial grid at HK latitude (~22.3° N) + 45° bearing octant (0..7),
    // folding opposite bearings (oct % 4) on narrow two-way local roads so they emit ONE centered line.
    const OCC_LAT_SCALE = 1850; // ~59.8 m
    const OCC_LON_SCALE = 1720; // ~59.9 m
    const cellKeyOf = (lat, lon, brg, centeredTwoWay = false) => {
      const rawOct = Math.round((((brg % 360) + 360) % 360) / 45) % 8;
      const oct = centeredTwoWay ? (rawOct % 4) : rawOct;
      return `${Math.round(lat * OCC_LAT_SCALE)}_${Math.round(lon * OCC_LON_SCALE)}_${centeredTwoWay ? 'C' : 'D'}${oct}`;
    };

    const cellBuckets = new Map();
    const stagedRoutes = [];
    const skipReasons = [];
    let totalMicroSteps = 0;
    let suppressedByTdMicroSteps = 0;
    let outsideViewportMicroSteps = 0;
    let survivingMicroSteps = 0;

    // Prioritize live road-snapped segments first so canonical geometry comes from the highest-fidelity route
    const orderedSegs = segments
      .filter((seg) => seg && Array.isArray(seg.coords) && seg.coords.length >= 2)
      .slice()
      .sort((a, b) => {
        const aSched = a.isScheduledFallback || a.isScheduledOnly ? 1 : 0;
        const bSched = b.isScheduledFallback || b.isScheduledOnly ? 1 : 0;
        if (aSched !== bSched) return aSched - bSched;
        const aSnap = a.isRoadSnapped ? 0 : 1;
        const bSnap = b.isRoadSnapped ? 0 : 1;
        return aSnap - bSnap;
      });

    for (let sIdx = 0; sIdx < orderedSegs.length; sIdx++) {
      const seg = orderedSegs[sIdx];
      const isSchedFb = Boolean(seg.isScheduledFallback);
      if (seg.isScheduledOnly && !(allowNlbScheduledFallback && isSchedFb)) {
        _recordDebugSkip(skipReasons, {
          scope: 'span',
          routeNo: seg.routeNo || '',
          company: seg.company || '',
          fromSeq: seg.fromSeq || null,
          toSeq: seg.toSeq || null,
          reason: 'scheduled_only'
        });
        continue;
      }
      if (seg.coveredByTd || seg.tdCovered || seg.source === 'TD') {
        _recordDebugSkip(skipReasons, {
          scope: 'span',
          routeNo: seg.routeNo || '',
          company: seg.company || '',
          fromSeq: seg.fromSeq || null,
          toSeq: seg.toSeq || null,
          reason: 'covered_by_td'
        });
        continue;
      }
      // Strictly reject unsnapped straight chords > 120 m lacking intermediate road shape points
      if (!seg.isRoadSnapped && seg.coords.length === 2) {
        const chordKm = _haversineKmLocal(seg.coords[0][0], seg.coords[0][1], seg.coords[1][0], seg.coords[1][1]);
        if (chordKm > 0.25) {
          _recordDebugSkip(skipReasons, {
            scope: 'span',
            routeNo: seg.routeNo || '',
            company: seg.company || '',
            fromSeq: seg.fromSeq || null,
            toSeq: seg.toSeq || null,
            reason: 'no_road_geometry'
          });
          continue;
        }
      }

      const rawHopCapM = Number(opts.maxRawHopM) > 0
        ? Number(opts.maxRawHopM)
        : ((!seg.isRoadSnapped || seg.coords.length >= 3) ? 250 : 0);
      const microSteps = subdividePolylineMicroSteps(
        seg.coords,
        targetStepM,
        rawHopCapM > 0 ? { maxRawHopM: rawHopCapM } : {}
      );
      if (!microSteps.length) {
        _recordDebugSkip(skipReasons, {
          scope: 'span',
          routeNo: seg.routeNo || '',
          company: seg.company || '',
          fromSeq: seg.fromSeq || null,
          toSeq: seg.toSeq || null,
          reason: 'no_road_geometry'
        });
        continue;
      }

      const segRoadEn = [seg.roadEn, seg.fromNameEn, seg.toNameEn].filter(Boolean).join(' ');
      const segRoadTc = [seg.roadTc, seg.fromNameTc, seg.toNameTc].filter(Boolean).join(' ');
      const isCenteredTwoWay = Boolean(seg.isCenteredTwoWay || isNarrowTwoWayLocalRoad(segRoadEn, segRoadTc));
      const isAirportPerimeter = Boolean(
        seg.roadClass === 'AIRPORT_PERIMETER' ||
        isAirportPerimeterZone({ stopName_e: segRoadEn, name_tc: segRoadTc }, null)
      );

      const spd = Math.abs(Number(seg.speedKmh));
      const effSpd = Number.isFinite(spd) && spd > 0 ? spd : 26;
      const smoothMin = isAirportPerimeter ? Math.min(Number(seg.smoothMinKmh) || 20, 20) : (Number(seg.smoothMinKmh) || 17);
      const modMin = isAirportPerimeter ? Math.min(Number(seg.moderateMinKmh) || 8, 8) : (Number(seg.moderateMinKmh) || 10.5);
      const expKmh = isAirportPerimeter ? 34 : (Number(seg.expectedKmh) || 26);
      const rawTier = normalizeTrafficTier(seg.tier, effSpd);
      const allowRed = Boolean(
        !isSchedFb &&
        !seg.isScheduledOnly &&
        !seg.isTerminusApproach &&
        !seg.isOriginLayover &&
        rawTier === 'CONGESTED' &&
        seg.allowRed !== false &&
        (!isAirportPerimeter || effSpd < 8)
      );
      const routeTag = seg.routeLabel || `${seg.company || ''} ${seg.routeNo || ''}`.trim();
      const keptSteps = [];
      let segTdDropped = 0;
      let segViewportDropped = 0;

      for (let m = 0; m < microSteps.length; m++) {
        const st = microSteps[m];
        totalMicroSteps++;

        if (clipBounds && !_segmentIntersectsBounds(st.a[0], st.a[1], st.b[0], st.b[1], clipBounds)) {
          outsideViewportMicroSteps++;
          segViewportDropped++;
          continue;
        }

        if (tdIndex.hasAny && isMicroStepCoveredByTd(st, tdIndex, {
          maxDistKm: tdMaxDistKm,
          maxAngDeg: tdMaxAngDeg,
          allowUndividedOpposite,
          stepRoadEn: segRoadEn,
          stepRoadTc: segRoadTc
        })) {
          suppressedByTdMicroSteps++;
          segTdDropped++;
          continue;
        }

        const cKey = cellKeyOf(st.midLat, st.midLon, st.brg, isCenteredTwoWay);
        let bucket = cellBuckets.get(cKey);
        if (!bucket) {
          bucket = {
            cellKey: cKey,
            liveSpeeds: [],
            schedSpeeds: [],
            smoothMins: [],
            modMins: [],
            expectedKmhs: [],
            allowRedCount: 0,
            liveCount: 0,
            routes: new Set(),
            hasSlowLive: false,
            isCenteredTwoWay,
            isAirportPerimeter
          };
          cellBuckets.set(cKey, bucket);
        } else {
          if (isCenteredTwoWay) bucket.isCenteredTwoWay = true;
          if (isAirportPerimeter) bucket.isAirportPerimeter = true;
        }

        if (isSchedFb || seg.isScheduledOnly) {
          bucket.schedSpeeds.push(effSpd);
        } else {
          bucket.liveSpeeds.push(effSpd);
          bucket.liveCount++;
          if (rawTier === 'CONGESTED' || rawTier === 'MODERATE') bucket.hasSlowLive = true;
          if (allowRed) bucket.allowRedCount++;
        }
        bucket.smoothMins.push(smoothMin);
        bucket.modMins.push(modMin);
        bucket.expectedKmhs.push(expKmh);
        if (routeTag) bucket.routes.add(routeTag);

        keptSteps.push({
          ...st,
          cellKey: cKey,
          isCenteredTwoWay
        });
        survivingMicroSteps++;
      }

      if (segTdDropped > 0 && keptSteps.length === 0) {
        _recordDebugSkip(skipReasons, {
          scope: 'span',
          routeNo: seg.routeNo || '',
          company: seg.company || '',
          fromSeq: seg.fromSeq || null,
          toSeq: seg.toSeq || null,
          reason: 'covered_by_td',
          detail: `${segTdDropped} micro-steps suppressed by TD`
        });
      } else if (segViewportDropped > 0 && keptSteps.length === 0) {
        _recordDebugSkip(skipReasons, {
          scope: 'span',
          routeNo: seg.routeNo || '',
          company: seg.company || '',
          fromSeq: seg.fromSeq || null,
          toSeq: seg.toSeq || null,
          reason: 'outside_viewport'
        });
      }

      if (keptSteps.length) {
        stagedRoutes.push({ seg, routeTag, isSchedFb, isCenteredTwoWay, keptSteps });
      }
    }

    // Resolve each directional occupancy cell to ONE consensus speed & tier
    const resolvedCells = new Map();
    cellBuckets.forEach((b, key) => {
      const hasLive = b.liveSpeeds.length > 0;
      const speeds = hasLive ? b.liveSpeeds : b.schedSpeeds;
      const medSpd = Math.abs(Number(_medianNumber(speeds).toFixed(1)));
      const medSmooth = b.isAirportPerimeter ? 20 : (_medianNumber(b.smoothMins) || 17);
      const medMod = b.isAirportPerimeter ? 8 : (_medianNumber(b.modMins) || 10.5);
      const medExp = b.isAirportPerimeter ? 34 : (_medianNumber(b.expectedKmhs) || 26);
      const ratio = medSpd / Math.max(15, medExp);

      let tier = 'SMOOTH';
      if (b.isAirportPerimeter) {
        // Airport perimeter / cargo service roads: 20–35+ km/h is Flowing Green; Red ONLY if < 8 km/h with allowRed
        if (medSpd < 8) {
          tier = (hasLive && b.allowRedCount > 0) ? 'CONGESTED' : 'MODERATE';
        } else if (medSpd < 20) {
          tier = 'MODERATE';
        } else {
          tier = 'SMOOTH';
        }
      } else if (medSpd >= 40) {
        tier = 'SMOOTH';
      } else if (medSpd < medMod || ratio < 0.44) {
        tier = (hasLive && b.allowRedCount > 0) ? 'CONGESTED' : 'MODERATE';
      } else if (medSpd < medSmooth || ratio < 0.72) {
        tier = 'MODERATE';
      }
      // Scheduled/headway fallback is strictly Green/Yellow only — NEVER Red!
      if (!hasLive && tier === 'CONGESTED') {
        tier = 'MODERATE';
      }

      resolvedCells.set(key, {
        speedKmh: Math.abs(Math.round(medSpd)),
        tier,
        color: getBusSpeedColorHex(tier, medSpd),
        routeCount: Math.max(1, b.routes.size),
        routes: Array.from(b.routes),
        isScheduledFallback: !hasLive,
        isCenteredTwoWay: Boolean(b.isCenteredTwoWay)
      });
    });

    // Emit ONE single canonical geometry per directional occupancy cell and chain contiguous same-color micro-steps.
    // On narrow two-way local roads, opposite directions (0° vs 180°) also merge into ONE single centered corridor line.
    const claimedCells = new Map();
    const claimedStepSpatial = new Map(); // guard against slight 10-25m road-geometry jitter across cell seams
    const corridors = [];
    let mergedDuplicateMicroSteps = 0;

    const isNearAlreadyEmitted = (st, ownerSegIdx, centeredTwoWay = false) => {
      const gl = Math.floor(st.midLat * OCC_LAT_SCALE);
      const go = Math.floor(st.midLon * OCC_LON_SCALE);
      for (let dl = -1; dl <= 1; dl++) {
        for (let dox = -1; dox <= 1; dox++) {
          const arr = claimedStepSpatial.get(`${gl + dl}_${go + dox}`);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const ex = arr[i];
            if (ex.ownerSegIdx === ownerSegIdx) continue;
            const ang = _angDiffLocal(st.brg, ex.brg);
            const mergeOpp = Boolean(centeredTwoWay || ex.isCenteredTwoWay);
            if (ang > 35 && !(mergeOpp && ang >= 145)) continue;
            const dKm = _pointToSegKmLocal(st.midLat, st.midLon, ex.a[0], ex.a[1], ex.b[0], ex.b[1]).distKm;
            if (dKm <= (mergeOpp ? 0.028 : 0.022)) return true;
          }
        }
      }
      return false;
    };

    const recordEmittedStep = (st, ownerSegIdx, centeredTwoWay = false) => {
      const k = `${Math.floor(st.midLat * OCC_LAT_SCALE)}_${Math.floor(st.midLon * OCC_LON_SCALE)}`;
      let arr = claimedStepSpatial.get(k);
      if (!arr) {
        arr = [];
        claimedStepSpatial.set(k, arr);
      }
      arr.push({ a: st.a, b: st.b, brg: st.brg, ownerSegIdx, isCenteredTwoWay: Boolean(centeredTwoWay) });
    };

    for (let r = 0; r < stagedRoutes.length; r++) {
      const { seg, routeTag, isCenteredTwoWay, keptSteps } = stagedRoutes[r];
      let activeChain = null;

      const flushChain = () => {
        if (activeChain && activeChain.coords.length >= 2) {
          corridors.push(activeChain);
        }
        activeChain = null;
      };

      for (let m = 0; m < keptSteps.length; m++) {
        const st = keptSteps[m];
        const cellInfo = resolvedCells.get(st.cellKey);
        if (!cellInfo) {
          flushChain();
          continue;
        }
        const existingOwner = claimedCells.get(st.cellKey);
        if ((existingOwner !== undefined && existingOwner !== r) || isNearAlreadyEmitted(st, r, isCenteredTwoWay || cellInfo.isCenteredTwoWay)) {
          mergedDuplicateMicroSteps++;
          flushChain();
          continue;
        }
        if (existingOwner === undefined) {
          claimedCells.set(st.cellKey, r);
        }
        recordEmittedStep(st, r, isCenteredTwoWay || cellInfo.isCenteredTwoWay);

        const canAppend = Boolean(
          activeChain &&
          activeChain.tier === cellInfo.tier &&
          activeChain.color === cellInfo.color &&
          activeChain.isScheduledFallback === cellInfo.isScheduledFallback &&
          activeChain.isCenteredTwoWay === Boolean(isCenteredTwoWay || cellInfo.isCenteredTwoWay) &&
          _haversineKmLocal(
            activeChain.coords[activeChain.coords.length - 1][0],
            activeChain.coords[activeChain.coords.length - 1][1],
            st.a[0],
            st.a[1]
          ) <= 0.02
        );

        if (canAppend) {
          activeChain.coords.push(st.b);
          activeChain.microStepCount++;
          activeChain.speedSum += cellInfo.speedKmh;
          activeChain.speedKmh = Math.abs(Math.round(activeChain.speedSum / activeChain.microStepCount));
          cellInfo.routes.forEach((rt) => activeChain._routeSet.add(rt));
          activeChain.routes = Array.from(activeChain._routeSet);
          activeChain.routeCount = Math.max(1, activeChain.routes.length);
        } else {
          flushChain();
          const rtSet = new Set(cellInfo.routes.length ? cellInfo.routes : (routeTag ? [routeTag] : []));
          activeChain = {
            coords: [st.a, st.b],
            tier: cellInfo.tier,
            color: cellInfo.color,
            speedKmh: Math.abs(cellInfo.speedKmh),
            speedSum: Math.abs(cellInfo.speedKmh),
            microStepCount: 1,
            routeCount: Math.max(1, rtSet.size),
            routes: Array.from(rtSet),
            _routeSet: rtSet,
            routeLabel: routeTag || (cellInfo.routes[0] || ''),
            fromSeq: seg.fromSeq || null,
            toSeq: seg.toSeq || null,
            fromIdx: seg.fromIdx ?? null,
            toIdx: seg.toIdx ?? null,
            fromNameEn: seg.fromNameEn || '',
            fromNameTc: seg.fromNameTc || '',
            toNameEn: seg.toNameEn || '',
            toNameTc: seg.toNameTc || '',
            isScheduledFallback: cellInfo.isScheduledFallback,
            isCenteredTwoWay: Boolean(isCenteredTwoWay || cellInfo.isCenteredTwoWay),
            source: 'BUS_API'
          };
        }
      }
      flushChain();
    }

    // Merge adjacent collinear corridor chains (same tier/color/mode, endpoint gap <= 35 m, bearing within 35°)
    // so consecutive rural/arterial stop spans (e.g. South Lantau Road) render as one continuous polyline.
    const mergedCorridors = [];
    for (let i = 0; i < corridors.length; i++) {
      const cur = corridors[i];
      if (!cur || !Array.isArray(cur.coords) || cur.coords.length < 2) continue;
      let attached = false;
      const curStart = cur.coords[0];
      const curNext = cur.coords[1];
      const curStartBrg = _bearingDegLocal(curStart[0], curStart[1], curNext[0], curNext[1]);
      for (let j = mergedCorridors.length - 1; j >= 0; j--) {
        const prev = mergedCorridors[j];
        if (
          prev.tier !== cur.tier ||
          prev.color !== cur.color ||
          prev.isScheduledFallback !== cur.isScheduledFallback ||
          prev.isCenteredTwoWay !== cur.isCenteredTwoWay
        ) {
          continue;
        }
        const pLen = prev.coords.length;
        const prevEnd = prev.coords[pLen - 1];
        const prevPrev = prev.coords[pLen - 2];
        const gapKm = _haversineKmLocal(prevEnd[0], prevEnd[1], curStart[0], curStart[1]);
        if (gapKm > 0.035) continue;
        const prevEndBrg = _bearingDegLocal(prevPrev[0], prevPrev[1], prevEnd[0], prevEnd[1]);
        if (_angDiffLocal(prevEndBrg, curStartBrg) > 35) continue;

        const sliceStart = gapKm <= 0.005 ? 1 : 0;
        for (let k = sliceStart; k < cur.coords.length; k++) {
          prev.coords.push(cur.coords[k]);
        }
        prev.microStepCount += cur.microStepCount;
        prev.speedSum += cur.speedSum;
        prev.speedKmh = Math.abs(Math.round(prev.speedSum / Math.max(1, prev.microStepCount)));
        cur._routeSet.forEach((rt) => prev._routeSet.add(rt));
        prev.routes = Array.from(prev._routeSet);
        prev.routeCount = Math.max(1, prev.routes.length);
        if (cur.toSeq) prev.toSeq = cur.toSeq;
        if (cur.toIdx !== null && cur.toIdx !== undefined) prev.toIdx = cur.toIdx;
        if (cur.toNameEn) prev.toNameEn = cur.toNameEn;
        if (cur.toNameTc) prev.toNameTc = cur.toNameTc;
        attached = true;
        break;
      }
      if (!attached) {
        mergedCorridors.push(cur);
      }
    }

    // Strip internal helper properties
    const cleanCorridors = mergedCorridors.map((c) => {
      const { _routeSet, speedSum, ...rest } = c;
      return rest;
    });

    return {
      corridors: cleanCorridors,
      stats: {
        totalMicroSteps,
        suppressedByTdMicroSteps,
        outsideViewportMicroSteps,
        survivingMicroSteps,
        occupiedCells: resolvedCells.size,
        mergedDuplicateMicroSteps,
        renderedCorridors: cleanCorridors.length
      },
      skipReasons
    };
  }

  // Strict TD Ground-Truth Coverage Check (~100 m & ±45° bearing, or either direction on undivided urban roads)
  // against BOTH live TD speed links and TD speed detectors.
  function isSegmentCoveredByTdGroundTruth(segCoords, tdDetectors = [], tdSpeedGeoJson = null, opts = {}) {
    if (!Array.isArray(segCoords) || segCoords.length < 2) return false;
    const maxDistKm = Number(opts.maxDistKm) || 0.10; // ~100 m
    const maxAngDeg = Number(opts.maxAngDeg) || 45;   // ±45° same-direction bearing
    const allowUndividedOpp = opts.allowUndividedOpposite !== false;
    const { subSegs, minLat, maxLat, minLon, maxLon } = _buildSpanSubSegs(segCoords);
    if (!subSegs.length) return false;

    const detList = Array.isArray(tdDetectors)
      ? tdDetectors
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_DETECTORS__) ? globalScope.__LIVE_TRAFFIC_DETECTORS__ : []);
    const padDeg = 0.0025;
    if (detList.length) {
      for (let i = 0; i < detList.length; i++) {
        const d = detList[i];
        if (!d) continue;
        const dLat = Number(d.lat), dLon = Number(d.lon), spd = Number(d.spd);
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
        if (bestKm <= maxDistKm && bestBrg !== null) {
          if (!Number.isFinite(Number(d.rot))) return true;
          const diff = _angDiffLocal(Number(d.rot), bestBrg);
          const isUndiv = isUndividedUrbanRoad(d.roadEn || '', d.roadTc || '', d.id || '');
          if (diff <= maxAngDeg || (allowUndividedOpp && isUndiv && diff >= (180 - maxAngDeg))) {
            return true;
          }
        }
      }
    }

    const speedGeo = tdSpeedGeoJson !== undefined && tdSpeedGeoJson !== null
      ? tdSpeedGeoJson
      : (globalScope.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null);
    if (speedGeo) {
      const linkMatches = _matchTdSpeedLinksForSubSegs(subSegs, minLat, maxLat, minLon, maxLon, speedGeo, maxDistKm, maxAngDeg);
      if (linkMatches.length > 0) return true;
      if (allowUndividedOpp) {
        const feats = Array.isArray(speedGeo) ? speedGeo : (Array.isArray(speedGeo?.features) ? speedGeo.features : []);
        for (let i = 0; i < feats.length; i++) {
          const f = feats[i];
          const p = f?.properties || {};
          if (p.hasSpeedData === false) continue;
          const spdRaw = p.spd ?? p.speedKmh;
          if (spdRaw === null || spdRaw === undefined || !Number.isFinite(Number(spdRaw))) continue;
          if (!isUndividedUrbanRoad(p.roadEn || '', p.roadTc || '', p.id || p.detectorId || '')) continue;
          const rc = _extractSpeedLinkCoords(f);
          if (!rc || rc.length < 2) continue;
          for (let k = 0; k < rc.length - 1; k++) {
            const p1 = rc[k], p2 = rc[k + 1];
            if (!Array.isArray(p1) || !Array.isArray(p2)) continue;
            const la1 = Number(p1[1]), lo1 = Number(p1[0]), la2 = Number(p2[1]), lo2 = Number(p2[0]);
            if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
            const linkBrg = _haversineKmLocal(la1, lo1, la2, lo2) >= 0.004
              ? _bearingDegLocal(la1, lo1, la2, lo2)
              : (Number.isFinite(Number(p.rot)) ? Number(p.rot) : null);
            const linkMidLat = (la1 + la2) * 0.5, linkMidLon = (lo1 + lo2) * 0.5;
            for (let s = 0; s < subSegs.length; s++) {
              const ss = subSegs[s];
              if (linkBrg !== null) {
                const diff = _angDiffLocal(linkBrg, ss.brg);
                if (diff > maxAngDeg && diff < (180 - maxAngDeg)) continue;
              }
              const dMin = Math.min(
                _pointToSegKmLocal(linkMidLat, linkMidLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon).distKm,
                _pointToSegKmLocal(ss.midLat, ss.midLon, la1, lo1, la2, lo2).distKm
              );
              if (dMin <= maxDistKm) return true;
            }
          }
        }
      }
    }
    return false;
  }

  function _isOffRouteHighwayLeakForSpan(roadEn = '', roadTc = '', id = '', opts = {}) {
    const idStr = String(id || '').toUpperCase();
    const txt = `${roadEn || ''} ${roadTc || ''} ${idStr}`;
    const routeNo = String(opts.routeNo || '').trim().toUpperCase();
    const spanText = `${opts.fromStop?.stopName_e || ''} ${opts.toStop?.stopName_e || ''} ${opts.fromStop?.name_tc || ''} ${opts.toStop?.name_tc || ''}`;
    const stopsText = Array.isArray(opts.stops)
      ? opts.stops.map((s) => `${s?.stopName_e || ''} ${s?.name_tc || ''}`).join(' ')
      : '';
    const routeContext = `${spanText} ${stopsText}`;
    const isE36Explicit = /^E36[A-Z]?$/.test(routeNo);
    const isE36ByStops = Boolean(
      /pat\s*heung|kam\s*ho|grand\s*mayfair|yuen\s*long\s*park|八鄉|錦河|柏瓏|元朗公園/i.test(routeContext) &&
      /airport|tung\s*chung|tm[\s-]*clk|chek\s*lap\s*kok|機場|東涌|屯門赤鱲角/i.test(routeContext)
    );
    if (isE36Explicit || isE36ByStops) {
      // E36 exits Yuen Long Hwy onto Tsing Long Hwy (Route 3 / Tai Lam Tunnel) BEFORE Kong Sham Western Hwy,
      // and NEVER runs on Tuen Mun Road (Brilliant Garden / Fung Tei / Siu Hong).
      if (/TDS91037|TDS91040/i.test(idStr)) return true;
      if (/kong\s*sham\s*western|shenzhen\s*bay|港深西部公路|深圳灣/i.test(txt)) return true;
      if (/brilliant\s*garden|fung\s*tei|siu\s*hong|寶怡|鳳地|兆康/i.test(txt)) return true;
      if (isE36Explicit && /\b(?:tuen\s*mun\s*r(?:oa)?d|tmr)\b|屯門公路/i.test(txt)) return true;
    }
    // Block HZMB Hong Kong Link Road / elevated viaducts from bleeding onto parallel ground roads (e.g. South Perimeter Rd)
    const isViaductOrHzmb = /\b(?:hzmb|hong\s*kong\s*link\s*r(?:oa)?d|viaduct)\b|港珠澳大橋香港連接路|高架/i.test(txt);
    if (isViaductOrHzmb && !/hzmb|hong\s*kong\s*link|bridge\s*port|port|港珠澳|大橋口岸/i.test(spanText)) {
      return true;
    }
    return false;
  }

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

    const fromStop = opts.fromStop || null;
    const toStop = opts.toStop || null;
    const spanTextEn = `${fromStop?.stopName_e || ''} ${toStop?.stopName_e || ''}`.trim();
    const spanTextTc = `${fromStop?.name_tc || ''} ${toStop?.name_tc || ''}`.trim();
    const roadDistKm = Number.isFinite(Number(opts.roadDistKm))
      ? Math.abs(Number(opts.roadDistKm))
      : _polylineLengthKm(segCoords);

    // Never match highway detectors/cameras off a bare 2-point straight chord between distant stops
    // (e.g. E36 Stop 15 Yuen Long Park -> Stop 16 TM-CLK Tunnel BBI before road geometry loads)
    const isBareDistantChord = Boolean(
      (opts.isRoadSnapped === false && roadDistKm >= 1.25) ||
      (opts.isRoadSnapped === false && segCoords.length === 2 && roadDistKm >= 0.85)
    );
    if (isBareDistantChord) return empty;

    const fromStems = extractExplicitRoadStems(fromStop?.stopName_e || '', fromStop?.name_tc || '');
    const toStems = extractExplicitRoadStems(toStop?.stopName_e || '', toStop?.name_tc || '');
    const hasExplicitLocalRoad = Boolean(
      !_isExpresswayOrTunnelRoad(`${spanTextEn} ${spanTextTc}`) &&
      (fromStems.en.length > 0 || toStems.en.length > 0 || fromStems.tc.length > 0 || toStems.tc.length > 0)
    );
    const isBbiSpan = BBI_OR_HIGHWAY_STOP_RE.test(`${spanTextEn} ${spanTextTc}`);
    const isAirportPerimeterSpan = isAirportPerimeterZone(fromStop, toStop);
    // Prevent local road spans (e.g. E36 Stop 2 Kam Ho Rd -> Stop 3 Grand Mayfair, or airport perimeter roads)
    // from flipping isHighwaySpan=true just because distance slightly exceeds 1.25 km.
    const isHighwaySpan = Boolean(
      opts.isHighwaySpan ||
      isBbiSpan ||
      (roadDistKm >= 1.25 && !isAirportPerimeterSpan && !(hasExplicitLocalRoad && roadDistKm < 2.2))
    );
    const isNonHighwaySideStreet = !isHighwaySpan;

    // Require <= 60 m from actual route shape polyline on highways/trunk spans and <= 45 m on non-highway side streets,
    // with strict <= 45° corridor bearing alignment so parallel highways never leak onto side roads or off-route branches.
    const maxDetDistKm = Number(opts.maxDetDistKm) || (isNonHighwaySideStreet ? 0.045 : 0.060);
    const maxDetAngDeg = Number(opts.maxDetAngDeg) || 45;
    const maxCamDistKm = Number(opts.maxCamDistKm) || (isNonHighwaySideStreet ? 0.045 : 0.060);
    const maxCamAngDeg = Number(opts.maxCamAngDeg) || 45;

    const bothStopsSameLocalRoad = Boolean(
      !_isExpresswayOrTunnelRoad(`${spanTextEn} ${spanTextTc}`) &&
      fromStems.en.length > 0 &&
      toStems.en.length > 0 &&
      fromStems.en.some((a) => toStems.en.some((b) => a === b || a.includes(b) || b.includes(a)))
    );

    const isCompatibleTdFeature = (roadEn, roadTc, id) => {
      if (_isOffRouteHighwayLeakForSpan(roadEn, roadTc, id, opts)) return false;
      const detIsHighway = _isExpresswayOrTunnelRoad(`${roadEn || ''} ${roadTc || ''}`, id || '');
      // Never allow an expressway/highway/tunnel detector to leak onto a non-highway side street
      // unless the stop itself explicitly names that highway/tunnel.
      if (isNonHighwaySideStreet && detIsHighway && !_isExpresswayOrTunnelRoad(`${spanTextEn} ${spanTextTc}`)) {
        return false;
      }
      return areRoadNamesCompatible(spanTextEn, spanTextTc, roadEn || '', roadTc || '', {
        isHighwaySpan,
        detIsHighway,
        bothStopsSameLocalRoad
      });
    };

    const { subSegs, minLat, maxLat, minLon, maxLon } = _buildSpanSubSegs(segCoords);
    if (!subSegs.length) return empty;

    const padDeg = 0.0025; // ~275m bbox prefilter
    const matchedDets = [];
    if (Array.isArray(tdDetectors) && tdDetectors.length) {
      for (let i = 0; i < tdDetectors.length; i++) {
        const d = tdDetectors[i];
        if (!d) continue;
        const dLat = Number(d.lat), dLon = Number(d.lon);
        const spd = Number(d.spd);
        if (!Number.isFinite(dLat) || !Number.isFinite(dLon) || !Number.isFinite(spd) || spd <= 0) continue;
        if (dLat < minLat - padDeg || dLat > maxLat + padDeg || dLon < minLon - padDeg || dLon > maxLon + padDeg) continue;
        if (!isCompatibleTdFeature(d.roadEn || '', d.roadTc || '', d.id || '')) continue;

        let bestKm = Infinity;
        let bestBrg = null;
        let bestS = -1;
        let bestRawT = 0.5;
        for (let s = 0; s < subSegs.length; s++) {
          const ss = subSegs[s];
          const proj = _pointToSegKmLocal(dLat, dLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon);
          if (proj.distKm < bestKm) {
            bestKm = proj.distKm;
            bestBrg = ss.brg;
            bestS = s;
            bestRawT = proj.t;
          }
        }
        if (bestKm > maxDetDistKm || bestBrg === null) continue;
        // Reject fork/turn-off overshoot past the endpoints of the span polyline
        if ((bestS === 0 && bestRawT < -0.02) || (bestS === subSegs.length - 1 && bestRawT > 1.02)) continue;
        if (Number.isFinite(Number(d.rot))) {
          const diff = _angDiffLocal(Number(d.rot), bestBrg);
          if (diff > maxDetAngDeg) continue;
        }
        matchedDets.push({ det: d, distKm: bestKm, spd: Math.abs(spd), occ: Math.abs(Number(d.occ) || 0) });
      }
    }

    // Match nearest same-direction TD camera along this span (<= 60 m highway / <= 45 m side street, <= 45° bearing)
    let bestCam = null;
    if (Array.isArray(tdCameras) && tdCameras.length) {
      let bestCamScore = Infinity;
      for (let i = 0; i < tdCameras.length; i++) {
        const c = tdCameras[i];
        if (!c || !c.key) continue;
        const cLat = Number(c.lat), cLon = Number(c.lon);
        if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
        if (cLat < minLat - padDeg || cLat > maxLat + padDeg || cLon < minLon - padDeg || cLon > maxLon + padDeg) continue;
        if (!isCompatibleTdFeature(c.desc || '', c.descTc || '', c.key || '')) continue;

        let bestKm = Infinity;
        let bestBrg = null;
        let bestS = -1;
        let bestRawT = 0.5;
        for (let s = 0; s < subSegs.length; s++) {
          const ss = subSegs[s];
          const proj = _pointToSegKmLocal(cLat, cLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon);
          if (proj.distKm < bestKm) {
            bestKm = proj.distKm;
            bestBrg = ss.brg;
            bestS = s;
            bestRawT = proj.t;
          }
        }
        if (bestKm > maxCamDistKm || bestBrg === null) continue;
        if ((bestS === 0 && bestRawT < -0.02) || (bestS === subSegs.length - 1 && bestRawT > 1.02)) continue;
        if (Number.isFinite(Number(c.bearingDeg))) {
          if (_angDiffLocal(Number(c.bearingDeg), bestBrg) > maxCamAngDeg) continue;
        }
        if (bestKm < bestCamScore) {
          bestCamScore = bestKm;
          bestCam = {
            key: c.key,
            camKey: c.key,
            desc: _sanitizeDirectionTypos(c.desc || c.key),
            meters: Math.abs(Math.round(bestKm * 1000)),
            lat: cLat,
            lon: cLon,
            dir: _sanitizeDirectionTypos(c.dir || ''),
            bearingDeg: Number.isFinite(Number(c.bearingDeg)) ? Number(c.bearingDeg) : bestBrg
          };
        }
      }
    }

    // If no direct detector point hit, also check live TD speed-map GeoJSON links (respecting <=60m / <=45m & road-name compatibility)
    const tdSpeedGeoJson = (opts.tdSpeedGeoJson !== undefined)
      ? opts.tdSpeedGeoJson
      : (globalScope.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null);
    if (!matchedDets.length && tdSpeedGeoJson) {
      const rawLinkMatches = _matchTdSpeedLinksForSubSegs(subSegs, minLat, maxLat, minLon, maxLon, tdSpeedGeoJson, maxDetDistKm, maxDetAngDeg);
      const linkMatches = rawLinkMatches.filter((m) => isCompatibleTdFeature(m.roadEn, m.roadTc, m.id));
      if (linkMatches.length) {
        const activeSlowLinks = linkMatches.filter(x => {
          const tr = normalizeTrafficTier(x.tier, x.spd);
          return tr === 'CONGESTED' || tr === 'MODERATE';
        });
        let focusLink = linkMatches[0];
        let resolvedSpd = 0;
        if (activeSlowLinks.length) {
          activeSlowLinks.sort((a, b) => a.spd - b.spd);
          focusLink = activeSlowLinks[0];
          resolvedSpd = Math.abs(Math.round(focusLink.spd));
        } else {
          linkMatches.sort((a, b) => a.distKm - b.distKm);
          focusLink = linkMatches[0];
          resolvedSpd = Math.abs(Math.round(linkMatches.reduce((acc, x) => acc + x.spd, 0) / linkMatches.length));
        }
        const tdTier = normalizeTrafficTier(activeSlowLinks.length ? focusLink.tier : 'SMOOTH', resolvedSpd);
        const tdStatus = tdTier === 'CONGESTED' ? 'JAMMED' : (tdTier === 'MODERATE' ? 'SLOW' : 'SMOOTH');
        const _isLinkedCamSafe = (linked, camKey) => {
          if (!linked) return true; // No catalog coords; parent detector/link already passed strict lateral + road-name filter
          if (!isCompatibleTdFeature(linked.desc || '', linked.descTc || '', camKey || '')) return false;
          const cLat = Number(linked.lat), cLon = Number(linked.lon);
          if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) return true;
          let minKm = Infinity;
          for (let s = 0; s < subSegs.length; s++) {
            const ss = subSegs[s];
            const dKm = _pointToSegKmLocal(cLat, cLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon).distKm;
            if (dKm < minKm) minKm = dKm;
          }
          return minKm <= maxCamDistKm;
        };

        if (!bestCam && focusLink.camKey) {
          const linked = Array.isArray(tdCameras) ? tdCameras.find(c => c.key === focusLink.camKey) : null;
          if (_isLinkedCamSafe(linked, focusLink.camKey)) {
            bestCam = {
              key: focusLink.camKey,
              camKey: focusLink.camKey,
              desc: _sanitizeDirectionTypos(linked?.desc || focusLink.roadEn || focusLink.roadTc || focusLink.camKey),
              meters: Math.abs(Math.round(focusLink.distKm * 1000)),
              lat: Number(linked?.lat ?? subSegs[0].midLat),
              lon: Number(linked?.lon ?? subSegs[0].midLon),
              dir: _sanitizeDirectionTypos(linked?.dir || ''),
              bearingDeg: linked?.bearingDeg ?? focusLink.rot
            };
          }
        }
        return {
          hasTd: true,
          tdSpeedKmh: resolvedSpd,
          tdTier,
          tdStatus,
          tdColor: getBusSpeedColorHex(tdTier, resolvedSpd),
          tdOcc: Math.abs(Math.round(focusLink.occ || 0)),
          tdDetId: focusLink.id || '',
          tdRoadEn: _sanitizeDirectionTypos(focusLink.roadEn || focusLink.roadTc || ''),
          tdRoadTc: _sanitizeDirectionTypos(focusLink.roadTc || focusLink.roadEn || ''),
          tdDet: focusLink.props || null,
          tdMatchCount: linkMatches.length,
          cam: bestCam
        };
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
      resolvedSpd = Math.abs(Math.round(focus.spd));
    } else {
      matchedDets.sort((a, b) => a.distKm - b.distKm);
      focus = matchedDets[0];
      resolvedSpd = Math.abs(Math.round(matchedDets.reduce((acc, x) => acc + x.spd, 0) / matchedDets.length));
    }
    const tdTier = normalizeTrafficTier(activeSlow.length ? focus.det.tier : 'SMOOTH', resolvedSpd);
    const tdStatus = tdTier === 'CONGESTED' ? 'JAMMED' : (tdTier === 'MODERATE' ? 'SLOW' : 'SMOOTH');

    // If detector itself links a camKey and we didn't find a closer directional camera, attach that camera metadata only if nearby & road-compatible
    if (!bestCam && focus.det?.camKey) {
      const linked = Array.isArray(tdCameras) ? tdCameras.find(c => c.key === focus.det.camKey) : null;
      let camOk = true;
      if (linked) {
        if (!isCompatibleTdFeature(linked.desc || '', linked.descTc || '', focus.det.camKey || '')) {
          camOk = false;
        } else {
          const cLat = Number(linked.lat), cLon = Number(linked.lon);
          if (Number.isFinite(cLat) && Number.isFinite(cLon)) {
            let minKm = Infinity;
            for (let s = 0; s < subSegs.length; s++) {
              const ss = subSegs[s];
              const dKm = _pointToSegKmLocal(cLat, cLon, ss.aLat, ss.aLon, ss.bLat, ss.bLon).distKm;
              if (dKm < minKm) minKm = dKm;
            }
            if (minKm > maxCamDistKm) camOk = false;
          }
        }
      }
      if (camOk) {
        bestCam = {
          key: focus.det.camKey,
          camKey: focus.det.camKey,
          desc: _sanitizeDirectionTypos(linked?.desc || focus.det.roadEn || focus.det.roadTc || focus.det.camKey),
          meters: Math.abs(Math.round(focus.distKm * 1000)),
          lat: Number(linked?.lat ?? focus.det.lat),
          lon: Number(linked?.lon ?? focus.det.lon),
          dir: _sanitizeDirectionTypos(linked?.dir || ''),
          bearingDeg: linked?.bearingDeg ?? focus.det.rot
        };
      }
    }

    return {
      hasTd: true,
      tdSpeedKmh: resolvedSpd,
      tdTier,
      tdStatus,
      tdColor: getBusSpeedColorHex(tdTier, resolvedSpd),
      tdOcc: Math.abs(Math.round(focus.occ || 0)),
      tdDetId: focus.det.id || '',
      tdRoadEn: _sanitizeDirectionTypos(focus.det.roadEn || focus.det.roadTc || ''),
      tdRoadTc: _sanitizeDirectionTypos(focus.det.roadTc || focus.det.roadEn || ''),
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
      } else if (Number.isFinite(Number(e.rawTargetMs))) {
        ms = Number(e.rawTargetMs);
      } else if (Number.isFinite(Number(e.targetMs))) {
        ms = Number(e.targetMs);
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
        seq: Number(e.eta_seq ?? e.etaSeq ?? e.seq ?? (i + 1)) || (i + 1),
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
    const routeNo = opts.routeNo || '';
    const company = opts.company || '';
    const isNlb = String(company || '').toUpperCase() === 'NLB';
    const allowNlbScheduledFallback = Boolean(opts.allowNlbScheduledFallback !== undefined ? opts.allowNlbScheduledFallback : isNlb);
    const debugSkips = Array.isArray(opts.debugSkips) ? opts.debugSkips : [];
    const publishDebug = (segsOut) => {
      if (opts.skipGlobalDebugUpdate) return;
      const dbg = _ensureBusSpeedDebugState();
      dbg.updatedAt = new Date().toISOString();
      if (routeNo || company) {
        const rKey = `${company || 'BUS'}|${routeNo || 'UNKNOWN'}|${opts.bound || ''}`;
        dbg.routeDiagnostics[rKey] = {
          routeNo,
          company,
          bound: opts.bound || '',
          segmentCount: segsOut.length,
          liveSegmentCount: segsOut.filter(s => s.source === 'BUS_API' && !s.isScheduledOnly && !s.isScheduledFallback).length,
          scheduledFallbackCount: segsOut.filter(s => s.isScheduledFallback).length,
          tdOverrideCount: segsOut.filter(s => s.source === 'TD').length,
          skipReasons: debugSkips.slice(0, 60)
        };
      }
      if (debugSkips.length) {
        for (let d = 0; d < debugSkips.length; d++) {
          _recordDebugSkip(dbg.skipReasons, debugSkips[d]);
        }
        dbg.skipReasonCounts = _tallySkipReasons(dbg.skipReasons);
      }
      if (opts.replaceComputedSegments) {
        dbg.computedSegments = segsOut.slice(0, 200);
      }
    };

    if (!Array.isArray(stops) || stops.length < 2 || !etaByStopIdx) {
      _recordDebugSkip(debugSkips, { scope: 'route', routeNo, company, fromSeq: null, toSeq: null, reason: 'no_live_eta_pairs', detail: 'missing stops or ETA map' });
      publishDebug([]);
      return [];
    }
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const tdDetectors = Array.isArray(opts.tdDetectors)
      ? opts.tdDetectors
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_DETECTORS__) ? globalScope.__LIVE_TRAFFIC_DETECTORS__ : []);
    const tdCameras = Array.isArray(opts.tdCameras)
      ? opts.tdCameras
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_CAMERAS__) ? globalScope.__LIVE_TRAFFIC_CAMERAS__ : []);
    const tdSpeedGeoJson = (opts.tdSpeedGeoJson !== undefined)
      ? opts.tdSpeedGeoJson
      : (globalScope.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null);
    const tdCoveredPairs = opts.tdCoveredStopPairs instanceof Set ? opts.tdCoveredStopPairs : null;

    const parsedByIdx = new Array(stops.length);
    let stopsWithAnyEta = 0;
    for (let i = 0; i < stops.length; i++) {
      const raw = (etaByStopIdx instanceof Map) ? etaByStopIdx.get(i) : etaByStopIdx[i];
      const parsed = _parseStopEtaEntries(raw, nowMs);
      parsedByIdx[i] = parsed;
      if (parsed.length > 0) stopsWithAnyEta++;
    }

    // Never fabricate speeds when live/API ETA data is completely missing
    if (stopsWithAnyEta < 2) {
      _recordDebugSkip(debugSkips, { scope: 'route', routeNo, company, fromSeq: null, toSeq: null, reason: 'no_live_eta_pairs', detail: `only ${stopsWithAnyEta} stop(s) had ETA entries` });
      publishDebug([]);
      return [];
    }

    // Pass 1: Build raw stop-to-stop geometry, TD ground truth, and dwell/quantization-corrected bus speeds
    const allowSparseBridge = Boolean(opts.allowSparseBridge || isNlb);
    const maxSparseJump = isNlb ? 6 : 3;
    const rawSegs = [];
    let polyCursor = 0;

    for (let i = 0; i < stops.length - 1; ) {
      const arrA = parsedByIdx[i];
      if (!arrA || !arrA.length) {
        _recordDebugSkip(debugSkips, { scope: 'span', routeNo, company, fromSeq: i + 1, toSeq: i + 2, reason: 'no_live_eta_pairs', detail: 'origin stop has no ETA' });
        i++;
        continue;
      }

      // Pair with next stop (i + 1), or bridge ahead when sparse sampling long non-KMB / NLB rural routes
      let j = i + 1;
      if (allowSparseBridge && (!parsedByIdx[j] || !parsedByIdx[j].length)) {
        const maxJump = Math.min(stops.length - 1, i + maxSparseJump);
        let foundJ = -1;
        for (let cand = i + 2; cand <= maxJump; cand++) {
          if (parsedByIdx[cand] && parsedByIdx[cand].length) {
            foundJ = cand;
            break;
          }
        }
        if (foundJ > i) j = foundJ;
      }

      const arrB = parsedByIdx[j];
      if (!arrB || !arrB.length) {
        _recordDebugSkip(debugSkips, { scope: 'span', routeNo, company, fromSeq: i + 1, toSeq: j + 1, reason: 'no_live_eta_pairs', detail: 'next stop has no ETA' });
        i++;
        continue;
      }

      const a = stops[i], b = stops[j];
      const aLat = parseFloat(a?.latitude ?? a?.lat), aLon = parseFloat(a?.longitude ?? a?.lon);
      const bLat = parseFloat(b?.latitude ?? b?.lat), bLon = parseFloat(b?.longitude ?? b?.lon);
      if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) {
        i = j;
        continue;
      }

      const sliced = sliceStopSpanPolyline(roadPolylinePoints, aLat, aLon, bLat, bLon, polyCursor);
      polyCursor = sliced.nextCursor;
      const segCoords = sliced.coords;

      const straightKm = _haversineKmLocal(aLat, aLon, bLat, bLon);
      const polyKm = _polylineLengthKm(segCoords);
      const isRuralWinding = isRuralWindingCorridor(a, b);
      // Calibrated 1.45x winding-road factor for rural/mountain corridors when unsnapped (e.g. South Lantau, Tung Chung Rd, Tai O, Sai Kung, Shek O)
      const unsnappedDistFactor = isRuralWinding ? 1.45 : 1.18;
      const roadDistKm = Math.max(0.08, sliced.isRoadSnapped ? polyKm : straightKm * unsnappedDistFactor);
      if (roadDistKm < 0.08 || roadDistKm > 28) {
        _recordDebugSkip(debugSkips, { scope: 'span', routeNo, company, fromSeq: i + 1, toSeq: j + 1, reason: 'invalid_distance', detail: `${roadDistKm.toFixed(2)} km` });
        i = j;
        continue;
      }

      // Ground Truth Check: TD detectors & speed links ALWAYS have priority when covering this span
      // (with strict <=60m highway / <=45m side-street & road-name compatibility, and never on distant bare chords)
      const tdTruth = matchTdGroundTruthForSpan(segCoords, tdDetectors, tdCameras, {
        tdSpeedGeoJson,
        fromStop: a,
        toStop: b,
        roadDistKm,
        isRoadSnapped: Boolean(sliced.isRoadSnapped),
        routeNo,
        stops
      });
      const pairFlaggedTd = Boolean(tdCoveredPairs && tdCoveredPairs.has(`${i + 1}_${j + 1}`));
      const coveredByTd = tdTruth.hasTd || pairFlaggedTd;

      const originLat = parseFloat(stops[0]?.latitude ?? stops[0]?.lat);
      const originLon = parseFloat(stops[0]?.longitude ?? stops[0]?.lon);
      const distToOriginEndKm = (Number.isFinite(originLat) && Number.isFinite(originLon))
        ? _haversineKmLocal(originLat, originLon, bLat, bLon)
        : Infinity;
      const isOriginLayoverLoop = Boolean(i === 0 && (distToOriginEndKm <= 0.15 || straightKm <= 0.15));
      const bothScheduledOnly = Boolean(
        arrA.every((e) => e.isScheduled) || arrB.every((e) => e.isScheduled)
      );

      // Exclude departure-terminal layover loops (within 150 m of route origin stop, e.g. Mui Wo Ferry Pier)
      // from sparse-ETA headway fallback BEFORE delta matching so long layover headways never produce slow stubs!
      if (isOriginLayoverLoop && bothScheduledOnly && !coveredByTd) {
        _recordDebugSkip(debugSkips, {
          scope: 'span',
          routeNo,
          company,
          fromSeq: i + 1,
          toSeq: j + 1,
          reason: 'origin_terminus_span',
          detail: `Origin layover loop (${Math.round(Math.min(distToOriginEndKm, straightKm) * 1000)}m) excluded from headway fallback`
        });
        i = j;
        continue;
      }

      const minSec = Math.max(15, (roadDistKm / 92) * 3600);
      const maxSec = Math.min(2400, Math.max(360, (roadDistKm / 3.0) * 3600));
      const matched = _matchDeltaSecBetweenLists(arrA, arrB, minSec, maxSec, true);
      if (!matched.deltas.length) {
        _recordDebugSkip(debugSkips, { scope: 'span', routeNo, company, fromSeq: i + 1, toSeq: j + 1, reason: 'no_live_eta_pairs', detail: 'no valid forward ETA delta' });
        i = j;
        continue;
      }

      if (isOriginLayoverLoop && matched.isScheduledOnly && !coveredByTd) {
        _recordDebugSkip(debugSkips, {
          scope: 'span',
          routeNo,
          company,
          fromSeq: i + 1,
          toSeq: j + 1,
          reason: 'origin_terminus_span',
          detail: `Origin layover loop (${Math.round(Math.min(distToOriginEndKm, straightKm) * 1000)}m) excluded from headway fallback`
        });
        i = j;
        continue;
      }

      // Upper-percentile consensus (35th percentile of deltaSec = 65th percentile speed):
      // One slow bus loading a wheelchair doesn't mean the road is jammed if another bus flowed smoothly!
      matched.deltas.sort((x, y) => x - y);
      const pIdx = Math.floor((matched.deltas.length - 1) * 0.35);
      const deltaSec = Math.abs(matched.deltas[pIdx]);

      const roadProfile = classifyBusRoadClass(roadDistKm, a, b);
      const isAirportPerimeter = roadProfile.roadClass === 'AIRPORT_PERIMETER';
      const isTerminusDep = isTerminusLikeStop(a, i);
      const destNmCombined = `${b?.stopName_e || ''} ${b?.name_tc || ''}`;
      const isFinalStopSpan = (j >= stops.length - 1);
      const isTerminusApproach = Boolean(
        isFinalStopSpan && (
          stops.length >= 5 ||
          isTerminusLikeStop(b, -1) ||
          /pat\s*heung\s*r(?:oa)?d|八鄉路/i.test(destNmCombined) ||
          Boolean(opts.excludeTerminusApproach)
        )
      );
      const hopCount = Math.max(1, j - i);

      // Realistic HK stop dwell + traffic signal + acceleration + minute-quantization + terminus slack compensation
      let dwellSec = roadProfile.baseDwellSec + Math.max(0, hopCount - 1) * 18;
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
      let busSpeedKmh = Math.abs(Math.max(4, Math.min(maxCapKmh, Number((roadDistKm / (movingSec / 3600)).toFixed(1)))));

      // Guard 0: Sub-minute ETA rounding artifact (Δt <= 65s over > 600 m) is always Flowing / Green
      const isEtaRoundingArtifact = Boolean(deltaSec <= 65 && roadDistKm > 0.60);

      // Classify Bus API tier using calibrated HK road-class thresholds
      const ratio = busSpeedKmh / Math.max(15, roadProfile.expectedKmh);
      let busTier = 'SMOOTH';
      if (isEtaRoundingArtifact) {
        busTier = 'SMOOTH';
        busSpeedKmh = Math.max(roadProfile.smoothMinKmh, Math.min(roadProfile.expectedKmh, busSpeedKmh));
        _recordDebugSkip(debugSkips, {
          scope: 'span',
          routeNo,
          company,
          fromSeq: i + 1,
          toSeq: j + 1,
          reason: 'eta_rounding_artifact',
          detail: `dt=${Math.round(deltaSec)}s over ${Math.round(roadDistKm * 1000)}m clamped Flowing`
        });
      } else if (isAirportPerimeter) {
        // Airport perimeter / cargo service roads: 20–35+ km/h = Flowing Green; Red only if < 8 km/h across >= 2 consecutive spans
        if (busSpeedKmh < 8) {
          busTier = 'CONGESTED';
        } else if (busSpeedKmh < 20) {
          busTier = 'MODERATE';
        } else {
          busTier = 'SMOOTH';
        }
      } else if (busSpeedKmh >= 40) {
        busTier = 'SMOOTH';
      } else if (busSpeedKmh < roadProfile.moderateMinKmh || ratio < 0.44) {
        busTier = 'CONGESTED';
      } else if (busSpeedKmh < roadProfile.smoothMinKmh || ratio < 0.72) {
        busTier = 'MODERATE';
      }

      // Guard 1: Short urban/new-town hop (<= 2 min rounded ETA) is normal bus pacing — NEVER false RED!
      if (roadDistKm < 0.78 && deltaSec <= 125 && busTier === 'CONGESTED') {
        busTier = 'SMOOTH';
        busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
      }
      // Guard 2: Terminus departure (stop 0 -> 1) <= 3 min or origin layover loop within 150m is normal departure padding — NEVER false slow/red!
      if (isOriginLayoverLoop && !coveredByTd) {
        _recordDebugSkip(debugSkips, {
          scope: 'span',
          routeNo,
          company,
          fromSeq: i + 1,
          toSeq: j + 1,
          reason: 'origin_terminus_span',
          detail: `Origin layover loop within 150m clamped Flowing`
        });
        if (busTier !== 'SMOOTH') {
          busTier = 'SMOOTH';
          busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
        }
      } else if (i === 0 && roadDistKm < 1.2 && deltaSec <= 185 && busTier === 'CONGESTED') {
        busTier = 'SMOOTH';
        busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
      }
      // Guard 3: Exclude final terminus-approach span (last 1 stop into terminus like Pat Heung Road)
      // from triggering false "Slow Bus Flow" / "Heavy Bus Flow" warnings caused by terminus arrival padding!
      if (isTerminusApproach && !coveredByTd) {
        _recordDebugSkip(debugSkips, {
          scope: 'span',
          routeNo,
          company,
          fromSeq: i + 1,
          toSeq: j + 1,
          reason: 'terminus_span',
          detail: `${_stripPlatformLabel(a?.stopName_e || '')} -> ${_stripPlatformLabel(b?.stopName_e || '')}`
        });
        if (busTier !== 'SMOOTH') {
          busTier = 'SMOOTH';
          busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
        }
      }

      // Guard 4: Scheduled/headway ETA handling:
      // - Origin terminal departure headway (stop 0 -> 1 from Ferry Pier / Terminus) is ALWAYS Flowing (Green),
      //   so layover/headway gaps at Mui Wo Ferry Pier never trigger false "Slow" warnings!
      // - For NLB corridors when live ETA pairs are sparse between intermediate stops: allow Green/Yellow ONLY (never Red!)
      //   via scheduled/headway interval inference so South Lantau renders cleanly without fabricating speeds.
      // - For all other routes: scheduled-only ETAs never fabricate amber/red delays.
      const isScheduledFallback = Boolean(matched.isScheduledOnly && allowNlbScheduledFallback);
      if (matched.isScheduledOnly) {
        if (i === 0 && isTerminusDep) {
          if (busTier !== 'SMOOTH') {
            _recordDebugSkip(debugSkips, {
              scope: 'span',
              routeNo,
              company,
              fromSeq: i + 1,
              toSeq: j + 1,
              reason: 'origin_terminus_span',
              detail: 'Origin terminal scheduled departure headway classified Flowing'
            });
            busTier = 'SMOOTH';
            busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
          }
        } else if (isScheduledFallback) {
          if (busTier === 'CONGESTED') {
            busTier = 'MODERATE';
            busSpeedKmh = Math.max(busSpeedKmh, roadProfile.moderateMinKmh);
          }
        } else if (busTier !== 'SMOOTH') {
          busTier = 'SMOOTH';
          busSpeedKmh = Math.max(busSpeedKmh, roadProfile.smoothMinKmh);
        }
      }

      if (coveredByTd) {
        _recordDebugSkip(debugSkips, {
          scope: 'span',
          routeNo,
          company,
          fromSeq: i + 1,
          toSeq: j + 1,
          reason: 'covered_by_td',
          detail: tdTruth.tdRoadEn || tdTruth.tdDetId || 'TD ground truth'
        });
      }

      rawSegs.push({
        fromIdx: i,
        toIdx: j,
        fromSeq: i + 1,
        toSeq: j + 1,
        fromNameEn: _stripPlatformLabel(a?.stopName_e || a?.name_tc || ''),
        fromNameTc: _stripPlatformLabel(a?.name_tc || a?.stopName_e || ''),
        toNameEn: _stripPlatformLabel(b?.stopName_e || b?.name_tc || ''),
        toNameTc: _stripPlatformLabel(b?.name_tc || b?.stopName_e || ''),
        routeNo,
        company,
        roadClass: roadProfile.roadClass,
        isRuralWinding,
        isTerminusDep,
        isOriginLayover: isOriginLayoverLoop,
        isTerminusApproach,
        isEtaRoundingArtifact,
        isRoadSnapped: Boolean(sliced.isRoadSnapped),
        smoothMinKmh: roadProfile.smoothMinKmh,
        moderateMinKmh: roadProfile.moderateMinKmh,
        roadDistKm: Math.abs(Number(roadDistKm.toFixed(2))),
        deltaSec: Math.abs(Math.round(deltaSec)),
        busInferredSpeedKmh: Math.abs(busSpeedKmh),
        busInferredTier: busTier,
        speedKmh: Math.abs(busSpeedKmh),
        expectedKmh: roadProfile.expectedKmh,
        tier: busTier,
        isBottleneck: !matched.isScheduledOnly && !isTerminusApproach && !isOriginLayoverLoop && (busTier === 'CONGESTED' || busTier === 'MODERATE'),
        allowRed: false,
        hasConsecutiveSlowSpan: false,
        color: getBusSpeedColorHex(busTier, busSpeedKmh),
        source: 'BUS_API',
        confidence: matched.isScheduledOnly ? 'LOW' : (matched.deltas.length >= 2 ? 'HIGH' : 'MEDIUM'),
        isScheduledOnly: matched.isScheduledOnly,
        isScheduledFallback,
        coveredByTd,
        tdCovered: coveredByTd,
        tdTruth,
        coords: segCoords
      });
      i = j;
    }

    // Pass 2: 2-Stop Sliding-Window Smoothing for short urban hops (< 0.70 km)
    // Eliminates single-intersection traffic-light luck / minute-rounding spikes on empty roads!
    for (let k = 0; k < rawSegs.length; k++) {
      const seg = rawSegs[k];
      if (seg.coveredByTd || seg.isScheduledOnly || seg.isTerminusApproach || seg.isOriginLayover || seg.tier === 'SMOOTH' || seg.roadDistKm >= 0.70) continue;
      const prev = (k > 0 && rawSegs[k - 1].toIdx === seg.fromIdx && !rawSegs[k - 1].isScheduledOnly) ? rawSegs[k - 1] : null;
      const next = (k + 1 < rawSegs.length && rawSegs[k + 1].fromIdx === seg.toIdx && !rawSegs[k + 1].isScheduledOnly) ? rawSegs[k + 1] : null;
      const neighbors = [prev, next].filter(Boolean);
      if (!neighbors.length) continue;

      const combinedDistKm = seg.roadDistKm + neighbors.reduce((acc, n) => acc + n.roadDistKm, 0);
      const combinedSec = seg.deltaSec + neighbors.reduce((acc, n) => acc + n.deltaSec, 0);
      const macroDwell = (neighbors.length + 1) * 28;
      const macroMovingSec = Math.max(30, combinedSec - Math.min(combinedSec * 0.5, macroDwell));
      const macroKmh = combinedDistKm / (macroMovingSec / 3600);

      // If surrounding multi-stop corridor flows smoothly (>= 20 km/h urban), downgrade isolated single-hop spike
      if (macroKmh >= 20) {
        const blended = Math.abs(Number((seg.speedKmh * 0.4 + macroKmh * 0.6).toFixed(1)));
        seg.speedKmh = blended;
        seg.busInferredSpeedKmh = blended;
        seg.tier = blended >= (seg.smoothMinKmh || 17) ? 'SMOOTH' : 'MODERATE';
        seg.busInferredTier = seg.tier;
        seg.isBottleneck = seg.tier !== 'SMOOTH';
        seg.color = getBusSpeedColorHex(seg.tier, seg.speedKmh);
      }
    }

    // Pass 2.5: Require >= 2 consecutive slow/congested live spans before flagging Red (CONGESTED)
    // On Airport Perimeter roads, require speed < 8 km/h across >= 2 consecutive non-terminus spans!
    const preConsecTiers = rawSegs.map(s => ((s.isScheduledOnly || s.isTerminusApproach || s.isOriginLayover) ? 'SMOOTH' : s.tier));
    for (let k = 0; k < rawSegs.length; k++) {
      const seg = rawSegs[k];
      if (seg.coveredByTd || seg.isScheduledOnly || seg.isTerminusApproach || seg.isOriginLayover || seg.tier !== 'CONGESTED') continue;
      const isApZone = seg.roadClass === 'AIRPORT_PERIMETER';
      const neighborQualifies = (idx) => {
        if (idx < 0 || idx >= rawSegs.length) return false;
        const n = rawSegs[idx];
        if (n.isScheduledOnly || n.isTerminusApproach || n.isOriginLayover) return false;
        if (isApZone) return n.speedKmh < 8 && preConsecTiers[idx] === 'CONGESTED';
        return preConsecTiers[idx] === 'CONGESTED' || preConsecTiers[idx] === 'MODERATE';
      };
      const hasPrevSlow = (k > 0 && rawSegs[k - 1].toIdx === seg.fromIdx && neighborQualifies(k - 1));
      const hasNextSlow = (k + 1 < rawSegs.length && rawSegs[k + 1].fromIdx === seg.toIdx && neighborQualifies(k + 1));
      if ((!isApZone || seg.speedKmh < 8) && (hasPrevSlow || hasNextSlow)) {
        seg.hasConsecutiveSlowSpan = true;
        seg.allowRed = true;
      } else {
        const isRuralOrTerminus = Boolean(seg.isRuralWinding || seg.roadClass === 'RURAL_ARTERIAL' || seg.fromIdx === 0 || seg.isTerminusDep);
        const downgradedTier = isApZone
          ? (seg.speedKmh >= 20 ? 'SMOOTH' : 'MODERATE')
          : ((isRuralOrTerminus || seg.roadDistKm < 0.85) ? 'SMOOTH' : 'MODERATE');
        const floorKmh = downgradedTier === 'SMOOTH' ? (seg.smoothMinKmh || 20) : (seg.moderateMinKmh || 14);
        seg.tier = downgradedTier;
        seg.busInferredTier = downgradedTier;
        seg.speedKmh = Math.abs(Math.max(seg.speedKmh, floorKmh));
        seg.busInferredSpeedKmh = seg.speedKmh;
        seg.isBottleneck = downgradedTier !== 'SMOOTH';
        seg.hasConsecutiveSlowSpan = false;
        seg.allowRed = false;
        seg.color = getBusSpeedColorHex(downgradedTier, seg.speedKmh);
      }
    }

    // Pass 3: Apply Strict TD Ground-Truth Priority when a TD speed detector covers the stretch!
    // (e.g., Castle Peak Rd-Ping Shan: TD 70 km/h GREEN overrides slower local bus ETA inference)
    const resolved = rawSegs.map((seg) => {
      const td = seg.tdTruth;
      if (td && td.hasTd) {
        const conflict = (seg.busInferredTier !== td.tdTier);
        return {
          ...seg,
          speedKmh: Math.abs(Number(td.tdSpeedKmh) || 0),
          tier: td.tdTier,
          isBottleneck: td.tdTier === 'CONGESTED' || td.tdTier === 'MODERATE',
          color: td.tdColor,
          source: 'TD',
          tdConflictResolved: conflict,
          detId: td.tdDetId,
          detectorId: td.tdDetId,
          occ: Math.abs(Number(td.tdOcc) || 0),
          roadEn: _sanitizeDirectionTypos(td.tdRoadEn),
          roadTc: _sanitizeDirectionTypos(td.tdRoadTc),
          cam: td.cam,
          camKey: td.cam?.camKey || td.cam?.key || '',
          camDesc: _sanitizeDirectionTypos(td.cam?.desc || '')
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
        camDesc: _sanitizeDirectionTypos(td?.cam?.desc || '')
      };
    });

    publishDebug(resolved);
    return resolved;
  }

  // Unified Stop-by-Stop Traffic Timeline Builder (Single Source of Truth for stop-row pills,
  // horizontal Board -> Terminus journey bar, expanded card banner, and inline "Details >" breakdown!)
  // Strictly enforces 3-tier priority per stop-to-stop span:
  //   1) TD Speed Detector (+ TD Camera if present, with <=60m highway / <=45m side-street & road-name compatibility)
  //   2) Calibrated Bus Speed Inference (+ TD Camera if present, excluding terminus-approach false warnings)
  //   3) TD Camera only (if no speed data yet)
  function buildStopByStopSegmentTraffic(stops, roadPolylinePoints = null, tdDetectors = [], tdCameras = [], busSpeedSegments = [], opts = {}) {
    if (!Array.isArray(stops) || stops.length < 2) return [];
    const detList = Array.isArray(tdDetectors)
      ? tdDetectors
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_DETECTORS__) ? globalScope.__LIVE_TRAFFIC_DETECTORS__ : []);
    const camList = Array.isArray(tdCameras)
      ? tdCameras
      : (Array.isArray(globalScope.__LIVE_TRAFFIC_CAMERAS__) ? globalScope.__LIVE_TRAFFIC_CAMERAS__ : []);
    const routeNo = String(opts.routeNo || '').trim();
    const busMap = new Map();
    if (Array.isArray(busSpeedSegments)) {
      for (let i = 0; i < busSpeedSegments.length; i++) {
        const b = busSpeedSegments[i];
        if (!b || !Number.isFinite(Number(b.fromIdx))) continue;
        const fIdx = Number(b.fromIdx);
        const tIdx = Number.isFinite(Number(b.toIdx)) ? Number(b.toIdx) : (fIdx + 1);
        busMap.set(fIdx, b);
        // If sparse bridging spanned multiple stops, expose the bridged speed cleanly on covered intermediate slots
        for (let m = fIdx + 1; m < tIdx; m++) {
          if (!busMap.has(m)) busMap.set(m, b);
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
      const unsnappedFactor = isRuralWindingCorridor(a, b) ? 1.45 : 1.15;
      const roadDistKm = Math.abs(Number(Math.max(0.06, sliced.isRoadSnapped ? _polylineLengthKm(segCoords) : straightKm * unsnappedFactor).toFixed(2)));

      const tdSpeedGeoJson = (opts.tdSpeedGeoJson !== undefined)
        ? opts.tdSpeedGeoJson
        : (globalScope.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null);
      const tdTruth = matchTdGroundTruthForSpan(segCoords, detList, camList, {
        tdSpeedGeoJson,
        fromStop: a,
        toStop: b,
        roadDistKm,
        isRoadSnapped: Boolean(sliced.isRoadSnapped),
        routeNo,
        stops
      });
      const busSeg = busMap.get(i) || null;
      const destNmCombined = `${b?.stopName_e || ''} ${b?.name_tc || ''}`;
      const isTerminusApproach = Boolean(
        busSeg?.isTerminusApproach ||
        (i === stops.length - 2 && (
          stops.length >= 5 ||
          isTerminusLikeStop(b, -1) ||
          /pat\s*heung\s*r(?:oa)?d|八鄉路/i.test(destNmCombined) ||
          Boolean(opts.excludeTerminusApproach)
        ))
      );

      // Tier 1: TD Speed Detector / Speed Link Ground Truth ALWAYS wins
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
          speedKmh: Math.abs(Number(tdTruth.tdSpeedKmh) || 0),
          color: tdTruth.tdColor,
          occ: Math.abs(Number(tdTruth.tdOcc) || 0),
          detId: tdTruth.tdDetId,
          det: tdTruth.tdDet || null,
          roadEn: _sanitizeDirectionTypos(tdTruth.tdRoadEn),
          roadTc: _sanitizeDirectionTypos(tdTruth.tdRoadTc),
          cam: tdTruth.cam,
          camKey: tdTruth.cam?.camKey || tdTruth.cam?.key || '',
          camDesc: _sanitizeDirectionTypos(tdTruth.cam?.desc || ''),
          roadDistKm,
          deltaSec: busSeg?.deltaSec ? Math.abs(Number(busSeg.deltaSec)) : null,
          expectedKmh: busSeg?.expectedKmh || null,
          busInferredSpeedKmh: busSeg?.busInferredSpeedKmh != null ? Math.abs(Number(busSeg.busInferredSpeedKmh)) : null,
          isTerminusApproach: false,
          isScheduledOnly: false,
          isScheduledFallback: false,
          coords: segCoords
        });
        continue;
      }

      // Tier 2: Calibrated Bus Speed Inference (only when no TD detector or TD speed link covers this stretch)
      if (busSeg && !busSeg.coveredByTd && !busSeg.tdCovered && busSeg.source !== 'TD' && Number.isFinite(Number(busSeg.speedKmh))) {
        let tier = normalizeTrafficTier(busSeg.tier, Math.abs(Number(busSeg.speedKmh)));
        let effSpeed = Math.abs(Math.round(Number(busSeg.speedKmh)));
        if (isTerminusApproach && tier !== 'SMOOTH') {
          tier = 'SMOOTH';
          effSpeed = Math.max(effSpeed, Math.round(Number(busSeg.smoothMinKmh) || 18));
        }
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
          speedKmh: effSpeed,
          color: getBusSpeedColorHex(tier, effSpeed),
          occ: 0,
          detId: '',
          det: null,
          roadEn: `${fromNameEn} → ${toNameEn}`.trim(),
          roadTc: `${fromNameTc || fromNameEn} → ${toNameTc || toNameEn}`.trim(),
          cam: matchedCam,
          camKey: matchedCam?.camKey || matchedCam?.key || '',
          camDesc: _sanitizeDirectionTypos(matchedCam?.desc || ''),
          roadDistKm: Math.abs(Number(busSeg.roadDistKm || roadDistKm)),
          deltaSec: busSeg.deltaSec ? Math.abs(Number(busSeg.deltaSec)) : null,
          expectedKmh: busSeg.expectedKmh || null,
          confidence: busSeg.confidence || 'MEDIUM',
          isScheduledOnly: Boolean(busSeg.isScheduledOnly),
          isScheduledFallback: Boolean(busSeg.isScheduledFallback),
          isTerminusApproach,
          allowRed: Boolean(busSeg.allowRed && !isTerminusApproach),
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
          det: null,
          roadEn: tdTruth.cam.desc || `${fromNameEn} → ${toNameEn}`.trim(),
          roadTc: tdTruth.cam.desc || `${fromNameTc || fromNameEn} → ${toNameTc || toNameEn}`.trim(),
          cam: tdTruth.cam,
          camKey: tdTruth.cam.camKey || tdTruth.cam.key || '',
          camDesc: tdTruth.cam.desc || '',
          roadDistKm,
          deltaSec: null,
          expectedKmh: null,
          isTerminusApproach,
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
        det: null,
        roadEn: `${fromNameEn} → ${toNameEn}`.trim(),
        roadTc: `${fromNameTc || fromNameEn} → ${toNameTc || toNameEn}`.trim(),
        cam: null,
        camKey: '',
        camDesc: '',
        roadDistKm,
        deltaSec: null,
        expectedKmh: null,
        isTerminusApproach,
        coords: segCoords
      });
    }

    return out;
  }

  // Quantized directional stretch key (~220m cell + 45° travel octant) for corridor deduplication
  function _corridorStretchKey(aLat, aLon, bLat, bLon) {
    const midLat = (aLat + bLat) * 0.5;
    const midLon = (aLon + bLon) * 0.5;
    const brg = _bearingDegLocal(aLat, aLon, bLat, bLon);
    const oct = Math.round(brg / 45) % 8;
    return `${Math.round(midLat * 450)}_${Math.round(midLon * 450)}_${oct}`;
  }

  // Multi-operator spatially-balanced corridor selector for Global Bus Speed Overlay (KMB, LWB, CTB, NLB, GMB, MTRB).
  // - Uses exact segment-vs-bounds intersection so zoomed-in z14–16 viewports NEVER drop corridors whose endpoints lie outside!
  // - Uses 4x4 viewport spatial macro-grid bucketing + South Lantau NLB corridor guarantees (1, 2, 3M, 4, 11, 23, A35)
  //   so dense urban hubs (e.g. Tung Chung) NEVER crowd out South Lantau at Lantau-wide zoom (z11–13).
  // - Deduplicates overlapping routes on the exact same corridor and skips routes fully covered by TD detectors.
  function selectGlobalBusSpeedRoutes(routePool, bounds, getStopsForGroupFn, maxRoutesOrOpts = 40, tdDetectorsArg = null, tdSpeedGeoJsonArg = null) {
    if (!Array.isArray(routePool) || !routePool.length || !bounds || (typeof bounds.contains !== 'function' && !_extractBoundsBox(bounds))) return [];
    const opts = (maxRoutesOrOpts && typeof maxRoutesOrOpts === 'object') ? maxRoutesOrOpts : {};
    const rawMax = (typeof maxRoutesOrOpts === 'number') ? maxRoutesOrOpts : (Number(opts.maxRoutes) || 40);
    const effectiveMax = (rawMax <= 0 || !Number.isFinite(rawMax)) ? 40 : Math.min(80, Math.max(1, Math.floor(rawMax)));
    const tdDetectors = Array.isArray(tdDetectorsArg)
      ? tdDetectorsArg
      : (Array.isArray(opts.tdDetectors) ? opts.tdDetectors : []);
    const tdSpeedGeoJson = tdSpeedGeoJsonArg !== null && tdSpeedGeoJsonArg !== undefined
      ? tdSpeedGeoJsonArg
      : (opts.tdSpeedGeoJson || null);
    const box = _extractBoundsBox(bounds);

    // Build spatial index of TD-covered directional stretch cells (detectors + TD speed-map links)
    const tdCoveredCells = new Set();
    const markTdCell = (lat, lon, brgDeg, isUndiv = false) => {
      const cLat = Math.round(lat * 450);
      const cLon = Math.round(lon * 450);
      if (Number.isFinite(brgDeg)) {
        const oct = Math.round((((brgDeg % 360) + 360) % 360) / 45) % 8;
        tdCoveredCells.add(`${cLat}_${cLon}_${oct}`);
        tdCoveredCells.add(`${cLat}_${cLon}_${(oct + 1) % 8}`);
        tdCoveredCells.add(`${cLat}_${cLon}_${(oct + 7) % 8}`);
        if (isUndiv) {
          const opp = (oct + 4) % 8;
          tdCoveredCells.add(`${cLat}_${cLon}_${opp}`);
          tdCoveredCells.add(`${cLat}_${cLon}_${(opp + 1) % 8}`);
          tdCoveredCells.add(`${cLat}_${cLon}_${(opp + 7) % 8}`);
        }
      } else {
        for (let o = 0; o < 8; o++) tdCoveredCells.add(`${cLat}_${cLon}_${o}`);
      }
    };
    if (tdDetectors.length) {
      for (let i = 0; i < tdDetectors.length; i++) {
        const d = tdDetectors[i];
        const dLat = Number(d?.lat), dLon = Number(d?.lon);
        if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) continue;
        if (!_segmentIntersectsBounds(dLat, dLon, dLat, dLon, bounds)) continue;
        const isUndiv = isUndividedUrbanRoad(d.roadEn || '', d.roadTc || '', d.id || '');
        markTdCell(dLat, dLon, Number.isFinite(Number(d.rot)) ? Number(d.rot) : NaN, isUndiv);
      }
    }
    const tdSpeedFeats = Array.isArray(tdSpeedGeoJson)
      ? tdSpeedGeoJson
      : (Array.isArray(tdSpeedGeoJson?.features) ? tdSpeedGeoJson.features : []);
    if (tdSpeedFeats.length) {
      for (let i = 0; i < tdSpeedFeats.length; i++) {
        const f = tdSpeedFeats[i];
        const p = f?.properties || {};
        if (p.hasSpeedData === false) continue;
        const spdVal = Number(p.spd ?? p.speedKmh);
        if ((p.spd === null || p.spd === undefined) && (p.speedKmh === null || p.speedKmh === undefined)) continue;
        if (!Number.isFinite(spdVal)) continue;
        const rc = _extractSpeedLinkCoords(f);
        if (!rc || rc.length < 2) continue;
        const isUndiv = isUndividedUrbanRoad(p.roadEn || '', p.roadTc || '', p.id || p.detectorId || '');
        for (let k = 0; k < rc.length - 1; k++) {
          const a = rc[k], b = rc[k + 1];
          if (!Array.isArray(a) || !Array.isArray(b)) continue;
          const la1 = Number(a[1]), lo1 = Number(a[0]), la2 = Number(b[1]), lo2 = Number(b[0]);
          if (!Number.isFinite(la1) || !Number.isFinite(lo1) || !Number.isFinite(la2) || !Number.isFinite(lo2)) continue;
          if (!_segmentIntersectsBounds(la1, lo1, la2, lo2, bounds)) continue;
          const mLat = (la1 + la2) * 0.5, mLon = (lo1 + lo2) * 0.5;
          const brg = _haversineKmLocal(la1, lo1, la2, lo2) >= 0.004
            ? _bearingDegLocal(la1, lo1, la2, lo2)
            : (Number.isFinite(Number(p.rot)) ? Number(p.rot) : NaN);
          markTdCell(mLat, mLon, brg, isUndiv);
        }
      }
    }

    const macroBucketOf = (lat, lon) => {
      if (!box) return `${Math.floor(lat * 25)}_${Math.floor(lon * 25)}`;
      const latSpan = Math.max(1e-5, box.north - box.south);
      const lonSpan = Math.max(1e-5, box.east - box.west);
      const qy = Math.max(0, Math.min(3, Math.floor(((lat - box.south) / latSpan) * 4)));
      const qx = Math.max(0, Math.min(3, Math.floor(((lon - box.west) / lonSpan) * 4)));
      return `${qy}_${qx}`;
    };

    const candidates = [];
    const seenRouteFamily = new Set();
    const skipReasons = [];
    let outsideCount = 0;
    let tdCoveredRouteCount = 0;

    for (let i = 0; i < routePool.length; i++) {
      const g = routePool[i];
      if (!g || (g.mode && g.mode !== 'BUS')) continue;
      const rId = g.routeIds?.[0] || '';
      const co = String(g.company || '').toUpperCase();
      const isKmbLwb = co === 'KMB' || co === 'LWB' || rId.startsWith('KMB_') || rId.startsWith('LWB_');
      const isNlb = co === 'NLB' || rId.startsWith('NLB_');
      const isCtb = co === 'CTB' || rId.startsWith('CTB_');
      const isGmb = co.startsWith('GMB') || rId.startsWith('GMB_');
      const isMtrb = co === 'MTRB' || co === 'MTR BUS' || rId.startsWith('MTRB_');
      if (!isKmbLwb && !isNlb && !isCtb && !isGmb && !isMtrb) continue;

      const stops = typeof getStopsForGroupFn === 'function' ? getStopsForGroupFn(g, null) : (g.stops || []);
      if (!Array.isArray(stops) || stops.length < 2) continue;

      const inBoundsIdxSet = new Set();
      const stretchCells = new Set();
      const unmonitoredCells = new Set();
      const macroBuckets = new Set();

      for (let s = 0; s < stops.length; s++) {
        const la = parseFloat(stops[s]?.latitude ?? stops[s]?.lat);
        const lo = parseFloat(stops[s]?.longitude ?? stops[s]?.lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
        const inHere = _segmentIntersectsBounds(la, lo, la, lo, bounds);
        if (inHere) inBoundsIdxSet.add(s);
        if (s + 1 < stops.length) {
          const lb = parseFloat(stops[s + 1]?.latitude ?? stops[s + 1]?.lat);
          const lob = parseFloat(stops[s + 1]?.longitude ?? stops[s + 1]?.lon);
          if (!Number.isFinite(lb) || !Number.isFinite(lob)) continue;
          // Exact segment-vs-bounds intersection ensures zoomed-in z14–16 viewports
          // keep rural NLB corridors even when both endpoints lie outside the viewport!
          if (inHere || _segmentIntersectsBounds(la, lo, lb, lob, bounds)) {
            inBoundsIdxSet.add(s);
            inBoundsIdxSet.add(s + 1);
            const cellKey = _corridorStretchKey(la, lo, lb, lob);
            stretchCells.add(cellKey);
            if (!tdCoveredCells.has(cellKey)) {
              unmonitoredCells.add(cellKey);
              macroBuckets.add(macroBucketOf((la + lb) * 0.5, (lo + lob) * 0.5));
            }
          }
        }
      }

      if (inBoundsIdxSet.size < 2 && stretchCells.size < 1) {
        outsideCount++;
        continue;
      }
      // Skip routes whose entire visible stretch is already covered by TD speed detectors
      if (tdCoveredCells.size > 0 && unmonitoredCells.size === 0) {
        tdCoveredRouteCount++;
        _recordDebugSkip(skipReasons, {
          scope: 'route',
          routeNo: g.routeNo || '',
          company: co,
          fromSeq: null,
          toSeq: null,
          reason: 'covered_by_td'
        });
        continue;
      }

      // Preserve BOTH directions for NLB/GMB/KMB/CTB (NLB uses tdBound / routeId rather than bound!)
      const rParts = rId.split('_');
      const dirToken = g.bound || g.tdBound || (rParts.length >= 3 ? rParts[2] : '') || rId || g.dest_e || g.key || '';
      const famKey = `${co}|${g.routeNo || ''}|${dirToken}`;
      if (seenRouteFamily.has(famKey)) continue;
      seenRouteFamily.add(famKey);

      const inBoundsIndices = Array.from(inBoundsIdxSet).sort((x, y) => x - y);
      const operator = isKmbLwb ? 'KMB' : (isNlb ? 'NLB' : (isCtb ? 'CTB' : (isGmb ? 'GMB' : 'MTRB')));
      const routeNoUpper = String(g.routeNo || '').toUpperCase();
      const isPriorityNlb = Boolean(isNlb && NLB_PRIORITY_CORRIDOR_ROUTES.has(routeNoUpper));
      const efficiencyBonus = isPriorityNlb ? 2.8 : (isKmbLwb ? 1.5 : (isNlb ? 1.4 : (isCtb ? 0.6 : 0)));
      candidates.push({
        group: g,
        stops,
        operator,
        boundKey: dirToken,
        isPriorityNlb,
        macroBuckets: Array.from(macroBuckets),
        inBoundsIndices,
        stretchCells: unmonitoredCells.size ? unmonitoredCells : stretchCells,
        efficiencyBonus,
        score: (unmonitoredCells.size || stretchCells.size) * 2 + efficiencyBonus
      });
    }

    const picked = [];
    const coveredCells = new Set();
    const used = new Uint8Array(candidates.length);

    const countNovel = (cand) => {
      let novel = 0;
      cand.stretchCells.forEach((ck) => {
        if (!coveredCells.has(ck)) novel++;
      });
      return novel;
    };

    const acceptCandidate = (idx, novelCount, quadrantBucket = '') => {
      used[idx] = 1;
      const win = candidates[idx];
      win.stretchCells.forEach((ck) => coveredCells.add(ck));
      picked.push({
        group: win.group,
        stops: win.stops,
        operator: win.operator,
        boundKey: win.boundKey,
        isPriorityNlb: win.isPriorityNlb,
        quadrantBucket,
        inBoundsIndices: win.inBoundsIndices,
        novelCellCount: novelCount,
        score: win.score
      });
    };

    // Stage 1: Guarantee South Lantau / NLB priority corridors (1, 2, 3M, 4, 11, 23, A35)
    // whenever they intersect the viewport with uncovered road stretches!
    // Include ALL priority NLB routes in the viewport (preferring novel stretches first, then overlapping
    // South Lantau routes up to 14 slots) because sparse 15–30 min rural headways require multiple overlapping
    // NLB routes for continuous coverage, while the Directional Road-Cell Occupancy Grid merges them into ONE line.
    const maxPriorityNlbSlots = Math.min(14, effectiveMax);
    let priorityNlbPicked = 0;
    while (picked.length < effectiveMax && priorityNlbPicked < maxPriorityNlbSlots) {
      let bestIdx = -1;
      let bestGain = -1;
      let bestNovel = 0;
      for (let i = 0; i < candidates.length; i++) {
        if (used[i] || !candidates[i].isPriorityNlb) continue;
        const novel = countNovel(candidates[i]);
        const gain = novel > 0
          ? (1000 + novel * 2 + candidates[i].efficiencyBonus)
          : (candidates[i].stretchCells.size + candidates[i].efficiencyBonus);
        if (gain > bestGain) {
          bestGain = gain;
          bestNovel = novel;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      acceptCandidate(bestIdx, bestNovel, candidates[bestIdx].macroBuckets[0] || 'nlb');
      priorityNlbPicked++;
    }

    // Stage 2: Spatially balanced 4x4 macro-grid round-robin so dense urban clusters (Tung Chung)
    // NEVER crowd out rural corridors (Mui Wo / Pui O / Cheung Sha / Tong Fuk / Sai Kung) at z11–13!
    const bucketToIndices = new Map();
    for (let i = 0; i < candidates.length; i++) {
      if (used[i]) continue;
      const bks = candidates[i].macroBuckets.length ? candidates[i].macroBuckets : ['0_0'];
      for (let b = 0; b < bks.length; b++) {
        const bk = bks[b];
        let arr = bucketToIndices.get(bk);
        if (!arr) {
          arr = [];
          bucketToIndices.set(bk, arr);
        }
        arr.push(i);
      }
    }
    const bucketKeys = Array.from(bucketToIndices.keys()).sort();
    for (let round = 0; round < 2 && picked.length < effectiveMax && bucketKeys.length > 1; round++) {
      let anyPickedThisRound = false;
      for (let b = 0; b < bucketKeys.length && picked.length < effectiveMax; b++) {
        const bk = bucketKeys[b];
        const idxs = bucketToIndices.get(bk) || [];
        let bestIdx = -1;
        let bestGain = -1;
        let bestNovel = 0;
        for (let k = 0; k < idxs.length; k++) {
          const ci = idxs[k];
          if (used[ci]) continue;
          const novel = countNovel(candidates[ci]);
          if (novel <= 0) continue;
          const gain = novel * 2 + candidates[ci].efficiencyBonus;
          if (gain > bestGain) {
            bestGain = gain;
            bestNovel = novel;
            bestIdx = ci;
          }
        }
        if (bestIdx >= 0) {
          acceptCandidate(bestIdx, bestNovel, bk);
          anyPickedThisRound = true;
        }
      }
      if (!anyPickedThisRound) break;
    }

    // Stage 3: Greedy global set-cover for all remaining distinct unmonitored road stretches
    while (picked.length < effectiveMax) {
      let bestIdx = -1;
      let bestGainScore = -1;
      let bestNovelCount = 0;

      for (let i = 0; i < candidates.length; i++) {
        if (used[i]) continue;
        const c = candidates[i];
        const novel = countNovel(c);
        if (novel <= 0) continue;
        const gainScore = novel * 2 + c.efficiencyBonus;
        if (gainScore > bestGainScore) {
          bestGainScore = gainScore;
          bestNovelCount = novel;
          bestIdx = i;
        }
      }

      if (bestIdx < 0 || bestNovelCount <= 0) break;
      acceptCandidate(bestIdx, bestNovelCount, candidates[bestIdx].macroBuckets[0] || '');
    }

    // Publish selection diagnostics on window.__BUS_SPEED_DEBUG__
    if (!opts.skipGlobalDebugUpdate) {
      const dbg = _ensureBusSpeedDebugState();
      dbg.updatedAt = new Date().toISOString();
      if (box) dbg.bounds = box;
      dbg.selectedRoutes = picked.map((p) => ({
        key: p.group?.key || `${p.operator}_${p.group?.routeNo || ''}_${p.boundKey || ''}`,
        company: p.group?.company || p.operator,
        routeNo: p.group?.routeNo || '',
        bound: p.boundKey || p.group?.bound || p.group?.tdBound || '',
        operator: p.operator,
        novelCellCount: p.novelCellCount,
        inBoundsCount: p.inBoundsIndices?.length || 0,
        quadrantBucket: p.quadrantBucket || '',
        priorityNlb: Boolean(p.isPriorityNlb)
      }));
      if (outsideCount > 0) {
        _recordDebugSkip(skipReasons, {
          scope: 'route',
          routeNo: '*',
          company: '*',
          fromSeq: null,
          toSeq: null,
          reason: 'outside_viewport',
          detail: `${outsideCount} routes outside current viewport`
        });
      }
      dbg.selectionSummary = {
        totalPool: routePool.length,
        candidatesInViewport: candidates.length,
        selectedCount: picked.length,
        outsideViewportCount: outsideCount,
        coveredByTdRouteCount: tdCoveredRouteCount
      };
      if (skipReasons.length) {
        dbg.skipReasons = skipReasons.slice(0, 200);
        dbg.skipReasonCounts = _tallySkipReasons(dbg.skipReasons);
      }
    }

    return picked;
  }

  const BusSpeedEngine = {
    NLB_PRIORITY_CORRIDOR_ROUTES,
    getBusSpeedColorHex,
    sanitizeDirectionTypos: _sanitizeDirectionTypos,
    normalizeTrafficTier,
    isScheduledBusEtaEntry,
    isTerminusLikeStop,
    isRuralWindingCorridor,
    isUndividedUrbanRoad,
    isAirportPerimeterZone,
    isNarrowTwoWayLocalRoad,
    extractExplicitRoadStems,
    areRoadNamesCompatible,
    classifyBusRoadClass,
    sliceStopSpanPolyline,
    subdividePolylineMicroSteps,
    buildTdSpatialIndex,
    isMicroStepCoveredByTd,
    aggregateBusMicroStepsToCorridors,
    segmentIntersectsBounds: _segmentIntersectsBounds,
    polylineIntersectsBounds: _polylineIntersectsBounds,
    isSegmentCoveredByTdGroundTruth,
    matchTdGroundTruthForSpan,
    inferBusApiSegmentSpeeds,
    buildStopByStopSegmentTraffic,
    selectGlobalBusSpeedRoutes
  };

  globalScope.BusSpeedEngine = BusSpeedEngine;
  globalScope.getBusSpeedLayerColorHex = getBusSpeedColorHex;
  globalScope.isSegmentCoveredByTdGroundTruth = isSegmentCoveredByTdGroundTruth;
  globalScope.subdividePolylineMicroSteps = subdividePolylineMicroSteps;
  globalScope.aggregateBusMicroStepsToCorridors = aggregateBusMicroStepsToCorridors;
  globalScope.areRoadNamesCompatible = areRoadNamesCompatible;
  globalScope.inferBusApiSegmentSpeeds = inferBusApiSegmentSpeeds;
  globalScope.buildStopByStopSegmentTraffic = buildStopByStopSegmentTraffic;
  globalScope.selectGlobalBusSpeedRoutes = selectGlobalBusSpeedRoutes;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BusSpeedEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
