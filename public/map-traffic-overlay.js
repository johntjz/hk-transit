// ============================================================================
// File: map-traffic-overlay.js (johntjz/Hk-Fleet — Live TD Traffic, Cameras & Bus Speed Map Overlay)
// ============================================================================

if (typeof window !== 'undefined') {
  if (typeof window.mapInstance === 'undefined') window.mapInstance = null;
  if (typeof window.browseMapInstance === 'undefined') window.browseMapInstance = null;
  if (typeof window.xferMapInstance === 'undefined') window.xferMapInstance = null;
}

var detailPolylineLayer = (typeof detailPolylineLayer !== 'undefined') ? detailPolylineLayer : null;
var mapMarkers = (typeof mapMarkers !== 'undefined') ? mapMarkers : {};
var currentDetailRoadCoords = (typeof currentDetailRoadCoords !== 'undefined') ? currentDetailRoadCoords : [];
var currentDetailCorridorMeta = (typeof currentDetailCorridorMeta !== 'undefined') ? currentDetailCorridorMeta : null;

var _trafficLayerByMap = new WeakMap();
var _trafficMarkersByMap = new WeakMap();
var _trafficMoveTimerByMap = new WeakMap();
window.trafficLayerEnabled = true;
window.globalTrafficLayerEnabled = false;
window.busSpeedLayerEnabled = false;
window.__DETAIL_BUS_SPEED_SEGMENTS__ = [];
window.__GLOBAL_BUS_SPEED_SEGMENTS__ = null;
window.__GLOBAL_BUS_SPEED_CACHE__ = window.__GLOBAL_BUS_SPEED_CACHE__ || new Map();
window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__ = window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__ || new Map();
var _globalTrafficLayerGroup = null;
var _globalCameraClusterGroup = null;
var _globalBusSpeedLayerGroup = null;
var _globalBusSpeedLastAggStats = null;
var _globalBusSpeedLastCorridors = [];
var _globalTrafficControl = null;
var _globalTrafficMoveTimer = null;
var _globalBusSpeedFetchToken = 0;
var _detailBusSpeedSyncToken = 0;
var _detailFocusedAwayFromStop = false;
const GLOBAL_CAMERA_MIN_ZOOM = 14;

function projectPointMeters(lat, lon, bearingDeg, meters) {
  const rad = (Number(bearingDeg) || 0) * Math.PI / 180;
  const dLat = (meters * Math.cos(rad)) / 111111;
  const dLon = (meters * Math.sin(rad)) / (111111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lat + dLat, lon + dLon];
}

function classifyTrafficBoundMeta(rotDeg, dirStr = '', isZh = false) {
  const dirTxt = String(dirStr || '').toLowerCase();
  let boundKey = '';
  if (/\bnorth\b|\bnb\b|北行/.test(dirTxt)) boundKey = 'N';
  else if (/\bsouth\b|\bsb\b|南行/.test(dirTxt)) boundKey = 'S';
  else if (/\beast\b|\beb\b|東行/.test(dirTxt)) boundKey = 'E';
  else if (/\bwest\b|\bwb\b|西行/.test(dirTxt)) boundKey = 'W';

  if (!boundKey) {
    const r = ((Number(rotDeg) || 0) % 360 + 360) % 360;
    if (r >= 315 || r < 45) boundKey = 'N';
    else if (r >= 45 && r < 135) boundKey = 'E';
    else if (r >= 135 && r < 225) boundKey = 'S';
    else boundKey = 'W';
  }

  const table = {
    N: { boundKey: 'N', shortEn: 'N', shortTc: '北', labelEn: 'Northbound', labelTc: '北行', arrowGlyph: '↑', badgeBg: '#1D4ED8' },
    S: { boundKey: 'S', shortEn: 'S', shortTc: '南', labelEn: 'Southbound', labelTc: '南行', arrowGlyph: '↓', badgeBg: '#7C3AED' },
    E: { boundKey: 'E', shortEn: 'E', shortTc: '東', labelEn: 'Eastbound', labelTc: '東行', arrowGlyph: '→', badgeBg: '#0F766E' },
    W: { boundKey: 'W', shortEn: 'W', shortTc: '西', labelEn: 'Westbound', labelTc: '西行', arrowGlyph: '←', badgeBg: '#C2410C' }
  };
  const m = table[boundKey] || table.N;
  return {
    ...m,
    shortLabel: isZh ? m.shortTc : m.shortEn,
    fullLabel: isZh ? m.labelTc : m.labelEn
  };
}

