// ============================================================================
// File: map.js (johntjz/Hk-Fleet — Unified Leaflet Geometry & Map Engine)
// ============================================================================

window.mapInstance = null;
window.browseMapInstance = null;
window.xferMapInstance = null;

var detailPolylineLayer = null;
var mapMarkers = {};
var currentDetailRoadCoords = [];
var currentDetailCorridorMeta = null;
var detailMapHeightState = 0;
var isDetailGpsLocked = false;

var userCompassHeadingDeg = null;
var isCompassListening = false;
var userMarkerDetail = null;
var userMarkerBrowse = null;
var userMarkerXfer = null;
var userAccCircleBrowse = null;

var browseMapStopGrid = new Map();
var browseMapExitGrid = new Map();
var activeBrowseMarkersByKey = new Map();
var browseMapMoveDebounceTimer = null;
var browseMapClickedSpotMarker = null;

var xferMapLayers = [];
var xferMapClickedSpotMarker = null;
var isXferMapExpanded = false;
var xferDrawToken = 0;
var bikeRouteGeoCache = new Map();
var _mapResizeObservers = new WeakMap();

var _trafficLayerByMap = new WeakMap();
var _trafficMarkersByMap = new WeakMap();
var _trafficMoveTimerByMap = new WeakMap();
window.trafficLayerEnabled = true;
window.__ROUTE_GEOM_CACHE__ = window.__ROUTE_GEOM_CACHE__ || {};
var _busGeomInFlight = new Map();
var _detailGeomToken = 0;

function _readBusGeomStorageMap() {
  try {
    const raw = (typeof SafeStorage !== 'undefined' && SafeStorage?.getItem)
      ? SafeStorage.getItem('transit_bus_geom_v1')
      : (typeof localStorage !== 'undefined' ? localStorage.getItem('transit_bus_geom_v1') : null);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

function _writeBusGeomStorageEntry(cacheKey, coords) {
  if (!cacheKey || !Array.isArray(coords) || coords.length < 2) return;
  try {
    const store = _readBusGeomStorageMap();
    store[cacheKey] = { ts: Date.now(), coords };
    const keys = Object.keys(store);
    if (keys.length > 26) {
      keys.sort((a, b) => (store[a]?.ts || 0) - (store[b]?.ts || 0));
      for (let i = 0; i < keys.length - 24; i++) delete store[keys[i]];
    }
    const serialized = JSON.stringify(store);
    if (typeof SafeStorage !== 'undefined' && SafeStorage?.setItem) {
      SafeStorage.setItem('transit_bus_geom_v1', serialized);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem('transit_bus_geom_v1', serialized);
    }
  } catch (e) {}
}

function buildBusGeomCacheKey(group, stops = []) {
  const co = String(group?.company || 'BUS').toUpperCase();
  const rt = String(group?.routeNo || '').toUpperCase();
  const bd = String(group?.tdBound || '').toUpperCase();
  const gid = String(group?.gtfsId || '');
  const gk = String(group?.key || '');
  return `${co}|${rt}|${bd}|${gid}|${gk}|${Array.isArray(stops) ? stops.length : 0}`;
}

function getCachedBusRoutePolyline(group, stops = []) {
  if (!group || (group.mode && group.mode !== 'BUS')) return null;
  if (group.key && Array.isArray(window.__ROUTE_GEOM_CACHE__[group.key]) && window.__ROUTE_GEOM_CACHE__[group.key].length >= 2) {
    return window.__ROUTE_GEOM_CACHE__[group.key];
  }
  const ck = buildBusGeomCacheKey(group, stops);
  const store = _readBusGeomStorageMap();
  const entry = store[ck];
  if (entry && Array.isArray(entry.coords) && entry.coords.length >= 2) {
    if (group.key) window.__ROUTE_GEOM_CACHE__[group.key] = entry.coords;
    return entry.coords;
  }
  return null;
}

function _sampleBusStopCoordsForQuery(stops, maxWaypoints = 36) {
  const valid = (Array.isArray(stops) ? stops : [])
    .map(s => [parseFloat(s?.latitude ?? s?.lat), parseFloat(s?.longitude ?? s?.lon)])
    .filter(p => isValidRailOrFerryCoord(p[0], p[1]));
  if (valid.length <= maxWaypoints) return valid;
  const out = [valid[0]];
  const step = (valid.length - 1) / (maxWaypoints - 1);
  for (let i = 1; i < maxWaypoints - 1; i++) {
    out.push(valid[Math.round(i * step)]);
  }
  out.push(valid[valid.length - 1]);
  return out;
}

async function fetchRoadSnappedBusPolyline(group, stops = []) {
  if (!group || (group.mode && group.mode !== 'BUS')) return null;
  if (!Array.isArray(stops) || stops.length < 2) return null;

  const cached = getCachedBusRoutePolyline(group, stops);
  if (cached) return cached;

  const ck = buildBusGeomCacheKey(group, stops);
  if (_busGeomInFlight.has(ck)) return _busGeomInFlight.get(ck);

  const task = (async () => {
    try {
      const sampled = _sampleBusStopCoordsForQuery(stops, 36);
      if (sampled.length < 2) return null;
      const stopsParam = sampled.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
      const params = new URLSearchParams({
        action: 'bus_geom',
        gtfsId: String(group.gtfsId || ''),
        route: String(group.routeNo || ''),
        company: String(group.company || ''),
        bound: String(group.tdBound || ''),
        stops: stopsParam
      });
      const workerBase = (typeof WORKER_BASE_URL !== 'undefined' && WORKER_BASE_URL) ? WORKER_BASE_URL : '/api/worker';
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5500);
      const res = await fetch(`${workerBase}?${params.toString()}`, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const coords = Array.isArray(data?.coords) ? data.coords : [];
      if (coords.length < 2) return null;

      // Sanity check endpoints sit within 2.5km of route origin & destination
      const dStart = calculateDistanceKm(coords[0][0], coords[0][1], sampled[0][0], sampled[0][1]);
      const dEnd = calculateDistanceKm(coords[coords.length - 1][0], coords[coords.length - 1][1], sampled[sampled.length - 1][0], sampled[sampled.length - 1][1]);
      if (dStart > 2.5 || dEnd > 2.5) return null;

      if (group.key) window.__ROUTE_GEOM_CACHE__[group.key] = coords;
      _writeBusGeomStorageEntry(ck, coords);
      return coords;
    } catch (e) {
      return null;
    } finally {
      _busGeomInFlight.delete(ck);
    }
  })();

  _busGeomInFlight.set(ck, task);
  return task;
}

function findNearestPolylineIndex(coords, lat, lon, minIdx = 0) {
  if (!Array.isArray(coords) || !coords.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return -1;
  let bestI = -1;
  let bestKm = Infinity;
  const start = Math.max(0, Math.min(coords.length - 1, minIdx));
  for (let i = start; i < coords.length; i++) {
    const dKm = calculateDistanceKm(lat, lon, coords[i][0], coords[i][1]);
    if (dKm < bestKm) {
      bestKm = dKm;
      bestI = i;
    }
  }
  return bestKm <= 0.65 ? bestI : -1;
}

function sliceRoadPolylineBetweenStops(roadCoords, bStop, aStop) {
  if (!Array.isArray(roadCoords) || roadCoords.length < 3 || !bStop || !aStop) return null;
  const bPt = getStopLatLon(bStop);
  const aPt = getStopLatLon(aStop);
  if (!bPt || !aPt) return null;
  const bIdx = findNearestPolylineIndex(roadCoords, bPt[0], bPt[1], 0);
  if (bIdx < 0) return null;
  const aIdx = findNearestPolylineIndex(roadCoords, aPt[0], aPt[1], bIdx);
  if (aIdx <= bIdx) return null;
  const slice = roadCoords.slice(bIdx, aIdx + 1);
  return slice.length >= 2 ? slice : null;
}

window.getCachedBusRoutePolyline = getCachedBusRoutePolyline;
window.fetchRoadSnappedBusPolyline = fetchRoadSnappedBusPolyline;
window.sliceRoadPolylineBetweenStops = sliceRoadPolylineBetweenStops;

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
        <span style="font-size:1.02rem; font-weight:800; color:${tierCol};">${Number(det.spd)} <span style="font-size:0.70rem; font-weight:600;">km/h</span></span>
        <span style="font-size:0.72rem; font-weight:600; color:#475569;">${occVal}% ${isZh ? '佔用率' : 'occ'}</span>
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

function matchDetectorToRouteCorridor(det, routeCoords, isRoadSnapped = true, precomputedBbox = null, hasHighwaySpan = false) {
  if (!det || !Number.isFinite(det.lat) || !Number.isFinite(det.lon) || !Array.isArray(routeCoords) || routeCoords.length < 2) {
    return { matched: false, relation: 'none', distKm: Infinity };
  }
  // Strictly <= 150m corridor radius on active bus routes so off-route regional districts (Sha Tin, Ma On Shan, Tsuen Wan, parallel arterials) never leak onto the route map.
  const maxRadiusKm = isRoadSnapped ? 0.12 : 0.15;
  const sameTolDeg = isRoadSnapped ? 42 : 48;
  const oppMinDeg = isRoadSnapped ? 138 : 132;

  if (precomputedBbox) {
    if (det.lat < precomputedBbox.minLat || det.lat > precomputedBbox.maxLat || det.lon < precomputedBbox.minLon || det.lon > precomputedBbox.maxLon) {
      return { matched: false, relation: 'none', distKm: Infinity };
    }
  }

  const isLocalArterial = (typeof isOffCorridorLocalArterialDetector === 'function')
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

  const isDetailBusScoped = Boolean(
    corridorMeta &&
    corridorMeta.isBusRoute &&
    Array.isArray(corridorMeta.coords) &&
    corridorMeta.coords.length >= 2
  );
  const corridorBbox = isDetailBusScoped
    ? _computeCorridorBbox(corridorMeta.coords, 0.0022)
    : null;

  const kept = [];
  for (let i = 0; i < detectors.length; i++) {
    const d = detectors[i];
    if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const isFocused = Boolean(focusedDetId && d.id === focusedDetId);
    if (!isFocused && !padded.contains([d.lat, d.lon])) continue;

    if (isDetailBusScoped) {
      const m = matchDetectorToRouteCorridor(
        d,
        corridorMeta.coords,
        corridorMeta.isRoadSnapped,
        corridorBbox,
        Boolean(corridorMeta.hasHighwaySpan)
      );
      if (!m.matched && !isFocused) continue;
      // On active bus route view, keep ONLY the bus's travel direction so opposite-bound icons never clutter the route
      // (opposite-bound jam callouts remain surfaced in the Verdict & Cam modal).
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
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer((sub) => { if (sub && typeof sub.bringToFront === 'function') sub.bringToFront(); });
    } else if (typeof layer.bringToFront === 'function') {
      layer.bringToFront();
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
  if (!candidates.length) {
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
  // Hong Kong drives on the LEFT: offset each carriageway slightly to the left of its heading
  // so Northbound vs Southbound (and Eastbound vs Westbound) physically separate instead of overlapping.
  const laneOffsetMeters = zoom >= 15 ? 14 : (zoom >= 13 ? 26 : 42);
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
    const col = isJam ? '#DC2626' : (isSlow ? '#F59E0B' : '#16A34A');
    const boundMeta = classifyTrafficBoundMeta(d.rot, d.dir, isZh);

    // Offset center left-hand relative to travel bearing (rot - 90 deg)
    const leftBearing = ((Number(d.rot) || 0) + 270) % 360;
    const [cLat, cLon] = projectPointMeters(d.lat, d.lon, leftBearing, laneOffsetMeters);
    const pStart = projectPointMeters(cLat, cLon, (d.rot + 180) % 360, segHalfMeters);
    const pEnd = projectPointMeters(cLat, cLon, d.rot, segHalfMeters);

    // Clean left-hand offset road stripe (subtle for smooth flow, prominent for bottlenecks)
    L.polyline([pStart, pEnd], {
      color: '#FFFFFF',
      weight: isJam ? 8.6 : (isSlow ? 7.4 : (isDetailBusScoped ? 4.2 : 4.8)),
      opacity: isBottleneck ? 0.88 : (isDetailBusScoped ? 0.50 : 0.62),
      lineCap: 'round',
      interactive: false
    }).addTo(layerGroup);

    const flowLine = L.polyline([pStart, pEnd], {
      color: col,
      weight: isJam ? 5.2 : (isSlow ? 4.2 : (isDetailBusScoped ? 2.6 : 3.0)),
      opacity: isJam ? 0.94 : (isSlow ? 0.88 : (isDetailBusScoped ? 0.58 : 0.70)),
      lineCap: 'round'
    }).addTo(layerGroup);

    const cleanRoadName = sanitizeBottleneckLabel(isZh ? (d.roadTc || d.roadEn) : (d.roadEn || d.roadTc)) || (isZh ? '主要幹道' : 'Major Road');
    const tipTxt = sanitizeBottleneckLabel(`${cleanRoadName} · ${boundMeta.arrowGlyph} ${boundMeta.fullLabel} · ${d.spd} km/h${d.camKey ? ' 📷' : ''}`);
    const openVerdictDirect = Boolean(isBottleneck || isDetailBusScoped);
    const onDirectBottleneckClick = (ev) => {
      if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
      if (typeof window.openTrafficDecisionModal === 'function') {
        window.openTrafficDecisionModal(d.id, _findOppositeTrafficDetectorId(d), '', false);
      }
    };
    flowLine.bindTooltip(tipTxt, { sticky: true, className: 'kmb-map-stop-label' });
    if (openVerdictDirect) {
      if (typeof flowLine.on === 'function') flowLine.on('click', onDirectBottleneckClick);
    } else {
      flowLine.bindPopup(() => buildTrafficDetectorPopupHtml(d, isZh), { closeButton: true, maxWidth: 270 });
    }
    detMarkerMap.set(d.id, flowLine);

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

function syncTrafficOverlaysAllMaps() {
  if (window.mapInstance) renderTrafficOverlayOnMap(window.mapInstance, true);
  if (window.browseMapInstance) renderTrafficOverlayOnMap(window.browseMapInstance, true);
  if (window.xferMapInstance) {
    renderTrafficOverlayOnMap(window.xferMapInstance, true);
  }
}

function toggleTrafficLayerOverlay(forceState = null) {
  if (typeof triggerHaptic === 'function') triggerHaptic(10);
  window.trafficLayerEnabled = (typeof forceState === 'boolean') ? forceState : !window.trafficLayerEnabled;
  syncTrafficOverlaysAllMaps();
  if (typeof window.syncTrafficToggleButtonsUI === 'function') {
    window.syncTrafficToggleButtonsUI();
  }
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (typeof showToast === 'function') {
    showToast(window.trafficLayerEnabled
      ? (isZh ? '🚦 已顯示實時道路交通及路面快照' : '🚦 Live HK Road Traffic & Cameras ON')
      : (isZh ? '🚦 已隱藏實時道路交通圖層' : '🚦 Live Road Traffic Layer OFF'));
  }
}

function focusTrafficDetectorOnDetailMap(lat, lon, detId = '') {
  if (!window.mapInstance || !isValidRailOrFerryCoord(lat, lon)) return;
  if (!window.trafficLayerEnabled) {
    window.trafficLayerEnabled = true;
    if (typeof window.syncTrafficToggleButtonsUI === 'function') window.syncTrafficToggleButtonsUI();
  }
  window.__FOCUSED_TRAFFIC_DET_ID__ = String(detId || '');
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
  };

  window.mapInstance.once('moveend', () => setTimeout(focusTargetMarker, 60));
  window.mapInstance.setView([lat, lon], Math.max(window.mapInstance.getZoom() || 14, 15), { animate: false });
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
window._setDetailCorridorMetaForTest = function(meta) { currentDetailCorridorMeta = meta; };

window.attachStandardMapLayers = function(targetMap) {
  if (!targetMap || typeof L === 'undefined') return;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 18,
    maxZoom: 19,
    keepBuffer: 6,
    updateWhenIdle: false,
    className: 'dark-tiles',
    attribution: '&copy; OSM'
  }).addTo(targetMap);
};

function attachMapResizeObserver(containerId, mapInst, onVisibleResize = null) {
  if (typeof ResizeObserver === 'undefined' || !mapInst) return;
  const el = document.getElementById(containerId);
  if (!el || _mapResizeObservers.has(el)) return;
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (!rect || rect.width < 40 || rect.height < 40) return;
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w === lastW && h === lastH) return;
    const wasHidden = (lastW === 0 || lastH === 0);
    lastW = w;
    lastH = h;
    try { mapInst.invalidateSize(false); } catch (e) {}
    if (wasHidden && typeof onVisibleResize === 'function') {
      onVisibleResize();
    }
  });
  ro.observe(el);
  _mapResizeObservers.set(el, ro);
}

// ============================================================================
// 1. GPS USER MARKER & COMPASS CONE
// ============================================================================
function buildGpsUserHeadingIconHtml(headingDeg) {
  const hasHdg = Number.isFinite(headingDeg);
  const rot = hasHdg ? Math.round(headingDeg) : 0;
  const beamSvg = hasHdg
    ? `<svg class="gps-user-beam" viewBox="0 0 44 44" style="transform:rotate(${rot}deg);"><path d="M22 22 L10 3 A20 20 0 0 1 34 3 Z" fill="rgba(0,122,255,0.32)"/></svg>`
    : '';
  return `<div class="gps-user-dot-wrap">${beamSvg}<div class="gps-user-core"></div></div>`;
}

function updateUserMarkers() {
  if (typeof L === 'undefined' || typeof lastKnownPos === 'undefined' || !lastKnownPos || !Number.isFinite(lastKnownPos.lat)) return;
  const lat = lastKnownPos.lat, lon = lastKnownPos.lon;
  const acc = Math.min(250, Math.max(12, Number(lastKnownPos.acc) || 25));

  if (window.mapInstance) {
    if (!userMarkerDetail) {
      userMarkerDetail = L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: buildGpsUserHeadingIconHtml(userCompassHeadingDeg), iconSize: [44, 44], iconAnchor: [22, 22] }),
        zIndexOffset: 900
      }).addTo(window.mapInstance);
    } else {
      userMarkerDetail.setLatLng([lat, lon]);
      userMarkerDetail.setIcon(L.divIcon({ className: '', html: buildGpsUserHeadingIconHtml(userCompassHeadingDeg), iconSize: [44, 44], iconAnchor: [22, 22] }));
    }
    if (isDetailGpsLocked) {
      window.mapInstance.panTo([lat, lon], { animate: true, duration: 0.3 });
    }
  }

  if (window.browseMapInstance) {
    if (!userAccCircleBrowse) {
      userAccCircleBrowse = L.circle([lat, lon], {
        radius: acc, color: '#007AFF', weight: 1, fillColor: '#007AFF', fillOpacity: 0.14, interactive: false
      }).addTo(window.browseMapInstance);
    } else {
      userAccCircleBrowse.setLatLng([lat, lon]);
      userAccCircleBrowse.setRadius(acc);
    }

    const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
    const hdgStr = Number.isFinite(userCompassHeadingDeg) ? ` • 🧭 ${Math.round(userCompassHeadingDeg)}°` : '';
    const tipTxt = isZh
      ? `📍 我的位置${lastKnownPos.hasLiveFix ? ` (±${Math.round(acc)}m${hdgStr})` : ' (最後位置)'}`
      : `📍 My Location${lastKnownPos.hasLiveFix ? ` (±${Math.round(acc)}m${hdgStr})` : ' (Last Known)'}`;

    if (!userMarkerBrowse) {
      userMarkerBrowse = L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: buildGpsUserHeadingIconHtml(userCompassHeadingDeg), iconSize: [44, 44], iconAnchor: [22, 22] }),
        zIndexOffset: 950
      }).addTo(window.browseMapInstance);
      userMarkerBrowse.bindTooltip(tipTxt, { direction: 'top', offset: [0, -10], className: 'kmb-map-stop-label' });
    } else {
      userMarkerBrowse.setLatLng([lat, lon]);
      userMarkerBrowse.setIcon(L.divIcon({ className: '', html: buildGpsUserHeadingIconHtml(userCompassHeadingDeg), iconSize: [44, 44], iconAnchor: [22, 22] }));
      userMarkerBrowse.setTooltipContent(tipTxt);
    }
  }

  if (window.xferMapInstance) {
    if (!userMarkerXfer) {
      userMarkerXfer = L.marker([lat, lon], {
        icon: L.divIcon({ className: '', html: buildGpsUserHeadingIconHtml(userCompassHeadingDeg), iconSize: [44, 44], iconAnchor: [22, 22] }),
        zIndexOffset: 880
      }).addTo(window.xferMapInstance);
    } else {
      userMarkerXfer.setLatLng([lat, lon]);
      userMarkerXfer.setIcon(L.divIcon({ className: '', html: buildGpsUserHeadingIconHtml(userCompassHeadingDeg), iconSize: [44, 44], iconAnchor: [22, 22] }));
    }
  }
}