function sanitizeBottleneckLabel(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // Fix upstream TD direction typos (e.g. "Souththbound" -> "Southbound")
  s = s.replace(/\bSouththbound\b/gi, 'Southbound')
       .replace(/\bNorththbound\b/gi, 'Northbound')
       .replace(/\bEastthbound\b/gi, 'Eastbound')
       .replace(/\bWestthbound\b/gi, 'Westbound');
  // Strip raw telemetry compass degrees or malformed quote-degree artifacts (e.g. "250°", "250\"", "· 250°", "(250°)")
  s = s.replace(/\s*[·•\-–—]?\s*\(\s*\d{1,3}\s*(?:°|deg|["″”]|'')\s*\)/gi, '');
  s = s.replace(/\s*[·•]\s*\d{1,3}\s*(?:°|deg|["″”]|'')(?=\s|$|[·•,;)\]])/gi, '');
  s = s.replace(/(?:[\s·•\-–—]+)?\b\d{1,3}\s*(?:°|deg|["″”]|'')\s*$/gi, '');
  s = s.replace(/\s*[·•]\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

function _findOppositeTrafficDetectorId(det) {
  if (!det || !Number.isFinite(det.lat) || !Number.isFinite(det.lon)) return '';
  const list = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  if (!list.length) return '';
  const cosLat = Math.max(0.2, Math.cos(det.lat * Math.PI / 180));
  let bestId = '';
  let bestDistKm = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || c.id === det.id || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    if (Number.isFinite(Number(det.rot)) && Number.isFinite(Number(c.rot))) {
      if (_mapAngDiffDeg(det.rot, c.rot) < 135) continue;
    } else {
      continue;
    }
    const dKm = Math.hypot((c.lat - det.lat) * 111.111, (c.lon - det.lon) * 111.111 * cosLat);
    if (dKm <= 0.18 && dKm < bestDistKm) {
      bestDistKm = dKm;
      bestId = c.id;
    }
  }
  return bestId;
}

function buildTrafficDetectorPopupHtml(det, isZh) {
  const roadName = sanitizeBottleneckLabel(isZh ? (det.roadTc || det.roadEn || '主要幹道') : (det.roadEn || det.roadTc || 'Major Road')) || (isZh ? '主要幹道' : 'Major Road');
  const tierCol = det.tier === 'JAMMED' ? '#DC2626' : (det.tier === 'SLOW' ? '#D97706' : '#16A34A');
  const tierLbl = det.tier === 'JAMMED'
    ? (isZh ? '交通擠塞' : 'Jammed')
    : (det.tier === 'SLOW' ? (isZh ? '車多緩慢' : 'Slow') : (isZh ? '暢順無延誤' : 'Clear'));
  const boundMeta = classifyTrafficBoundMeta(det.rot, det.dir, isZh);
  const dec = (typeof synthesizeTrafficDecision === 'function')
    ? synthesizeTrafficDecision({ status: det.tier || 'SMOOTH', avgSpd: Number(det.spd) || 0, minSpd: Number(det.spd) || 0, maxOcc: Number(det.occ) || 0, worstDet: det }, null, isZh)
    : null;
  const verdictLine = sanitizeBottleneckLabel(dec ? (isZh ? dec.verdictTc : dec.verdictEn) : tierLbl);
  const occVal = Number(det.occ) || 0;
  const escId = escapeJsAttr(det.id || '');
  const btnLbl = det.camKey
    ? (isZh ? '📷 查看完整路況及實拍 ›' : '📷 Full Road Analysis & Cam ›')
    : (isZh ? '📊 查看詳細路況 ›' : '📊 Full Road Analysis ›');

  return `
    <div style="min-width:205px; max-width:248px; font-family:inherit; color:#1C1C1E;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px;">
        <span style="font-weight:800; font-size:0.82rem; line-height:1.25;">${escapeHtml(roadName)}</span>
        <span style="font-weight:800; font-size:0.70rem; color:${tierCol}; white-space:nowrap;">${escapeHtml(tierLbl)}</span>
      </div>
      <div style="display:flex; align-items:center; gap:6px; margin-top:5px; flex-wrap:wrap;">
        <span style="display:inline-flex; align-items:center; gap:3px; padding:2px 7px; border-radius:999px; background:${boundMeta.badgeBg}; color:#FFFFFF; font-size:0.68rem; font-weight:800; letter-spacing:0.01em;">
          ${boundMeta.arrowGlyph} ${escapeHtml(boundMeta.fullLabel)}
        </span>
        <span style="font-size:0.72rem; font-weight:700; color:${tierCol};">${escapeHtml(verdictLine)}</span>
      </div>
      <div style="display:flex; align-items:baseline; gap:10px; margin-top:6px; padding-top:6px; border-top:1px solid rgba(0,0,0,0.08); font-variant-numeric:tabular-nums;">
        <span style="font-size:1.02rem; font-weight:800; color:${tierCol};">${Math.abs(Math.round(Number(det.spd) || 0))} <span style="font-size:0.70rem; font-weight:600;">km/h</span></span>
        <span style="font-size:0.72rem; font-weight:600; color:#475569;">${Math.abs(Math.round(Number(occVal) || 0))}% ${isZh ? '佔用率' : 'occ'}</span>
      </div>
      <button type="button"
        onclick="event.stopPropagation(); if(typeof window.openTrafficDecisionModal==='function')window.openTrafficDecisionModal('${escId}');"
        style="margin-top:8px; width:100%; border:none; border-radius:8px; background:#0F172A; color:#FFFFFF; font-size:0.74rem; font-weight:700; padding:8px 10px; cursor:pointer; text-align:center;">
        ${btnLbl}
      </button>
    </div>
  `;
}

function _mapBearingDeg(lat1, lon1, lat2, lon2) {
  if (typeof computeBearingDeg === 'function') return computeBearingDeg(lat1, lon1, lat2, lon2);
  const toRad = Math.PI / 180;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function _mapAngDiffDeg(a, b) {
  if (typeof angularDiffDeg === 'function') return angularDiffDeg(a, b);
  const d = Math.abs(((Number(a) || 0) - (Number(b) || 0)) % 360);
  return d > 180 ? 360 - d : d;
}

function _mapPointToSegDistKm(pLat, pLon, aLat, aLon, bLat, bLon) {
  if (typeof pointToSegmentDistanceKm === 'function') {
    const res = pointToSegmentDistanceKm(pLat, pLon, aLat, aLon, bLat, bLon);
    if (res && typeof res === 'object' && Number.isFinite(res.distKm)) return res.distKm;
    if (Number.isFinite(res)) return res;
  }
  const cosLat = Math.max(0.2, Math.cos(((aLat + bLat) / 2) * Math.PI / 180));
  const ax = aLon * 111.111 * cosLat, ay = aLat * 111.111;
  const bx = bLon * 111.111 * cosLat, by = bLat * 111.111;
  const px = pLon * 111.111 * cosLat, py = pLat * 111.111;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function _computeCorridorBbox(coords, padDeg = 0.004) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    const la = Number(coords[i]?.[0]), lo = Number(coords[i]?.[1]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat: minLat - padDeg, maxLat: maxLat + padDeg, minLon: minLon - padDeg, maxLon: maxLon + padDeg };
}

function _stopsHaveHighwaySpan(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return false;
  const bbiRe = /tunnel|toll\s*plaza|\bbbi\b|highway|interchange|tsing\s*ma|lantau\s*link|轉車站|隧道|收費廣場|公路/i;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    const aName = `${a?.stopName_e || ''} ${a?.name_tc || ''}`;
    const bName = `${b?.stopName_e || ''} ${b?.name_tc || ''}`;
    if (bbiRe.test(aName) || bbiRe.test(bName)) return true;
    const la1 = parseFloat(a?.latitude ?? a?.lat), lo1 = parseFloat(a?.longitude ?? a?.lon);
    const la2 = parseFloat(b?.latitude ?? b?.lat), lo2 = parseFloat(b?.longitude ?? b?.lon);
    if (Number.isFinite(la1) && Number.isFinite(lo1) && Number.isFinite(la2) && Number.isFinite(lo2)) {
      if (typeof calculateDistanceKm === 'function' && calculateDistanceKm(la1, lo1, la2, lo2) >= 2.0) return true;
    }
  }
  return false;
}

function _isDividedHighwaySnapRoadMap(det) {
  if (!det) return false;
  if (typeof window !== 'undefined' && typeof window.isDividedHighwaySnapRoadHardcode === 'function') {
    return window.isDividedHighwaySnapRoadHardcode(det.roadEn || det.desc || '', det.roadTc || det.descTc || '', det.id || det.key || '');
  }
  const txt = `${det.roadEn || det.desc || ''} ${det.roadTc || det.descTc || ''} ${det.id || det.key || ''}`;
  return /\b(?:tuen\s*mun\s*r(?:oa)?d|tmr|yuen\s*long\s*h(?:igh)?w(?:a)?y|ylh|north\s*lantau\s*h(?:igh)?w(?:a)?y|nlh|tuen\s*mun[\s–-]*chek\s*lap\s*kok|tm[\s-]*clk(?:l)?|shun\s*long\s*r(?:oa)?d|lantau\s*link|tds91038)\b|屯門公路|元朗公路|北大嶼山公路|屯門至?赤鱲角|順朗路|青嶼幹線/i.test(txt);
}

function _isRoundaboutOrInterchangeMap(det) {
  if (!det) return false;
  if (typeof window !== 'undefined' && typeof window.isRoundaboutOrInterchangeDetectorHardcode === 'function') {
    return window.isRoundaboutOrInterchangeDetectorHardcode(det.roadEn || det.desc || '', det.roadTc || det.descTc || '', det.id || det.key || '', det.lat, det.lon);
  }
  const txt = `${det.roadEn || det.desc || ''} ${det.roadTc || det.descTc || ''} ${det.id || det.key || ''}`;
  if (/\b(?:roundabout|interchange|rotary|au\s*tau|pok\s*oi|long\s*tin|hung\s*tin|lung\s*mun\s*r(?:oa)?d|tm[\s-]*clk[\s-]*roundabout|tai\s*lam\s*tunnel\s*approach)\b|迴旋處|交匯處|凹頭|博愛|朗天路|洪天路|龍門路/i.test(txt)) {
    return true;
  }
  const la = Number(det.lat), lo = Number(det.lon);
  if (Number.isFinite(la) && Number.isFinite(lo)) {
    const hubs = [
      [22.4445, 114.0415],
      [22.4355, 114.0108],
      [22.4422, 114.0005],
      [22.3745, 113.9565]
    ];
    for (let i = 0; i < hubs.length; i++) {
      if (_distanceMetersFast(la, lo, hubs[i][0], hubs[i][1]) <= 280) return true;
    }
  }
  return false;
}

function _isRoundaboutBottleneckMap(det) {
  if (!det || !_isRoundaboutOrInterchangeMap(det)) return false;
  const spd = Number(det.spd ?? det.speedKmh);
  const occ = Math.abs(Number(det.occ ?? det.maxOcc ?? 0) || 0);
  return Boolean((Number.isFinite(spd) && spd > 0 && Math.abs(spd) < 18) || occ >= 70);
}

function _capBusApiTierMap(rawTier, speedKmh, seg = null) {
  if (typeof window !== 'undefined' && typeof window.capBusApiTierHardcode === 'function') {
    return window.capBusApiTierHardcode(rawTier, speedKmh, {
      isTerminusApproach: Boolean(seg?.isTerminusApproach),
      isScheduledFallback: Boolean(seg?.isScheduledFallback),
      isVerifiedMultiBusStall: Boolean(seg?.isVerifiedMultiBusStall)
    });
  }
  if (seg?.isTerminusApproach) return 'SMOOTH';
  const spd = Number(speedKmh);
  const hasSpd = speedKmh !== null && speedKmh !== undefined && Number.isFinite(spd) && spd > 0;
  const absSpd = hasSpd ? Math.abs(spd) : NaN;
  if (seg?.isScheduledFallback) return (hasSpd && absSpd < 18) ? 'MODERATE' : 'SMOOTH';
  if (seg?.isVerifiedMultiBusStall && hasSpd && absSpd < 8) return 'CONGESTED';
  if (hasSpd) return absSpd >= 18 ? 'SMOOTH' : 'MODERATE';
  const t = String(rawTier || '').toUpperCase();
  if (t === 'CONGESTED' || t === 'JAMMED' || t === 'MODERATE' || t === 'SLOW') return 'MODERATE';
  return 'SMOOTH';
}

function _isOffRouteHighwayLeakMap(det, routeNo = '', groupKey = '') {
  if (!det) return false;
  const idStr = String(det.id || det.key || '').toUpperCase();
  const txt = `${det.roadEn || det.desc || ''} ${det.roadTc || det.descTc || ''} ${idStr}`;
  const rNo = String(routeNo || '').trim().toUpperCase();
  const gKey = String(groupKey || '').toUpperCase();
  const isE36Explicit = /^E36[A-Z]?$/.test(rNo);
  const isE36Any = isE36Explicit || /(?:^|_)E36(?:[A-Z])?(?:_|$)/.test(gKey);
  if (isE36Any) {
    // Keep blocking off-route Kong Sham Western Hwy / Shenzhen Bay / Brilliant Garden / Fung Tei leaks,
    // while allowing E36's actual Tuen Mun Rd Siu Hong detector (TDS91038).
    if (/TDS91037|TDS91040/i.test(idStr)) return true;
    if (/brilliant\s*garden|fung\s*tei|寶怡|鳳地/i.test(txt)) return true;
  }
  if (isE36Explicit) {
    if (/kong\s*sham\s*western|shenzhen\s*bay|港深西部公路|深圳灣/i.test(txt)) return true;
  }
  return false;
}

function matchDetectorToRouteCorridor(det, routeCoords, isRoadSnapped = true, precomputedBbox = null, hasHighwaySpan = false, routeNo = '', groupKey = '') {
  if (!det || !Number.isFinite(det.lat) || !Number.isFinite(det.lon) || !Array.isArray(routeCoords) || routeCoords.length < 2) {
    return { matched: false, relation: 'none', distKm: Infinity };
  }
  const rawSpd = Number(det.spd);
  if (det.spd !== null && det.spd !== undefined && (!Number.isFinite(rawSpd) || rawSpd <= 0)) {
    return { matched: false, relation: 'none', distKm: Infinity };
  }
  if (_isOffRouteHighwayLeakMap(det, routeNo, groupKey)) {
    return { matched: false, relation: 'none', distKm: Infinity };
  }
  const isRbDet = _isRoundaboutOrInterchangeMap(det);
  const isDividedHwyDet = _isDividedHighwaySnapRoadMap(det);
  // Base <= 60m corridor radius on road-snapped routes; relaxed to <= 85m (<= 45°) on divided highways
  // (Tuen Mun Rd, Yuen Long Hwy, North Lantau Hwy, TM-CLKL) and <= 120m (<= 65°) on major roundabouts/interchanges.
  const maxRadiusKm = isRbDet
    ? (isRoadSnapped ? 0.120 : 0.15)
    : (isDividedHwyDet ? (isRoadSnapped ? 0.085 : 0.12) : (isRoadSnapped ? 0.060 : 0.12));
  const sameTolDeg = isRbDet ? 65 : (isDividedHwyDet ? 45 : (isRoadSnapped ? 42 : 45));
  const oppMinDeg = 180 - sameTolDeg;

  if (precomputedBbox) {
    if (det.lat < precomputedBbox.minLat || det.lat > precomputedBbox.maxLat || det.lon < precomputedBbox.minLon || det.lon > precomputedBbox.maxLon) {
      return { matched: false, relation: 'none', distKm: Infinity };
    }
  }

  const isLocalArterial = (!isRbDet && typeof isOffCorridorLocalArterialDetector === 'function')
    ? isOffCorridorLocalArterialDetector(det)
    : false;
  if (hasHighwaySpan && isLocalArterial) {
    return { matched: false, relation: 'none', distKm: Infinity };
  }

  let bestSameDistKm = Infinity;
  let bestOppDistKm = Infinity;
  const detRot = Number(det.rot);
  const hasRot = Number.isFinite(detRot);

  for (let i = 0; i < routeCoords.length - 1; i++) {
    const a = routeCoords[i], b = routeCoords[i + 1];
    if (!a || !b) continue;
    const aLat = Number(a[0]), aLon = Number(a[1]), bLat = Number(b[0]), bLon = Number(b[1]);
    if (!Number.isFinite(aLat) || !Number.isFinite(aLon) || !Number.isFinite(bLat) || !Number.isFinite(bLon)) continue;

    // Fast segment bounding-box reject before computing perpendicular distance
    const segPad = 0.0018;
    if (det.lat < Math.min(aLat, bLat) - segPad || det.lat > Math.max(aLat, bLat) + segPad) continue;
    if (det.lon < Math.min(aLon, bLon) - segPad || det.lon > Math.max(aLon, bLon) + segPad) continue;

    const dLatM = (bLat - aLat) * 111111;
    const dLonM = (bLon - aLon) * 111111 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    const segLenM = Math.hypot(dLatM, dLonM);
    if (segLenM < 5) continue;

    if (isLocalArterial && segLenM >= 1200) continue;

    if ((i === 0 || i === routeCoords.length - 2) && typeof pointToSegmentDistanceKm === 'function') {
      const proj = pointToSegmentDistanceKm(det.lat, det.lon, aLat, aLon, bLat, bLon);
      if (proj && typeof proj === 'object') {
        if (i === 0 && proj.t < -0.02) continue;
        if (i === routeCoords.length - 2 && proj.t > 1.02) continue;
      }
    }

    const distKm = _mapPointToSegDistKm(det.lat, det.lon, aLat, aLon, bLat, bLon);
    if (distKm > maxRadiusKm) continue;

    if (!hasRot) {
      if (distKm < bestSameDistKm) bestSameDistKm = distKm;
      continue;
    }

    const segBearing = _mapBearingDeg(aLat, aLon, bLat, bLon);
    const ang = _mapAngDiffDeg(detRot, segBearing);
    if (ang <= sameTolDeg) {
      if (distKm < bestSameDistKm) bestSameDistKm = distKm;
    } else if (ang >= oppMinDeg) {
      if (distKm < bestOppDistKm) bestOppDistKm = distKm;
    }
  }

  if (bestSameDistKm <= maxRadiusKm) {
    return { matched: true, relation: 'same', distKm: bestSameDistKm };
  }
  if (bestOppDistKm <= maxRadiusKm) {
    return { matched: true, relation: 'opp', distKm: bestOppDistKm };
  }
  return { matched: false, relation: 'none', distKm: Math.min(bestSameDistKm, bestOppDistKm) };
}

function filterTrafficDetectorsForMap(detectors, targetMap, corridorMeta = null, focusedDetId = '') {
  if (!Array.isArray(detectors) || !detectors.length || !targetMap) return [];
  const bounds = targetMap.getBounds ? targetMap.getBounds() : null;
  if (!bounds || (typeof bounds.isValid === 'function' && !bounds.isValid())) return [];
  const padded = typeof bounds.pad === 'function' ? bounds.pad(0.22) : bounds;

  const hasExplicitForward = Boolean(corridorMeta && Array.isArray(corridorMeta.forwardCoords));
  const activeRouteCoords = hasExplicitForward ? corridorMeta.forwardCoords : corridorMeta?.coords;
  const isDetailBusScoped = Boolean(
    corridorMeta &&
    corridorMeta.isBusRoute &&
    Array.isArray(corridorMeta.coords) &&
    corridorMeta.coords.length >= 2
  );
  const hasForwardSegment = Array.isArray(activeRouteCoords) && activeRouteCoords.length >= 2;
  const corridorBbox = (isDetailBusScoped && hasForwardSegment)
    ? _computeCorridorBbox(activeRouteCoords, 0.0022)
    : null;

  const kept = [];
  for (let i = 0; i < detectors.length; i++) {
    const d = detectors[i];
    if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const rawSpd = Number(d.spd);
    if (d.spd !== null && d.spd !== undefined && (!Number.isFinite(rawSpd) || rawSpd <= 0)) continue;
    const isFocused = Boolean(focusedDetId && d.id === focusedDetId);
    if (!isFocused && !padded.contains([d.lat, d.lon])) continue;

    if (isDetailBusScoped) {
      if (!hasForwardSegment) {
        if (isFocused) kept.push({ det: d, relation: 'focused', isFocused: true });
        continue;
      }
      const m = matchDetectorToRouteCorridor(
        d,
        activeRouteCoords,
        corridorMeta.isRoadSnapped,
        corridorBbox,
        Boolean(corridorMeta.hasHighwaySpan),
        corridorMeta.routeNo || '',
        corridorMeta.groupKey || ''
      );
      if (!m.matched && !isFocused) continue;
      // On active bus route view, keep ONLY the bus's forward travel direction within 12 km ahead
      if (!isFocused && m.relation !== 'same') continue;
      kept.push({ det: d, relation: m.matched ? m.relation : 'focused', isFocused });
    } else {
      kept.push({ det: d, relation: 'global', isFocused });
    }
  }
  return kept;
}

function projectDetectorToScreenPx(targetMap, lat, lon, zoom = 13) {
  if (targetMap && typeof targetMap.latLngToContainerPoint === 'function') {
    try {
      const pt = targetMap.latLngToContainerPoint([lat, lon]);
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
        return { x: pt.x, y: pt.y };
      }
    } catch (e) {}
  }
  const z = Number.isFinite(zoom) ? zoom : 13;
  const scale = 256 * Math.pow(2, z);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * Math.PI / 180)));
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function _bringLayerGroupToFront(layer) {
  if (!layer) return;
  try {
    const orderedLeaves = [];
    let seq = 0;
    const collect = (node) => {
      if (!node) return;
      if (typeof node.eachLayer === 'function') {
        node.eachLayer((sub) => collect(sub));
      } else if (typeof node.bringToFront === 'function') {
        const rank = Number.isFinite(Number(node.options?._zRank)) ? Number(node.options._zRank) : 1;
        orderedLeaves.push({ node, rank, seq: seq++ });
      }
    };
    collect(layer);
    orderedLeaves.sort((a, b) => (a.rank - b.rank) || (a.seq - b.seq));
    for (let i = 0; i < orderedLeaves.length; i++) {
      orderedLeaves[i].node.bringToFront();
    }
  } catch (e) {}
}

function renderTrafficOverlayOnMap(targetMap, forceRedraw = false) {
  if (!targetMap || typeof L === 'undefined') return;
  let layerGroup = _trafficLayerByMap.get(targetMap);
  if (!layerGroup) {
    layerGroup = L.layerGroup().addTo(targetMap);
    _trafficLayerByMap.set(targetMap, layerGroup);
  }

  // Keep existing traffic layers intact if the user is viewing an open traffic detector/camera popup
  // (Leaflet autoPan after openPopup triggers moveend; clearing layers would close the popup).
  const activePopup = targetMap._popup;
  if (!forceRedraw && activePopup && typeof activePopup.isOpen === 'function' && activePopup.isOpen() && activePopup._source && layerGroup.hasLayer(activePopup._source)) {
    return;
  }

  const detMarkerMap = new Map();
  _trafficMarkersByMap.set(targetMap, detMarkerMap);

  layerGroup.clearLayers();

  const detectors = window.__LIVE_TRAFFIC_DETECTORS__;
  if (!window.trafficLayerEnabled || !Array.isArray(detectors) || !detectors.length) return;

  const zoom = targetMap.getZoom ? (targetMap.getZoom() || 13) : 13;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const isDetailMap = Boolean(window.mapInstance && targetMap === window.mapInstance);
  const activeCorridor = isDetailMap ? currentDetailCorridorMeta : null;
  // Never dump regional highway traffic overlays onto rail or ferry route detail maps
  if (isDetailMap && activeCorridor && !activeCorridor.isBusRoute) {
    if (detailPolylineLayer) _bringLayerGroupToFront(detailPolylineLayer);
    return;
  }
  const isDetailBusScoped = Boolean(
    isDetailMap &&
    activeCorridor &&
    activeCorridor.isBusRoute &&
    Array.isArray(activeCorridor.coords) &&
    activeCorridor.coords.length >= 2
  );
  const focusedDetId = isDetailMap ? String(window.__FOCUSED_TRAFFIC_DET_ID__ || '') : '';

  const candidates = filterTrafficDetectorsForMap(detectors, targetMap, activeCorridor, focusedDetId);
  if (!candidates.length && !isDetailBusScoped) {
    if (isDetailMap && detailPolylineLayer) _bringLayerGroupToFront(detailPolylineLayer);
    return;
  }

  // Prioritize: focused detector -> worst severity/delay -> lowest live speed -> highest occupancy -> camera-equipped
  const tierPrio = (t) => (t === 'JAMMED' ? 0 : (t === 'SLOW' ? 1 : 2));
  const relPrio = (r) => (r === 'same' ? 0 : (r === 'global' ? 1 : 2));
  const delayScore = (det) => {
    if (typeof _estimateDetectorDelayMins === 'function') return _estimateDetectorDelayMins(det);
    if (det.tier === 'JAMMED') return 15;
    if (det.tier === 'SLOW') return 5;
    return 0;
  };
  candidates.sort((a, b) => {
    if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
    const tp = tierPrio(a.det.tier) - tierPrio(b.det.tier);
    if (tp !== 0) return tp;
    const dd = delayScore(b.det) - delayScore(a.det);
    if (dd !== 0) return dd;
    const aSpd = Number.isFinite(Number(a.det.spd)) ? Number(a.det.spd) : 99;
    const bSpd = Number.isFinite(Number(b.det.spd)) ? Number(b.det.spd) : 99;
    if (aSpd !== bSpd) return aSpd - bSpd;
    const occDiff = (Number(b.det.occ) || 0) - (Number(a.det.occ) || 0);
    if (occDiff !== 0) return occDiff;
    const rp = relPrio(a.relation) - relPrio(b.relation);
    if (rp !== 0) return rp;
    return (b.det.camKey ? 1 : 0) - (a.det.camKey ? 1 : 0);
  });

  const maxDraw = isDetailBusScoped
    ? 180
    : (zoom <= 11 ? 140 : (zoom <= 13 ? 220 : 320));
  const segHalfMeters = zoom <= 12 ? 155 : (zoom <= 14 ? 105 : 75);
  // Hong Kong drives on the LEFT: offset each carriageway slightly to the left of its heading,
  // tightening significantly at high zoom (z >= 15) so lines stay centered over the actual carriageway.
  const laneOffsetMeters = zoom >= 15 ? 5 : (zoom >= 13 ? 24 : 40);
  const MIN_ARROW_SPACING_PX = 52;
  const MIN_OPP_BOTTLENECK_SPACING_PX = 36;
  const MAX_ROUTE_BOTTLENECK_MARKERS = 2;
  const selected = candidates.slice(0, maxDraw);
  const placedArrows = [];
  let placedRouteBottlenecks = 0;

  selected.forEach(({ det: d, isFocused }) => {
    const isJam = d.tier === 'JAMMED';
    const isSlow = d.tier === 'SLOW';
    const isBottleneck = isJam || isSlow;
    const col = isJam ? '#dc2626' : (isSlow ? '#f59e0b' : '#16a34a');
    const boundMeta = classifyTrafficBoundMeta(d.rot, d.dir, isZh);

    // Offset center left-hand relative to travel bearing (rot - 90 deg)
    const leftBearing = ((Number(d.rot) || 0) + 270) % 360;
    const [cLat, cLon] = projectPointMeters(d.lat, d.lon, leftBearing, laneOffsetMeters);
    const pStart = projectPointMeters(cLat, cLon, (d.rot + 180) % 360, segHalfMeters);
    const pEnd = projectPointMeters(cLat, cLon, d.rot, segHalfMeters);

    const cleanRoadName = sanitizeBottleneckLabel(isZh ? (d.roadTc || d.roadEn) : (d.roadEn || d.roadTc)) || (isZh ? '主要幹道' : 'Major Road');
    const tipTxt = sanitizeBottleneckLabel(`${cleanRoadName} · ${boundMeta.arrowGlyph} ${boundMeta.fullLabel} · ${Math.abs(Math.round(Number(d.spd) || 0))} km/h${d.camKey ? ' 📷' : ''}`);
    const openVerdictDirect = Boolean(isBottleneck || isDetailBusScoped);
    const onDirectBottleneckClick = (ev) => {
      if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
      if (typeof window.openTrafficDecisionModal === 'function') {
        window.openTrafficDecisionModal(d.id, _findOppositeTrafficDetectorId(d), '', false);
      }
    };

    // In Detail Bus View when the road-snapped live speed corridor GeoJSON is active, never draw raw 2-point TD chords
    // on top of the route polyline so highway curves and roundabouts remain smooth and unobstructed.
    const hasActiveDetailSpeedCorridor = Boolean(isDetailBusScoped && window.__LAST_DETAIL_SPEED_GEOJSON__?.features?.length);
    const drawOverlayStripe = !hasActiveDetailSpeedCorridor;
    if (drawOverlayStripe) {
      L.polyline([pStart, pEnd], {
        color: '#FFFFFF',
        weight: isJam ? 7.6 : (isSlow ? 6.6 : 4.4),
        opacity: isBottleneck ? 0.85 : 0.56,
        lineCap: 'round',
        interactive: false
      }).addTo(layerGroup);

      const flowLine = L.polyline([pStart, pEnd], {
        color: col,
        weight: isJam ? 4.8 : (isSlow ? 4.0 : 2.8),
        opacity: isJam ? 0.94 : (isSlow ? 0.88 : 0.72),
        lineCap: 'round'
      }).addTo(layerGroup);

      flowLine.bindTooltip(tipTxt, { sticky: true, className: 'kmb-map-stop-label' });
      if (openVerdictDirect) {
        if (typeof flowLine.on === 'function') flowLine.on('click', onDirectBottleneckClick);
      } else {
        flowLine.bindPopup(() => buildTrafficDetectorPopupHtml(d, isZh), { closeButton: true, maxWidth: 270 });
      }
      detMarkerMap.set(d.id, flowLine);
    }

    // Minimalist route-view markers vs general browse map markers:
    // - On active bus route view (drawRouteOnMap): NEVER render smooth-flow detector circles/badges at any zoom level,
    //   and cap bottleneck markers to at most the 1-2 worst slowdowns/jams along the route corridor.
    // - On general browse map (no active route selected): hide smooth arrows below zoom 15 and enforce >= 52px spacing.
    const arrowEligible = isDetailBusScoped
      ? (isFocused || (isBottleneck && placedRouteBottlenecks < MAX_ROUTE_BOTTLENECK_MARKERS))
      : (isFocused || isBottleneck || zoom >= 15);
    if (arrowEligible) {
      const ptPx = projectDetectorToScreenPx(targetMap, pEnd[0], pEnd[1], zoom);
      let tooClose = false;
      if (!isFocused) {
        for (let k = 0; k < placedArrows.length; k++) {
          const prev = placedArrows[k];
          const dx = ptPx.x - prev.x;
          const dy = ptPx.y - prev.y;
          const distPx = Math.hypot(dx, dy);
          // Allow two distinct opposite-bound bottlenecks to sit slightly closer (36px) without overlapping their 21-22px badges
          const isOppBottleneckPair = isBottleneck && prev.isBottleneck && _mapAngDiffDeg(d.rot, prev.rot) >= 135;
          const minReqPx = isOppBottleneckPair ? MIN_OPP_BOTTLENECK_SPACING_PX : MIN_ARROW_SPACING_PX;
          if (distPx < minReqPx) {
            tooClose = true;
            break;
          }
        }
      }

      if (!tooClose) {
        placedArrows.push({ x: ptPx.x, y: ptPx.y, isBottleneck, rot: Number(d.rot) || 0 });
        if (isDetailBusScoped && isBottleneck && !isFocused) {
          placedRouteBottlenecks++;
        }

        // Slim 20-22px visual chevron badge + compact upright N/S/E/W label inside transparent 32x32 hit area
        const svgSize = isJam ? 22 : (isSlow ? 21 : 20);
        const badgeFill = isJam ? '#DC2626' : (isSlow ? '#D97706' : 'rgba(255,255,255,0.94)');
        const badgeStroke = isBottleneck ? '#FFFFFF' : '#16A34A';
        const chevronFill = isBottleneck ? '#FFFFFF' : '#16A34A';
        const arrowHtml = `
          <div class="traffic-dir-marker-hit" style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;position:relative;cursor:pointer;">
            <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 24 24" style="transform:rotate(${d.rot}deg);display:block;filter:drop-shadow(0 1px 2.5px rgba(0,0,0,0.42));">
              <circle cx="12" cy="12" r="10.2" fill="${badgeFill}" stroke="${badgeStroke}" stroke-width="${isBottleneck ? '1.8' : '1.6'}"/>
              <path d="M12 4.6 L17.6 16.8 L12 13.8 L6.4 16.8 Z" fill="${chevronFill}" stroke="${isBottleneck ? 'none' : '#FFFFFF'}" stroke-width="${isBottleneck ? '0' : '0.6'}" stroke-linejoin="round"/>
            </svg>
            <span style="position:absolute;right:1px;bottom:1px;min-width:11px;height:11px;padding:0 2px;border-radius:999px;background:${boundMeta.badgeBg};color:#FFFFFF;border:1.2px solid #FFFFFF;font-size:7.5px;font-weight:900;line-height:8.6px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.36);pointer-events:none;">${escapeHtml(boundMeta.shortLabel)}</span>
          </div>`;
        const arrowMarker = L.marker(pEnd, {
          icon: L.divIcon({ className: '', html: arrowHtml, iconSize: [32, 32], iconAnchor: [16, 16] }),
          // Keep traffic arrows strictly below numbered stop markers (320 / 650) and planner pins (700+)
          zIndexOffset: isJam ? 140 : (isSlow ? 110 : 70)
        }).addTo(layerGroup);
        arrowMarker.bindTooltip(tipTxt, { direction: 'top', offset: [0, -8], className: 'kmb-map-stop-label' });
        if (openVerdictDirect) {
          if (typeof arrowMarker.on === 'function') arrowMarker.on('click', onDirectBottleneckClick);
        } else {
          arrowMarker.bindPopup(() => buildTrafficDetectorPopupHtml(d, isZh), { closeButton: true, maxWidth: 270 });
        }
        detMarkerMap.set(`${d.id}_arrow`, arrowMarker);
      }
    }
  });

  // Render clickable directional TD traffic camera markers strictly along the forward route slice
  // from activeStopIdx to exitStopIdx (or terminus): <= 120 m road-snapped, <= 55° bearing for directional cams,
  // 1.0 opacity within 8 km ahead and 0.55 opacity beyond 8 km.
  if (isDetailMap && isDetailBusScoped && Array.isArray(currentDetailCorridorMeta?.coords) && currentDetailCorridorMeta.coords.length >= 2) {
    const forwardCamCoords = (Array.isArray(currentDetailCorridorMeta.forwardCameraCoords) && currentDetailCorridorMeta.forwardCameraCoords.length >= 2)
      ? currentDetailCorridorMeta.forwardCameraCoords
      : ((Array.isArray(currentDetailCorridorMeta.forwardCoords) && currentDetailCorridorMeta.forwardCoords.length >= 2)
        ? currentDetailCorridorMeta.forwardCoords
        : currentDetailCorridorMeta.coords);
    let routeCamPool = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) && window.__LIVE_TRAFFIC_CAMERAS__.length
      ? window.__LIVE_TRAFFIC_CAMERAS__
      : [];
    if (!routeCamPool.length && Array.isArray(detectors) && detectors.length) {
      const seenK = new Set();
      routeCamPool = [];
      for (let i = 0; i < detectors.length; i++) {
        const d = detectors[i];
        if (!d?.camKey || seenK.has(d.camKey)) continue;
        seenK.add(d.camKey);
        routeCamPool.push({
          key: d.camKey,
          desc: d.roadEn || d.roadTc || d.camKey,
          lat: d.lat,
          lon: d.lon,
          dir: d.dir || '',
          bearingDeg: Number.isFinite(Number(d.rot)) ? ((Math.round(Number(d.rot)) % 360) + 360) % 360 : undefined
        });
      }
    }

    const MAX_ROUTE_CAM_DIST_KM = 0.12;
    const MAX_ROUTE_CAM_BEARING_DIFF = 55;
    const RAMP_CAM_RE = /\b(?:slip\s*r(?:oa)?d|off[\s-]*ramp|on[\s-]*ramp|ramp|link\s*r(?:oa)?d)\b|支路|引道|連接路/i;
    const activeRouteNo = currentDetailCorridorMeta?.routeNo || (typeof detailRouteGroup !== 'undefined' ? (detailRouteGroup?.routeNo || '') : '');
    const activeRouteStops = (typeof detailRouteGroup !== 'undefined' && detailRouteGroup) ? _getDetailStopsForGroup(detailRouteGroup) : [];
    const camBounds = targetMap.getBounds ? targetMap.getBounds().pad(0.18) : null;
    const matchedRouteCams = [];
    for (let cIdx = 0; cIdx < routeCamPool.length; cIdx++) {
      const cam = routeCamPool[cIdx];
      const cLat = Number(cam?.lat), cLon = Number(cam?.lon);
      if (!cam?.key || !Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
      if (camBounds && typeof camBounds.contains === 'function' && !camBounds.contains([cLat, cLon])) continue;
      const proj = _projectPointOntoPolylineDetailed(cLat, cLon, forwardCamCoords);
      if (proj.distKm > MAX_ROUTE_CAM_DIST_KM) continue;

      const hasExplicitDir = Boolean(
        (cam.bearingDeg !== undefined && cam.bearingDeg !== null && Number.isFinite(Number(cam.bearingDeg))) ||
        String(cam.dir || '').trim() ||
        /\b(?:northbound|southbound|eastbound|westbound|nb|sb|eb|wb)\b|北行|南行|東行|西行/i.test(String(cam.desc || ''))
      );
      const bearingDeg = resolveCameraBearingDeg(cam, detectors, forwardCamCoords);
      const angDiff = (Number.isFinite(proj.segBrg) && Number.isFinite(bearingDeg))
        ? _mapAngDiffDeg(bearingDeg, proj.segBrg)
        : 0;
      if (hasExplicitDir && Number.isFinite(proj.segBrg) && Number.isFinite(bearingDeg)) {
        if (angDiff > MAX_ROUTE_CAM_BEARING_DIFF) continue;
      }

      const isDividedHwyCam = (typeof window.isDividedHighwaySnapRoadHardcode === 'function')
        ? window.isDividedHighwaySnapRoadHardcode(cam.desc || '', cam.descTc || '', cam.key || '')
        : false;
      const camSpeedSnapKm = isDividedHwyCam ? 0.085 : 0.045;
      const isRampCam = RAMP_CAM_RE.test(`${cam.desc || ''} ${cam.descTc || ''}`);
      const allowSpeedAttach = Boolean(!isRampCam && proj.distKm <= camSpeedSnapKm && (!hasExplicitDir || angDiff <= 45));
      const matchedDet = (allowSpeedAttach && typeof window.findNearestMatchingDetectorForCamera === 'function')
        ? window.findNearestMatchingDetectorForCamera(
            { ...cam, bearingDeg },
            detectors,
            { routeCoords: forwardCamCoords, routeNo: activeRouteNo, stops: activeRouteStops }
          )
        : null;

      matchedRouteCams.push({
        cam,
        distKm: proj.distKm,
        alongKm: proj.alongKm,
        bearingDeg,
        matchedDet,
        allowSpeedAttach
      });
    }

    matchedRouteCams.sort((a, b) => (a.alongKm - b.alongKm) || (a.distKm - b.distKm));
    const placedRouteCamPts = [];
    const MIN_ROUTE_CAM_PX = zoom >= 16 ? 20 : 28;
    for (let i = 0; i < matchedRouteCams.length; i++) {
      const { cam, alongKm, bearingDeg, matchedDet, allowSpeedAttach } = matchedRouteCams[i];
      const cLat = Number(cam.lat), cLon = Number(cam.lon);
      const ptPx = projectDetectorToScreenPx(targetMap, cLat, cLon, zoom);
      let tooCloseCam = false;
      for (let p = 0; p < placedRouteCamPts.length; p++) {
        if (Math.hypot(ptPx.x - placedRouteCamPts[p].x, ptPx.y - placedRouteCamPts[p].y) < MIN_ROUTE_CAM_PX) {
          tooCloseCam = true;
          break;
        }
      }
      if (tooCloseCam) continue;
      placedRouteCamPts.push(ptPx);

      const camOpacity = alongKm <= 8.0 ? 1.0 : 0.55;
      const compassTxt = formatCompassFromBearingDeg(bearingDeg, isZh);
      const cleanDesc = sanitizeBottleneckLabel(cam.desc || cam.key);
      const camIcon = buildDirectionalCameraDivIcon(cam, bearingDeg, isZh, true, camOpacity, alongKm);
      const camMarker = L.marker([cLat, cLon], {
        icon: camIcon,
        opacity: camOpacity,
        zIndexOffset: alongKm <= 8.0 ? 245 : 220
      }).addTo(layerGroup);
      const validDetSpd = (allowSpeedAttach && matchedDet && Number.isFinite(Number(matchedDet.spd)) && Number(matchedDet.spd) > 0)
        ? Math.abs(Math.round(Number(matchedDet.spd)))
        : null;
      if (typeof camMarker.bindTooltip === 'function') {
        const distLbl = alongKm < 1 ? `${Math.round(alongKm * 1000)}m` : `${alongKm.toFixed(1)}km`;
        let spdPart = '';
        if (validDetSpd !== null) {
          const detOcc = Math.abs(Number(matchedDet.occ) || 0);
          const flowTxt = (validDetSpd < 15 || detOcc >= 75)
            ? (isZh ? '擠塞' : 'Jammed')
            : (validDetSpd < 40 ? (isZh ? '緩慢' : 'Slow') : (isZh ? '暢通' : 'Clear'));
          spdPart = ` · ${flowTxt} • ${validDetSpd} km/h`;
        }
        camMarker.bindTooltip(`📷 ${cleanDesc}${compassTxt ? ` (${compassTxt})` : ''}${spdPart} · ${distLbl}`, {
          direction: 'top',
          offset: [0, -10],
          className: 'kmb-map-stop-label'
        });
      }
      if (typeof camMarker.on === 'function') {
        camMarker.on('click', (ev) => {
          if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
          if (typeof window.openTrafficCameraModal === 'function') {
            window.openTrafficCameraModal({
              ...cam,
              bearingDeg,
              suppressDetectorSpeed: !allowSpeedAttach || !matchedDet,
              matchedDetId: matchedDet?.id || ''
            });
          }
        });
      }
      detMarkerMap.set(`cam_${cam.key}`, camMarker);
    }
  }

  // Always keep active route polyline cleanly above road traffic stripes
  if (isDetailMap && detailPolylineLayer) {
    _bringLayerGroupToFront(detailPolylineLayer);
  } else if (window.xferMapInstance && targetMap === window.xferMapInstance && Array.isArray(xferMapLegPolylines) && xferMapLegPolylines.length) {
    xferMapLegPolylines.forEach((entry) => {
      try {
        if (entry.casing?.bringToFront) entry.casing.bringToFront();
        if (entry.poly?.bringToFront) entry.poly.bringToFront();
      } catch (e) {}
    });
  }
}

function bindTrafficRefreshOnMapMove(targetMap) {
  if (!targetMap || targetMap._trafficMoveBound) return;
  targetMap._trafficMoveBound = true;
  targetMap.on('moveend', () => {
    clearTimeout(_trafficMoveTimerByMap.get(targetMap));
    const tid = setTimeout(() => renderTrafficOverlayOnMap(targetMap, false), 120);
    _trafficMoveTimerByMap.set(targetMap, tid);
  });
}

function _getDetailStopsForGroup(group) {
  if (!group || typeof getStopsForGroup !== 'function') return [];
  const boardKey = (typeof detailBoardStopKey !== 'undefined' && detailBoardStopKey)
    ? detailBoardStopKey
    : ((typeof detailTargetStopKey !== 'undefined' && detailTargetStopKey) ? detailTargetStopKey : null);
  return getStopsForGroup(group, boardKey) || [];
}

function _resolveActiveExitStopIdx(stops, activeStopIdx = 0) {
  const exitKey = (typeof window !== 'undefined' && window.detailTargetStopKey)
    ? window.detailTargetStopKey
    : ((typeof detailTargetStopKey !== 'undefined') ? detailTargetStopKey : null);
  if (!exitKey || !Array.isArray(stops) || !stops.length) return null;
  const idx = stops.findIndex(s => s && (s.stopKey === exitKey || s.stopId === exitKey));
  return (idx > activeStopIdx) ? idx : null;
}

function _refreshDetailBusSpeedPolylineIfActive() {
  if (!window.mapInstance || !currentDetailCorridorMeta?.isBusRoute) return;
  if (!Array.isArray(currentDetailRoadCoords) || currentDetailRoadCoords.length < 2) return;
  if (typeof detailRouteGroup === 'undefined' || !detailRouteGroup) return;
  const stops = _getDetailStopsForGroup(detailRouteGroup);
  const effRoadCoords = (typeof window.ensureRoutePolylineCoversStops === 'function' && Array.isArray(stops) && stops.length >= 2)
    ? window.ensureRoutePolylineCoversStops(currentDetailRoadCoords, stops)
    : currentDetailRoadCoords;
  if (effRoadCoords !== currentDetailRoadCoords) {
    currentDetailRoadCoords = effRoadCoords;
  }
  const activeIdx = (typeof detailExpandedStopIdx === 'number' && detailExpandedStopIdx >= 0) ? detailExpandedStopIdx : 0;
  const exitIdx = _resolveActiveExitStopIdx(stops, activeIdx);
  if (currentDetailCorridorMeta && typeof window.sliceForwardPolylineFromStop === 'function') {
    currentDetailCorridorMeta = {
      ...currentDetailCorridorMeta,
      coords: effRoadCoords,
      activeStopIdx: activeIdx,
      exitStopIdx: exitIdx,
      forwardCoords: window.sliceForwardPolylineFromStop(effRoadCoords, stops, activeIdx, 12.0, exitIdx),
      forwardCameraCoords: window.sliceForwardPolylineFromStop(effRoadCoords, stops, activeIdx, 45.0, exitIdx)
    };
  }
  const routeAccent = detailRouteGroup?.colorHex ||
    (typeof window.__GET_ROUTE_COLOR_HEX__ === 'function'
      ? window.__GET_ROUTE_COLOR_HEX__(detailRouteGroup?.mode, detailRouteGroup?.company, detailRouteGroup?.routeNo)
      : '#FF3B30');
  if (detailPolylineLayer) {
    try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {}
  }
  detailPolylineLayer = buildDetailBusPolylineLayer(effRoadCoords, stops, activeIdx, routeAccent);
  if (detailPolylineLayer) {
    detailPolylineLayer.addTo(window.mapInstance);
    _bringLayerGroupToFront(detailPolylineLayer);
  }
}

function syncTrafficOverlaysAllMaps() {
  if (window.mapInstance) {
    _refreshDetailBusSpeedPolylineIfActive();
    renderTrafficOverlayOnMap(window.mapInstance, true);
  }
  if (window.browseMapInstance) {
    if (window.globalTrafficLayerEnabled) {
      renderGlobalTrafficDashboard(window.browseMapInstance);
      renderGlobalBusSpeedOverlay(window.browseMapInstance);
    }
  }
  if (window.xferMapInstance) {
    renderTrafficOverlayOnMap(window.xferMapInstance, true);
  }
}

function toggleTrafficLayerOverlay(forceState = null) {
  if (typeof triggerHaptic === 'function') triggerHaptic(10);
  window.trafficLayerEnabled = (typeof forceState === 'boolean') ? forceState : !window.trafficLayerEnabled;
  if (window.trafficLayerEnabled && window.mapInstance && currentDetailCorridorMeta?.isBusRoute && typeof detailRouteGroup !== 'undefined' && detailRouteGroup) {
    if (!Array.isArray(window.__DETAIL_BUS_SPEED_SEGMENTS__) || !window.__DETAIL_BUS_SPEED_SEGMENTS__.length) {
      const stops = _getDetailStopsForGroup(detailRouteGroup);
      syncDetailRouteBusSpeedSegments(detailRouteGroup, stops);
    }
  }
  syncTrafficOverlaysAllMaps();
  if (typeof window.syncTrafficToggleButtonsUI === 'function') {
    window.syncTrafficToggleButtonsUI();
  }
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (typeof showToast === 'function') {
    showToast(window.trafficLayerEnabled
      ? (isZh ? '🚦 已顯示實時道路交通、巴士車速及路面快照' : '🚦 Live Traffic, Bus Speed & Cameras ON')
      : (isZh ? '🚦 已隱藏實時道路交通圖層' : '🚦 Live Traffic Layer OFF'));
  }
}

function _getActiveDetailStopContext() {
  if (typeof detailRouteGroup === 'undefined' || !detailRouteGroup || typeof getStopsForGroup !== 'function') return null;
  const stops = _getDetailStopsForGroup(detailRouteGroup);
  if (!Array.isArray(stops) || !stops.length) return null;
  const idx = (typeof detailExpandedStopIdx === 'number' && detailExpandedStopIdx >= 0 && detailExpandedStopIdx < stops.length)
    ? detailExpandedStopIdx
    : 0;
  const stop = stops[idx];
  const lat = parseFloat(stop?.latitude ?? stop?.lat);
  const lon = parseFloat(stop?.longitude ?? stop?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { idx, seq: idx + 1, stop, lat, lon };
}

function _distanceMetersFast(lat1, lon1, lat2, lon2) {
  if (typeof calculateDistanceKm === 'function') {
    return calculateDistanceKm(lat1, lon1, lat2, lon2) * 1000;
  }
  const cosLat = Math.max(0.2, Math.cos(((lat1 + lat2) / 2) * Math.PI / 180));
  return Math.hypot((lat2 - lat1) * 111111, (lon2 - lon1) * 111111 * cosLat);
}

function hideDetailBackToStopPill() {
  _detailFocusedAwayFromStop = false;
  const pill = document.getElementById('detailBackToStopPill');
  if (pill) pill.style.display = 'none';
}

function updateDetailBackToStopPill(forceShowIfFar = false) {
  const pill = document.getElementById('detailBackToStopPill');
  if (!pill) return;
  if (!window.mapInstance || (typeof currentView !== 'undefined' && currentView !== 'detail')) {
    pill.style.display = 'none';
    return;
  }
  const activeCtx = _getActiveDetailStopContext();
  if (!activeCtx) {
    pill.style.display = 'none';
    return;
  }
  const center = window.mapInstance.getCenter ? window.mapInstance.getCenter() : null;
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
    pill.style.display = 'none';
    return;
  }
  const distM = _distanceMetersFast(center.lat, center.lng, activeCtx.lat, activeCtx.lon);
  if ((forceShowIfFar || _detailFocusedAwayFromStop) && distM > 300) {
    const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
    const lbl = isZh ? `↩ 返回第 ${activeCtx.seq} 站` : `↩ Back to Stop ${activeCtx.seq}`;
    pill.innerText = lbl;
    pill.setAttribute('aria-label', lbl);
    pill.style.display = 'inline-flex';
  } else if (distM <= 260 || !_detailFocusedAwayFromStop) {
    _detailFocusedAwayFromStop = false;
    pill.style.display = 'none';
  }
}

function returnToActiveDetailStop() {
  if (typeof triggerHaptic === 'function') triggerHaptic(10);
  if (typeof window.closeTrafficDecisionModal === 'function') {
    window.closeTrafficDecisionModal();
  }
  window.__FOCUSED_TRAFFIC_DET_ID__ = '';
  hideDetailBackToStopPill();
  const activeCtx = _getActiveDetailStopContext();
  if (window.mapInstance) {
    try { window.mapInstance.closePopup?.(); } catch (e) {}
    if (activeCtx) {
      const targetZoom = Math.min(Math.max(window.mapInstance.getZoom ? (window.mapInstance.getZoom() || 15) : 15, 15), 16);
      if (typeof window.mapInstance.flyTo === 'function') {
        window.mapInstance.flyTo([activeCtx.lat, activeCtx.lon], targetZoom, { duration: 0.45 });
      } else if (typeof window.mapInstance.setView === 'function') {
        window.mapInstance.setView([activeCtx.lat, activeCtx.lon], targetZoom, { animate: true });
      }
      if (mapMarkers[activeCtx.idx] && typeof mapMarkers[activeCtx.idx].openTooltip === 'function') {
        setTimeout(() => {
          try { mapMarkers[activeCtx.idx]?.openTooltip?.(); } catch (e) {}
        }, 420);
      }
    }
    renderTrafficOverlayOnMap(window.mapInstance, true);
  }
}

function focusTrafficDetectorOnDetailMap(lat, lon, detId = '') {
  if (!window.mapInstance || !isValidRailOrFerryCoord(lat, lon)) return;
  if (typeof window.restoreDetailSheetSplitMap === 'function') {
    window.restoreDetailSheetSplitMap();
  }
  if (!window.trafficLayerEnabled) {
    window.trafficLayerEnabled = true;
    if (typeof window.syncTrafficToggleButtonsUI === 'function') window.syncTrafficToggleButtonsUI();
  }
  window.__FOCUSED_TRAFFIC_DET_ID__ = String(detId || '');
  const activeCtx = _getActiveDetailStopContext();
  const distFromStopM = activeCtx ? _distanceMetersFast(activeCtx.lat, activeCtx.lon, Number(lat), Number(lon)) : 0;
  _detailFocusedAwayFromStop = distFromStopM > 300;

  const mapEl = document.getElementById('map-container');
  if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  clearTimeout(_trafficMoveTimerByMap.get(window.mapInstance));
  let opened = false;
  const focusTargetMarker = () => {
    if (opened) return;
    opened = true;
    clearTimeout(_trafficMoveTimerByMap.get(window.mapInstance));
    renderTrafficOverlayOnMap(window.mapInstance, true);
    const detMap = _trafficMarkersByMap.get(window.mapInstance);
    const layer = detMap?.get(`${detId}_arrow`) || detMap?.get(detId);
    if (layer && typeof layer.openTooltip === 'function') {
      layer.openTooltip();
    }
    updateDetailBackToStopPill(_detailFocusedAwayFromStop);
  };

  window.mapInstance.once('moveend', () => setTimeout(focusTargetMarker, 60));
  window.mapInstance.setView([lat, lon], Math.max(window.mapInstance.getZoom() || 14, 15), { animate: false });
  if (_detailFocusedAwayFromStop) {
    updateDetailBackToStopPill(true);
  }
  setTimeout(focusTargetMarker, 260);
}

window.sanitizeBottleneckLabel = sanitizeBottleneckLabel;
window.classifyTrafficBoundMeta = classifyTrafficBoundMeta;
window.matchDetectorToRouteCorridor = matchDetectorToRouteCorridor;
window.filterTrafficDetectorsForMap = filterTrafficDetectorsForMap;
window.projectDetectorToScreenPx = projectDetectorToScreenPx;
window.renderTrafficOverlayOnMap = renderTrafficOverlayOnMap;
window.syncTrafficOverlaysAllMaps = syncTrafficOverlaysAllMaps;
window.toggleTrafficLayerOverlay = toggleTrafficLayerOverlay;
window.focusTrafficDetectorOnDetailMap = focusTrafficDetectorOnDetailMap;
window.hideDetailBackToStopPill = hideDetailBackToStopPill;
window.updateDetailBackToStopPill = updateDetailBackToStopPill;
window.returnToActiveDetailStop = returnToActiveDetailStop;
window._setDetailCorridorMetaForTest = function(meta) { currentDetailCorridorMeta = meta; };

function buildDetailBusPolylineLayer(coords, stops, activeStopIdx, routeAccent) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const effCoords = (typeof window.ensureRoutePolylineCoversStops === 'function' && Array.isArray(stops) && stops.length >= 2)
    ? window.ensureRoutePolylineCoversStops(coords, stops)
    : coords;
  coords = effCoords;
  const layers = [];
  const liveDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  // When Traffic Overlay is ON, NEVER paint unmonitored route lines in route-brand Red (#FF3B30/#ef4444);
  // use neutral Slate/Blue (#3b82f6) so unmonitored segments are never mistaken for jammed traffic.
  const unmonitoredTrafficColor = '#3b82f6';
  const solidRouteFallback = window.trafficLayerEnabled ? unmonitoredTrafficColor : (routeAccent || '#2563eb');
  const highContrastCasingColor = '#0f172a';
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  const appendBusSpeedOverlay = (detailSpeedGeo = null) => {
    if (!window.trafficLayerEnabled) return;
    const busSegs = Array.isArray(window.__DETAIL_BUS_SPEED_SEGMENTS__) ? window.__DETAIL_BUS_SPEED_SEGMENTS__ : [];
    if (!busSegs.length) return;
    const tdCoverFn = typeof window.isSegmentCoveredByTdGroundTruth === 'function' ? window.isSegmentCoveredByTdGroundTruth : null;
    const combinedTdSpeedFeats = [];
    if (Array.isArray(window.__LIVE_TRAFFIC_SPEED_GEOJSON__?.features)) {
      combinedTdSpeedFeats.push(...window.__LIVE_TRAFFIC_SPEED_GEOJSON__.features);
    }
    if (Array.isArray(detailSpeedGeo?.features)) {
      detailSpeedGeo.features.forEach((f) => {
        const p = f?.properties || {};
        if (p.hasSpeedData !== false && p.speedKmh !== null && p.speedKmh !== undefined && Number.isFinite(Number(p.speedKmh))) {
          combinedTdSpeedFeats.push(f);
        }
      });
    }
    const combinedTdSpeedGeo = { type: 'FeatureCollection', features: combinedTdSpeedFeats };

    let renderList = null;
    if (typeof window.aggregateBusMicroStepsToCorridors === 'function') {
      const agg = window.aggregateBusMicroStepsToCorridors(busSegs, liveDetectors, combinedTdSpeedGeo, {
        targetStepM: 50,
        tdMaxDistKm: 0.10,
        tdMaxAngDeg: 45,
        allowUndividedOpposite: true,
        allowNlbScheduledFallback: true,
        allowConsecutiveStopSpans: true
      });
      renderList = Array.isArray(agg?.corridors) ? agg.corridors : [];
    } else {
      renderList = [];
      for (let i = 0; i < busSegs.length; i++) {
        const seg = busSegs[i];
        if (!seg || (seg.isScheduledOnly && !seg.isScheduledFallback)) continue;
        // Strict TD ground-truth priority (~100m, ±45°): discard BUS_API estimate wherever TD coverage exists
        if (seg.coveredByTd || seg.tdCovered || seg.source === 'TD') continue;
        if (!Array.isArray(seg.coords) || seg.coords.length < 2) continue;
        if (tdCoverFn && tdCoverFn(seg.coords, liveDetectors, combinedTdSpeedFeats, { maxDistKm: 0.10, maxAngDeg: 45 })) continue;
        renderList.push(seg);
      }
    }

    for (let i = 0; i < renderList.length; i++) {
      const seg = renderList[i];
      if (!seg || !Array.isArray(seg.coords) || seg.coords.length < 2) continue;
      const cappedTier = _capBusApiTierMap(seg.tier, seg.speedKmh, seg);
      const cappedColor = cappedTier === 'CONGESTED' ? '#dc2626' : (cappedTier === 'MODERATE' ? '#f59e0b' : '#16a34a');
      // Soft translucent dashed casing + translucent dashed BUS_API stroke (opacity 0.62, dashArray '8, 6', weight 4)
      layers.push(
        L.polyline(seg.coords, {
          color: highContrastCasingColor,
          weight: 5.5,
          opacity: 0.22,
          dashArray: '8, 6',
          smoothFactor: 1.5,
          lineJoin: 'round',
          lineCap: 'round',
          interactive: false,
          _zRank: 2
        })
      );
      const busLine = L.polyline(seg.coords, {
        color: cappedColor,
        weight: 4,
        opacity: 0.62,
        dashArray: '8, 6',
        smoothFactor: 1.5,
        lineJoin: 'round',
        lineCap: 'round',
        _zRank: 3
      });
      if (typeof busLine.bindTooltip === 'function') {
        const rawFrom = isZh ? (seg.fromNameTc || seg.fromNameEn) : (seg.fromNameEn || seg.fromNameTc);
        const rawTo = isZh ? (seg.toNameTc || seg.toNameEn) : (seg.toNameEn || seg.toNameTc);
        const fromNm = sanitizeBottleneckLabel(rawFrom || `Stop ${seg.fromSeq || ((seg.fromIdx || 0) + 1)}`);
        const toNm = sanitizeBottleneckLabel(rawTo || `Stop ${seg.toSeq || ((seg.toIdx || 0) + 2)}`);
        const flowTxt = cappedTier === 'CONGESTED'
          ? (isZh ? '擠塞' : 'Jammed')
          : (cappedTier === 'MODERATE'
            ? (isZh ? '緩慢' : 'Slow')
            : (isZh ? '暢通' : 'Clear'));
        const absSpd = Number.isFinite(Number(seg.speedKmh)) && Number(seg.speedKmh) > 0
          ? Math.abs(Math.round(Number(seg.speedKmh)))
          : null;
        const busLabel = absSpd !== null
          ? (isZh ? `🚌 巴士推算 • ${absSpd} km/h` : `🚌 Bus API • ${absSpd} km/h`)
          : (isZh ? '🚌 巴士推算' : '🚌 Bus API');
        busLine.bindTooltip(
          `${busLabel} · ${flowTxt} (${fromNm} → ${toNm})`,
          { sticky: true, className: 'kmb-map-stop-label' }
        );
      }
      layers.push(busLine);
    }
  };

  const hasGeoJsonTwin = Boolean(
    window.trafficLayerEnabled &&
    typeof window.buildRouteSpeedGeoJson === 'function' &&
    typeof L !== 'undefined' &&
    typeof L.geoJSON === 'function'
  );

  if (hasGeoJsonTwin) {
    const isRoadSnapped = Boolean(currentDetailCorridorMeta?.isRoadSnapped);
    const hasHighwaySpan = Boolean(currentDetailCorridorMeta?.hasHighwaySpan || _stopsHaveHighwaySpan(stops));
    const activeRouteNo = currentDetailCorridorMeta?.routeNo || (typeof detailRouteGroup !== 'undefined' ? (detailRouteGroup?.routeNo || '') : '');
    const detailStopSegs = Array.isArray(window.__DETAIL_STOP_SEGMENTS__) ? window.__DETAIL_STOP_SEGMENTS__ : [];
    const detailBusSegs = Array.isArray(window.__DETAIL_BUS_SPEED_SEGMENTS__) ? window.__DETAIL_BUS_SPEED_SEGMENTS__ : [];
    let effectiveStopSegs = [];
    if (detailStopSegs.length && (!Array.isArray(stops) || stops.length < 2 || detailStopSegs.length === stops.length - 1)) {
      effectiveStopSegs = detailStopSegs;
    } else if (Array.isArray(stops) && stops.length >= 2 && typeof window.buildStopByStopSegmentTraffic === 'function') {
      effectiveStopSegs = window.buildStopByStopSegmentTraffic(
        stops,
        coords,
        liveDetectors,
        Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : [],
        detailBusSegs,
        {
          tdSpeedGeoJson: window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null,
          routeNo: activeRouteNo
        }
      );
    } else if (detailBusSegs.length) {
      effectiveStopSegs = detailBusSegs;
    }

    const speedGeoJson = window.buildRouteSpeedGeoJson(coords, liveDetectors, {
      isRoadSnapped,
      hasHighwaySpan,
      routeNo: activeRouteNo,
      stops: Array.isArray(stops) ? stops : [],
      stopSegments: effectiveStopSegs,
      ensureStopCoverage: true,
      noDataColor: unmonitoredTrafficColor,
      maxMicroStepKm: 0.15
    });
    window.__LAST_DETAIL_SPEED_GEOJSON__ = speedGeoJson;

    if (speedGeoJson && Array.isArray(speedGeoJson.features) && speedGeoJson.features.length > 0) {
      // High-contrast dark casing (#0f172a, weight 7, opacity 0.85, _zRank: 0) strictly underneath route segments
      // so solid vivid route / TD / BUS_API / BUS_EST speed top strokes (_zRank: 1) always render cleanly on top of the casing.
      speedGeoJson.features.forEach((feat) => {
        const gCoords = feat?.geometry?.coordinates;
        if (!Array.isArray(gCoords) || gCoords.length < 2) return;
        const latlngs = gCoords.map(c => [c[1], c[0]]);
        layers.push(
          L.polyline(latlngs, {
            color: highContrastCasingColor,
            weight: 7,
            opacity: 0.85,
            dashArray: null,
            smoothFactor: 1.5,
            lineJoin: 'round',
            lineCap: 'round',
            interactive: false,
            _zRank: 0
          })
        );
      });
      const geoLayer = L.geoJSON(speedGeoJson, {
        style: (feat) => {
          const p = feat?.properties || {};
          const hasLiveSpeed = p.hasSpeedData !== false && p.speedKmh !== null && p.speedKmh !== undefined && Number.isFinite(Number(p.speedKmh));
          if (!hasLiveSpeed) {
            // Neutral Slate/Blue (#3b82f6) strictly as a last-resort fallback when neither TD nor BUS_API/BUS_EST exists
            return {
              color: unmonitoredTrafficColor,
              weight: 4,
              opacity: 0.95,
              dashArray: null,
              smoothFactor: 1.5,
              lineJoin: 'round',
              lineCap: 'round',
              _zRank: 1
            };
          }
          // Solid vivid speed stroke for TD, BUS_API, and BUS_EST segments
          return {
            color: p.color || unmonitoredTrafficColor,
            weight: 4.5,
            opacity: p.source === 'BUS_EST' ? 0.88 : 0.92,
            dashArray: null,
            smoothFactor: 1.5,
            lineJoin: 'round',
            lineCap: 'round',
            _zRank: 1
          };
        },
        onEachFeature: (feat, lyr) => {
          if (lyr && lyr.options) lyr.options._zRank = 1;
          const p = feat?.properties;
          const hasLiveSpeed = Boolean(p && p.hasSpeedData !== false && p.speedKmh !== null && p.speedKmh !== undefined && Number.isFinite(Number(p.speedKmh)));
          if (!hasLiveSpeed) {
            if (typeof lyr.bindTooltip === 'function') {
              lyr.bindTooltip(
                isZh ? '實時巴士路線（無運輸署測速段）' : 'Bus route (no TD speed detector)',
                { sticky: true, className: 'kmb-map-stop-label' }
              );
            }
            return;
          }
          const absSpd = Math.abs(Math.round(Number(p.speedKmh)));
          const flowTxt = p.tier === 'CONGESTED'
            ? (isZh ? '擠塞' : 'Jammed')
            : (p.tier === 'MODERATE'
              ? (isZh ? '緩慢' : 'Slow')
              : (isZh ? '暢通' : 'Clear'));
          if (p.source === 'BUS_API' || p.source === 'BUS_EST') {
            const rawFrom = isZh ? (p.fromNameTc || p.fromNameEn) : (p.fromNameEn || p.fromNameTc);
            const rawTo = isZh ? (p.toNameTc || p.toNameEn) : (p.toNameEn || p.toNameTc);
            const fromNm = sanitizeBottleneckLabel(rawFrom || (p.fromSeq ? `Stop ${p.fromSeq}` : ''));
            const toNm = sanitizeBottleneckLabel(rawTo || (p.toSeq ? `Stop ${p.toSeq}` : ''));
            const spanPart = (fromNm && toNm) ? ` (${fromNm} → ${toNm})` : '';
            const srcLabel = p.source === 'BUS_EST'
              ? (isZh ? `🚌 路況估算 • ${absSpd} km/h` : `🚌 Bus Est. • ${absSpd} km/h`)
              : (isZh ? `🚌 巴士推算 • ${absSpd} km/h` : `🚌 Bus API • ${absSpd} km/h`);
            if (typeof lyr.bindTooltip === 'function') {
              lyr.bindTooltip(`${srcLabel} · ${flowTxt}${spanPart}`, { sticky: true, className: 'kmb-map-stop-label' });
            }
            if (Number.isFinite(Number(p.fromIdx)) && typeof lyr.on === 'function') {
              lyr.on('click', (ev) => {
                if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
                if (typeof window.openStopSegmentTrafficModal === 'function') {
                  window.openStopSegmentTrafficModal(Number(p.fromIdx));
                }
              });
            }
            return;
          }
          if (!p.detectorId) return;
          const cleanName = sanitizeBottleneckLabel(isZh ? (p.roadTc || p.roadEn) : (p.roadEn || p.roadTc)) || (isZh ? '實時路況' : 'Live Road');
          if (typeof lyr.bindTooltip === 'function') {
            lyr.bindTooltip(`${cleanName} · ${flowTxt} • ${absSpd} km/h`, { sticky: true, className: 'kmb-map-stop-label' });
          }
          if (typeof lyr.on === 'function') {
            lyr.on('click', (ev) => {
              if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
              if (typeof window.openTrafficDecisionModal === 'function') {
                const detObj = liveDetectors.find(x => x.id === p.detectorId);
                const oppId = detObj ? _findOppositeTrafficDetectorId(detObj) : '';
                window.openTrafficDecisionModal(p.detectorId, oppId, '', false);
              }
            });
          }
        }
      });
      layers.push(geoLayer);
      const mergedBusOnGeo = speedGeoJson.features.some(
        (f) => f?.properties?.source === 'BUS_API' || f?.properties?.source === 'BUS_EST'
      );
      if (!mergedBusOnGeo) {
        appendBusSpeedOverlay(speedGeoJson);
      }
      return L.layerGroup(layers);
    }
  }

  const activeStop = stops?.[activeStopIdx];
  const actLat = parseFloat(activeStop?.latitude ?? activeStop?.lat);
  const actLon = parseFloat(activeStop?.longitude ?? activeStop?.lon);
  const splitIdx = (activeStopIdx > 0 && Number.isFinite(actLat) && Number.isFinite(actLon))
    ? findNearestPolylineIndex(coords, actLat, actLon, 0)
    : 0;
  const fallbackColor = solidRouteFallback;

  if (splitIdx > 1 && splitIdx < coords.length - 1) {
    const upstreamCoords = coords.slice(0, splitIdx + 1);
    const activeCoords = coords.slice(splitIdx);
    layers.push(
      L.polyline(upstreamCoords, { color: highContrastCasingColor, weight: 6, opacity: 0.45, dashArray: null, lineJoin: 'round', lineCap: 'round', interactive: false, _zRank: 0 }),
      L.polyline(upstreamCoords, { color: fallbackColor, weight: 3.5, opacity: 0.50, dashArray: null, lineJoin: 'round', lineCap: 'round', interactive: false, _zRank: 1 }),
      L.polyline(activeCoords, { color: highContrastCasingColor, weight: 7, opacity: 0.85, dashArray: null, lineJoin: 'round', lineCap: 'round', interactive: false, _zRank: 0 }),
      L.polyline(activeCoords, { color: fallbackColor, weight: 4, opacity: 0.95, dashArray: null, lineJoin: 'round', lineCap: 'round', _zRank: 1 })
    );
  } else {
    layers.push(
      L.polyline(coords, { color: highContrastCasingColor, weight: 7, opacity: 0.85, dashArray: null, lineJoin: 'round', lineCap: 'round', interactive: false, _zRank: 0 }),
      L.polyline(coords, { color: fallbackColor, weight: 4, opacity: 0.95, dashArray: null, lineJoin: 'round', lineCap: 'round', _zRank: 1 })
    );
  }
  appendBusSpeedOverlay();
  return L.layerGroup(layers);
}

function getGlobalTrafficLaneOffsetMeters(zoom = 13) {
  const z = Number.isFinite(Number(zoom)) ? Number(zoom) : 13;
  // Tight HK keep-left offset: 1.5m at z >= 15 and 2.5m at z < 15 so opposite carriageways stay strictly parallel and never cross
  return z >= 15 ? 1.5 : 2.5;
}

function getGlobalTrafficSpeedColorHex(spd, fallback = '#3b82f6') {
  if (spd !== null && spd !== undefined && Number.isFinite(Number(spd))) {
    const n = Number(spd);
    if (n <= 0) return fallback || '#3b82f6';
    if (n < 20) return '#ef4444';
    if (n < 40) return '#f59e0b';
    return '#22c55e';
  }
  const fb = String(fallback || '').toLowerCase();
  if (fb === '#16a34a') return '#22c55e';
  if (fb === '#dc2626') return '#ef4444';
  return fallback || '#3b82f6';
}

function _normalizeGlobalSpeedTier(spd, tierRaw = '', occ = 0) {
  const occVal = Math.abs(Number(occ) || 0);
  if (spd !== null && spd !== undefined && Number.isFinite(Number(spd))) {
    const n = Number(spd);
    if (n <= 0) return 'NO_DATA';
    if (n >= 40) return 'SMOOTH';
    if (n < 15 || occVal >= 75) return 'CONGESTED';
    return 'MODERATE';
  }
  const t = String(tierRaw || '').toUpperCase();
  if (t === 'JAMMED' || t === 'CONGESTED') return 'CONGESTED';
  if (t === 'SLOW' || t === 'MODERATE') return 'MODERATE';
  return 'SMOOTH';
}

function _applyKeepLeftOffsetAlongCoords(coords, offsetM) {
  if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(offsetM) || offsetM === 0) return coords;
  const out = [];
  const last = coords.length - 1;
  for (let i = 0; i <= last; i++) {
    const pPrev = coords[Math.max(0, i - 1)];
    const pNext = coords[Math.min(last, i + 1)];
    const localBrg = _mapBearingDeg(pPrev[1], pPrev[0], pNext[1], pNext[0]);
    const leftBrg = (localBrg + 270) % 360;
    const [oLat, oLon] = projectPointMeters(coords[i][1], coords[i][0], leftBrg, offsetM);
    out.push([Number(oLon.toFixed(6)), Number(oLat.toFixed(6))]);
  }
  return out;
}

function _segmentsIntersect2D(a1, a2, b1, b2) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function _polylinesIntersect2D(coordsA, coordsB) {
  if (!Array.isArray(coordsA) || !Array.isArray(coordsB) || coordsA.length < 2 || coordsB.length < 2) return false;
  for (let i = 0; i < coordsA.length - 1; i++) {
    for (let j = 0; j < coordsB.length - 1; j++) {
      if (_segmentsIntersect2D(coordsA[i], coordsA[i + 1], coordsB[j], coordsB[j + 1])) return true;
    }
  }
  return false;
}

function _nearestPointOnPolylineMeters(pLon, pLat, coords) {
  const cosLat = Math.max(0.2, Math.cos(pLat * Math.PI / 180));
  const px = pLon * 111111 * cosLat, py = pLat * 111111;
  let bestDistM = Infinity;
  let bestProj = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const ax = a[0] * 111111 * cosLat, ay = a[1] * 111111;
    const bx = b[0] * 111111 * cosLat, by = b[1] * 111111;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 1e-6 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    const dM = Math.hypot(px - qx, py - qy);
    if (dM < bestDistM) {
      bestDistM = dM;
      bestProj = {
        lon: qx / (111111 * cosLat),
        lat: qy / 111111,
        brg: _mapBearingDeg(a[1], a[0], b[1], b[0])
      };
    }
  }
  return { distM: bestDistM, proj: bestProj };
}

function filterAndOffsetGlobalSpeedGeoJson(speedGeo, zoom = 13, detectors = null) {
  const rawFeatures = (speedGeo && speedGeo.type === 'FeatureCollection' && Array.isArray(speedGeo.features))
    ? speedGeo.features
    : [];
  const offsetM = getGlobalTrafficLaneOffsetMeters(zoom);
  const roadCoreOf = (s) => String(s || '').split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0].trim().toLowerCase();

  const staged = [];
  const existingPairKeys = new Set();

  for (let i = 0; i < rawFeatures.length; i++) {
    const feat = rawFeatures[i];
    const coords = feat?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const p = feat.properties || {};
    // Guard against null / stale (<= 0 km/h) TD Speed Map GeoJSON links (e.g. HZMB Hong Kong Link Road) defaulting to Red!
    const rawSpdVal = p.spd ?? p.speedKmh;
    const numSpd = Number(rawSpdVal);
    if (p.hasSpeedData === false || rawSpdVal === null || rawSpdVal === undefined || !Number.isFinite(numSpd) || numSpd <= 0) {
      continue;
    }
    const cleanSpd = Math.abs(numSpd);
    const refCoords = (Array.isArray(p.rawCoords) && p.rawCoords.length >= 2) ? p.rawCoords : coords;

    // Keep multi-point polylines (coords.length >= 3) of any length.
    // For 2-point links, NEVER bend with Hermite curves (coarse 10° rot causes opposite carriageways to bow and cross in an X).
    // Filter out short stubs (< 60 m) AND long 2-point hillside-cutting chords (> 320 m).
    let straightM = Infinity;
    const isTwoPoint = refCoords.length === 2;
    if (isTwoPoint) {
      straightM = _distanceMetersFast(refCoords[0][1], refCoords[0][0], refCoords[1][1], refCoords[1][0]);
      if (!Number.isFinite(straightM) || straightM < 60 || straightM > 320) continue;
    }

    const rotA = Number.isFinite(Number(p.rotA)) ? Number(p.rotA) : Number(p.rot);
    const rotB = Number.isFinite(Number(p.rotB)) ? Number(p.rotB) : NaN;
    if (isTwoPoint && Number.isFinite(rotA)) {
      const linkBrg = _mapBearingDeg(refCoords[0][1], refCoords[0][0], refCoords[1][1], refCoords[1][0]);
      const angA = _mapAngDiffDeg(rotA, linkBrg);
      if (angA > 28) continue;
      if (Number.isFinite(rotB)) {
        const angB = _mapAngDiffDeg(rotB, linkBrg);
        const turnDeg = _mapAngDiffDeg(rotA, rotB);
        if (angB > 28 || turnDeg > 36) continue;
      }
    }

    // Strictly parallel HK keep-left offset (1.5m at z>=15, 2.5m at z<15)
    let finalCoords = refCoords;
    if (Array.isArray(p.rawCoords) && p.rawCoords.length >= 2) {
      finalCoords = _applyKeepLeftOffsetAlongCoords(refCoords, offsetM);
    } else if (refCoords.length >= 2) {
      // Pre-offset legacy coordinates or raw multi-point polylines
      const pullBackM = (isTwoPoint && Number.isFinite(rotA) && p.appliedOffsetM === undefined && p.preOffset6m)
        ? -(6 - offsetM)
        : offsetM;
      finalCoords = _applyKeepLeftOffsetAlongCoords(refCoords, pullBackM);
    }

    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (let k = 0; k < finalCoords.length; k++) {
      const lo = finalCoords[k][0], la = finalCoords[k][1];
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }

    if (p.id && p.toId) existingPairKeys.add(`${p.id}->${p.toId}`);
    if (refCoords.length >= 2) {
      const sig = `${Number(refCoords[0][1]).toFixed(4)},${Number(refCoords[0][0]).toFixed(4)}->${Number(refCoords[refCoords.length - 1][1]).toFixed(4)},${Number(refCoords[refCoords.length - 1][0]).toFixed(4)}`;
      existingPairKeys.add(sig);
    }

    const cleanRoadEn = sanitizeBottleneckLabel(p.roadEn || '');
    const cleanRoadTc = sanitizeBottleneckLabel(p.roadTc || p.roadEn || '');
    const cleanOcc = Math.abs(Number(p.occ) || 0);
    const normTier = _normalizeGlobalSpeedTier(cleanSpd, p.tier, cleanOcc);
    const normColor = normTier === 'CONGESTED' ? '#ef4444' : (normTier === 'MODERATE' ? '#f59e0b' : '#22c55e');
    staged.push({
      feat,
      p: {
        ...p,
        spd: cleanSpd,
        occ: cleanOcc,
        roadEn: cleanRoadEn,
        roadTc: cleanRoadTc,
        tier: normTier,
        color: normColor,
        isGapBridge: Boolean(p.isGapBridge),
        opacity: p.isGapBridge ? 0.55 : 0.95
      },
      roadCore: roadCoreOf(cleanRoadEn),
      rot: Number.isFinite(rotA) ? rotA : null,
      straightM,
      isTwoPoint,
      coords: finalCoords,
      bbox: { minLat, maxLat, minLon, maxLon },
      dropped: false
    });
  }

  // Short-gap bridging (<= 600 m) between two same-direction speed detectors on the same road
  // sharing the same speed tier (SMOOTH / MODERATE / CONGESTED), rendered at ~0.55 opacity.
  // Longer (> 600 m) or mismatched-tier gaps stay uncolored/neutral.
  const detPool = Array.isArray(detectors)
    ? detectors
    : (Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : []);
  const mismatchedTierPairIds = new Set();
  if (detPool.length >= 2) {
    const byRoad = new Map();
    for (let i = 0; i < detPool.length; i++) {
      const d = detPool[i];
      if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
      if (!Number.isFinite(Number(d.rot))) continue;
      const dSpd = Number(d.spd);
      if (d.spd === null || d.spd === undefined || !Number.isFinite(dSpd) || dSpd <= 0) continue;
      const rk = roadCoreOf(d.roadEn);
      if (!rk) continue;
      if (!byRoad.has(rk)) byRoad.set(rk, []);
      byRoad.get(rk).push(d);
    }

    for (const [rk, list] of byRoad.entries()) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const aLat = Number(a.lat), aLon = Number(a.lon), aRot = Number(a.rot);
        let bestNext = null;
        let bestIdx = -1;
        let bestDistM = Infinity;
        for (let j = 0; j < list.length; j++) {
          if (i === j) continue;
          const b = list[j];
          const bRot = Number(b.rot);
          if (_mapAngDiffDeg(aRot, bRot) > 28) continue;
          const dM = _distanceMetersFast(aLat, aLon, Number(b.lat), Number(b.lon));
          if (dM < 60 || dM > 600) continue;
          const linkBrg = _mapBearingDeg(aLat, aLon, Number(b.lat), Number(b.lon));
          if (_mapAngDiffDeg(aRot, linkBrg) > 22 || _mapAngDiffDeg(bRot, linkBrg) > 22) continue;
          if (dM < bestDistM) {
            bestDistM = dM;
            bestNext = b;
            bestIdx = j;
          }
        }
        if (!bestNext) continue;

        const bLat = Number(bestNext.lat), bLon = Number(bestNext.lon);
        const pairIdKey = (a.id && bestNext.id) ? `${a.id}->${bestNext.id}` : '';
        const pairCoordSig = `${aLat.toFixed(4)},${aLon.toFixed(4)}->${bLat.toFixed(4)},${bLon.toFixed(4)}`;
        if ((pairIdKey && existingPairKeys.has(pairIdKey)) || existingPairKeys.has(pairCoordSig)) continue;

        // Ensure no intermediate same-direction detector lies between a and bestNext
        let hasMid = false;
        for (let k = 0; k < list.length; k++) {
          if (k === i || k === bestIdx) continue;
          const c = list[k];
          if (_mapAngDiffDeg(aRot, Number(c.rot)) > 28) continue;
          const cLat = Number(c.lat), cLon = Number(c.lon);
          const dAC = _distanceMetersFast(aLat, aLon, cLat, cLon);
          const dCB = _distanceMetersFast(cLat, cLon, bLat, bLon);
          if (dAC >= 40 && dCB >= 40 && dAC < bestDistM - 30 && dCB < bestDistM - 30) {
            if (_mapPointToSegDistKm(cLat, cLon, aLat, aLon, bLat, bLon) <= 0.09) {
              hasMid = true;
              break;
            }
          }
        }
        if (hasMid) continue;

        const tierA = _normalizeGlobalSpeedTier(a.spd, a.tier);
        const tierB = _normalizeGlobalSpeedTier(bestNext.spd, bestNext.tier);
        const isGapBridge = bestDistM > 320;
        // For short gaps (320m - 600m), require matching speed tier before bridging
        if (isGapBridge && tierA !== tierB) {
          if (a.id) mismatchedTierPairIds.add(a.id);
          if (bestNext.id) mismatchedTierPairIds.add(bestNext.id);
          continue;
        }

        const avgSpd = Math.abs((Number.isFinite(Number(a.spd)) && Number.isFinite(Number(bestNext.spd)))
          ? Math.round((Number(a.spd) + Number(bestNext.spd)) * 0.5)
          : (Number(a.spd ?? bestNext.spd) || 0));
        if (avgSpd <= 0) continue;
        const rawBridgeCoords = [[aLon, aLat], [bLon, bLat]];
        const finalCoords = _applyKeepLeftOffsetAlongCoords(rawBridgeCoords, offsetM);
        existingPairKeys.add(pairCoordSig);
        if (pairIdKey) existingPairKeys.add(pairIdKey);

        const minLat = Math.min(finalCoords[0][1], finalCoords[1][1]);
        const maxLat = Math.max(finalCoords[0][1], finalCoords[1][1]);
        const minLon = Math.min(finalCoords[0][0], finalCoords[1][0]);
        const maxLon = Math.max(finalCoords[0][0], finalCoords[1][0]);

        const cleanRoadEn = sanitizeBottleneckLabel(a.roadEn || '');
        const cleanRoadTc = sanitizeBottleneckLabel(a.roadTc || a.roadEn || '');
        staged.push({
          feat: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: finalCoords },
            properties: {}
          },
          p: {
            id: a.id || '',
            toId: bestNext.id || '',
            roadEn: cleanRoadEn,
            roadTc: cleanRoadTc,
            dir: sanitizeBottleneckLabel(a.dir || ''),
            rot: aRot,
            rotA: aRot,
            rotB: Number(bestNext.rot) || aRot,
            spd: avgSpd,
            occ: Math.abs(Number(a.occ) || 0),
            tier: tierA,
            color: getGlobalTrafficSpeedColorHex(avgSpd, a.color),
            camKey: a.camKey || '',
            lenM: Math.round(bestDistM),
            rawCoords: rawBridgeCoords,
            isGapBridge,
            opacity: isGapBridge ? 0.55 : 0.95
          },
          roadCore: rk,
          rot: aRot,
          straightM: bestDistM,
          isTwoPoint: true,
          coords: finalCoords,
          bbox: { minLat, maxLat, minLon, maxLon },
          dropped: false
        });
      }
    }
  }

  // Project live congested TD Speed Detectors / Cameras (0 < spd <= 35 km/h or roundabout occ >= 70%, e.g. TDSLFR10002 Wong Chu Rd EB 17 km/h)
  // onto a >= 250 m (280 m) directional road polyline wherever TD Speed Map GeoJSON has a coverage gap
  // OR where a jammed roundabout/interchange approach would otherwise be washed out by downstream free-flow highway speed!
  if (detPool.length > 0) {
    const PROJ_HALF_M = 140; // 280 m total directional corridor line (>= 250 m)
    for (let i = 0; i < detPool.length; i++) {
      const d = detPool[i];
      if (!d) continue;
      const dLat = Number(d.lat), dLon = Number(d.lon), dRot = Number(d.rot);
      const dSpd = Number(d.spd);
      const dOcc = Math.abs(Number(d.occ) || 0);
      const isRbBottleneck = _isRoundaboutBottleneckMap(d);
      if (!Number.isFinite(dLat) || !Number.isFinite(dLon) || !Number.isFinite(dRot)) continue;
      if (!Number.isFinite(dSpd) || dSpd <= 0 || (dSpd > 35 && !isRbBottleneck)) continue;
      // Preserve mismatched-tier gap-bridging neutrality when no base TD GeoJSON links exist and no camKey is attached
      if (rawFeatures.length === 0 && !d.camKey && !isRbBottleneck && d.id && mismatchedTierPairIds.has(d.id)) continue;

      // Skip if an existing staged TD link already covers this detector within <= 65 m & <= 45° —
      // EXCEPT never let a free-flow (>= 40 km/h) downstream highway link suppress a jammed roundabout/interchange bottleneck!
      let alreadyCovered = false;
      for (let s = 0; s < staged.length; s++) {
        const st = staged[s];
        if (st.dropped) continue;
        if (dLat < st.bbox.minLat - 0.001 || dLat > st.bbox.maxLat + 0.001 || dLon < st.bbox.minLon - 0.001 || dLon > st.bbox.maxLon + 0.001) {
          continue;
        }
        const near = _nearestPointOnPolylineMeters(dLon, dLat, st.coords);
        if (near.distM <= 65 && near.proj && _mapAngDiffDeg(dRot, near.proj.brg) <= 45) {
          const stSpd = Number(st.p?.spd);
          const stIsFreeFlow = (Number.isFinite(stSpd) && stSpd >= 40) || st.p?.tier === 'SMOOTH';
          if (isRbBottleneck && stIsFreeFlow) {
            continue;
          }
          alreadyCovered = true;
          break;
        }
      }
      if (alreadyCovered) continue;

      const backBrg = (dRot + 180) % 360;
      const [pBackLat, pBackLon] = projectPointMeters(dLat, dLon, backBrg, PROJ_HALF_M);
      const [pFwdLat, pFwdLon] = projectPointMeters(dLat, dLon, dRot, PROJ_HALF_M);
      const rawProjCoords = [
        [Number(pBackLon.toFixed(6)), Number(pBackLat.toFixed(6))],
        [Number(dLon.toFixed(6)), Number(dLat.toFixed(6))],
        [Number(pFwdLon.toFixed(6)), Number(pFwdLat.toFixed(6))]
      ];
      const finalCoords = _applyKeepLeftOffsetAlongCoords(rawProjCoords, offsetM);
      const cleanSpd = Math.abs(Math.round(dSpd));
      const cleanRoadEn = sanitizeBottleneckLabel(d.roadEn || '');
      const cleanRoadTc = sanitizeBottleneckLabel(d.roadTc || d.roadEn || '');
      // Strict TD Red reservation: Red (#ef4444) only when speed < 15 km/h or occupancy >= 75%
      const projTier = (cleanSpd < 15 || dOcc >= 75) ? 'CONGESTED' : 'MODERATE';
      const projColor = projTier === 'CONGESTED' ? '#ef4444' : '#f59e0b';

      const minLat = Math.min(finalCoords[0][1], finalCoords[1][1], finalCoords[2][1]);
      const maxLat = Math.max(finalCoords[0][1], finalCoords[1][1], finalCoords[2][1]);
      const minLon = Math.min(finalCoords[0][0], finalCoords[1][0], finalCoords[2][0]);
      const maxLon = Math.max(finalCoords[0][0], finalCoords[1][0], finalCoords[2][0]);

      staged.push({
        feat: {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: finalCoords },
          properties: {}
        },
        p: {
          id: d.id || '',
          detectorId: d.id || '',
          roadEn: cleanRoadEn,
          roadTc: cleanRoadTc,
          dir: sanitizeBottleneckLabel(d.dir || ''),
          rot: dRot,
          rotA: dRot,
          rotB: dRot,
          spd: cleanSpd,
          occ: dOcc,
          tier: projTier,
          color: projColor,
          camKey: d.camKey || '',
          lenM: PROJ_HALF_M * 2,
          rawCoords: rawProjCoords,
          isGapBridge: false,
          isProjectedDetector: true,
          roundaboutBottleneck: isRbBottleneck,
          opacity: 0.95
        },
        roadCore: roadCoreOf(cleanRoadEn),
        rot: dRot,
        straightM: PROJ_HALF_M * 2,
        isTwoPoint: false,
        coords: finalCoords,
        bbox: { minLat, maxLat, minLon, maxLon },
        dropped: false
      });
    }
  }

  // Opposite-carriageway crossing guard:
  // Ensure opposite-direction links on the same highway never crisscross in an X shape.
  const minSepM = Math.max(2.0, offsetM * 1.4);
  for (let i = 0; i < staged.length; i++) {
    const a = staged[i];
    if (a.dropped || !a.roadCore || a.rot === null) continue;
    for (let j = i + 1; j < staged.length; j++) {
      const b = staged[j];
      if (b.dropped || b.roadCore !== a.roadCore || b.rot === null) continue;
      if (_mapAngDiffDeg(a.rot, b.rot) < 135) continue;
      const pad = 0.00035;
      if (a.bbox.maxLat + pad < b.bbox.minLat || b.bbox.maxLat + pad < a.bbox.minLat) continue;
      if (a.bbox.maxLon + pad < b.bbox.minLon || b.bbox.maxLon + pad < a.bbox.minLon) continue;

      if (!_polylinesIntersect2D(a.coords, b.coords)) continue;

      // Enforce simultaneous symmetric HK keep-left carriageway separation around the shared centerline
      const origA = a.coords.slice();
      const origB = b.coords.slice();
      const halfSepM = Math.max(1.6, minSepM * 0.6);
      const projectToKeepLeft = (srcCoords, oppCoords) => {
        const last = srcCoords.length - 1;
        return srcCoords.map((pt, idx) => {
          const near = _nearestPointOnPolylineMeters(pt[0], pt[1], oppCoords);
          if (!near.proj || near.distM > 65) return pt;
          const pPrev = srcCoords[Math.max(0, idx - 1)];
          const pNext = srcCoords[Math.min(last, idx + 1)];
          const hdg = _mapBearingDeg(pPrev[1], pPrev[0], pNext[1], pNext[0]);
          const leftBrg = (hdg + 270) % 360;
          const leftRad = leftBrg * Math.PI / 180;
          const cosLat = Math.max(0.2, Math.cos(pt[1] * Math.PI / 180));
          const dxM = (pt[0] - near.proj.lon) * 111111 * cosLat;
          const dyM = (pt[1] - near.proj.lat) * 111111;
          const signedLeftM = dxM * Math.sin(leftRad) + dyM * Math.cos(leftRad);
          if (signedLeftM < minSepM) {
            const midLat = (pt[1] + near.proj.lat) * 0.5;
            const midLon = (pt[0] + near.proj.lon) * 0.5;
            const [sLat, sLon] = projectPointMeters(midLat, midLon, leftBrg, halfSepM);
            return [Number(sLon.toFixed(6)), Number(sLat.toFixed(6))];
          }
          return pt;
        });
      };
      a.coords = projectToKeepLeft(origA, origB);
      b.coords = projectToKeepLeft(origB, origA);
      // If still intersecting after symmetric keep-left push, drop the longer/bridge segment
      if (_polylinesIntersect2D(a.coords, b.coords)) {
        if (a.p.isGapBridge && !b.p.isGapBridge) a.dropped = true;
        else if (b.p.isGapBridge && !a.p.isGapBridge) b.dropped = true;
        else if (a.straightM >= b.straightM) a.dropped = true;
        else b.dropped = true;
        if (a.dropped) break;
      }
    }
  }

  const out = [];
  for (let i = 0; i < staged.length; i++) {
    const item = staged[i];
    if (item.dropped) continue;
    out.push({
      ...item.feat,
      geometry: { ...item.feat.geometry, coordinates: item.coords },
      properties: {
        ...item.p,
        color: getGlobalTrafficSpeedColorHex(item.p.spd, item.p.color),
        appliedOffsetM: offsetM
      }
    });
  }
  return { type: 'FeatureCollection', features: out };
}