let _lastCompassUpdateMs = 0;
let _lastCompassAppliedDeg = null;

function applyCompassHeadingInPlace(deg) {
  const rot = `rotate(${Math.round(deg)}deg)`;
  [userMarkerDetail, userMarkerBrowse, userMarkerXfer].forEach(marker => {
    const el = marker?.getElement?.();
    const beam = el?.querySelector?.('.gps-user-beam');
    if (beam) beam.style.transform = rot;
  });
}

function handleDeviceOrientationEvent(ev) {
  let hdg = null;
  if (typeof ev.webkitCompassHeading === 'number' && Number.isFinite(ev.webkitCompassHeading)) {
    hdg = ev.webkitCompassHeading;
  } else if (typeof ev.alpha === 'number' && Number.isFinite(ev.alpha)) {
    hdg = (360 - ev.alpha) % 360;
  }
  if (hdg === null) return;
  const normDeg = (hdg + 360) % 360;
  const nowMs = Date.now();
  if (_lastCompassAppliedDeg !== null) {
    const diff = Math.abs(((normDeg - _lastCompassAppliedDeg + 540) % 360) - 180);
    if (diff < 3 || (nowMs - _lastCompassUpdateMs) < 100) return;
  }
  _lastCompassUpdateMs = nowMs;
  _lastCompassAppliedDeg = normDeg;
  userCompassHeadingDeg = normDeg;
  if (userMarkerDetail?.getElement?.()?.querySelector?.('.gps-user-beam') || userMarkerBrowse?.getElement?.()?.querySelector?.('.gps-user-beam')) {
    applyCompassHeadingInPlace(normDeg);
  } else {
    updateUserMarkers();
  }
}

async function autoStartCompassCone(fromUserGesture = false) {
  if (isCompassListening) return;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      if (!fromUserGesture) return;
      const perm = await DeviceOrientationEvent.requestPermission().catch(() => '');
      if (perm !== 'granted') return;
    }
    isCompassListening = true;
    window.addEventListener('deviceorientationabsolute', handleDeviceOrientationEvent, true);
    window.addEventListener('deviceorientation', handleDeviceOrientationEvent, true);
  } catch (e) {}
}

// ============================================================================
// 2. SHARED STOP-ID SLICER, CURVED WALK GUIDES & OSRM CYCLING ROUTER
// ============================================================================
function getStopLatLon(st) {
  if (!st) return null;
  const lat = parseFloat(st.lat ?? st.latitude);
  const lon = parseFloat(st.lon ?? st.longitude);
  if (!isValidRailOrFerryCoord(lat, lon)) return null;
  return [lat, lon];
}