function buildGlobalSpeedMapGeoJsonFallback(detectors = []) {
  const features = [];
  if (!Array.isArray(detectors) || !detectors.length) {
    return { type: 'FeatureCollection', features };
  }
  const roadCoreOf = (s) => String(s || '').split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0].trim().toLowerCase();
  const byRoad = new Map();
  for (let i = 0; i < detectors.length; i++) {
    const d = detectors[i];
    if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
    const rk = roadCoreOf(d.roadEn) || d.id;
    if (!byRoad.has(rk)) byRoad.set(rk, []);
    byRoad.get(rk).push(d);
  }
  for (const list of byRoad.values()) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const aLat = Number(a.lat), aLon = Number(a.lon);
      const aRot = Number(a.rot) || 0;
      let bestNext = null;
      let bestNextIdx = -1;
      let bestDistM = Infinity;
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue;
        const b = list[j];
        const bRot = Number(b.rot) || 0;
        if (_mapAngDiffDeg(aRot, bRot) > 28) continue;
        const dM = _distanceMetersFast(aLat, aLon, Number(b.lat), Number(b.lon));
        // Keep parallel 2-point links between 60m and 320m; short gaps (320-600m) are bridged in filterAndOffsetGlobalSpeedGeoJson
        if (dM < 60 || dM > 320) continue;
        const linkBrg = _mapBearingDeg(aLat, aLon, Number(b.lat), Number(b.lon));
        if (_mapAngDiffDeg(aRot, linkBrg) > 22) continue;
        if (_mapAngDiffDeg(bRot, linkBrg) > 22) continue;
        if (dM < bestDistM) {
          bestDistM = dM;
          bestNext = b;
          bestNextIdx = j;
        }
      }
      if (!bestNext) continue;
      const bLat = Number(bestNext.lat), bLon = Number(bestNext.lon);
      let hasMid = false;
      for (let k = 0; k < list.length; k++) {
        if (k === i || k === bestNextIdx) continue;
        const c = list[k];
        if (!c || _mapAngDiffDeg(aRot, Number(c.rot) || 0) > 28) continue;
        const cLat = Number(c.lat), cLon = Number(c.lon);
        const dAC = _distanceMetersFast(aLat, aLon, cLat, cLon);
        const dCB = _distanceMetersFast(cLat, cLon, bLat, bLon);
        if (dAC >= 40 && dCB >= 40 && dAC < bestDistM - 30 && dCB < bestDistM - 30) {
          if (_mapPointToSegDistKm(cLat, cLon, aLat, aLon, bLat, bLon) <= 0.09) {
            hasMid = true;
            break;
          }
        }
      }
      if (hasMid) continue;

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[aLon, aLat], [bLon, bLat]]
        },
        properties: {
          id: a.id || '',
          toId: bestNext.id || '',
          roadEn: a.roadEn || '',
          roadTc: a.roadTc || a.roadEn || '',
          dir: a.dir || '',
          rot: aRot,
          rotA: aRot,
          rotB: Number(bestNext.rot) || aRot,
          spd: a.spd ?? null,
          occ: a.occ || 0,
          tier: a.tier || 'SMOOTH',
          color: getGlobalTrafficSpeedColorHex(a.spd),
          camKey: a.camKey || '',
          lenM: Math.round(bestDistM),
          rawCoords: [[aLon, aLat], [bLon, bLat]],
          isGapBridge: false,
          opacity: 0.95
        }
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function clearGlobalTrafficDashboard(targetMap = window.browseMapInstance) {
  if (_globalCameraClusterGroup) {
    try { _globalCameraClusterGroup.clearLayers?.(); } catch (e) {}
    if (targetMap) {
      try { targetMap.removeLayer(_globalCameraClusterGroup); } catch (e) {}
    }
    _globalCameraClusterGroup = null;
  }
  if (_globalTrafficLayerGroup) {
    try { _globalTrafficLayerGroup.clearLayers?.(); } catch (e) {}
    if (targetMap) {
      try { targetMap.removeLayer(_globalTrafficLayerGroup); } catch (e) {}
    }
    _globalTrafficLayerGroup = null;
  }
  if (typeof updateTrafficViewportDebugCounts === 'function') {
    updateTrafficViewportDebugCounts(targetMap);
  }
}