function matchStopIndexInSequence(stops, targetStop, minIdx = 0) {
  if (!Array.isArray(stops) || !stops.length || !targetStop) return -1;
  const tCode = String(targetStop.mtrCode || targetStop.lrtCode || targetStop.stopId || '').trim().toUpperCase();
  const tKey = String(targetStop.stopKey || '');
  const tSeq = Number(targetStop.seq || 0);
  const tNorm = typeof normStationLookupKey === 'function' ? normStationLookupKey(targetStop.stopName_e) : '';
  const tBase = typeof getBaseStopNameKey === 'function' ? getBaseStopNameKey(targetStop.stopName_e) : '';
  const tPt = getStopLatLon(targetStop);

  if (tSeq > 0 && tCode) {
    const idx = stops.findIndex((s, i) =>
      i >= minIdx &&
      Number(s.seq || (i + 1)) === tSeq &&
      String(s.mtrCode || s.lrtCode || s.stopId || '').trim().toUpperCase() === tCode
    );
    if (idx !== -1) return idx;
  }

  if (tCode) {
    const idx = stops.findIndex((s, i) =>
      i >= minIdx &&
      String(s.mtrCode || s.lrtCode || s.stopId || '').trim().toUpperCase() === tCode
    );
    if (idx !== -1) return idx;
  }

  if (tKey) {
    const idx = stops.findIndex((s, i) => i >= minIdx && s.stopKey === tKey);
    if (idx !== -1) return idx;
  }

  if (tNorm || tBase) {
    const idx = stops.findIndex((s, i) => {
      if (i < minIdx) return false;
      const sBase = typeof getBaseStopNameKey === 'function' ? getBaseStopNameKey(s.stopName_e) : '';
      if (tBase && sBase === tBase) return true;
      const sNorm = typeof normStationLookupKey === 'function' ? normStationLookupKey(s.stopName_e) : '';
      if (tNorm && sNorm && sNorm === tNorm) {
        if (!tPt) return true;
        const sPt = getStopLatLon(s);
        return sPt ? calculateDistanceKm(tPt[0], tPt[1], sPt[0], sPt[1]) <= 0.45 : true;
      }
      return false;
    });
    if (idx !== -1) return idx;
  }

  if (tPt) {
    let bestIdx = -1, bestKm = 0.35;
    for (let i = minIdx; i < stops.length; i++) {
      const sPt = getStopLatLon(stops[i]);
      if (!sPt) continue;
      const dKm = calculateDistanceKm(tPt[0], tPt[1], sPt[0], sPt[1]);
      if (dKm < bestKm) {
        bestKm = dKm;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) return bestIdx;
  }

  return -1;
}

function sliceRouteStopPoints(group, bStop, aStop) {
  const bPt = getStopLatLon(bStop);
  const aPt = getStopLatLon(aStop);
  const directFallback = [
    bPt ? { pt: bPt, stop: bStop } : null,
    aPt ? { pt: aPt, stop: aStop } : null
  ].filter(Boolean);

  if (!group || !bStop || !aStop) return directFallback;

  const bCode = String(bStop?.mtrCode || bStop?.lrtCode || bStop?.stopId || '').trim().toUpperCase();
  const aCode = String(aStop?.mtrCode || aStop?.lrtCode || aStop?.stopId || '').trim().toUpperCase();

  let stops = getStopsForGroup(group, bStop.stopKey);
  if (group.mode === 'MTR') {
    stops = stops.filter(s => {
      const sc = String(s.mtrCode || s.lrtCode || s.stopId || '').trim().toUpperCase();
      if (sc === bCode || sc === aCode) return true;
      return !isParallelRailTerminusPair(sc, bCode) && !isParallelRailTerminusPair(sc, aCode);
    });
  }
  if (!stops.length) return directFallback;

  const bIdx = matchStopIndexInSequence(stops, bStop, 0);
  if (bIdx === -1) return directFallback;

  const aIdx = matchStopIndexInSequence(stops, aStop, bIdx + 1);
  if (aIdx === -1 || aIdx <= bIdx) {
    return directFallback;
  }

  const slice = stops
    .slice(bIdx, aIdx + 1)
    .map(s => {
      const pt = getStopLatLon(s);
      return pt ? { pt, stop: s } : null;
    })
    .filter(Boolean);

  return slice.length >= 2 ? slice : directFallback;
}

function sliceRouteStops(group, bStop, aStop) {
  return sliceRouteStopPoints(group, bStop, aStop).map(x => x.pt);
}

function buildGentleCurvePoints(fromPt, toPt, steps = 14) {
  const lat1 = fromPt[0], lon1 = fromPt[1];
  const lat2 = toPt[0], lon2 = toPt[1];
  const dLat = lat2 - lat1, dLon = lon2 - lon1;
  const midLat = (lat1 + lat2) / 2;
  const midLon = (lon1 + lon2) / 2;
  const ctrlLat = midLat - dLon * 0.11;
  const ctrlLon = midLon + dLat * 0.11;

  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const omt = 1 - t;
    pts.push([
      omt * omt * lat1 + 2 * omt * t * ctrlLat + t * t * lat2,
      omt * omt * lon1 + 2 * omt * t * ctrlLon + t * t * lon2
    ]);
  }
  return pts;
}

async function fetchOsrmStreetGeometry(fromPt, toPt, profile = 'foot') {
  if (!fromPt || !toPt) return null;
  const isBike = (profile === 'cycling');
  const key = `${profile}_${fromPt[0].toFixed(4)},${fromPt[1].toFixed(4)}_${toPt[0].toFixed(4)},${toPt[1].toFixed(4)}`;
  if (bikeRouteGeoCache.has(key)) return bikeRouteGeoCache.get(key);

  if (bikeRouteGeoCache.size > 120) {
    const firstKey = bikeRouteGeoCache.keys().next().value;
    if (firstKey) bikeRouteGeoCache.delete(firstKey);
  }

  const osrmProfile = isBike ? 'cycling' : 'foot';
  const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${fromPt[1].toFixed(6)},${fromPt[0].toFixed(6)};${toPt[1].toFixed(6)},${toPt[0].toFixed(6)}?overview=full&geometries=geojson`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 3200);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();
    const rt = data?.routes?.[0];
    const rawCoords = rt?.geometry?.coordinates;
    if (!Array.isArray(rawCoords) || rawCoords.length < 2) return null;

    const latLngs = rawCoords.map(([lng, lat]) => [lat, lng]);
    const distM = Math.round(Number(rt.distance) || 0);
    // Reject absurd OSRM detours (> 3.2x straight line, e.g. disconnected island/highway node)
    const straightM = calculateDistanceKm(fromPt[0], fromPt[1], toPt[0], toPt[1]) * 1000;
    if (straightM > 30 && distM > Math.max(900, straightM * 3.2)) return null;

    const mins = isBike
      ? Math.max(2, Math.round((distM / 4.16 + 90) / 60))
      : Math.max(1, Math.round(distM / 75));
    const parsed = { latLngs, distM, mins, bikeMins: mins, profile };
    bikeRouteGeoCache.set(key, parsed);
    return parsed;
  } catch (e) {
    clearTimeout(tid);
    return null;
  }
}

async function fetchOsrmBikeGeometry(fromPt, toPt) {
  return fetchOsrmStreetGeometry(fromPt, toPt, 'cycling');
}

function drawWalkingLeg(targetMap, fromPt, toPt, options = {}) {
  if (!targetMap || typeof L === 'undefined' || !fromPt || !toPt) return null;
  if (!isValidRailOrFerryCoord(fromPt[0], fromPt[1]) || !isValidRailOrFerryCoord(toPt[0], toPt[1])) return null;
  const dKm = calculateDistanceKm(fromPt[0], fromPt[1], toPt[0], toPt[1]);
  if (!Number.isFinite(dKm) || dKm < 0.025) return null;

  const isBike = Boolean(options.isBike);
  const profile = isBike ? 'cycling' : 'foot';
  const cacheKey = `${profile}_${fromPt[0].toFixed(4)},${fromPt[1].toFixed(4)}_${toPt[0].toFixed(4)},${toPt[1].toFixed(4)}`;
  const cachedRoute = bikeRouteGeoCache.has(cacheKey) ? bikeRouteGeoCache.get(cacheKey) : null;
  const shouldFetchStreet = dKm >= 0.04 && dKm <= 3.6 && !window.crossesWaterBarrier(fromPt[0], fromPt[1], toPt[0], toPt[1]);

  const coords = cachedRoute ? cachedRoute.latLngs : [fromPt, toPt];

  const line = L.polyline(coords, {
    color: isBike ? '#16A34A' : '#2563EB',
    weight: isBike ? 4.5 : 4,
    dashArray: isBike ? '10, 5' : '4, 7',
    opacity: cachedRoute ? 0.92 : 0.72,
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(targetMap);

  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (cachedRoute) {
    const tip = isBike
      ? (isZh ? `單車路線 ${cachedRoute.distM}m (~${cachedRoute.mins}分)` : `Bike ${cachedRoute.distM}m (~${cachedRoute.mins}m)`)
      : (isZh ? `步行路線 ${cachedRoute.distM}m (~${cachedRoute.mins}分)` : `Walk ${cachedRoute.distM}m (~${cachedRoute.mins}m)`);
    line.bindTooltip(tip, { sticky: true, className: 'kmb-map-stop-label' });
  } else if (options.label) {
    line.bindTooltip(options.label, { sticky: true, className: 'kmb-map-stop-label' });
  }

  // Upgrade straight fallback line to true street-following footpath/cycleway geometry via OSRM
  if (shouldFetchStreet && !cachedRoute) {
    const myDrawToken = options.drawToken ?? xferDrawToken;
    fetchOsrmStreetGeometry(fromPt, toPt, profile).then((res) => {
      if (!res || myDrawToken !== xferDrawToken || !targetMap.hasLayer(line)) return;
      line.setLatLngs(res.latLngs);
      line.setStyle({ opacity: 0.94 });
      const upgradedTip = isBike
        ? (isZh ? `單車路線 ${res.distM}m (~${res.mins}分)` : `Bike ${res.distM}m (~${res.mins}m)`)
        : (isZh ? `步行路線 ${res.distM}m (~${res.mins}分)` : `Walk ${res.distM}m (~${res.mins}m)`);
      if (line.getTooltip()) line.setTooltipContent(upgradedTip);
      else line.bindTooltip(upgradedTip, { sticky: true, className: 'kmb-map-stop-label' });
      fitTransferPlannerMapBounds();
    });
  }

  return line;
}

// ============================================================================
// 3. ROUTE DETAIL MAP (window.mapInstance)
// ============================================================================
function cycleMapSheetHeight() {
  const mapEl = document.getElementById('map-container');
  if (!mapEl) return;
  detailMapHeightState = (detailMapHeightState + 1) % 3;
  mapEl.style.height = detailMapHeightState === 0 ? '35dvh' : (detailMapHeightState === 1 ? '64dvh' : '22dvh');
  setTimeout(() => window.mapInstance?.invalidateSize(false), 120);
}

function initDetailMapSheetDragResize() {
  const handle = document.getElementById('mapSheetHandle');
  const mapEl = document.getElementById('map-container');
  if (!handle || !mapEl || handle._dragBound) return;
  handle._dragBound = true;

  let activePointerId = null;
  let startY = 0;
  let startH = 0;
  let movedPx = 0;
  let rafId = 0;

  const scheduleInvalidate = () => {
    if (rafId) return;
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        window.mapInstance?.invalidateSize(false);
      });
    } else {
      window.mapInstance?.invalidateSize(false);
    }
  };

  const getBoundsPx = () => {
    const vh = (typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0) ? window.innerHeight : 800;
    return { minH: 170, maxH: Math.max(260, Math.round(vh * 0.74)), vh };
  };

  const finishDrag = (e, allowTapToggle) => {
    if (activePointerId === null || (e && e.pointerId !== undefined && e.pointerId !== activePointerId)) return;
    const pid = activePointerId;
    activePointerId = null;
    if (typeof handle.releasePointerCapture === 'function') {
      try {
        if (typeof handle.hasPointerCapture !== 'function' || handle.hasPointerCapture(pid)) {
          handle.releasePointerCapture(pid);
        }
      } catch (err) {}
    }
    handle.classList?.remove('is-dragging');
    document.body?.classList?.remove('map-sheet-dragging');
    if (rafId && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(rafId); rafId = 0; }
    mapEl.style.transition = '';

    if (allowTapToggle && movedPx < 5) {
      cycleMapSheetHeight();
      return;
    }

    const { vh } = getBoundsPx();
    const curH = mapEl.offsetHeight || parseFloat(mapEl.style.height) || startH;
    const ratio = vh > 0 ? (curH / vh) : 0.35;
    detailMapHeightState = ratio >= 0.50 ? 1 : (ratio <= 0.27 ? 2 : 0);
    window.mapInstance?.invalidateSize(false);
  };

  handle.addEventListener('dragstart', (e) => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); });
  handle.addEventListener('pointerdown', (e) => {
    if (!e) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('#mapSheetToggleBtn')) return;
    if (e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    activePointerId = (e.pointerId !== undefined) ? e.pointerId : 1;
    startY = Number(e.clientY) || 0;
    startH = mapEl.offsetHeight || parseFloat(mapEl.style.height) || Math.round(getBoundsPx().vh * 0.35);
    movedPx = 0;
    mapEl.style.transition = 'none';
    handle.classList?.add('is-dragging');
    document.body?.classList?.add('map-sheet-dragging');
    if (typeof handle.setPointerCapture === 'function') {
      try { handle.setPointerCapture(activePointerId); } catch (err) {}
    }
  });
  handle.addEventListener('pointermove', (e) => {
    if (activePointerId === null || !e || (e.pointerId !== undefined && e.pointerId !== activePointerId)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const dy = (Number(e.clientY) || 0) - startY;
    movedPx = Math.max(movedPx, Math.abs(dy));
    const { minH, maxH } = getBoundsPx();
    const newH = Math.max(minH, Math.min(maxH, Math.round(startH + dy)));
    mapEl.style.height = `${newH}px`;
    scheduleInvalidate();
  });
  handle.addEventListener('pointerup', (e) => finishDrag(e, true));
  handle.addEventListener('pointercancel', (e) => finishDrag(e, false));
}

window.initDetailMapSheetDragResize = initDetailMapSheetDragResize;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDetailMapSheetDragResize);
  } else {
    initDetailMapSheetDragResize();
  }
}

function syncDetailGpsLockBtnUI() {
  const btn = document.getElementById('mapGpsRecenterBtn');
  if (btn) btn.classList.toggle('active', Boolean(isDetailGpsLocked));
}

function toggleDetailGpsLock() {
  triggerHaptic(12);
  isDetailGpsLocked = !isDetailGpsLocked;
  syncDetailGpsLockBtnUI();
  if (isDetailGpsLocked) {
    if (window.mapInstance && lastKnownPos) {
      window.mapInstance.flyTo([lastKnownPos.lat, lastKnownPos.lon], Math.min(Math.max(window.mapInstance.getZoom() || 15, 15), 16), { animate: true, duration: 0.35 });
    }
    showToast(currentLang === 'zh' ? '🔒 已鎖定 GPS 跟隨 (再按解鎖)' : '🔒 GPS Follow Locked (Tap again to unlock)');
  } else {
    showToast(currentLang === 'zh' ? '🔓 已解除 GPS 鎖定' : '🔓 GPS Follow Unlocked');
  }
}

function zoomMapIn() { window.mapInstance?.zoomIn(); }
function zoomMapOut() { window.mapInstance?.zoomOut(); }

function buildDetailBusPolylineLayer(coords, stops, activeStopIdx, routeAccent) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const layers = [];
  const activeStop = stops?.[activeStopIdx];
  const actLat = parseFloat(activeStop?.latitude ?? activeStop?.lat);
  const actLon = parseFloat(activeStop?.longitude ?? activeStop?.lon);
  const splitIdx = (activeStopIdx > 0 && Number.isFinite(actLat) && Number.isFinite(actLon))
    ? findNearestPolylineIndex(coords, actLat, actLon, 0)
    : 0;

  if (splitIdx > 1 && splitIdx < coords.length - 1) {
    const upstreamCoords = coords.slice(0, splitIdx + 1);
    const activeCoords = coords.slice(splitIdx);
    layers.push(
      L.polyline(upstreamCoords, { color: '#FFFFFF', weight: 6.5, opacity: 0.60, lineJoin: 'round', lineCap: 'round', interactive: false }),
      L.polyline(upstreamCoords, { color: routeAccent, weight: 4, opacity: 0.42, lineJoin: 'round', lineCap: 'round', interactive: false }),
      L.polyline(activeCoords, { color: '#FFFFFF', weight: 8.5, opacity: 0.88, lineJoin: 'round', lineCap: 'round', interactive: false }),
      L.polyline(activeCoords, { color: routeAccent, weight: 5.5, opacity: 0.96, lineJoin: 'round', lineCap: 'round' })
    );
  } else {
    layers.push(
      L.polyline(coords, { color: '#FFFFFF', weight: 8.2, opacity: 0.86, lineJoin: 'round', lineCap: 'round', interactive: false }),
      L.polyline(coords, { color: routeAccent, weight: 5.2, opacity: 0.94, lineJoin: 'round', lineCap: 'round' })
    );
  }
  return L.layerGroup(layers);
}

function drawRouteOnMap(group, activeStopIdx = 0) {
  if (typeof L === 'undefined') {
    if (typeof window.ensureLeafletLoaded === 'function') {
      window.ensureLeafletLoaded().then(() => {
        if (typeof L !== 'undefined' && typeof currentView !== 'undefined' && currentView === 'detail' && detailRouteGroup === group) {
          drawRouteOnMap(group, activeStopIdx);
        }
      });
    }
    return;
  }
  const startLat = (typeof lastKnownPos !== 'undefined' && lastKnownPos?.lat) ? lastKnownPos.lat : 22.2855;
  const startLon = (typeof lastKnownPos !== 'undefined' && lastKnownPos?.lon) ? lastKnownPos.lon : 114.1577;
  if (!window.mapInstance) {
    window.mapInstance = L.map('map-canvas-inner', { zoomControl: false, preferCanvas: true }).setView([startLat, startLon], 13);
    window.attachStandardMapLayers(window.mapInstance);
    window.mapInstance.on('dragstart', () => {
      if (isDetailGpsLocked) {
        isDetailGpsLocked = false;
        syncDetailGpsLockBtnUI();
      }
    });
    attachMapResizeObserver('map-container', window.mapInstance);
    bindTrafficRefreshOnMapMove(window.mapInstance);
  }
  initDetailMapSheetDragResize();
  try { window.mapInstance.invalidateSize(false); } catch (e) {}

  if (detailPolylineLayer) { try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {} detailPolylineLayer = null; }
  Object.values(mapMarkers).forEach(m => { try { window.mapInstance.removeLayer(m); } catch (e) {} });
  mapMarkers = {};

  const stops = getStopsForGroup(group, detailTargetStopKey);
  if (!stops.length) return;

  const isLight = document.documentElement.classList.contains('light-mode');
  const routeAccent = group?.colorHex || window.__GET_ROUTE_COLOR_HEX__(group?.mode, group?.company, group?.routeNo);
  const polyPts = stops
    .map(s => [parseFloat(s.latitude), parseFloat(s.longitude)])
    .filter(p => isValidRailOrFerryCoord(p[0], p[1]));

  const isBusRoute = !group?.mode || group.mode === 'BUS';
  const cachedRoadCoords = isBusRoute ? getCachedBusRoutePolyline(group, stops) : null;
  currentDetailRoadCoords = cachedRoadCoords || polyPts;
  if (currentDetailCorridorMeta?.groupKey !== (group?.key || '')) {
    window.__FOCUSED_TRAFFIC_DET_ID__ = '';
  }
  const hasHighwaySpan = isBusRoute && _stopsHaveHighwaySpan(stops);
  currentDetailCorridorMeta = {
    groupKey: group?.key || '',
    mode: group?.mode || 'BUS',
    isBusRoute,
    hasHighwaySpan,
    isRoadSnapped: Boolean(cachedRoadCoords && cachedRoadCoords.length >= 2),
    coords: currentDetailRoadCoords
  };

  const lineStyle = { color: routeAccent, weight: 5, opacity: 0.92, lineJoin: 'round', lineCap: 'round' };
  const myGeomToken = ++_detailGeomToken;

  if (group?.mode === 'MTR' && stops.length >= 4 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId)) {
    const trunkStops = stops.slice(0, -2);
    const termA = stops[stops.length - 2];
    const termB = stops[stops.length - 1];
    const forkStopB = (group.routeNo === 'TKL' && stops.find(s => s.stopId === 'TKO')) || trunkStops[trunkStops.length - 1];
    const branchAPts = [...trunkStops, termA].map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]).filter(p => isValidRailOrFerryCoord(p[0], p[1]));
    const branchBPts = [forkStopB, termB].map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]).filter(p => isValidRailOrFerryCoord(p[0], p[1]));
    detailPolylineLayer = L.layerGroup([
      L.polyline(branchAPts, lineStyle),
      L.polyline(branchBPts, { ...lineStyle, dashArray: '6, 6' })
    ]).addTo(window.mapInstance);
  } else if (group?.mode === 'MTR' && stops.length >= 4 && isParallelRailTerminusPair(stops[0]?.stopId, stops[1]?.stopId)) {
    const termA = stops[0];
    const termB = stops[1];
    const trunkStops = stops.slice(2);
    const forkStopB = (group.routeNo === 'TKL' && stops.find(s => s.stopId === 'TKO')) || trunkStops[0];
    const branchAPts = [termA, ...trunkStops].map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]).filter(p => isValidRailOrFerryCoord(p[0], p[1]));
    const branchBPts = [termB, forkStopB].map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]).filter(p => isValidRailOrFerryCoord(p[0], p[1]));
    detailPolylineLayer = L.layerGroup([
      L.polyline(branchAPts, lineStyle),
      L.polyline(branchBPts, { ...lineStyle, dashArray: '6, 6' })
    ]).addTo(window.mapInstance);
  } else if (cachedRoadCoords && cachedRoadCoords.length >= 2) {
    detailPolylineLayer = buildDetailBusPolylineLayer(cachedRoadCoords, stops, activeStopIdx, routeAccent).addTo(window.mapInstance);
  } else if (polyPts.length >= 2) {
    detailPolylineLayer = L.polyline(polyPts, isBusRoute ? { ...lineStyle, opacity: 0.45, dashArray: '6, 6' } : lineStyle).addTo(window.mapInstance);
    if (isBusRoute) {
      fetchRoadSnappedBusPolyline(group, stops).then((roadCoords) => {
        if (!roadCoords || myGeomToken !== _detailGeomToken || !window.mapInstance) return;
        if (typeof detailRouteGroup !== 'undefined' && detailRouteGroup?.key !== group.key) return;
        const curActive = (typeof detailExpandedStopIdx === 'number' && detailExpandedStopIdx >= 0) ? detailExpandedStopIdx : activeStopIdx;
        if (detailPolylineLayer) {
          try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {}
        }
        currentDetailRoadCoords = roadCoords;
        currentDetailCorridorMeta = {
          groupKey: group?.key || '',
          mode: group?.mode || 'BUS',
          isBusRoute: true,
          hasHighwaySpan,
          isRoadSnapped: true,
          coords: roadCoords
        };
        detailPolylineLayer = buildDetailBusPolylineLayer(roadCoords, stops, curActive, routeAccent).addTo(window.mapInstance);
        // Re-run route-scoped traffic filtering against the exact road-snapped highway corridor
        renderTrafficOverlayOnMap(window.mapInstance, true);
        if (typeof window.onBusRouteGeometryReady === 'function') {
          window.onBusRouteGeometryReady(group.key);
        }
      });
    }
  }

  stops.forEach((s, idx) => {
    const lat = parseFloat(s.latitude), lon = parseFloat(s.longitude);
    if (!isValidRailOrFerryCoord(lat, lon)) return;
    const isAct = (idx === activeStopIdx);
    const bgCol = isAct ? routeAccent : (isLight ? '#FFFFFF' : '#2C2C2E');
    const fgCol = isAct ? '#FFFFFF' : (isLight ? '#1C1C1E' : '#FFFFFF');
    const bdrCol = isAct ? '#FFFFFF' : routeAccent;
    const m = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-stop-icon',
        html: `<div style="width:${isAct ? 22 : 16}px;height:${isAct ? 22 : 16}px;background:${bgCol};color:${fgCol};border:2.5px solid ${bdrCol};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.56rem;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${idx + 1}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
      }),
      zIndexOffset: isAct ? 650 : 320
    }).addTo(window.mapInstance);
    m.bindTooltip(`${idx + 1}. ${getStopName(s)}`, { direction: 'top', offset: [0, -8], className: 'kmb-map-stop-label' });
    m.on('click', () => expandStop(idx, false, false, false));
    mapMarkers[idx] = m;
  });

  isDetailGpsLocked = false;
  syncDetailGpsLockBtnUI();
  updateUserMarkers();

  const fitPts = (cachedRoadCoords && cachedRoadCoords.length >= 2) ? cachedRoadCoords : polyPts;
  if (fitPts.length >= 2) {
    try {
      window.mapInstance.invalidateSize(false);
      window.mapInstance.fitBounds(L.latLngBounds(fitPts), { paddingTopLeft: [36, 36], paddingBottomRight: [36, 44], maxZoom: 16 });
    } catch (e) {}
  }
  renderTrafficOverlayOnMap(window.mapInstance, true);
}