function renderGlobalTrafficDashboard(targetMap = window.browseMapInstance) {
  if (!targetMap || typeof L === 'undefined') return;

  if (!window.globalTrafficLayerEnabled) {
    clearGlobalTrafficDashboard(targetMap);
    return;
  }

  // De-cluttering Logic: hide bus/MTR/ferry stop markers so macro traffic speed lines are unobstructed
  clearAllActiveBrowseMarkers();
  clearGlobalTrafficDashboard(targetMap);

  _globalTrafficLayerGroup = L.layerGroup().addTo(targetMap);
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const zoom = targetMap.getZoom ? (targetMap.getZoom() || 13) : 13;

  const detectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const workerGeo = window.__LIVE_TRAFFIC_SPEED_GEOJSON__;
  const rawSpeedGeo = (workerGeo && workerGeo.type === 'FeatureCollection' && Array.isArray(workerGeo.features) && workerGeo.features.length > 0)
    ? workerGeo
    : buildGlobalSpeedMapGeoJsonFallback(detectors);
  const speedGeo = filterAndOffsetGlobalSpeedGeoJson(rawSpeedGeo, zoom, detectors);
  window.__LAST_GLOBAL_SPEED_GEOJSON__ = speedGeo;

  const casingWeight = 6.5;
  const flowWeight = 4.5;

  if (speedGeo && Array.isArray(speedGeo.features) && speedGeo.features.length > 0) {
    if (typeof L.geoJSON === 'function') {
      // Crisp dark casing (#0f172a) underneath solid TD ground-truth 4.5px stroke (opacity 0.92, dashArray null)
      L.geoJSON(speedGeo, {
        interactive: false,
        style: (feat) => ({
          color: '#0f172a',
          weight: casingWeight,
          opacity: feat?.properties?.isGapBridge ? 0.34 : 0.65,
          dashArray: null,
          smoothFactor: 1.5,
          lineCap: 'round',
          lineJoin: 'round'
        })
      }).addTo(_globalTrafficLayerGroup);

      L.geoJSON(speedGeo, {
        style: (feat) => ({
          color: feat?.properties?.color || '#3b82f6',
          weight: flowWeight,
          opacity: feat?.properties?.isGapBridge ? 0.55 : 0.92,
          dashArray: null,
          smoothFactor: 1.5,
          lineCap: 'round',
          lineJoin: 'round'
        }),
        onEachFeature: (feat, lyr) => {
          const p = feat?.properties;
          if (!p) return;
          const cleanName = sanitizeBottleneckLabel(isZh ? (p.roadTc || p.roadEn) : (p.roadEn || p.roadTc)) || (isZh ? '主要幹道' : 'Major Road');
          const spdTxt = (p.spd !== null && p.spd !== undefined && Number.isFinite(Number(p.spd)) && Number(p.spd) > 0)
            ? `${Math.abs(Math.round(Number(p.spd)))} km/h`
            : (isZh ? '無實時數據' : 'No live speed');
          const bridgeNote = p.isGapBridge ? (isZh ? ' · 路段推算' : ' · bridged gap') : '';
          if (typeof lyr.bindTooltip === 'function') {
            lyr.bindTooltip(`${cleanName} · ${spdTxt}${bridgeNote}`, { sticky: true, className: 'kmb-map-stop-label' });
          }
          if (p.id && typeof lyr.on === 'function') {
            lyr.on('click', (ev) => {
              if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
              if (typeof window.openTrafficDecisionModal === 'function') {
                const detObj = detectors.find(x => x.id === p.id);
                window.openTrafficDecisionModal(p.id, detObj ? _findOppositeTrafficDetectorId(detObj) : '', '', false);
              }
            });
          }
        }
      }).addTo(_globalTrafficLayerGroup);
    } else {
      speedGeo.features.forEach((feat) => {
        const coords = feat?.geometry?.coordinates || [];
        if (coords.length < 2) return;
        const latlngs = coords.map(c => [c[1], c[0]]);
        const isBridge = Boolean(feat?.properties?.isGapBridge);
        L.polyline(latlngs, { color: '#0f172a', weight: casingWeight, opacity: isBridge ? 0.34 : 0.62, smoothFactor: 1.5, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(_globalTrafficLayerGroup);
        L.polyline(latlngs, { color: feat?.properties?.color || '#3b82f6', weight: flowWeight, opacity: isBridge ? 0.55 : 0.95, smoothFactor: 1.5, lineCap: 'round', lineJoin: 'round' }).addTo(_globalTrafficLayerGroup);
      });
    }
  }

  // Issue 1: Clean overview without numbered camera cluster bubbles!
  // Only show individual directional cameras when zoomed in (zoom >= 14), filtered to current viewport with de-overlap.
  if (zoom < GLOBAL_CAMERA_MIN_ZOOM) {
    if (typeof updateTrafficViewportDebugCounts === 'function') {
      updateTrafficViewportDebugCounts(targetMap);
    }
    return;
  }

  let cameras = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) && window.__LIVE_TRAFFIC_CAMERAS__.length
    ? window.__LIVE_TRAFFIC_CAMERAS__
    : [];
  if (!cameras.length && detectors.length) {
    const seenCam = new Set();
    cameras = [];
    for (let i = 0; i < detectors.length; i++) {
      const d = detectors[i];
      if (!d?.camKey || seenCam.has(d.camKey)) continue;
      seenCam.add(d.camKey);
      cameras.push({
        key: d.camKey,
        desc: d.roadEn || d.roadTc || d.camKey,
        lat: d.lat,
        lon: d.lon,
        detId: d.id
      });
    }
  }

  if (cameras.length) {
    _globalCameraClusterGroup = L.layerGroup();
    const rawBounds = targetMap.getBounds ? targetMap.getBounds() : null;
    const viewBounds = (rawBounds && typeof rawBounds.pad === 'function') ? rawBounds.pad(0.15) : rawBounds;
    const placedCamPts = [];
    const MIN_GLOBAL_CAM_PX = zoom >= 16 ? 22 : 34;

    for (let i = 0; i < cameras.length; i++) {
      const cam = cameras[i];
      const cLat = Number(cam.lat), cLon = Number(cam.lon);
      if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
      if (viewBounds && typeof viewBounds.contains === 'function' && !viewBounds.contains([cLat, cLon])) continue;

      const ptPx = projectDetectorToScreenPx(targetMap, cLat, cLon, zoom);
      let tooClose = false;
      for (let p = 0; p < placedCamPts.length; p++) {
        if (Math.hypot(ptPx.x - placedCamPts[p].x, ptPx.y - placedCamPts[p].y) < MIN_GLOBAL_CAM_PX) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      placedCamPts.push(ptPx);

      const bearingDeg = resolveCameraBearingDeg(cam, detectors, null);
      const compassTxt = formatCompassFromBearingDeg(bearingDeg, isZh);
      const dirMeta = (typeof window.extractCardinalDirectionMeta === 'function')
        ? window.extractCardinalDirectionMeta(cam, isZh)
        : null;
      const boundBadge = dirMeta?.code ? `${dirMeta.arrowGlyph} ${dirMeta.code}` : '';
      const camIcon = buildDirectionalCameraDivIcon(cam, bearingDeg, isZh, false, 1.0);
      const m = L.marker([cLat, cLon], { icon: camIcon, zIndexOffset: 240 });
      const cleanDesc = sanitizeBottleneckLabel(cam.desc || cam.key);
      const orientTag = [boundBadge, compassTxt].filter(Boolean).join(' · ');
      const matchedDetForTip = (typeof window.findNearestMatchingDetectorForCamera === 'function')
        ? window.findNearestMatchingDetectorForCamera({ ...cam, bearingDeg }, detectors)
        : null;
      const tipSpdPart = (matchedDetForTip && Number.isFinite(Number(matchedDetForTip.spd)) && Number(matchedDetForTip.spd) > 0)
        ? ` · ${Math.abs(Math.round(Number(matchedDetForTip.spd)))} km/h`
        : '';
      if (typeof m.bindTooltip === 'function') {
        m.bindTooltip(`📷 ${cleanDesc}${orientTag ? ` (${orientTag})` : ''}${tipSpdPart}`, { direction: 'top', offset: [0, -10], className: 'kmb-map-stop-label' });
      }
      if (typeof m.on === 'function') {
        m.on('click', (ev) => {
          if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
          try {
            document.querySelectorAll('.global-traffic-cam-marker.cam-selected').forEach(el => el.classList.remove('cam-selected'));
            const clickedEl = document.querySelector(`.global-traffic-cam-marker[data-cam-key="${CSS.escape ? CSS.escape(cam.key) : cam.key}"]`);
            if (clickedEl) clickedEl.classList.add('cam-selected');
          } catch (e) {}
          const matchedDet = (typeof window.findNearestMatchingDetectorForCamera === 'function')
            ? window.findNearestMatchingDetectorForCamera({ ...cam, bearingDeg }, detectors)
            : (detectors.find(x => x.id === cam.key || x.camKey === cam.key) || null);
          if (matchedDet && typeof window.openTrafficDecisionModal === 'function') {
            window.openTrafficDecisionModal(matchedDet.id, _findOppositeTrafficDetectorId(matchedDet), '', false, { ...cam, bearingDeg });
          } else if (typeof window.openTrafficCameraModal === 'function') {
            window.openTrafficCameraModal({ ...cam, bearingDeg, suppressDetectorSpeed: true });
          }
        });
      }
      _globalCameraClusterGroup.addLayer ? _globalCameraClusterGroup.addLayer(m) : m.addTo(_globalCameraClusterGroup);
    }
    _globalCameraClusterGroup.addTo(targetMap);
  }
  if (typeof updateTrafficViewportDebugCounts === 'function') {
    updateTrafficViewportDebugCounts(targetMap);
  }
}

const _CLIENT_CAM_LANDMARK_ANCHORS = [
  { re: /\btm[\s-]*clk(?:l|\s*tunnel)?\s*(?:northern|north)\s*portal\b/i, lat: 22.3694, lon: 113.9585 },
  { re: /\btm[\s-]*clk(?:l|\s*tunnel)?\s*(?:southern|south)\s*portal\b/i, lat: 22.3176, lon: 113.9498 },
  { re: /\btm[\s-]*clkl\b|\btuen\s*mun[\s-]*chek\s*lap\s*kok\b/i, lat: 22.3694, lon: 113.9585 },
  { re: /\blung\s*mun\s*(?:rd|road)\s*roundabout\b/i, lat: 22.3712, lon: 113.9562 },
  { re: /\blung\s*mun\s*(?:rd|road)\b/i, lat: 22.3782, lon: 113.9612 },
  { re: /\bwong\s*chu\s*(?:rd|road)\b/i, lat: 22.3822, lon: 113.9675 },
  { re: /\btuen\s*mun\s*(?:rd|road)\b/i, lat: 22.3885, lon: 113.9765 },
  { re: /\bhzmb\b|\bhong\s*kong\s*port\b|\bshun\s*long\s*(?:rd|road)\b/i, lat: 22.3168, lon: 113.9502 },
  { re: /\bnorth\s*lantau\s*(?:hwy|highway)\b/i, lat: 22.2952, lon: 113.9438 },
  { re: /\btung\s*chung\b/i, lat: 22.2892, lon: 113.9416 },
  { re: /\bairport\b|\bchek\s*lap\s*kok\b/i, lat: 22.3080, lon: 113.9185 },
  { re: /\btsing\s*ma\b|\blantau\s*link\b/i, lat: 22.3514, lon: 114.0737 },
  { re: /\bting\s*kau\b/i, lat: 22.3688, lon: 114.0793 },
  { re: /\btai\s*lam\s*tunnel\b/i, lat: 22.4048, lon: 114.0598 },
  { re: /\byuen\s*long\s*(?:hwy|highway)\b/i, lat: 22.4388, lon: 114.0110 },
  { re: /\btolo\s*(?:hwy|highway)\b/i, lat: 22.4265, lon: 114.2055 },
  { re: /\blion\s*rock\s*tunnel\b/i, lat: 22.3568, lon: 114.1755 },
  { re: /\btate'?s\s*cairn\b/i, lat: 22.3698, lon: 114.2125 },
  { re: /\bshing\s*mun\s*tunnel\b/i, lat: 22.3792, lon: 114.1562 },
  { re: /\bcross[\s-]*harbour\s*tunnel\b|\bcht\b/i, lat: 22.2918, lon: 114.1818 },
  { re: /\bwestern\s*harbour\b|\bwhc\b/i, lat: 22.2955, lon: 114.1525 },
  { re: /\beastern\s*harbour\b|\behc\b/i, lat: 22.2958, lon: 114.2225 },
  { re: /\baberdeen\s*tunnel\b/i, lat: 22.2562, lon: 114.1755 },
  { re: /\btseung\s*kwan\s*o\s*tunnel\b|\btko\s*tunnel\b/i, lat: 22.3182, lon: 114.2465 },
  { re: /\bcheung\s*tsing\b/i, lat: 22.3515, lon: 114.0985 },
  { re: /\beagle'?s\s*nest\b|\btsing\s*sha\b/i, lat: 22.3502, lon: 114.1538 },
  { re: /\bcentral[\s-]*wan\s*chai\s*bypass\b/i, lat: 22.2852, lon: 114.1745 }
];

function _camHaversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _camBearingDeg(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.round(Math.atan2(y, x) * 180 / Math.PI) % 360) + 360) % 360;
}

function _minPointToPolylineDistKm(lat, lon, coords) {
  if (!Array.isArray(coords) || coords.length < 2) return Infinity;
  let best = Infinity;
  const useSegFn = typeof window !== 'undefined' && typeof window.pointToSegmentDistanceKm === 'function';
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    if (!a || !b) continue;
    const dKm = useSegFn
      ? window.pointToSegmentDistanceKm(lat, lon, a[0], a[1], b[0], b[1]).distKm
      : _camHaversineKm(lat, lon, (a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5);
    if (dKm < best) best = dKm;
  }
  return best;
}

function _projectPointOntoPolylineDetailed(lat, lon, coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return { distKm: Infinity, alongKm: Infinity, segBrg: NaN };
  }
  let bestDistKm = Infinity;
  let bestAlongKm = Infinity;
  let bestSegBrg = NaN;
  let cumKm = 0;
  const useSegFn = typeof window !== 'undefined' && typeof window.pointToSegmentDistanceKm === 'function';
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    if (!a || !b) continue;
    const segKm = _camHaversineKm(a[0], a[1], b[0], b[1]);
    let dKm = Infinity;
    let t = 0;
    if (useSegFn) {
      const res = window.pointToSegmentDistanceKm(lat, lon, a[0], a[1], b[0], b[1]);
      dKm = res.distKm;
      t = Number.isFinite(res.t) ? res.t : 0;
    } else {
      dKm = _camHaversineKm(lat, lon, (a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5);
      t = 0.5;
    }
    if (dKm < bestDistKm) {
      bestDistKm = dKm;
      bestAlongKm = cumKm + t * segKm;
      bestSegBrg = _camBearingDeg(a[0], a[1], b[0], b[1]);
    }
    cumKm += segKm;
  }
  return { distKm: bestDistKm, alongKm: bestAlongKm, segBrg: bestSegBrg };
}

const _CLIENT_VERIFIED_CAMERA_AZIMUTHS = {
  TC003F: 175, // TM-CLK Tunnel Northern Portal (looking south into tunnel portal)
  TC002F: 225, // Lung Mun Rd Roundabout near TM-CLKL (looking southwest along Lung Fu Rd tunnel approach)
  TC001F: 20,  // TM-CLK Tunnel Southern Portal (looking north into southern portal)
  NL128F: 75,  // North Lantau Highway near Tung Chung
  NL126F: 255, // North Lantau Highway near Pak Mong
  NL206F: 205  // Shun Long Road near North Lantau Highway
};

function resolveCameraBearingDeg(cam, detectors = [], routeCoords = null) {
  if (!cam) return 0;
  const camKeyUpper = String(cam.key || '').trim().toUpperCase();
  // 0. Explicit verified camera viewing azimuths (take precedence over XML/heuristic fallbacks)
  if (camKeyUpper && Object.prototype.hasOwnProperty.call(_CLIENT_VERIFIED_CAMERA_AZIMUTHS, camKeyUpper)) {
    return _CLIENT_VERIFIED_CAMERA_AZIMUTHS[camKeyUpper];
  }
  if (cam.bearingDeg !== undefined && cam.bearingDeg !== null && Number.isFinite(Number(cam.bearingDeg))) {
    return ((Math.round(Number(cam.bearingDeg)) % 360) + 360) % 360;
  }
  const cLat = Number(cam.lat), cLon = Number(cam.lon);
  const desc = String(cam.desc || '');
  const detList = Array.isArray(detectors) ? detectors : [];
  const cRoad = desc.split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0].trim().toLowerCase();

  const extractTextDir = (s) => {
    const t = String(s || '');
    if (/\b(?:northbound|north[\s-]*bound|\(nb\)|nb)\b|北行/i.test(t)) return 'NB';
    if (/\b(?:eastbound|east[\s-]*bound|\(eb\)|eb)\b|東行/i.test(t)) return 'EB';
    if (/\b(?:southbound|south[\s-]*bound|\(sb\)|sb)\b|南行/i.test(t)) return 'SB';
    if (/\b(?:westbound|west[\s-]*bound|\(wb\)|wb)\b|西行/i.test(t)) return 'WB';
    return '';
  };
  const isOppDir = (a, b) => (a === 'EB' && b === 'WB') || (a === 'WB' && b === 'EB') || (a === 'NB' && b === 'SB') || (a === 'SB' && b === 'NB');

  const dirTxt = `${cam.dir || ''} ${desc}`;
  const textDir = extractTextDir(dirTxt);
  let cardinalDeg = null;
  if (/\bnorth[\s-]*east(?:bound)?\b/i.test(dirTxt)) cardinalDeg = 45;
  else if (/\bnorth[\s-]*west(?:bound)?\b/i.test(dirTxt)) cardinalDeg = 315;
  else if (/\bsouth[\s-]*east(?:bound)?\b/i.test(dirTxt)) cardinalDeg = 135;
  else if (/\bsouth[\s-]*west(?:bound)?\b/i.test(dirTxt)) cardinalDeg = 225;
  else if (textDir === 'NB') cardinalDeg = 0;
  else if (textDir === 'EB') cardinalDeg = 90;
  else if (textDir === 'SB') cardinalDeg = 180;
  else if (textDir === 'WB') cardinalDeg = 270;

  // 1. Exact TD detector match (e.g. AID* / TDS* cameras like TDS90070 EB @ 30° & TDS91054 WB @ 200°):
  //    Always prioritize exact detector road heading/link tangent before cardinal compass fallbacks.
  if (detList.length) {
    let exactDet = null;
    let pairedDet = null;
    for (let i = 0; i < detList.length; i++) {
      const d = detList[i];
      if (!d || !Number.isFinite(Number(d.rot))) continue;
      if (d.id === cam.key) { exactDet = d; break; }
      if (!pairedDet && d.camKey === cam.key) {
        const dTextDir = extractTextDir(d.roadEn || '');
        if (!textDir || !dTextDir || !isOppDir(textDir, dTextDir)) pairedDet = d;
      }
    }
    const matchedDet = exactDet || pairedDet;
    if (matchedDet) {
      const detRot = ((Math.round(Number(matchedDet.rot)) % 360) + 360) % 360;
      const speedFeats = window?.__LIVE_TRAFFIC_SPEED_GEOJSON__?.features;
      if (Array.isArray(speedFeats) && speedFeats.length) {
        for (let i = 0; i < speedFeats.length; i++) {
          const f = speedFeats[i];
          if (f?.properties?.id !== matchedDet.id && f?.properties?.toId !== matchedDet.id) continue;
          const rc = Array.isArray(f?.properties?.rawCoords) && f.properties.rawCoords.length >= 2
            ? f.properties.rawCoords
            : f?.geometry?.coordinates;
          if (!Array.isArray(rc) || rc.length < 2) continue;
          const a = rc[0], b = rc[rc.length - 1];
          const linkTangent = _camBearingDeg(a[1], a[0], b[1], b[0]);
          if (_mapAngDiffDeg(detRot, linkTangent) <= 25) return ((Math.round(linkTangent) % 360) + 360) % 360;
        }
      }
      return detRot;
    }
  }

  // 2. Explicit cardinal / intercardinal bound from camera description:
  //    2a. Match same-road TD speed-link or detector with the SAME explicit bound label at any curve angle
  //    2b. Fallback to nearby speed-link tangent or detector rot within <= 75° of cardinalDeg (never opposite bound)
  if (cardinalDeg !== null) {
    if (Number.isFinite(cLat) && Number.isFinite(cLon)) {
      const speedFeats = window?.__LIVE_TRAFFIC_SPEED_GEOJSON__?.features;
      if (Array.isArray(speedFeats) && speedFeats.length) {
        let bestSameBoundTangent = null, bestSameBoundDist = Infinity;
        let bestTangent = null, bestScore = Infinity;
        for (let i = 0; i < speedFeats.length; i++) {
          const f = speedFeats[i];
          const rc = Array.isArray(f?.properties?.rawCoords) && f.properties.rawCoords.length >= 2
            ? f.properties.rawCoords
            : f?.geometry?.coordinates;
          if (!Array.isArray(rc) || rc.length < 2) continue;
          const a = rc[0], b = rc[rc.length - 1];
          const midLat = (a[1] + b[1]) * 0.5, midLon = (a[0] + b[0]) * 0.5;
          if (Math.abs(midLat - cLat) > 0.015 || Math.abs(midLon - cLon) > 0.015) continue;
          const fTextDir = extractTextDir(f?.properties?.roadEn || '');
          if (textDir && fTextDir && isOppDir(textDir, fTextDir)) continue;
          const linkTangent = _camBearingDeg(a[1], a[0], b[1], b[0]);
          const dKm = _mapPointToSegDistKm(cLat, cLon, a[1], a[0], b[1], b[0]);
          const fRoad = String(f?.properties?.roadEn || '').split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0].trim().toLowerCase();
          const sameRoad = Boolean(cRoad && fRoad && (cRoad === fRoad || cRoad.includes(fRoad) || fRoad.includes(cRoad)));
          if (sameRoad && textDir && fTextDir === textDir && dKm <= 1.2 && dKm < bestSameBoundDist) {
            bestSameBoundDist = dKm;
            bestSameBoundTangent = linkTangent;
          }
          const dAng = _mapAngDiffDeg(cardinalDeg, linkTangent);
          if (dAng <= 75 && dKm <= 0.85) {
            const score = dKm + (sameRoad ? 0 : 0.28) + dAng * 0.0015;
            if (score < bestScore) {
              bestScore = score;
              bestTangent = linkTangent;
            }
          }
        }
        if (bestSameBoundTangent !== null) return ((Math.round(bestSameBoundTangent) % 360) + 360) % 360;
        if (bestTangent !== null) return ((Math.round(bestTangent) % 360) + 360) % 360;
      }

      if (detList.length) {
        let bestSameBoundRot = null, bestSameBoundDist = Infinity;
        let bestRot = null, bestScore = Infinity;
        for (let i = 0; i < detList.length; i++) {
          const d = detList[i];
          if (!d || !Number.isFinite(Number(d.rot)) || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
          const dTextDir = extractTextDir(d.roadEn || '');
          if (textDir && dTextDir && isOppDir(textDir, dTextDir)) continue;
          const dKm = _camHaversineKm(cLat, cLon, d.lat, d.lon);
          const dRoad = String(d.roadEn || '').split(/\s+near\s+|\s+-\s+|\s*\/\s*|\s*\(/i)[0].trim().toLowerCase();
          const sameRoad = Boolean(cRoad && dRoad && (cRoad === dRoad || cRoad.includes(dRoad) || dRoad.includes(cRoad)));
          if (sameRoad && textDir && dTextDir === textDir && dKm <= 1.0 && dKm < bestSameBoundDist) {
            bestSameBoundDist = dKm;
            bestSameBoundRot = Number(d.rot);
          }
          const dAng = _mapAngDiffDeg(cardinalDeg, Number(d.rot));
          if (dKm <= 0.65 && dAng <= 75) {
            const score = dKm + (sameRoad ? 0 : 0.25) + dAng * 0.002;
            if (score < bestScore) {
              bestScore = score;
              bestRot = Number(d.rot);
            }
          }
        }
        if (bestSameBoundRot !== null) return ((Math.round(bestSameBoundRot) % 360) + 360) % 360;
        if (bestRot !== null) return ((Math.round(bestRot) % 360) + 360) % 360;
      }
    }
    return cardinalDeg;
  }

  // 3. Landmark / cross-road vector for standalone intersection, roundabout & portal cameras
  if (Number.isFinite(cLat) && Number.isFinite(cLon) && desc) {
    const lmMatch = desc.match(/(?:\bnear\b|\btowards?\b|\bfacing\b|\bat\b|\/)\s*([^(\-–,]+)/i);
    const focusPhrase = lmMatch ? lmMatch[1].trim() : '';
    const phrases = focusPhrase ? [focusPhrase, desc] : [desc];
    for (let p = 0; p < phrases.length; p++) {
      for (let a = 0; a < _CLIENT_CAM_LANDMARK_ANCHORS.length; a++) {
        const anchor = _CLIENT_CAM_LANDMARK_ANCHORS[a];
        if (!anchor.re.test(phrases[p])) continue;
        const dKm = _camHaversineKm(cLat, cLon, anchor.lat, anchor.lon);
        if (dKm >= 0.025 && dKm <= 8.0) {
          return _camBearingDeg(cLat, cLon, anchor.lat, anchor.lon);
        }
      }
    }

    // 4. Nearest detector rot / vector fallback
    let bestDet = null, bestDist = Infinity;
    for (let i = 0; i < detList.length; i++) {
      const d = detList[i];
      if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
      const dKm = _camHaversineKm(cLat, cLon, d.lat, d.lon);
      if (dKm <= 1.2 && dKm < bestDist) {
        bestDist = dKm;
        bestDet = d;
      }
    }
    if (bestDet) {
      if (Number.isFinite(Number(bestDet.rot)) && bestDist <= 0.65) {
        return ((Math.round(Number(bestDet.rot)) % 360) + 360) % 360;
      }
      if (bestDist >= 0.02) return _camBearingDeg(cLat, cLon, bestDet.lat, bestDet.lon);
    }

    // 5. Nearest active route segment tangent fallback
    if (Array.isArray(routeCoords) && routeCoords.length >= 2) {
      let bestSegDist = Infinity, bestSegBrg = 0;
      for (let i = 0; i < routeCoords.length - 1; i++) {
        const a = routeCoords[i], b = routeCoords[i + 1];
        if (!a || !b) continue;
        const midLat = (a[0] + b[0]) * 0.5, midLon = (a[1] + b[1]) * 0.5;
        const dKm = _camHaversineKm(cLat, cLon, midLat, midLon);
        if (dKm < bestSegDist) {
          bestSegDist = dKm;
          bestSegBrg = _camBearingDeg(a[0], a[1], b[0], b[1]);
        }
      }
      if (Number.isFinite(bestSegBrg)) return bestSegBrg;
    }
  }
  return 0;
}

function formatCompassFromBearingDeg(deg, isZh = false) {
  const d = ((Number(deg) % 360) + 360) % 360;
  if (isZh) {
    const dirs = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
    return `望向${dirs[Math.round(d / 45) % 8]}`;
  }
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `Facing ${dirs[Math.round(d / 45) % 8]}`;
}

function buildDirectionalCameraDivIcon(cam, bearingDeg, isZh = false, isRouteView = false, opacity = 1.0, alongKm = null) {
  const deg = ((Math.round(Number(bearingDeg) || 0) % 360) + 360) % 360;
  const titleTxt = escapeHtml(cam?.desc || cam?.key || (isZh ? '運輸署實時鏡頭' : 'TD Live Traffic Camera'));
  const op = Number.isFinite(Number(opacity)) ? Math.max(0.2, Math.min(1, Number(opacity))) : 1.0;
  const alongAttr = Number.isFinite(Number(alongKm)) ? ` data-along-km="${Number(alongKm).toFixed(2)}"` : '';
  // High-contrast 45° radar FOV sector (36px radius wedge centered at 40,40) rotated clockwise by bearingDeg
  const html = `
    <div class="cam-fov-marker-wrap${isRouteView ? ' is-route-cam' : ''}" data-cam-key="${escapeHtml(cam?.key || '')}" data-bearing="${deg}" data-opacity="${op}"${alongAttr} style="opacity:${op};" title="${titleTxt}">
      <svg class="cam-fov-svg" width="80" height="80" viewBox="0 0 80 80" aria-hidden="true" style="transform:rotate(${deg}deg);">
        <path d="M40 40 L26.22 6.74 A36 36 0 0 1 53.78 6.74 Z" fill="rgba(37, 99, 235, 0.28)" stroke="#2563eb" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M40 2.6 L43.4 9.2 L40 7.6 L36.6 9.2 Z" fill="#2563eb" stroke="#FFFFFF" stroke-width="0.9" stroke-linejoin="round"/>
      </svg>
      <div class="global-traffic-cam-marker" data-cam-key="${escapeHtml(cam?.key || '')}">📷</div>
    </div>`;
  return L.divIcon({
    className: 'global-traffic-cam-icon',
    html,
    iconSize: [80, 80],
    iconAnchor: [40, 40]
  });
}

if (typeof window !== 'undefined') {
  window.getGlobalTrafficSpeedColorHex = getGlobalTrafficSpeedColorHex;
  window.resolveCameraBearingDeg = resolveCameraBearingDeg;
  window.formatCompassFromBearingDeg = formatCompassFromBearingDeg;
  window.buildDirectionalCameraDivIcon = buildDirectionalCameraDivIcon;
}

function _ensureMapBusSpeedDebugState() {
  if (!window.__BUS_SPEED_DEBUG__ || typeof window.__BUS_SPEED_DEBUG__ !== 'object') {
    window.__BUS_SPEED_DEBUG__ = {
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
  return window.__BUS_SPEED_DEBUG__;
}

function _extractMapBoundsBox(bounds) {
  if (!bounds) return null;
  try {
    if (typeof bounds.getSouth === 'function' && typeof bounds.getNorth === 'function' && typeof bounds.getWest === 'function' && typeof bounds.getEast === 'function') {
      return {
        south: Number(bounds.getSouth()),
        north: Number(bounds.getNorth()),
        west: Number(bounds.getWest()),
        east: Number(bounds.getEast())
      };
    }
    if (bounds._southWest && bounds._northEast) {
      return {
        south: Number(bounds._southWest.lat),
        north: Number(bounds._northEast.lat),
        west: Number(bounds._southWest.lng ?? bounds._southWest.lon),
        east: Number(bounds._northEast.lng ?? bounds._northEast.lon)
      };
    }
    if (Number.isFinite(Number(bounds.south)) && Number.isFinite(Number(bounds.north)) && Number.isFinite(Number(bounds.west)) && Number.isFinite(Number(bounds.east))) {
      return {
        south: Number(bounds.south),
        north: Number(bounds.north),
        west: Number(bounds.west),
        east: Number(bounds.east)
      };
    }
  } catch (e) {}
  return null;
}

function _polylineIntersectsMapBounds(latLngCoords, bounds) {
  if (!Array.isArray(latLngCoords) || !latLngCoords.length) return false;
  if (!bounds) return true;
  if (typeof window.BusSpeedEngine?.polylineIntersectsBounds === 'function') {
    return window.BusSpeedEngine.polylineIntersectsBounds(latLngCoords, bounds);
  }
  const box = _extractMapBoundsBox(bounds);
  if (box) {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (let i = 0; i < latLngCoords.length; i++) {
      const p = latLngCoords[i];
      if (!Array.isArray(p) || p.length < 2) continue;
      const la = Number(p[0]), lo = Number(p[1]);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
    return !(maxLat < box.south || minLat > box.north || maxLon < box.west || minLon > box.east);
  }
  if (typeof bounds.contains === 'function') {
    for (let i = 0; i < latLngCoords.length; i++) {
      const p = latLngCoords[i];
      if (Array.isArray(p) && p.length >= 2 && bounds.contains([p[0], p[1]])) return true;
    }
    return false;
  }
  return true;
}

function _recordMapBusSpeedSkip(entry) {
  if (!entry || !entry.reason) return;
  const dbg = _ensureMapBusSpeedDebugState();
  if (!Array.isArray(dbg.skipReasons)) dbg.skipReasons = [];
  if (dbg.skipReasons.length < 400) dbg.skipReasons.push(entry);
  const counts = {};
  for (let i = 0; i < dbg.skipReasons.length; i++) {
    const r = dbg.skipReasons[i]?.reason;
    if (r) counts[r] = (counts[r] || 0) + 1;
  }
  dbg.skipReasonCounts = counts;
}

function updateTrafficViewportDebugCounts(targetMap = window.browseMapInstance) {
  const dbg = _ensureMapBusSpeedDebugState();
  const isEnabled = Boolean(window.globalTrafficLayerEnabled);
  const bounds = (targetMap && typeof targetMap.getBounds === 'function') ? targetMap.getBounds() : null;
  const box = _extractMapBoundsBox(bounds);
  const zoom = (targetMap && typeof targetMap.getZoom === 'function') ? targetMap.getZoom() : null;

  let activeTdSegments = 0;
  let activeBusApiSegments = 0;
  let activeBusApiMicroSteps = 0;

  if (isEnabled) {
    const tdGeo = window.__LAST_GLOBAL_SPEED_GEOJSON__ || window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null;
    const tdFeats = Array.isArray(tdGeo?.features) ? tdGeo.features : [];
    for (let i = 0; i < tdFeats.length; i++) {
      const coords = tdFeats[i]?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const latLngs = coords.map((c) => [c[1], c[0]]);
      if (!bounds || _polylineIntersectsMapBounds(latLngs, bounds)) {
        activeTdSegments++;
      }
    }

    const corridors = Array.isArray(_globalBusSpeedLastCorridors) ? _globalBusSpeedLastCorridors : [];
    for (let i = 0; i < corridors.length; i++) {
      const c = corridors[i];
      if (!c || !Array.isArray(c.coords) || c.coords.length < 2) continue;
      if (!bounds || _polylineIntersectsMapBounds(c.coords, bounds)) {
        activeBusApiSegments++;
        activeBusApiMicroSteps += Number(c.microStepCount) || Math.max(1, c.coords.length - 1);
      }
    }
  }

  dbg.updatedAt = new Date().toISOString();
  dbg.trafficEnabled = isEnabled;
  dbg.zoom = Number.isFinite(Number(zoom)) ? Number(zoom) : dbg.zoom;
  if (box) dbg.bounds = box;
  dbg.viewportCounts = {
    activeTdSegments,
    activeBusApiSegments,
    activeBusApiMicroSteps,
    suppressedByTdMicroSteps: isEnabled ? Number(_globalBusSpeedLastAggStats?.suppressedByTdMicroSteps || 0) : 0
  };
  return dbg.viewportCounts;
}

function getTrafficViewportTelemetry(targetMap = window.browseMapInstance) {
  const counts = updateTrafficViewportDebugCounts(targetMap);
  const dbg = _ensureMapBusSpeedDebugState();
  return {
    trafficEnabled: Boolean(dbg.trafficEnabled),
    zoom: dbg.zoom,
    bounds: dbg.bounds,
    activeTdSegments: counts.activeTdSegments,
    activeBusApiSegments: counts.activeBusApiSegments,
    activeBusApiMicroSteps: counts.activeBusApiMicroSteps,
    suppressedByTdMicroSteps: counts.suppressedByTdMicroSteps,
    selectedRouteCount: Array.isArray(dbg.selectedRoutes) ? dbg.selectedRoutes.length : 0,
    computedSegmentCount: Array.isArray(dbg.computedSegments) ? dbg.computedSegments.length : 0,
    skipReasonCounts: { ...(dbg.skipReasonCounts || {}) },
    updatedAt: dbg.updatedAt
  };
}

function clearGlobalBusSpeedOverlay(targetMap = window.browseMapInstance) {
  if (_globalBusSpeedLayerGroup) {
    try { _globalBusSpeedLayerGroup.clearLayers?.(); } catch (e) {}
    if (targetMap) {
      try { targetMap.removeLayer(_globalBusSpeedLayerGroup); } catch (e) {}
    }
    _globalBusSpeedLayerGroup = null;
  }
  _globalBusSpeedLastCorridors = [];
  _globalBusSpeedLastAggStats = null;
  updateTrafficViewportDebugCounts(targetMap);
}

function _resolveGroupDirectionKey(group) {
  if (!group) return 'O';
  if (group.bound) return String(group.bound).trim().toUpperCase();
  if (group.tdBound) return String(group.tdBound).trim().toUpperCase();
  const rId = group.routeIds?.[0] || '';
  const parts = rId.split('_');
  if (parts.length >= 3 && parts[2]) return String(parts[2]).trim().toUpperCase();
  if (rId) return String(rId).trim();
  if (group.dest_e) return String(group.dest_e).trim().toUpperCase().slice(0, 24);
  return 'O';
}

function _applyKeepLeftOffsetLatLngs(latlngs, offsetM) {
  if (!Array.isArray(latlngs) || latlngs.length < 2 || !Number.isFinite(offsetM) || offsetM === 0) return latlngs;
  if (typeof _mapBearingDeg !== 'function' || typeof projectPointMeters !== 'function') return latlngs;
  const out = [];
  const last = latlngs.length - 1;
  for (let i = 0; i <= last; i++) {
    const pPrev = latlngs[Math.max(0, i - 1)];
    const pNext = latlngs[Math.min(last, i + 1)];
    const localBrg = _mapBearingDeg(pPrev[0], pPrev[1], pNext[0], pNext[1]);
    const leftBrg = (localBrg + 270) % 360;
    const [oLat, oLon] = projectPointMeters(latlngs[i][0], latlngs[i][1], leftBrg, offsetM);
    out.push([Number(oLat.toFixed(6)), Number(oLon.toFixed(6))]);
  }
  return out;
}

function _globalBusStretchDedupKey(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return '';
  const a = coords[0];
  const b = coords[coords.length - 1];
  const mid = coords[Math.floor(coords.length / 2)];
  const la = Number(mid[0]), lo = Number(mid[1]);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
  const brg = (typeof computeBearingDeg === 'function')
    ? computeBearingDeg(a[0], a[1], b[0], b[1])
    : 0;
  const oct = Math.round((((brg % 360) + 360) % 360) / 45) % 8;
  return `${Math.round(la * 650)}_${Math.round(lo * 650)}_${oct}`;
}

function _busTierSeverityRank(tier) {
  const t = String(tier || '').toUpperCase();
  if (t === 'CONGESTED' || t === 'JAMMED') return 3;
  if (t === 'MODERATE' || t === 'SLOW') return 2;
  if (t === 'SMOOTH') return 1;
  return 0;
}

function formatDeduplicatedRoutesLabel(routes, maxRoutes = 5) {
  if (!Array.isArray(routes) || !routes.length) return '';
  const byOp = new Map();
  const opOrder = [];
  const seenFull = new Set();

  for (let i = 0; i < routes.length; i++) {
    const raw = String(routes[i] || '').trim();
    if (!raw || seenFull.has(raw)) continue;
    seenFull.add(raw);
    const parts = raw.split(/\s+/);
    let op = '';
    let num = raw;
    if (parts.length >= 2) {
      op = parts[0].toUpperCase();
      num = parts.slice(1).join(' ');
    }
    if (!byOp.has(op)) {
      byOp.set(op, new Set());
      opOrder.push(op);
    }
    byOp.get(op).add(num);
  }

  const sortRouteNos = (a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    const aPure = /^\d+$/.test(a), bPure = /^\d+$/.test(b);
    if (aPure && bPure) return na - nb;
    if (aPure !== bPure) return aPure ? -1 : 1;
    const aNum = /^\d/.test(a), bNum = /^\d/.test(b);
    if (aNum && bNum && Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a.localeCompare(b);
  };

  let remaining = Math.max(1, Number(maxRoutes) || 5);
  const groups = [];
  for (let i = 0; i < opOrder.length && remaining > 0; i++) {
    const op = opOrder[i];
    const sorted = Array.from(byOp.get(op)).sort(sortRouteNos).slice(0, remaining);
    remaining -= sorted.length;
    if (sorted.length) {
      groups.push(op ? `${op} ${sorted.join(', ')}` : sorted.join(', '));
    }
  }
  return groups.join(' · ');
}
window.formatDeduplicatedRoutesLabel = formatDeduplicatedRoutesLabel;

var _detailJourneyHighlightLayer = null;
function focusJourneySegmentOnDetailMap(fromIdx) {
  if (typeof window.restoreDetailSheetSplitMap === 'function') {
    window.restoreDetailSheetSplitMap();
  }
  const segs = Array.isArray(window.__DETAIL_STOP_SEGMENTS__)
    ? window.__DETAIL_STOP_SEGMENTS__
    : (Array.isArray(window.__DETAIL_STOP_TRAFFIC_SEGMENTS__) ? window.__DETAIL_STOP_TRAFFIC_SEGMENTS__ : []);
  const seg = segs.find((s) => Number(s?.fromIdx) === Number(fromIdx)) || segs[Number(fromIdx)] || null;
  if (seg && window.mapInstance && typeof L !== 'undefined') {
    if (_detailJourneyHighlightLayer) {
      try { window.mapInstance.removeLayer(_detailJourneyHighlightLayer); } catch (e) {}
      _detailJourneyHighlightLayer = null;
    }
    const coords = Array.isArray(seg.coords) && seg.coords.length >= 2 ? seg.coords : null;
    if (coords) {
      const effTier = seg.source === 'BUS_API' ? _capBusApiTierMap(seg.tier, seg.speedKmh, seg) : seg.tier;
      const hiColor = effTier === 'CONGESTED' ? '#ef4444' : (effTier === 'MODERATE' ? '#f59e0b' : (effTier === 'SMOOTH' ? '#22c55e' : '#38bdf8'));
      const halo = L.polyline(coords, {
        color: '#ffffff',
        weight: 10,
        opacity: 0.92,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      const stroke = L.polyline(coords, {
        color: hiColor,
        weight: 6,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      _detailJourneyHighlightLayer = L.layerGroup([halo, stroke]).addTo(window.mapInstance);
      if (typeof window.mapInstance.fitBounds === 'function') {
        try {
          window.mapInstance.fitBounds(coords, { padding: [36, 36], maxZoom: 15, animate: true });
        } catch (e) {}
      }
    }
  }
  if (typeof window.openStopSegmentTrafficModal === 'function') {
    window.openStopSegmentTrafficModal(fromIdx);
  }
  return seg;
}
window.focusJourneySegmentOnDetailMap = focusJourneySegmentOnDetailMap;

function _drawBusSpeedSegmentsIntoLayer(segments, layerGroup, routeLabel = '', drawnStretchMap = null, drawOpts = {}) {
  if (!layerGroup || typeof L === 'undefined' || !Array.isArray(segments) || !segments.length) return 0;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const tdDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  // Prefer the actual RENDERED global TD speed GeoJSON (including projected congested TD detector polylines)
  // so Bus-API micro-steps are ONLY suppressed where a rendered TD polyline exists (never by unrendered points alone).
  const tdSpeedGeo = window.__LAST_GLOBAL_SPEED_GEOJSON__ || window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null;
  const tdCoverFn = typeof window.isSegmentCoveredByTdGroundTruth === 'function' ? window.isSegmentCoveredByTdGroundTruth : null;
  const laneOffsetM = Number.isFinite(Number(drawOpts?.laneOffsetM)) ? Number(drawOpts.laneOffsetM) : 0;

  // Hard Spatial Mutex & Directional Road-Cell Occupancy Grid (~50m micro-steps, 100m TD suppression, ~60m × 45° cells)
  if (typeof window.aggregateBusMicroStepsToCorridors === 'function' && !drawOpts?.skipMicroStepAggregation) {
    const agg = window.aggregateBusMicroStepsToCorridors(segments, tdDetectors, tdSpeedGeo, {
      bounds: drawOpts?.bounds || null,
      targetStepM: 50,
      tdMaxDistKm: 0.10,
      tdMaxAngDeg: 45,
      allowUndividedOpposite: true,
      allowNlbScheduledFallback: true,
      includeUnrenderedDetectors: false
    });
    if (typeof drawOpts?.onAggregateResult === 'function') {
      drawOpts.onAggregateResult(agg);
    }
    const corridors = Array.isArray(agg?.corridors) ? agg.corridors : [];
    let drawn = 0;
    for (let i = 0; i < corridors.length; i++) {
      const c = corridors[i];
      if (!c || !Array.isArray(c.coords) || c.coords.length < 2) continue;
      // Narrow two-way local roads (e.g. Ngan Wan Rd, Mui Wo Rural Committee Rd, South Lantau Rd) render ONE centered line
      const effOffsetM = c.isCenteredTwoWay ? 0 : laneOffsetM;
      const drawCoords = effOffsetM > 0 ? _applyKeepLeftOffsetLatLngs(c.coords, effOffsetM) : c.coords;
      const cappedTier = _capBusApiTierMap(c.tier, c.speedKmh, c);
      const strokeColor = cappedTier === 'CONGESTED' ? '#dc2626' : (cappedTier === 'MODERATE' ? '#f59e0b' : '#16a34a');

      // Single clean translucent dashed BUS_API stroke (opacity 0.62, dashArray '8, 6', weight 4) over subtle casing
      L.polyline(drawCoords, {
        color: '#0f172a',
        weight: 5.5,
        opacity: 0.22,
        dashArray: '8, 6',
        smoothFactor: 1.5,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
        _zRank: 2
      }).addTo(layerGroup);
      const line = L.polyline(drawCoords, {
        color: strokeColor,
        weight: 4,
        opacity: 0.62,
        dashArray: '8, 6',
        smoothFactor: 1.5,
        lineCap: 'round',
        lineJoin: 'round',
        _zRank: 3
      }).addTo(layerGroup);

      if (typeof line.bindTooltip === 'function') {
        const dedupTag = formatDeduplicatedRoutesLabel(
          Array.isArray(c.routes) && c.routes.length ? c.routes : (routeLabel ? [routeLabel] : (c.routeLabel ? [c.routeLabel] : [])),
          5
        ) || routeLabel || c.routeLabel || '';
        const rawFrom = isZh ? (c.fromNameTc || c.fromNameEn) : (c.fromNameEn || c.fromNameTc);
        const rawTo = isZh ? (c.toNameTc || c.toNameEn) : (c.toNameEn || c.toNameTc);
        const fromNm = sanitizeBottleneckLabel(rawFrom || `Stop ${c.fromSeq || ((c.fromIdx || 0) + 1)}`);
        const toNm = sanitizeBottleneckLabel(rawTo || `Stop ${c.toSeq || ((c.toIdx || 0) + 2)}`);
        const flowTxt = cappedTier === 'CONGESTED'
          ? (isZh ? '擠塞' : 'Jammed')
          : (cappedTier === 'MODERATE'
            ? (isZh ? '緩慢' : 'Slow')
            : (isZh ? '暢通' : 'Clear'));
        const absSpd = Number.isFinite(Number(c.speedKmh)) && Number(c.speedKmh) > 0
          ? Math.abs(Math.round(Number(c.speedKmh)))
          : null;
        const speedPart = absSpd !== null
          ? (isZh ? `巴士推算 • ${absSpd} km/h • ` : `Bus API • ${absSpd} km/h • `)
          : '';
        const tooltipText = c.isScheduledFallback
          ? `🚌 ${dedupTag ? `${dedupTag} • ` : ''}${isZh ? '預計班次推算' : 'Scheduled headway'} • ${flowTxt}`
          : `🚌 ${dedupTag ? `${dedupTag} • ` : ''}${speedPart}${flowTxt} (${fromNm} → ${toNm})`;
        line.bindTooltip(
          tooltipText,
          { sticky: true, className: 'kmb-map-stop-label' }
        );
      }
      drawn++;
    }
    return drawn;
  }

  // Fallback path (when busspeed.js aggregation engine is not loaded in minimal unit-test harnesses)
  let drawn = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || (seg.isScheduledOnly && !seg.isScheduledFallback)) continue;
    // Strict TD ground-truth priority (~100m, ±45°): never draw synthetic BUS_API where rendered TD links cover the road
    if (seg.coveredByTd || seg.tdCovered || seg.source === 'TD') continue;
    if (!Array.isArray(seg.coords) || seg.coords.length < 2) continue;
    if (tdCoverFn && tdSpeedGeo && tdCoverFn(seg.coords, [], tdSpeedGeo, { maxDistKm: 0.10, maxAngDeg: 45 })) continue;
    // Strictly require road-snapped polylines (never draw straight coastline/bay-cutting chords > 120m)
    if (!seg.isRoadSnapped && seg.coords.length === 2 && typeof calculateDistanceKm === 'function') {
      const chordKm = calculateDistanceKm(seg.coords[0][0], seg.coords[0][1], seg.coords[1][0], seg.coords[1][1]);
      if (chordKm > 0.12) continue;
    }

    const cappedTier = _capBusApiTierMap(seg.tier, seg.speedKmh, seg);
    // Deduplicate overlapping bus routes on the exact same road stretch
    if (drawnStretchMap instanceof Map) {
      const stretchKey = _globalBusStretchDedupKey(seg.coords);
      if (stretchKey) {
        const sev = _busTierSeverityRank(cappedTier);
        const prevSev = drawnStretchMap.get(stretchKey) || 0;
        if (prevSev >= sev) continue;
        drawnStretchMap.set(stretchKey, sev);
      }
    }

    const strokeColor = cappedTier === 'CONGESTED' ? '#dc2626' : (cappedTier === 'MODERATE' ? '#f59e0b' : '#16a34a');
    // Translucent dashed BUS_API stroke (opacity 0.62, dashArray '8, 6', weight 4) with subtle matching dashed casing
    L.polyline(seg.coords, {
      color: '#0f172a',
      weight: 5.5,
      opacity: 0.22,
      dashArray: '8, 6',
      smoothFactor: 1.5,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
      _zRank: 2
    }).addTo(layerGroup);
    const line = L.polyline(seg.coords, {
      color: strokeColor,
      weight: 4,
      opacity: 0.62,
      dashArray: '8, 6',
      smoothFactor: 1.5,
      lineCap: 'round',
      lineJoin: 'round',
      _zRank: 3
    }).addTo(layerGroup);
    if (typeof line.bindTooltip === 'function') {
      const dedupTag = formatDeduplicatedRoutesLabel(routeLabel ? [routeLabel] : [], 5) || routeLabel || '';
      const rawFrom = isZh ? (seg.fromNameTc || seg.fromNameEn) : (seg.fromNameEn || seg.fromNameTc);
      const rawTo = isZh ? (seg.toNameTc || seg.toNameEn) : (seg.toNameEn || seg.toNameTc);
      const fromNm = sanitizeBottleneckLabel(rawFrom || `Stop ${seg.fromSeq || ((seg.fromIdx || 0) + 1)}`);
      const toNm = sanitizeBottleneckLabel(rawTo || `Stop ${seg.toSeq || ((seg.toIdx || 0) + 2)}`);
      const flowTxt = cappedTier === 'CONGESTED'
        ? (isZh ? '擠塞' : 'Jammed')
        : (cappedTier === 'MODERATE'
          ? (isZh ? '緩慢' : 'Slow')
          : (isZh ? '暢通' : 'Clear'));
      const absSpd = Number.isFinite(Number(seg.speedKmh)) && Number(seg.speedKmh) > 0
        ? Math.abs(Math.round(Number(seg.speedKmh)))
        : null;
      const speedPart = absSpd !== null
        ? (isZh ? `巴士推算 • ${absSpd} km/h • ` : `Bus API • ${absSpd} km/h • `)
        : '';
      const tooltipText = seg.isScheduledFallback
        ? `🚌 ${dedupTag ? `${dedupTag} • ` : ''}${isZh ? '預計班次推算' : 'Scheduled headway'} • ${flowTxt}`
        : `🚌 ${dedupTag ? `${dedupTag} • ` : ''}${speedPart}${flowTxt} (${fromNm} → ${toNm})`;
      line.bindTooltip(
        tooltipText,
        { sticky: true, className: 'kmb-map-stop-label' }
      );
    }
    drawn++;
  }
  return drawn;
}

function _collectPersistentGlobalBusSpeedSegments() {
  const out = [];
  const now = Date.now();
  const MAX_AGE_MS = 180000;
  if (window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__ instanceof Map) {
    for (const [k, entry] of window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__.entries()) {
      if (!entry || !Array.isArray(entry.segs) || (now - (entry.ts || 0)) > MAX_AGE_MS) {
        window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__.delete(k);
        continue;
      }
      for (let i = 0; i < entry.segs.length; i++) {
        out.push(entry.segs[i]);
      }
    }
  }
  if (Array.isArray(window.__GLOBAL_BUS_SPEED_SEGMENTS__) && window.__GLOBAL_BUS_SPEED_SEGMENTS__.length) {
    for (let i = 0; i < window.__GLOBAL_BUS_SPEED_SEGMENTS__.length; i++) {
      out.push(window.__GLOBAL_BUS_SPEED_SEGMENTS__[i]);
    }
  }
  return out;
}

function _repaintGlobalBusSpeedFromStore(targetMap = window.browseMapInstance) {
  if (!targetMap || typeof L === 'undefined') return 0;
  if (!window.globalTrafficLayerEnabled) {
    clearGlobalBusSpeedOverlay(targetMap);
    return 0;
  }

  const allSegs = _collectPersistentGlobalBusSpeedSegments();
  const bounds = targetMap.getBounds ? targetMap.getBounds() : null;
  const zoom = targetMap.getZoom ? (targetMap.getZoom() || 13) : 13;
  const laneOffsetM = getGlobalTrafficLaneOffsetMeters(zoom);

  // Double-buffered atomic swap: build the next aggregated layer BEFORE removing the previous one
  // so already-rendered Bus-API corridors stay continuously visible during zoom/pan with zero blanking.
  const nextLayerGroup = L.layerGroup();
  let aggResult = null;
  const drawnCount = allSegs.length
    ? _drawBusSpeedSegmentsIntoLayer(allSegs, nextLayerGroup, '', new Map(), {
        bounds,
        laneOffsetM,
        onAggregateResult: (agg) => { aggResult = agg; }
      })
    : 0;

  nextLayerGroup.addTo(targetMap);
  _bringLayerGroupToFront(nextLayerGroup);

  const prevLayer = _globalBusSpeedLayerGroup;
  _globalBusSpeedLayerGroup = nextLayerGroup;
  if (prevLayer && prevLayer !== nextLayerGroup) {
    try { prevLayer.clearLayers?.(); } catch (e) {}
    try { targetMap.removeLayer(prevLayer); } catch (e) {}
  }

  _globalBusSpeedLastAggStats = aggResult?.stats || null;
  _globalBusSpeedLastCorridors = Array.isArray(aggResult?.corridors)
    ? aggResult.corridors
    : allSegs.filter((s) => s && Array.isArray(s.coords) && s.coords.length >= 2 && !s.coveredByTd && s.source !== 'TD');

  const dbg = _ensureMapBusSpeedDebugState();
  dbg.computedSegments = allSegs.map((s) => ({
    company: s.company || '',
    routeNo: s.routeNo || '',
    fromSeq: s.fromSeq ?? null,
    toSeq: s.toSeq ?? null,
    tier: s.tier || '',
    speedKmh: s.speedKmh ?? null,
    color: s.color || '',
    source: s.source || 'BUS_API',
    isScheduledFallback: Boolean(s.isScheduledFallback),
    isTerminusApproach: Boolean(s.isTerminusApproach),
    allowRed: Boolean(s.allowRed)
  }));
  dbg.renderedCorridors = _globalBusSpeedLastCorridors.map((c) => ({
    routes: c.routes || (c.routeLabel ? [c.routeLabel] : []),
    tier: c.tier || '',
    speedKmh: c.speedKmh ?? null,
    color: c.color || '',
    microStepCount: c.microStepCount || 0,
    isScheduledFallback: Boolean(c.isScheduledFallback)
  }));
  if (aggResult?.stats) {
    dbg.aggregationStats = { ...aggResult.stats };
  }
  if (Array.isArray(aggResult?.skipReasons) && aggResult.skipReasons.length) {
    for (let i = 0; i < aggResult.skipReasons.length; i++) {
      _recordMapBusSpeedSkip(aggResult.skipReasons[i]);
    }
  }
  updateTrafficViewportDebugCounts(targetMap);
  return drawnCount;
}

function _extractKmbEtaByStopIdx(group, stops, bulkMap) {
  if (!bulkMap || !bulkMap.size || !Array.isArray(stops)) return null;
  const rId = group?.routeIds?.[0] || '';
  const parts = rId.split('_');
  const dirChar = parts[2] || (String(group?.bound || group?.tdBound || '').toUpperCase().startsWith('I') ? 'I' : 'O');
  const out = {};
  for (let i = 0; i < stops.length; i++) {
    const seq = stops[i]?.seq ?? (i + 1);
    const arr = bulkMap.get(`${dirChar}_${seq}`) || bulkMap.get(String(seq)) || bulkMap.get(Number(seq));
    if (Array.isArray(arr) && arr.length) out[i] = arr;
  }
  return Object.keys(out).length ? out : null;
}

async function syncDetailRouteBusSpeedSegments(group, stops, preloadedEtaByStopIdx = null) {
  if (!group || !Array.isArray(stops) || stops.length < 2) {
    window.__DETAIL_BUS_SPEED_SEGMENTS__ = [];
    return [];
  }
  const isBusRoute = !group.mode || group.mode === 'BUS';
  if (!isBusRoute || typeof window.inferBusApiSegmentSpeeds !== 'function') {
    window.__DETAIL_BUS_SPEED_SEGMENTS__ = [];
    return [];
  }
  const myToken = ++_detailBusSpeedSyncToken;
  const tdDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const tdCameras = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : [];
  const rawRoadCoords = (Array.isArray(currentDetailRoadCoords) && currentDetailRoadCoords.length >= 2)
    ? currentDetailRoadCoords
    : stops.map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const roadCoords = (typeof window.ensureRoutePolylineCoversStops === 'function' && Array.isArray(stops) && stops.length >= 2)
    ? window.ensureRoutePolylineCoversStops(rawRoadCoords, stops)
    : rawRoadCoords;

  const rId = group.routeIds?.[0] || '';
  const parts = rId.split('_');
  const svcType = parts[3] || group.serviceType || '1';
  const dirChar = _resolveGroupDirectionKey(group);
  const coUpper = String(group.company || '').toUpperCase();

  let etaByStopIdx = preloadedEtaByStopIdx;
  if (!etaByStopIdx) {
    const cacheKey = `${group.company || ''}|${group.routeNo || ''}|${dirChar}|${svcType}`;
    const cached = window.__GLOBAL_BUS_SPEED_CACHE__?.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < 45000 && cached.etaByStopIdx) {
      etaByStopIdx = cached.etaByStopIdx;
    } else if ((coUpper === 'KMB' || coUpper === 'LWB' || rId.startsWith('KMB_') || rId.startsWith('LWB_')) && typeof fetchKmbRouteBulkEta === 'function') {
      try {
        const bulkMap = await fetchKmbRouteBulkEta(parts[1] || group.routeNo, svcType, false);
        if (myToken !== _detailBusSpeedSyncToken) return window.__DETAIL_BUS_SPEED_SEGMENTS__ || [];
        etaByStopIdx = _extractKmbEtaByStopIdx(group, stops, bulkMap);
        if (etaByStopIdx) {
          window.__GLOBAL_BUS_SPEED_CACHE__?.set(cacheKey, { ts: Date.now(), etaByStopIdx });
        }
      } catch (e) {}
    } else if (typeof fetchEtaRaw === 'function') {
      // Sample up to 14 stops around the expanded stop for CTB / NLB / GMB routes (covers South Lantau 3M / 11 / 23 / HKI CTB)
      const centerIdx = (typeof detailExpandedStopIdx === 'number' && detailExpandedStopIdx >= 0) ? detailExpandedStopIdx : 0;
      const startIdx = Math.max(0, centerIdx - 2);
      const endIdx = Math.min(stops.length - 1, startIdx + 13);
      const indices = [];
      for (let i = startIdx; i <= endIdx; i++) indices.push(i);
      try {
        const nowMs = Date.now();
        const results = await Promise.all(indices.map(async (idx) => {
          const s = stops[idx];
          const stKey = s?.stopKey || (typeof getGlobalStopKey === 'function' ? getGlobalStopKey(s) : '');
          if (!stKey) return [idx, []];
          const arr = await fetchEtaRaw(group, stKey, true, nowMs, idx);
          return [idx, Array.isArray(arr) ? arr : []];
        }));
        if (myToken !== _detailBusSpeedSyncToken) return window.__DETAIL_BUS_SPEED_SEGMENTS__ || [];
        etaByStopIdx = {};
        results.forEach(([idx, arr]) => {
          if (Array.isArray(arr) && arr.length) etaByStopIdx[idx] = arr;
        });
        if (Object.keys(etaByStopIdx).length) {
          window.__GLOBAL_BUS_SPEED_CACHE__?.set(cacheKey, { ts: Date.now(), etaByStopIdx });
        }
      } catch (e) {}
    }
  }

  const isNlb = coUpper === 'NLB' || rId.startsWith('NLB_');
  const isKmb = coUpper === 'KMB' || coUpper === 'LWB' || rId.startsWith('KMB_') || rId.startsWith('LWB_');
  const effectiveEtaMap = (etaByStopIdx && Object.keys(etaByStopIdx).length) ? etaByStopIdx : {};
  const segs = window.inferBusApiSegmentSpeeds(stops, effectiveEtaMap, roadCoords, {
    tdDetectors,
    tdCameras,
    tdSpeedGeoJson: window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null,
    routeNo: group.routeNo || '',
    company: group.company || '',
    bound: dirChar,
    allowSparseBridge: !isKmb,
    allowNlbScheduledFallback: isNlb,
    includeSyntheticFallback: true,
    nowMs: Date.now()
  });
  window.__DETAIL_BUS_SPEED_SEGMENTS__ = segs;
  if (typeof window.refreshStopByStopTrafficUI === 'function') {
    window.refreshStopByStopTrafficUI();
  }
  if (window.trafficLayerEnabled && window.mapInstance && currentDetailCorridorMeta?.groupKey === (group?.key || '')) {
    _refreshDetailBusSpeedPolylineIfActive();
  }
  if (typeof window.onDetailBusSpeedReady === 'function') {
    window.onDetailBusSpeedReady(group?.key || '');
  }
  return segs;
}

function renderGlobalBusSpeedOverlay(targetMap = window.browseMapInstance) {
  if (!targetMap || typeof L === 'undefined') return;
  if (!window.globalTrafficLayerEnabled) {
    clearGlobalBusSpeedOverlay(targetMap);
    return;
  }

  // Hide hollow white stop circles so Traffic & Bus Speed render as clean road-aligned green/amber/red lines
  clearAllActiveBrowseMarkers();

  // Keep already-rendered Bus-API segments visible IMMEDIATELY during zoom/pan refreshes (zero blanking!)
  _repaintGlobalBusSpeedFromStore(targetMap);

  const routePool = (typeof groupedRoutes !== 'undefined' && Array.isArray(groupedRoutes) && groupedRoutes.length)
    ? groupedRoutes
    : ((typeof routeGroups !== 'undefined' && Array.isArray(routeGroups)) ? routeGroups : []);
  if (typeof window.inferBusApiSegmentSpeeds !== 'function' || !routePool.length) return;

  const bounds = targetMap.getBounds ? targetMap.getBounds() : null;
  if (!bounds || (typeof bounds.contains !== 'function' && !_extractMapBoundsBox(bounds))) return;
  const tdDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const tdCameras = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : [];
  const tdSpeedGeo = window.__LAST_GLOBAL_SPEED_GEOJSON__ || window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null;

  // Select distinct unmonitored bus corridors in the current viewport (KMB, LWB, CTB, NLB, GMB, MTRB),
  // prioritizing South Lantau NLB corridors and spatial macro-grid bucketing so dense hubs never crowd out rural routes.
  const picked = (typeof window.selectGlobalBusSpeedRoutes === 'function')
    ? window.selectGlobalBusSpeedRoutes(
        routePool,
        bounds,
        (typeof getStopsForGroup === 'function' ? getStopsForGroup : null),
        40,
        tdDetectors,
        tdSpeedGeo
      )
    : [];
  if (!picked.length) {
    updateTrafficViewportDebugCounts(targetMap);
    return;
  }

  const myToken = ++_globalBusSpeedFetchToken;
  const processRouteItem = async ({ group, stops, operator, inBoundsIndices, boundKey }) => {
    const rId = group.routeIds?.[0] || '';
    const parts = rId.split('_');
    const svcType = parts[3] || group.serviceType || '1';
    const dirChar = boundKey || _resolveGroupDirectionKey(group);
    const cacheKey = `${group.company || ''}|${group.routeNo || ''}|${dirChar}|${svcType}`;
    const routeLabel = `${group.company || operator || ''} ${group.routeNo || ''}`.trim();
    const cached = window.__GLOBAL_BUS_SPEED_CACHE__?.get(cacheKey);
    const cachedEta = (cached && (Date.now() - cached.ts) < 45000) ? cached.etaByStopIdx : null;

    const [etaRes, snappedRoad] = await Promise.all([
      (async () => {
        if (cachedEta) return cachedEta;
        if (operator === 'KMB' && typeof fetchKmbRouteBulkEta === 'function') {
          try {
            const bulkMap = await fetchKmbRouteBulkEta(parts[1] || group.routeNo, svcType, false);
            const extracted = _extractKmbEtaByStopIdx(group, stops, bulkMap);
            if (extracted) {
              window.__GLOBAL_BUS_SPEED_CACHE__?.set(cacheKey, { ts: Date.now(), etaByStopIdx: extracted });
            }
            return extracted;
          } catch (e) {
            return null;
          }
        }
        // Live stop sampling across the full visible corridor for NLB (South Lantau / Mui Wo / Pui O / Cheung Sha / Tong Fuk), CTB, GMB, MTRB
        if (typeof fetchEtaRaw === 'function') {
          try {
            const isNlb = operator === 'NLB';
            const vis = Array.isArray(inBoundsIndices) && inBoundsIndices.length ? inBoundsIndices : [0, 1, 2, 3, 4, 5];
            const padStops = isNlb ? 2 : 1;
            const firstVis = Math.max(0, vis[0] - padStops);
            const lastVis = Math.min(stops.length - 1, vis[vis.length - 1] + padStops);
            const spanLen = Math.max(1, lastVis - firstVis + 1);
            const maxSamples = isNlb ? 16 : 14;
            const stride = spanLen > (maxSamples * 2) ? 3 : (spanLen > maxSamples ? 2 : 1);
            const sampleIdxs = [];
            for (let idx = firstVis; idx <= lastVis && sampleIdxs.length < (maxSamples - 1); idx += stride) {
              sampleIdxs.push(idx);
            }
            if (sampleIdxs.length && sampleIdxs[sampleIdxs.length - 1] !== lastVis && sampleIdxs.length < maxSamples) {
              sampleIdxs.push(lastVis);
            }
            const nowMs = Date.now();
            const mapOut = {};
            for (let c = 0; c < sampleIdxs.length; c += 4) {
              if (myToken !== _globalBusSpeedFetchToken) return null;
              const chunk = sampleIdxs.slice(c, c + 4);
              const results = await Promise.all(chunk.map(async (idx) => {
                const s = stops[idx];
                const stKey = s?.stopKey || (typeof getGlobalStopKey === 'function' ? getGlobalStopKey(s) : '');
                if (!stKey) return [idx, []];
                const arr = await fetchEtaRaw(group, stKey, true, nowMs, idx);
                return [idx, Array.isArray(arr) ? arr : []];
              }));
              results.forEach(([idx, arr]) => {
                if (Array.isArray(arr) && arr.length) mapOut[idx] = arr;
              });
            }
            if (Object.keys(mapOut).length >= 2) {
              window.__GLOBAL_BUS_SPEED_CACHE__?.set(cacheKey, { ts: Date.now(), etaByStopIdx: mapOut });
              return mapOut;
            }
          } catch (e) {}
        }
        return null;
      })(),
      (async () => {
        const cachedPoly = getCachedBusRoutePolyline(group, stops);
        if (Array.isArray(cachedPoly) && cachedPoly.length >= 3) return cachedPoly;
        if (typeof fetchRoadSnappedBusPolyline === 'function') {
          try {
            const poly = await fetchRoadSnappedBusPolyline(group, stops);
            if (Array.isArray(poly) && poly.length >= 3) return poly;
          } catch (e) {}
        }
        return null;
      })()
    ]);

    if (!etaRes) {
      _recordMapBusSpeedSkip({
        scope: 'route',
        routeNo: group.routeNo || '',
        company: group.company || operator || '',
        bound: dirChar,
        reason: 'no_live_eta_pairs',
        detail: 'Route returned fewer than 2 stop ETA lists'
      });
      return null;
    }
    if (!Array.isArray(snappedRoad) || snappedRoad.length < 3) {
      _recordMapBusSpeedSkip({
        scope: 'route',
        routeNo: group.routeNo || '',
        company: group.company || operator || '',
        bound: dirChar,
        reason: 'no_road_geometry',
        detail: 'Road-snapped polyline unavailable'
      });
      return null;
    }
    const segs = window.inferBusApiSegmentSpeeds(stops, etaRes, snappedRoad, {
      tdDetectors,
      tdCameras,
      tdSpeedGeoJson: tdSpeedGeo,
      routeNo: group.routeNo || '',
      company: group.company || operator || '',
      bound: dirChar,
      allowSparseBridge: operator !== 'KMB',
      allowNlbScheduledFallback: operator === 'NLB',
      nowMs: Date.now()
    });
    return { cacheKey, routeLabel, segs };
  };

  // Paint routes progressively in clean batches of 5 (cached & priority NLB routes painted first)
  // and re-aggregate through the ~60m × 45° Directional Road-Cell Occupancy Grid on every batch
  // so overlapping routes NEVER stack brown/multi-color dashed lines on top of each other.
  (async () => {
    const cachedItems = [];
    const priorityLiveItems = [];
    const liveItems = [];
    for (let i = 0; i < picked.length; i++) {
      const item = picked[i];
      const g = item.group;
      const rId = g.routeIds?.[0] || '';
      const parts = rId.split('_');
      const svcType = parts[3] || g.serviceType || '1';
      const dirChar = item.boundKey || _resolveGroupDirectionKey(g);
      const cacheKey = `${g.company || ''}|${g.routeNo || ''}|${dirChar}|${svcType}`;
      const hasEta = Boolean(window.__GLOBAL_BUS_SPEED_CACHE__?.get(cacheKey)?.etaByStopIdx);
      const hasPoly = Boolean(getCachedBusRoutePolyline(g, item.stops)?.length >= 3);
      if (hasEta && hasPoly) cachedItems.push(item);
      else if (item.isPriorityNlb) priorityLiveItems.push(item);
      else liveItems.push(item);
    }

    const ordered = [...cachedItems, ...priorityLiveItems, ...liveItems];
    const BATCH_SIZE = 5;
    for (let start = 0; start < ordered.length; start += BATCH_SIZE) {
      if (myToken !== _globalBusSpeedFetchToken || !window.globalTrafficLayerEnabled) return;
      const slice = ordered.slice(start, start + BATCH_SIZE);
      const batchRes = await Promise.all(slice.map((item) => processRouteItem(item).catch(() => null)));
      if (myToken !== _globalBusSpeedFetchToken || !window.globalTrafficLayerEnabled) return;
      let storeUpdated = false;
      batchRes.forEach((b) => {
        if (b && b.cacheKey && Array.isArray(b.segs) && b.segs.length) {
          window.__GLOBAL_BUS_SPEED_SEGMENTS_BY_ROUTE__.set(b.cacheKey, {
            ts: Date.now(),
            routeLabel: b.routeLabel,
            segs: b.segs
          });
          storeUpdated = true;
        }
      });
      if (storeUpdated) {
        _repaintGlobalBusSpeedFromStore(targetMap);
      } else {
        updateTrafficViewportDebugCounts(targetMap);
      }
    }
  })().catch(() => {});
}

function scheduleGlobalTrafficRefresh(mapInst, opts = {}) {
  if (!mapInst || !window.globalTrafficLayerEnabled) return;
  const delayMs = Number.isFinite(Number(opts.delayMs)) ? Number(opts.delayMs) : 160;
  if (opts.immediateTdDashboard) {
    renderGlobalTrafficDashboard(mapInst);
  }
  if (opts.immediateBusRepaint) {
    _repaintGlobalBusSpeedFromStore(mapInst);
  }
  if (typeof clearTimeout === 'function') clearTimeout(_globalTrafficMoveTimer);
  if (typeof setTimeout === 'function') {
    _globalTrafficMoveTimer = setTimeout(() => {
      if (!mapInst || !window.globalTrafficLayerEnabled) return;
      const z = mapInst.getZoom ? (mapInst.getZoom() || 13) : 13;
      if (opts.refreshTdOnSettle || z >= GLOBAL_CAMERA_MIN_ZOOM) {
        renderGlobalTrafficDashboard(mapInst);
      } else {
        updateTrafficViewportDebugCounts(mapInst);
      }
      renderGlobalBusSpeedOverlay(mapInst);
    }, delayMs);
  }
}

// Compatibility delegate: Bus Speed is merged into the single unified Traffic toggle
function toggleBusSpeedLayer(forceState = null) {
  if (typeof currentView !== 'undefined' && currentView === 'map') {
    toggleGlobalTrafficLayer(forceState);
  } else {
    toggleTrafficLayerOverlay(forceState);
  }
}

function toggleGlobalTrafficLayer(forceState = null) {
  if (typeof triggerHaptic === 'function') triggerHaptic(10);
  window.globalTrafficLayerEnabled = (typeof forceState === 'boolean') ? forceState : !window.globalTrafficLayerEnabled;
  window.busSpeedLayerEnabled = window.globalTrafficLayerEnabled;
  if (typeof window.syncTrafficToggleButtonsUI === 'function') {
    window.syncTrafficToggleButtonsUI();
  }
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  if (window.globalTrafficLayerEnabled) {
    if (window.browseMapInstance) {
      clearAllActiveBrowseMarkers();
      renderGlobalTrafficDashboard(window.browseMapInstance);
      renderGlobalBusSpeedOverlay(window.browseMapInstance);
    }
    // Refresh complete unfiltered TD Speed Map & cameras from Worker cache
    if (typeof syncEdgeTrafficCorridors === 'function') {
      syncEdgeTrafficCorridors();
    }
    if (typeof showToast === 'function') {
      showToast(isZh ? '🚦 全港實時路況及巴士車速已開啟（放大可查看鏡頭）' : '🚦 City-Wide Live Traffic & Bus Speed ON (Zoom in for cameras)');
    }
  } else {
    if (typeof clearTimeout === 'function') clearTimeout(_globalTrafficMoveTimer);
    clearGlobalTrafficDashboard(window.browseMapInstance);
    clearGlobalBusSpeedOverlay(window.browseMapInstance);
    if (window.browseMapInstance) {
      renderBrowseMapVisiblePins();
    }
    if (typeof showToast === 'function') {
      showToast(isZh ? '🚏 已關閉全港路況，恢復顯示巴士及鐵路站' : '🚏 Global Traffic OFF — Bus & rail stops restored');
    }
  }
}

function attachGlobalTrafficControlToBrowseMap(mapInst) {
  if (!mapInst || typeof L === 'undefined' || typeof L.Control === 'undefined' || _globalTrafficControl) return;
  const GlobalTrafficControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: function() {
      const container = L.DomUtil.create('div', 'leaflet-control-global-traffic');
      const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

      const btn = L.DomUtil.create('button', 'map-traffic-chip-btn map-traffic-toggle global-traffic-btn', container);
      btn.type = 'button';
      btn.id = 'browseMapTrafficBtn';
      btn.innerText = window.globalTrafficLayerEnabled
        ? (isZh ? '🚦 全港路況 開' : '🚦 Traffic ON')
        : (isZh ? '🚦 全港路況' : '🚦 Traffic');
      btn.classList.toggle('active', Boolean(window.globalTrafficLayerEnabled));
      btn.setAttribute('aria-pressed', window.globalTrafficLayerEnabled ? 'true' : 'false');

      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        toggleGlobalTrafficLayer();
      });
      return container;
    }
  });
  _globalTrafficControl = new GlobalTrafficControl();
  _globalTrafficControl.addTo(mapInst);
}

window.GLOBAL_CAMERA_MIN_ZOOM = GLOBAL_CAMERA_MIN_ZOOM;
window.getGlobalTrafficLaneOffsetMeters = getGlobalTrafficLaneOffsetMeters;
window.filterAndOffsetGlobalSpeedGeoJson = filterAndOffsetGlobalSpeedGeoJson;
window.buildGlobalSpeedMapGeoJsonFallback = buildGlobalSpeedMapGeoJsonFallback;
window.renderGlobalTrafficDashboard = renderGlobalTrafficDashboard;
window.clearGlobalTrafficDashboard = clearGlobalTrafficDashboard;
window.toggleGlobalTrafficLayer = toggleGlobalTrafficLayer;
window.toggleBusSpeedLayer = toggleBusSpeedLayer;
window.renderGlobalBusSpeedOverlay = renderGlobalBusSpeedOverlay;
window.clearGlobalBusSpeedOverlay = clearGlobalBusSpeedOverlay;
window.syncDetailRouteBusSpeedSegments = syncDetailRouteBusSpeedSegments;
window.buildDetailBusPolylineLayer = buildDetailBusPolylineLayer;
window.getTrafficViewportTelemetry = getTrafficViewportTelemetry;
window.updateTrafficViewportDebugCounts = updateTrafficViewportDebugCounts;
window.scheduleGlobalTrafficRefresh = scheduleGlobalTrafficRefresh;
window._bringLayerGroupToFront = _bringLayerGroupToFront;
window._repaintGlobalBusSpeedFromStore = _repaintGlobalBusSpeedFromStore;
window._projectPointOntoPolylineDetailed = _projectPointOntoPolylineDetailed;
window._polylinesIntersect2D = _polylinesIntersect2D;

if (typeof window !== 'undefined') {
  window.projectPointMeters = projectPointMeters;
  window.buildTrafficDetectorPopupHtml = buildTrafficDetectorPopupHtml;
  window._stopsHaveHighwaySpan = _stopsHaveHighwaySpan;
  window.bindTrafficRefreshOnMapMove = bindTrafficRefreshOnMapMove;
  window._getDetailStopsForGroup = _getDetailStopsForGroup;
  window._resolveActiveExitStopIdx = _resolveActiveExitStopIdx;
  window._refreshDetailBusSpeedPolylineIfActive = _refreshDetailBusSpeedPolylineIfActive;
  window.getGlobalTrafficSpeedColorHex = getGlobalTrafficSpeedColorHex;
  window._drawBusSpeedSegmentsIntoLayer = _drawBusSpeedSegmentsIntoLayer;
  window.attachGlobalTrafficControlToBrowseMap = attachGlobalTrafficControlToBrowseMap;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GLOBAL_CAMERA_MIN_ZOOM,
    projectPointMeters,
    classifyTrafficBoundMeta,
    sanitizeBottleneckLabel,
    buildTrafficDetectorPopupHtml,
    _stopsHaveHighwaySpan,
    matchDetectorToRouteCorridor,
    filterTrafficDetectorsForMap,
    projectDetectorToScreenPx,
    _bringLayerGroupToFront,
    renderTrafficOverlayOnMap,
    bindTrafficRefreshOnMapMove,
    _refreshDetailBusSpeedPolylineIfActive,
    syncTrafficOverlaysAllMaps,
    toggleTrafficLayerOverlay,
    hideDetailBackToStopPill,
    updateDetailBackToStopPill,
    returnToActiveDetailStop,
    focusTrafficDetectorOnDetailMap,
    buildDetailBusPolylineLayer,
    getGlobalTrafficLaneOffsetMeters,
    getGlobalTrafficSpeedColorHex,
    filterAndOffsetGlobalSpeedGeoJson,
    buildGlobalSpeedMapGeoJsonFallback,
    clearGlobalTrafficDashboard,
    renderGlobalTrafficDashboard,
    resolveCameraBearingDeg,
    formatCompassFromBearingDeg,
    buildDirectionalCameraDivIcon,
    getTrafficViewportTelemetry,
    updateTrafficViewportDebugCounts,
    clearGlobalBusSpeedOverlay,
    formatDeduplicatedRoutesLabel,
    focusJourneySegmentOnDetailMap,
    _drawBusSpeedSegmentsIntoLayer,
    _repaintGlobalBusSpeedFromStore,
    syncDetailRouteBusSpeedSegments,
    renderGlobalBusSpeedOverlay,
    scheduleGlobalTrafficRefresh,
    toggleBusSpeedLayer,
    toggleGlobalTrafficLayer,
    attachGlobalTrafficControlToBrowseMap,
    _projectPointOntoPolylineDetailed,
    _polylinesIntersect2D
  };
}