function highlightActiveStopMarkerOnMap(activeIdx) {
  if (!window.mapInstance || !detailRouteGroup) return;
  const stops = getStopsForGroup(detailRouteGroup, detailTargetStopKey);
  const isLight = document.documentElement.classList.contains('light-mode');
  const routeAccent = detailRouteGroup?.colorHex || window.__GET_ROUTE_COLOR_HEX__(detailRouteGroup?.mode, detailRouteGroup?.company, detailRouteGroup?.routeNo);
  const isBusRoute = !detailRouteGroup?.mode || detailRouteGroup.mode === 'BUS';
  if (isBusRoute && Array.isArray(currentDetailRoadCoords) && currentDetailRoadCoords.length > stops.length && detailPolylineLayer) {
    try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {}
    detailPolylineLayer = buildDetailBusPolylineLayer(currentDetailRoadCoords, stops, activeIdx, routeAccent).addTo(window.mapInstance);
    _bringLayerGroupToFront(detailPolylineLayer);
  }
  Object.entries(mapMarkers).forEach(([idxStr, m]) => {
    const idx = Number(idxStr);
    const isAct = (idx === activeIdx);
    const bgCol = isAct ? routeAccent : (isLight ? '#FFFFFF' : '#2C2C2E');
    const fgCol = isAct ? '#FFFFFF' : (isLight ? '#1C1C1E' : '#FFFFFF');
    const bdrCol = isAct ? '#FFFFFF' : routeAccent;
    m.setIcon(L.divIcon({
      className: 'custom-stop-icon',
      html: `<div style="width:${isAct ? 22 : 16}px;height:${isAct ? 22 : 16}px;background:${bgCol};color:${fgCol};border:2.5px solid ${bdrCol};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.56rem;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${idx + 1}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    }));
    if (typeof m.setZIndexOffset === 'function') m.setZIndexOffset(isAct ? 650 : 320);
    if (isAct && stops[idx]) m.openTooltip();
  });
}

// ============================================================================
// 4. STOP BROWSER MAP (window.browseMapInstance)
// ============================================================================
function getStopImportanceTier(s) {
  if (!s) return 0;
  if (s.mode === 'MTR' && s.company !== 'LRT' && !s.lrtCode) return 4000;
  if (s.mode === 'FERRY') return 3500;
  if (s.mode === 'MTR' && (s.company === 'LRT' || s.lrtCode)) return 2500;
  return (s.routeNos ? s.routeNos.size : 1);
}

function rebuildBrowseMapSpatialGrid() {
  browseMapStopGrid.clear();
  browseMapExitGrid.clear();

  const seenCellDedup = new Set();
  for (let i = 0; i < allStops.length; i++) {
    const s = allStops[i];
    const lat = parseFloat(s.latitude), lon = parseFloat(s.longitude);
    if (!isValidRailOrFerryCoord(lat, lon)) continue;
    const isLrt = (s.mode === 'MTR' && (s.company === 'LRT' || s.lrtCode));
    const subType = s.mode === 'FERRY' ? 'FERRY' : (isLrt ? 'LRT' : (s.mode === 'MTR' ? 'MTR' : 'BUS'));
    const dedupSig = subType === 'MTR'
      ? `MTR_${String(s.mtrCode || s.stopId || getBaseStopNameKey(s.stopName_e)).toUpperCase()}`
      : (subType === 'LRT'
        ? `LRT_${String(s.lrtCode || s.stopId || getBaseStopNameKey(s.stopName_e)).toUpperCase()}`
        : (subType === 'BUS'
          ? `BUS_${getBaseStopNameKey(s.stopName_e)}_${lat.toFixed(4)}_${lon.toFixed(4)}`
          : `${subType}_${normStationLookupKey(s.stopName_e) || getBaseStopNameKey(s.stopName_e)}`));
    if (seenCellDedup.has(dedupSig)) continue;
    seenCellDedup.add(dedupSig);

    const ck = `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`;
    if (!browseMapStopGrid.has(ck)) browseMapStopGrid.set(ck, []);
    browseMapStopGrid.get(ck).push(s);
  }

  for (const bucket of browseMapStopGrid.values()) {
    bucket.sort((a, b) => getStopImportanceTier(b) - getStopImportanceTier(a));
  }
}

function buildBrowseMapActionPopupHtml({ stopKey = '', nameEn, nameTc, routesText = '', lat, lon, nodeType = 'BUS', hasStopRadar = false }) {
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const dispName = escapeHtml(isZh && nameTc ? nameTc : nameEn);
  const escK = escapeJsAttr(stopKey);
  const escE = escapeJsAttr(nameEn);
  const escZ = escapeJsAttr(nameTc || nameEn);

  const subLine = routesText
    ? `<div style="font-size:0.72rem; opacity:0.8; margin:2px 0 8px;">${escapeHtml(routesText)}</div>`
    : `<div style="font-size:0.70rem; opacity:0.75; margin:2px 0 8px;">${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}</div>`;

  const radarBtnHtml = hasStopRadar
    ? `<button onclick="window.browseMapInstance?.closePopup(); window.xferMapInstance?.closePopup(); selectStopFromSearch('${escK}'); switchView('main', false);"
         style="width:100%; margin-top:5px; padding:6px 10px; border-radius:8px; border:1px solid #007AFF; background:#fff; color:#007AFF; font-weight:700; font-size:0.76rem; cursor:pointer;">
         ${isZh ? '查看此站實時班次' : 'View Stop Live ETAs'}
       </button>`
    : '';

  return `
    <div style="min-width:195px; max-width:240px; font-family:inherit; color:#1C1C1E;">
      <div style="font-weight:800; font-size:0.84rem; line-height:1.3;">${dispName}</div>
      ${subLine}
      <div style="display:flex; gap:6px;">
        <button onclick="sendMapPointToTransferPlanner('home', '${escK}', '${escE}', '${escZ}', ${lat}, ${lon}, '${nodeType}')"
          style="flex:1; padding:6px 8px; border-radius:8px; border:1.5px solid #cbd5e1; background:#fff; color:#1C1C1E; font-weight:800; font-size:0.75rem; cursor:pointer;">
          ${isZh ? '設為起點' : 'From Here'}
        </button>
        <button onclick="sendMapPointToTransferPlanner('work', '${escK}', '${escE}', '${escZ}', ${lat}, ${lon}, '${nodeType}')"
          style="flex:1; padding:6px 8px; border-radius:8px; border:none; background:#007AFF; color:#fff; font-weight:800; font-size:0.75rem; cursor:pointer;">
          ${isZh ? '去這裡' : 'Go Here'}
        </button>
      </div>
      ${radarBtnHtml}
    </div>
  `;
}

function scheduleBrowseMapPinDiff() {
  clearTimeout(browseMapMoveDebounceTimer);
  browseMapMoveDebounceTimer = setTimeout(() => {
    renderBrowseMapVisiblePins();
  }, 80);
}

function clearAllActiveBrowseMarkers() {
  if (!window.browseMapInstance) return;
  for (const marker of activeBrowseMarkersByKey.values()) {
    try { window.browseMapInstance.removeLayer(marker); } catch (e) {}
  }
  activeBrowseMarkersByKey.clear();
}

function initAndRenderBrowseMap() {
  if (typeof L === 'undefined') {
    if (typeof window.ensureLeafletLoaded === 'function') {
      window.ensureLeafletLoaded().then(() => {
        if (typeof L !== 'undefined' && typeof currentView !== 'undefined' && currentView === 'map') {
          initAndRenderBrowseMap();
        }
      });
    }
    return;
  }
  const centerLat = lastKnownPos?.lat || 22.2855;
  const centerLon = lastKnownPos?.lon || 114.1577;
  if (!window.browseMapInstance) {
    window.browseMapInstance = L.map('browse-map-canvas', { zoomControl: false, preferCanvas: true }).setView([centerLat, centerLon], 15);
    window.attachStandardMapLayers(window.browseMapInstance);
    window.browseMapInstance.on('moveend', scheduleBrowseMapPinDiff);
    attachMapResizeObserver('browse-map-canvas', window.browseMapInstance, () => renderBrowseMapVisiblePins());

    window.browseMapInstance.on('contextmenu', (e) => {
      const lat = Number(e.latlng.lat.toFixed(5));
      const lon = Number(e.latlng.lng.toFixed(5));
      triggerHaptic(14);
      if (browseMapClickedSpotMarker) {
        try { window.browseMapInstance.removeLayer(browseMapClickedSpotMarker); } catch (err) {}
      }
      const distTag = getStopDistrictTag({ stopName_e: '', latitude: lat, longitude: lon });
      const labelEn = distTag ? `Pinned Spot (${distTag})` : `Pinned Map Spot`;
      const labelZh = distTag ? `地圖標記點 (${distTag})` : `地圖標記點`;

      browseMapClickedSpotMarker = L.circleMarker([lat, lon], {
        radius: 8, fillColor: '#007AFF', color: '#FFFFFF', weight: 2.5, fillOpacity: 0.95
      }).addTo(window.browseMapInstance);

      const popupHtml = buildBrowseMapActionPopupHtml({
        stopKey: `MAP_PIN_${lat}_${lon}`,
        nameEn: labelEn,
        nameTc: labelZh,
        lat,
        lon,
        nodeType: 'ADDRESS',
        hasStopRadar: false
      });
      browseMapClickedSpotMarker.bindPopup(popupHtml, { closeButton: true, offset: [0, -4] }).openPopup();
    });

    if (!window.browseMapInstance._compassBound) {
      window.browseMapInstance._compassBound = true;
      autoStartCompassCone(false);
      window.browseMapInstance.once('click dragstart', () => autoStartCompassCone(true));
    }
  } else {
    window.browseMapInstance.invalidateSize(false);
  }
  updateUserMarkers();
  if (!browseMapStopGrid.size && allStops.length) rebuildBrowseMapSpatialGrid();
  renderBrowseMapVisiblePins();
}

function createBrowseMapStopMarker(s, displayLat = null, displayLon = null) {
  const trueLat = parseFloat(s.latitude), trueLon = parseFloat(s.longitude);
  const lat = displayLat ?? trueLat;
  const lon = displayLon ?? trueLon;
  const isLrt = (s.mode === 'MTR' && (s.company === 'LRT' || s.lrtCode));
  const subType = s.mode === 'FERRY' ? 'FERRY' : (isLrt ? 'LRT' : (s.mode === 'MTR' ? 'MTR' : 'BUS'));
  const routesStr = Array.from(s.routeNos || []).map(r => cleanFerryLabel(r)).slice(0, 8).join(', ');

  let m;
  if (subType !== 'BUS') {
    const tagTxt = subType === 'MTR' ? 'MTR' : (subType === 'LRT' ? 'LR' : 'FER');
    const bgCol = subType === 'MTR' ? '#007AFF' : (subType === 'LRT' ? '#5856D6' : '#0090D9');
    const sz = subType === 'LRT' ? 20 : 24;
    m = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:${sz}px;height:${sz}px;border-radius:6px;background:${bgCol};color:#fff;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:0.54rem;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${tagTxt}</div>`,
        iconSize: [sz, sz],
        iconAnchor: [sz / 2, sz / 2]
      }),
      zIndexOffset: subType === 'MTR' ? 800 : 700
    }).addTo(window.browseMapInstance);
  } else {
    m = L.circleMarker([lat, lon], {
      radius: 6,
      fillColor: '#FFFFFF',
      color: '#FF3B30',
      weight: 2.2,
      fillOpacity: 0.95
    }).addTo(window.browseMapInstance);
  }

  m.bindTooltip(`${getStopName(s)}${routesStr ? ` (${routesStr})` : ''}`, { direction: 'top', className: 'kmb-map-stop-label' });
  m.bindPopup(buildBrowseMapActionPopupHtml({
    stopKey: s.stopKey,
    nameEn: cleanFerryLabel(s.stopName_e),
    nameTc: cleanFerryLabel(s.name_tc || s.stopName_e),
    routesText: routesStr,
    lat: trueLat,
    lon: trueLon,
    nodeType: s.mode || 'BUS',
    hasStopRadar: true
  }), { closeButton: true, offset: [0, -4] });
  return m;
}

function renderBrowseMapVisiblePins() {
  if (!window.browseMapInstance) return;
  if (!browseMapStopGrid.size && allStops.length) rebuildBrowseMapSpatialGrid();
  updateUserMarkers();

  const bounds = window.browseMapInstance.getBounds();
  const zoom = window.browseMapInstance.getZoom() || 15;
  const center = window.browseMapInstance.getCenter();
  const cLatCell = center.lat * 100, cLonCell = center.lng * 100;

  const minLa = Math.floor(bounds.getSouth() * 100) - 1;
  const maxLa = Math.floor(bounds.getNorth() * 100) + 1;
  const minLo = Math.floor(bounds.getWest() * 100) - 1;
  const maxLo = Math.floor(bounds.getEast() * 100) + 1;

  const visibleCells = [];
  for (let la = minLa; la <= maxLa; la++) {
    for (let lo = minLo; lo <= maxLo; lo++) {
      const ck = `${la}_${lo}`;
      if (browseMapStopGrid.has(ck)) {
        const distSq = (la + 0.5 - cLatCell) ** 2 + (lo + 0.5 - cLonCell) ** 2;
        visibleCells.push({ ck, distSq });
      }
    }
  }
  visibleCells.sort((a, b) => a.distSq - b.distSq);

  const desiredPins = new Map();
  const railAndFerryHubs = [];
  const maxTotalPins = zoom >= 16 ? 340 : 260;

  for (const { ck } of visibleCells) {
    const cellStops = browseMapStopGrid.get(ck) || [];
    for (const s of cellStops) {
      const isHeavyMtr = (s.mode === 'MTR' && s.company !== 'LRT' && !s.lrtCode);
      if (!isHeavyMtr && s.mode !== 'FERRY') continue;
      const lat = parseFloat(s.latitude), lon = parseFloat(s.longitude);
      if (bounds.contains([lat, lon])) {
        desiredPins.set(s.stopKey, { kind: 'STOP', item: s, dispLat: lat, dispLon: lon });
        railAndFerryHubs.push([lat, lon]);
      }
    }
  }

  const perCellBusQuota = zoom <= 13 ? 3 : (zoom <= 15 ? 14 : 999);
  for (const { ck } of visibleCells) {
    if (desiredPins.size >= maxTotalPins) break;
    const cellStops = browseMapStopGrid.get(ck) || [];
    let busInCell = 0;

    for (const s of cellStops) {
      if (desiredPins.size >= maxTotalPins) break;
      if (desiredPins.has(s.stopKey)) continue;
      const lat = parseFloat(s.latitude), lon = parseFloat(s.longitude);
      if (!bounds.contains([lat, lon])) continue;

      const isLrt = (s.mode === 'MTR' && (s.company === 'LRT' || s.lrtCode));
      if (isLrt) {
        if (zoom >= 13) {
          desiredPins.set(s.stopKey, { kind: 'STOP', item: s, dispLat: lat, dispLon: lon });
          railAndFerryHubs.push([lat, lon]);
        }
        continue;
      }

      const routeCount = s.routeNos ? s.routeNos.size : 1;
      if (zoom <= 13 && routeCount < 6) continue;
      if (busInCell >= perCellBusQuota) continue;
      busInCell++;

      let dispLat = lat, dispLon = lon;
      for (const [rLat, rLon] of railAndFerryHubs) {
        if (Math.abs(lat - rLat) < 0.00022 && Math.abs(lon - rLon) < 0.00022) {
          const angle = ((s.stopKey.charCodeAt(0) * 37 + s.stopKey.charCodeAt(s.stopKey.length - 1) + busInCell * 3) % 8) * (Math.PI / 4);
          dispLat = rLat + Math.sin(angle) * 0.00020;
          dispLon = rLon + Math.cos(angle) * 0.00022;
          break;
        }
      }
      desiredPins.set(s.stopKey, { kind: 'STOP', item: s, dispLat, dispLon });
    }
  }

  for (const [key, marker] of activeBrowseMarkersByKey.entries()) {
    if (!desiredPins.has(key)) {
      if (typeof marker.isPopupOpen === 'function' && marker.isPopupOpen()) continue;
      try { window.browseMapInstance.removeLayer(marker); } catch (e) {}
      activeBrowseMarkersByKey.delete(key);
    }
  }

  for (const [key, spec] of desiredPins.entries()) {
    if (activeBrowseMarkersByKey.has(key)) continue;
    const marker = createBrowseMapStopMarker(spec.item, spec.dispLat, spec.dispLon);
    activeBrowseMarkersByKey.set(key, marker);
  }
  renderTrafficOverlayOnMap(window.browseMapInstance);
}

async function recenterBrowseMapToGps(forceFreshFix = false) {
  triggerHaptic(12);
  autoStartCompassCone(true);
  if (forceFreshFix) {
    showToast(currentLang === 'zh' ? '🎯 正在更新 GPS 定位...' : '🎯 Acquiring live GPS fix...');
    await refreshGPS(3200, true);
  }
  updateUserMarkers();
  if (window.browseMapInstance && lastKnownPos) {
    window.browseMapInstance.flyTo([lastKnownPos.lat, lastKnownPos.lon], Math.max(window.browseMapInstance.getZoom() || 15, 16), { duration: 0.4 });
    setTimeout(() => userMarkerBrowse?.openTooltip(), 420);
  }
}

// ============================================================================
// 5. TRANSFER PLANNER MAP (window.xferMapInstance)
// ============================================================================
function setXferMapHeightPx(px, expanded = false) {
  const wrap = document.getElementById('xferMapWrapper');
  const btn = document.getElementById('xferMapExpandBtn');
  if (!wrap) return;
  isXferMapExpanded = expanded;
  wrap.style.height = `${px}px`;
  if (btn) {
    const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
    btn.innerText = expanded ? (isZh ? '⬌ 收起地圖' : '⬌ Collapse Map') : (isZh ? '⬍ 展開地圖' : '⬍ Full Map');
  }
  setTimeout(() => {
    if (window.xferMapInstance) {
      window.xferMapInstance.invalidateSize(false);
      fitTransferPlannerMapBounds();
    }
  }, 200);
}

function toggleXferMapFullScreen() {
  triggerHaptic(10);
  if (isXferMapExpanded) setXferMapHeightPx(220, false);
  else setXferMapHeightPx(Math.round(window.innerHeight * 0.62), true);
}

function initXferMapDragResize() {
  const handle = document.getElementById('xferMapDragHandle');
  const wrap = document.getElementById('xferMapWrapper');
  if (!handle || !wrap || handle._dragBound) return;
  handle._dragBound = true;
  let activePointerId = null, startY = 0, startH = 220, rafId = 0;

  const finishDrag = (e) => {
    if (activePointerId === null || (e && e.pointerId !== undefined && e.pointerId !== activePointerId)) return;
    const pid = activePointerId;
    activePointerId = null;
    if (typeof handle.releasePointerCapture === 'function') {
      try {
        if (typeof handle.hasPointerCapture !== 'function' || handle.hasPointerCapture(pid)) {
          handle.releasePointerCapture(pid);
        }
      } catch (err) {}
    }
    handle.style.cursor = 'grab';
    document.body?.classList?.remove('map-sheet-dragging');
    if (rafId && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(rafId); rafId = 0; }
    wrap.style.transition = 'height 0.25s ease';
    isXferMapExpanded = (wrap.offsetHeight || parseFloat(wrap.style.height) || 220) > 320;
    window.xferMapInstance?.invalidateSize(false);
  };

  handle.addEventListener('dragstart', (e) => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); });
  handle.addEventListener('pointerdown', (e) => {
    if (!e) return;
    if (e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    activePointerId = (e.pointerId !== undefined) ? e.pointerId : 1;
    startY = Number(e.clientY) || 0;
    startH = wrap.offsetHeight || parseFloat(wrap.style.height) || 220;
    wrap.style.transition = 'none';
    handle.style.cursor = 'grabbing';
    document.body?.classList?.add('map-sheet-dragging');
    if (typeof handle.setPointerCapture === 'function') {
      try { handle.setPointerCapture(activePointerId); } catch (err) {}
    }
  });
  handle.addEventListener('pointermove', (e) => {
    if (activePointerId === null || !e || (e.pointerId !== undefined && e.pointerId !== activePointerId)) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const vh = (typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0) ? window.innerHeight : 800;
    const newH = Math.max(140, Math.min(Math.round(vh * 0.72), Math.round(startH + ((Number(e.clientY) || 0) - startY))));
    wrap.style.height = `${newH}px`;
    if (!rafId) {
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          window.xferMapInstance?.invalidateSize(false);
        });
      } else {
        window.xferMapInstance?.invalidateSize(false);
      }
    }
  });
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initXferMapDragResize);
  } else {
    initXferMapDragResize();
  }
}

function handleXferMapSpotClick(e) {
  // Disable map tap-to-pin popup in Planner mode so panning/zooming never drops accidental pins.
  // Map tap-to-pin remains enabled outside Planner mode (e.g. Map Stop Browser).
  if (typeof currentView === 'undefined' || currentView === 'xfer') return;
  if (!window.xferMapInstance || !e?.latlng) return;
  const lat = Number(e.latlng.lat.toFixed(5));
  const lon = Number(e.latlng.lng.toFixed(5));
  if (!isValidRailOrFerryCoord(lat, lon)) return;
  triggerHaptic(10);

  if (xferMapClickedSpotMarker) {
    try { window.xferMapInstance.removeLayer(xferMapClickedSpotMarker); } catch (err) {}
    xferMapClickedSpotMarker = null;
  }

  let nearestHub = null;
  let nearestKm = 0.16;
  for (const h of (window.MULTI_MODAL_HUBS_DIRECTORY || [])) {
    const dKm = calculateDistanceKm(lat, lon, Number(h.lat), Number(h.lon));
    if (dKm < nearestKm) {
      nearestKm = dKm;
      nearestHub = h;
    }
  }

  const distTag = getStopDistrictTag({ stopName_e: '', latitude: lat, longitude: lon });
  const labelEn = nearestHub ? nearestHub.name_en : (distTag ? `Pinned Spot (${distTag})` : 'Pinned Map Spot');
  const labelZh = nearestHub ? (nearestHub.name_tc || nearestHub.name_en) : (distTag ? `地圖標記點 (${distTag})` : '地圖標記點');
  const pinLat = nearestHub ? Number(nearestHub.lat) : lat;
  const pinLon = nearestHub ? Number(nearestHub.lon) : lon;

  xferMapClickedSpotMarker = L.circleMarker([pinLat, pinLon], {
    radius: 8,
    fillColor: '#007AFF',
    color: '#FFFFFF',
    weight: 2.5,
    fillOpacity: 0.96
  }).addTo(window.xferMapInstance);

  const popupHtml = buildBrowseMapActionPopupHtml({
    stopKey: nearestHub ? nearestHub.id : `MAP_PIN_${pinLat}_${pinLon}`,
    nameEn: labelEn,
    nameTc: labelZh,
    routesText: nearestHub?.badge || '',
    lat: pinLat,
    lon: pinLon,
    nodeType: nearestHub ? (nearestHub.mode || 'MTR') : 'ADDRESS',
    hasStopRadar: false
  });
  xferMapClickedSpotMarker.bindPopup(popupHtml, { closeButton: true, offset: [0, -4] }).openPopup();
}

function clearTransferPlannerMapLayers() {
  xferDrawToken++;
  const map = window.xferMapInstance;
  if (map) {
    xferMapLayers.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
    if (xferMapClickedSpotMarker) {
      try { map.removeLayer(xferMapClickedSpotMarker); } catch (e) {}
    }
    try { map.closePopup(); } catch (e) {}
  }
  xferMapLayers = [];
  xferMapClickedSpotMarker = null;
}

window.clearTransferPlannerMapLayers = clearTransferPlannerMapLayers;
window.handleXferMapSpotClick = handleXferMapSpotClick;

function ensureXferMapInitialized() {
  if (typeof L === 'undefined') {
    if (typeof window.ensureLeafletLoaded === 'function') {
      window.ensureLeafletLoaded().then(() => {
        if (typeof L !== 'undefined' && typeof currentView !== 'undefined' && currentView === 'xfer') {
          ensureXferMapInitialized();
          if (typeof renderTransferPlannerView === 'function') {
            try { fitTransferPlannerMapBounds(); } catch (e) {}
          }
        }
      });
    }
    return null;
  }
  initXferMapDragResize();
  if (!window.xferMapInstance) {
    const startLat = (typeof lastKnownPos !== 'undefined' && lastKnownPos?.lat) ? lastKnownPos.lat : 22.302;
    const startLon = (typeof lastKnownPos !== 'undefined' && lastKnownPos?.lon) ? lastKnownPos.lon : 114.170;
    window.xferMapInstance = L.map('xfer-map-canvas', { zoomControl: false, preferCanvas: true }).setView([startLat, startLon], 12);
    window.attachStandardMapLayers(window.xferMapInstance);
    // Do NOT attach click/contextmenu tap-to-pin listeners on Planner map so panning/zooming stays clean.
    attachMapResizeObserver('xferMapWrapper', window.xferMapInstance, () => fitTransferPlannerMapBounds());
    bindTrafficRefreshOnMapMove(window.xferMapInstance);
  }
  updateUserMarkers();
  return window.xferMapInstance;
}

async function recenterXferMapToGps() {
  triggerHaptic(12);
  const map = ensureXferMapInitialized();
  if (!map) return;
  await refreshGPS(2500, false);
  updateUserMarkers();
  if (lastKnownPos && isValidRailOrFerryCoord(lastKnownPos.lat, lastKnownPos.lon)) {
    map.flyTo([lastKnownPos.lat, lastKnownPos.lon], 15, { duration: 0.35 });
  }
}

window.recenterXferMapToGps = recenterXferMapToGps;

let xferMapLegPolylines = [];
let activeFocusedLegIdx = -1;

function highlightPlannerMapLeg(legIdx = -1, rowEl = null) {
  const prevIdx = activeFocusedLegIdx;
  const toggleOff = (legIdx >= 0 && legIdx === prevIdx);
  activeFocusedLegIdx = toggleOff ? -1 : legIdx;

  try {
    document.querySelectorAll('.planner-step-transit.active-leg').forEach(el => el.classList.remove('active-leg'));
    if (!toggleOff && rowEl && rowEl.classList) {
      rowEl.classList.add('active-leg');
    }
  } catch (e) {}

  xferMapLegPolylines.forEach((entry, idx) => {
    if (!entry?.poly) return;
    const isFocused = (activeFocusedLegIdx === -1 || idx === activeFocusedLegIdx);
    const isHighlighted = (activeFocusedLegIdx >= 0 && idx === activeFocusedLegIdx);
    try {
      entry.poly.setStyle({
        weight: isHighlighted ? (entry.isFerry ? 6.5 : 8.0) : (entry.isFerry ? 4.5 : 5.5),
        opacity: isFocused ? 0.98 : 0.28
      });
      if (entry.casing) {
        entry.casing.setStyle({
          weight: isHighlighted ? (entry.isFerry ? 9.5 : 11.5) : (entry.isFerry ? 7 : 8.5),
          opacity: isFocused ? 0.92 : 0.25
        });
      }
      if (isHighlighted) {
        if (entry.casing && typeof entry.casing.bringToFront === 'function') entry.casing.bringToFront();
        if (typeof entry.poly.bringToFront === 'function') entry.poly.bringToFront();
      }
    } catch (e) {}
  });
  return activeFocusedLegIdx;
}

window.highlightPlannerMapLeg = highlightPlannerMapLeg;

function focusPlannerMapLeg(latA, lonA, latB = null, lonB = null, legIdx = -1, rowEl = null) {
  const map = window.xferMapInstance;
  const nextActive = (typeof legIdx === 'number' && legIdx >= 0) ? highlightPlannerMapLeg(legIdx, rowEl) : -1;
  if (!map || !isValidRailOrFerryCoord(latA, lonA)) return;
  try { map.invalidateSize(false); } catch (e) {}

  if (typeof legIdx === 'number' && legIdx >= 0 && nextActive === -1) {
    fitTransferPlannerMapBounds();
    return;
  }

  const legEntry = (typeof legIdx === 'number' && legIdx >= 0) ? xferMapLegPolylines[legIdx] : null;
  if (legEntry?.pts && legEntry.pts.length >= 2) {
    try {
      map.fitBounds(L.latLngBounds(legEntry.pts), {
        paddingTopLeft: [58, 58],
        paddingBottomRight: [58, 58],
        maxZoom: 16,
        animate: true
      });
      return;
    } catch (e) {}
  }

  if (latB !== null && lonB !== null && isValidRailOrFerryCoord(latB, lonB)) {
    const dKm = calculateDistanceKm(latA, lonA, latB, lonB);
    if (dKm >= 0.08) {
      map.fitBounds(L.latLngBounds([[latA, lonA], [latB, lonB]]), {
        paddingTopLeft: [54, 54],
        paddingBottomRight: [54, 54],
        maxZoom: 16,
        animate: true
      });
      return;
    }
  }
  map.flyTo([latA, lonA], Math.max(map.getZoom() || 14, 15), { duration: 0.35 });
}

window.focusPlannerMapLeg = focusPlannerMapLeg;

function fitTransferPlannerMapBounds() {
  const map = window.xferMapInstance;
  if (!map || !xferMapLayers.length) return;
  const wrap = document.getElementById('xferMapWrapper');
  if (wrap && (wrap.offsetWidth < 40 || wrap.offsetHeight < 40)) {
    requestAnimationFrame(() => fitTransferPlannerMapBounds());
    return;
  }
  try { map.invalidateSize(false); } catch (e) {}

  const pts = [];
  xferMapLayers.forEach(l => {
    if (typeof l.getLatLng === 'function') pts.push(l.getLatLng());
    else if (typeof l.getLatLngs === 'function') pts.push(...l.getLatLngs().flat(2));
  });
  if (pts.length >= 2) {
    try {
      map.fitBounds(L.latLngBounds(pts), {
        paddingTopLeft: [54, 56],
        paddingBottomRight: [54, 58],
        maxZoom: 16,
        animate: false
      });
    } catch (e) {}
  } else if (pts.length === 1) {
    map.setView(pts[0], 15, { animate: false });
  }
}

function drawTransferCorridorOnMap(spec, selectedCard) {
  const map = ensureXferMapInitialized();
  if (!map) return;

  try { map.invalidateSize(false); } catch (e) {}

  const myDrawToken = ++xferDrawToken;

  xferMapLayers.forEach(l => { try { map.removeLayer(l); } catch (e) {} });
  xferMapLayers = [];
  xferMapLegPolylines = [];
  activeFocusedLegIdx = -1;
  if (xferMapClickedSpotMarker) {
    try { map.removeLayer(xferMapClickedSpotMarker); } catch (e) {}
    xferMapClickedSpotMarker = null;
  }

  if (!spec?.fromMeta || !spec?.toMeta) return;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  const addPin = (lat, lon, label, bgCol, fgCol = '#FFFFFF', zOff = 700, placement = 'up') => {
    if (!isValidRailOrFerryCoord(lat, lon)) return;
    const isDown = (placement === 'down');
    const pinTransform = isDown ? 'translate(-50%, 30%)' : 'translate(-50%, -125%)';
    const dotHtml = `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:${bgCol};border:2.5px solid #FFFFFF;box-shadow:0 1px 5px rgba(0,0,0,0.42);"></div>`;
    const pillHtml = `<div style="position:absolute;left:0;top:0;transform:${pinTransform};display:inline-block;max-width:165px;overflow:hidden;text-overflow:ellipsis;padding:3px 9px;border-radius:999px;background:${bgCol};color:${fgCol};border:2px solid #FFFFFF;font-size:0.65rem;font-weight:700;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,0.28);pointer-events:auto;">${escapeHtml(label)}</div>`;
    const m = L.marker([lat, lon], {
      icon: L.divIcon({
        className: '',
        html: `<div style="position:relative;width:0;height:0;">${dotHtml}${pillHtml}</div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      zIndexOffset: zOff
    }).addTo(map);
    m.bindTooltip(label, {
      direction: isDown ? 'bottom' : 'top',
      offset: isDown ? [0, 24] : [0, -24],
      className: 'kmb-map-stop-label'
    });
    xferMapLayers.push(m);
  };

  const drawTransitLeg = (group, bStop, aStop, fallbackColor = '#007AFF') => {
    const stopPts = sliceRouteStopPoints(group, bStop, aStop);
    const rawPts = stopPts.map(x => x.pt);
    const isBus = !group?.mode || group.mode === 'BUS';
    const allGroupStops = isBus && typeof getStopsForGroup === 'function' ? getStopsForGroup(group, bStop?.stopKey) : [];
    const cachedRoad = isBus ? getCachedBusRoutePolyline(group, allGroupStops) : null;
    const snappedSlice = cachedRoad ? sliceRoadPolylineBetweenStops(cachedRoad, bStop, aStop) : null;
    const pts = (snappedSlice && snappedSlice.length >= 2) ? snappedSlice : rawPts;
    const col = group?.colorHex || window.__GET_ROUTE_COLOR_HEX__(group?.mode, group?.company, group?.routeNo) || fallbackColor;
    const isFerry = group?.mode === 'FERRY';
    if (pts.length >= 2) {
      // Crisp white casing under transit line for high legibility on OSM maps
      const casing = L.polyline(pts, {
        color: '#FFFFFF',
        weight: isFerry ? 7 : 8.5,
        opacity: 0.88,
        dashArray: isFerry ? '10, 7' : null,
        lineJoin: 'round',
        lineCap: 'round',
        interactive: false
      }).addTo(map);
      xferMapLayers.push(casing);

      const poly = L.polyline(pts, {
        color: col,
        weight: isFerry ? 4.5 : 5.5,
        opacity: 0.96,
        dashArray: isFerry ? '10, 7' : null,
        lineJoin: 'round',
        lineCap: 'round'
      }).addTo(map);
      const badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(group) : (group?.routeNo || '');
      if (badge) poly.bindTooltip(`${badge}`, { sticky: true, className: 'kmb-map-stop-label' });
      xferMapLayers.push(poly);
      const legRecord = { poly, casing, pts, isFerry, color: col };
      xferMapLegPolylines.push(legRecord);

      // Upgrade straight-chord bus leg asynchronously to road-snapped fixed bus geometry
      if (isBus && !snappedSlice && allGroupStops.length >= 2) {
        fetchRoadSnappedBusPolyline(group, allGroupStops).then((roadCoords) => {
          if (!roadCoords || myDrawToken !== xferDrawToken || !map.hasLayer(poly)) return;
          const sliced = sliceRoadPolylineBetweenStops(roadCoords, bStop, aStop);
          if (sliced && sliced.length >= 2) {
            casing.setLatLngs(sliced);
            poly.setLatLngs(sliced);
            legRecord.pts = sliced;
          }
        });
      }

      stopPts.forEach((entry, idx) => {
        const isEndpoint = (idx === 0 || idx === stopPts.length - 1);
        const dot = L.circleMarker(entry.pt, {
          radius: isEndpoint ? 5.6 : 3.4,
          fillColor: '#FFFFFF',
          color: col,
          weight: isEndpoint ? 2.8 : 2.0,
          fillOpacity: 1
        }).addTo(map);
        if (entry.stop) {
          dot.bindTooltip(getStopName(entry.stop), { direction: 'top', offset: [0, -6], className: 'kmb-map-stop-label' });
        }
        xferMapLayers.push(dot);
      });
    }
    return rawPts;
  };

  const originPt = [spec.fromMeta.lat, spec.fromMeta.lon];
  const destPt = [spec.toMeta.lat, spec.toMeta.lon];
  const origLabel = stripPlatformCodeFromDisplay(isZh && spec.fromMeta.name_tc ? spec.fromMeta.name_tc : spec.fromMeta.name_en);
  const destLabel = stripPlatformCodeFromDisplay(isZh && spec.toMeta.name_tc ? spec.toMeta.name_tc : spec.toMeta.name_en);

  addPin(originPt[0], originPt[1], origLabel || (isZh ? '起點' : 'Origin'), '#007AFF', '#FFFFFF', 830, 'down');
  addPin(destPt[0], destPt[1], destLabel || (isZh ? '終點' : 'Dest'), '#DC2626', '#FFFFFF', 840, 'down');

  const pushWalk = (pA, pB, isBike = false, label = '') => {
    const wl = drawWalkingLeg(map, pA, pB, { isBike, label, drawToken: myDrawToken });
    if (wl) xferMapLayers.push(wl);
  };

  const formatWalkLabel = (distM, isBike, exitObj = null, isTransfer = false) => {
    if (!distM && !exitObj?.ref) return '';
    const verb = isTransfer
      ? (isZh ? '步行轉乘' : 'Transfer walk')
      : (isBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk'));
    const exTxt = exitObj?.ref ? (isZh ? ` (${exitObj.ref}出口)` : ` (Exit ${exitObj.ref})`) : '';
    return `${verb}${distM ? ` ${distM}m` : ''}${exTxt}`;
  };

  const addExitBadgePin = (exitObj) => {
    if (!exitObj?.ref) return;
    const pt = getStopLatLon(exitObj);
    if (!pt) return;
    const lbl = isZh ? `${exitObj.ref}出口` : `Exit ${exitObj.ref}`;
    const dot = L.circleMarker(pt, {
      radius: 5.5,
      fillColor: '#6D28D9',
      color: '#FFFFFF',
      weight: 2.2,
      fillOpacity: 1
    }).addTo(map);
    dot.bindTooltip(isZh ? (exitObj.name_tc || lbl) : (exitObj.name_en || lbl), {
      direction: 'top',
      offset: [0, -6],
      className: 'kmb-map-stop-label'
    });
    xferMapLayers.push(dot);
  };

  if (selectedCard?.type === 'WALK_BIKE') {
    const wb = selectedCard.item;
    pushWalk(originPt, destPt, wb.isBike, `${wb.isBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${wb.distM}m (~${wb.totalMins}m)`);
  } else if (selectedCard?.type === 'DIRECT') {
    const dp = selectedCard.item;
    const pts = drawTransitLeg(dp.group, dp.boardStopObj, dp.alightStopObj, '#007AFF');
    const boardPt = getStopLatLon(dp.accessExitObj) || pts[0] || getStopLatLon(dp.boardStopObj);
    const alightPt = getStopLatLon(dp.egressExitObj) || pts[pts.length - 1] || getStopLatLon(dp.alightStopObj);

    if (dp.accessExitObj?.ref) addExitBadgePin(dp.accessExitObj);
    if (dp.egressExitObj?.ref) addExitBadgePin(dp.egressExitObj);

    pushWalk(originPt, boardPt, dp.accessByBike, formatWalkLabel(dp.accessWalkDistM, dp.accessByBike, dp.accessExitObj));
    if (alightPt && calculateDistanceKm(alightPt[0], alightPt[1], destPt[0], destPt[1]) >= 0.10) {
      const alightExSuffix = dp.egressExitObj?.ref ? (isZh ? ` (${dp.egressExitObj.ref}出口)` : ` (Exit ${dp.egressExitObj.ref})`) : '';
      addPin(alightPt[0], alightPt[1], `↓ ${getStopName(dp.alightStopObj)}${alightExSuffix}`, '#475569', '#FFFFFF', 745, 'up');
    }
    pushWalk(alightPt, destPt, dp.egressByBike, formatWalkLabel(dp.egressWalkDistM, dp.egressByBike, dp.egressExitObj));
  } else if (selectedCard?.type === 'XFER') {
    const cor = selectedCard.item;
    const node = cor.xferStopNodes?.[activeXferStopNodeIdx] || cor.xferStopNodes?.[0];
    if (node) {
      const p1 = drawTransitLeg(cor.leg1Group, cor.board1StopObj, node.alight1StopObj, '#007AFF');
      const firstBoardPt = getStopLatLon(cor.accessExitObj) || p1[0] || getStopLatLon(cor.board1StopObj);
      if (cor.accessExitObj?.ref) addExitBadgePin(cor.accessExitObj);
      pushWalk(originPt, firstBoardPt, cor.accessByBike, formatWalkLabel(cor.accessWalkDistM, cor.accessByBike, cor.accessExitObj));

      const rawA1Pt = p1[p1.length - 1] || getStopLatLon(node.alight1StopObj);
      const rawB2Pt = getStopLatLon(node.board2StopObj);
      const a1Pt = (node.xferExitSide === 'alight' && getStopLatLon(node.xferExitObj)) || rawA1Pt;
      const b2Pt = (node.xferExitSide === 'board' && getStopLatLon(node.xferExitObj)) || rawB2Pt;
      if (node.xferExitObj?.ref) addExitBadgePin(node.xferExitObj);
      pushWalk(a1Pt, b2Pt, false, formatWalkLabel(node.walkDistM, false, node.xferExitObj, true));
      const xfer1ExSuffix = node.xferExitObj?.ref ? (isZh ? ` (${node.xferExitObj.ref}出口)` : ` (Exit ${node.xferExitObj.ref})`) : '';
      addPin(node.lat, node.lon, `⇄ ${getStopName(node.board2StopObj)}${xfer1ExSuffix}`, '#D97706', '#FFFFFF', 760, 'up');

      const leg2EndObj = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
      const p2 = drawTransitLeg(cor.leg2Group, node.board2StopObj, leg2EndObj, '#16A34A');

      let lastTransitEndPt = p2[p2.length - 1] || getStopLatLon(leg2EndObj);
      let finalAlightObj = leg2EndObj;

      (cor.leg3Options || []).forEach(l3 => {
        const rawPrevPt = lastTransitEndPt || getStopLatLon(l3.prevAlightStopObj);
        const rawB3Pt = getStopLatLon(l3.boardStopObj);
        const prevPt = (l3.xferExitSide === 'alight' && getStopLatLon(l3.xferExitObj)) || rawPrevPt;
        const b3Pt = (l3.xferExitSide === 'board' && getStopLatLon(l3.xferExitObj)) || rawB3Pt;
        if (l3.xferExitObj?.ref) addExitBadgePin(l3.xferExitObj);
        pushWalk(prevPt, b3Pt, false, formatWalkLabel(l3.walkDistM, false, l3.xferExitObj, true));
        const l3ExSuffix = l3.xferExitObj?.ref ? (isZh ? ` (${l3.xferExitObj.ref}出口)` : ` (Exit ${l3.xferExitObj.ref})`) : '';
        if (rawB3Pt) addPin(rawB3Pt[0], rawB3Pt[1], `⇄ ${getStopName(l3.boardStopObj)}${l3ExSuffix}`, '#6366F1', '#FFFFFF', 750, 'up');

        const p3 = drawTransitLeg(l3.group, l3.boardStopObj, l3.alightStopObj, '#6366F1');
        lastTransitEndPt = p3[p3.length - 1] || getStopLatLon(l3.alightStopObj);
        finalAlightObj = l3.alightStopObj || finalAlightObj;
      });

      const finalEgressStartPt = getStopLatLon(cor.egressExitObj) || lastTransitEndPt || getStopLatLon(cor.alight2StopObj);
      if (cor.egressExitObj?.ref) addExitBadgePin(cor.egressExitObj);
      if (finalEgressStartPt && calculateDistanceKm(finalEgressStartPt[0], finalEgressStartPt[1], destPt[0], destPt[1]) >= 0.10) {
        const egressExSuffix = cor.egressExitObj?.ref ? (isZh ? ` (${cor.egressExitObj.ref}出口)` : ` (Exit ${cor.egressExitObj.ref})`) : '';
        addPin(finalEgressStartPt[0], finalEgressStartPt[1], `↓ ${getStopName(finalAlightObj || cor.alight2StopObj)}${egressExSuffix}`, '#475569', '#FFFFFF', 745, 'up');
      }
      pushWalk(finalEgressStartPt, destPt, cor.egressByBike, formatWalkLabel(cor.egressWalkDistM, cor.egressByBike, cor.egressExitObj));
    }
  }

  fitTransferPlannerMapBounds();
  renderTrafficOverlayOnMap(map);
  xferMapLegPolylines.forEach((entry) => {
    try {
      if (entry.casing?.bringToFront) entry.casing.bringToFront();
      if (entry.poly?.bringToFront) entry.poly.bringToFront();
    } catch (e) {}
  });
}
