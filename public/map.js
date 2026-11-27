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
  // Strictly <= 150m corridor radius on active bus routes so off-route districts and parallel arterials never leak onto the route map.
  const maxRadiusKm = 0.15;
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
    const segPad = 0.0020;
    if (det.lat < Math.min(aLat, bLat) - segPad || det.lat > Math.max(aLat, bLat) + segPad) continue;
    if (det.lon < Math.min(aLon, bLon) - segPad || det.lon > Math.max(aLon, bLon) + segPad) continue;

    const dLatM = (bLat - aLat) * 111111;
    const dLonM = (bLon - aLon) * 111111 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    const segLenM = Math.hypot(dLatM, dLonM);
    if (segLenM < 5) continue;

    if (isLocalArterial && segLenM >= 1200) continue;

    if (i === 0 && typeof pointToSegmentDistanceKm === 'function') {
      const proj = pointToSegmentDistanceKm(det.lat, det.lon, aLat, aLon, bLat, bLon);
      if (proj && typeof proj === 'object' && proj.t < -0.02) continue;
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
        Boolean(corridorMeta.hasHighwaySpan)
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
    const tipTxt = sanitizeBottleneckLabel(`${cleanRoadName} · ${boundMeta.arrowGlyph} ${boundMeta.fullLabel} · ${d.spd} km/h${d.camKey ? ' 📷' : ''}`);
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
      if (hasExplicitDir && Number.isFinite(proj.segBrg) && Number.isFinite(bearingDeg)) {
        if (_mapAngDiffDeg(bearingDeg, proj.segBrg) > MAX_ROUTE_CAM_BEARING_DIFF) continue;
      }

      matchedRouteCams.push({
        cam,
        distKm: proj.distKm,
        alongKm: proj.alongKm,
        bearingDeg
      });
    }

    matchedRouteCams.sort((a, b) => (a.alongKm - b.alongKm) || (a.distKm - b.distKm));
    const placedRouteCamPts = [];
    const MIN_ROUTE_CAM_PX = zoom >= 16 ? 20 : 28;
    for (let i = 0; i < matchedRouteCams.length; i++) {
      const { cam, alongKm, bearingDeg } = matchedRouteCams[i];
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
      if (typeof camMarker.bindTooltip === 'function') {
        const distLbl = alongKm < 1 ? `${Math.round(alongKm * 1000)}m` : `${alongKm.toFixed(1)}km`;
        camMarker.bindTooltip(`📷 ${cleanDesc}${compassTxt ? ` (${compassTxt})` : ''} · ${distLbl}`, {
          direction: 'top',
          offset: [0, -10],
          className: 'kmb-map-stop-label'
        });
      }
      if (typeof camMarker.on === 'function') {
        camMarker.on('click', (ev) => {
          if (ev?.originalEvent?.stopPropagation) ev.originalEvent.stopPropagation();
          if (typeof window.openTrafficCameraModal === 'function') {
            window.openTrafficCameraModal({ ...cam, bearingDeg });
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
  const activeIdx = (typeof detailExpandedStopIdx === 'number' && detailExpandedStopIdx >= 0) ? detailExpandedStopIdx : 0;
  const exitIdx = _resolveActiveExitStopIdx(stops, activeIdx);
  if (currentDetailCorridorMeta && typeof window.sliceForwardPolylineFromStop === 'function') {
    currentDetailCorridorMeta = {
      ...currentDetailCorridorMeta,
      activeStopIdx: activeIdx,
      exitStopIdx: exitIdx,
      forwardCoords: window.sliceForwardPolylineFromStop(currentDetailRoadCoords, stops, activeIdx, 12.0, exitIdx),
      forwardCameraCoords: window.sliceForwardPolylineFromStop(currentDetailRoadCoords, stops, activeIdx, 45.0, exitIdx)
    };
  }
  const routeAccent = detailRouteGroup?.colorHex ||
    (typeof window.__GET_ROUTE_COLOR_HEX__ === 'function'
      ? window.__GET_ROUTE_COLOR_HEX__(detailRouteGroup?.mode, detailRouteGroup?.company, detailRouteGroup?.routeNo)
      : '#FF3B30');
  if (detailPolylineLayer) {
    try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {}
  }
  detailPolylineLayer = buildDetailBusPolylineLayer(currentDetailRoadCoords, stops, activeIdx, routeAccent);
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
  const liveDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const solidRouteFallback = routeAccent || '#2563eb';
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
        allowNlbScheduledFallback: true
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
        color: seg.color || '#16a34a',
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
        const flowTxt = seg.tier === 'CONGESTED'
          ? (isZh ? '擠塞' : 'Heavy')
          : (seg.tier === 'MODERATE'
            ? (isZh ? '緩慢' : 'Slow')
            : (isZh ? '暢順' : 'Flowing'));
        busLine.bindTooltip(
          `🚌 ${isZh ? '巴士車速推算' : 'Bus Speed Est.'} · ${flowTxt} (${fromNm} → ${toNm})`,
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
    const speedGeoJson = window.buildRouteSpeedGeoJson(coords, liveDetectors, {
      isRoadSnapped,
      hasHighwaySpan,
      stops: Array.isArray(stops) ? stops : [],
      noDataColor: solidRouteFallback,
      maxMicroStepKm: 0.15
    });
    window.__LAST_DETAIL_SPEED_GEOJSON__ = speedGeoJson;

    if (speedGeoJson && Array.isArray(speedGeoJson.features) && speedGeoJson.features.length > 0) {
      // High-contrast dark casing (#0f172a, weight 7, opacity 0.85, _zRank: 0) strictly underneath route segments
      // so solid vivid route / TD speed top strokes (_zRank: 1) always render cleanly on top of the casing.
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
            // Solid vivid route top stroke (routeAccent or #2563eb, weight: 4, opacity: 0.95) on unmonitored local/airport roads
            return {
              color: solidRouteFallback,
              weight: 4,
              opacity: 0.95,
              dashArray: null,
              smoothFactor: 1.5,
              lineJoin: 'round',
              lineCap: 'round',
              _zRank: 1
            };
          }
          // TD ground-truth hardware sensor speed segment: solid, crisp, high-opacity polyline
          return {
            color: p.color || solidRouteFallback,
            weight: 4.5,
            opacity: 0.92,
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
          if (!p.detectorId) return;
          const cleanName = sanitizeBottleneckLabel(isZh ? (p.roadTc || p.roadEn) : (p.roadEn || p.roadTc)) || (isZh ? '實時路況' : 'Live Road');
          if (typeof lyr.bindTooltip === 'function') {
            lyr.bindTooltip(`${cleanName} · ${Math.round(Number(p.speedKmh))} km/h`, { sticky: true, className: 'kmb-map-stop-label' });
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
      appendBusSpeedOverlay(speedGeoJson);
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
    window.mapInstance.on('moveend', () => {
      if (_detailFocusedAwayFromStop) updateDetailBackToStopPill(false);
    });
    attachMapResizeObserver('map-container', window.mapInstance);
    bindTrafficRefreshOnMapMove(window.mapInstance);
  }
  initDetailMapSheetDragResize();
  try { window.mapInstance.invalidateSize(false); } catch (e) {}

  if (detailPolylineLayer) { try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {} detailPolylineLayer = null; }
  Object.values(mapMarkers).forEach(m => { try { window.mapInstance.removeLayer(m); } catch (e) {} });
  mapMarkers = {};

  const stops = _getDetailStopsForGroup(group);
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
    window.__DETAIL_BUS_SPEED_SEGMENTS__ = [];
  }
  const hasHighwaySpan = isBusRoute && _stopsHaveHighwaySpan(stops);
  const exitStopIdx = _resolveActiveExitStopIdx(stops, activeStopIdx);
  const initialForwardCoords = (isBusRoute && typeof window.sliceForwardPolylineFromStop === 'function')
    ? window.sliceForwardPolylineFromStop(currentDetailRoadCoords, stops, activeStopIdx, 12.0, exitStopIdx)
    : currentDetailRoadCoords;
  const initialForwardCameraCoords = (isBusRoute && typeof window.sliceForwardPolylineFromStop === 'function')
    ? window.sliceForwardPolylineFromStop(currentDetailRoadCoords, stops, activeStopIdx, 45.0, exitStopIdx)
    : initialForwardCoords;
  currentDetailCorridorMeta = {
    groupKey: group?.key || '',
    mode: group?.mode || 'BUS',
    isBusRoute,
    hasHighwaySpan,
    isRoadSnapped: Boolean(cachedRoadCoords && cachedRoadCoords.length >= 2),
    activeStopIdx,
    exitStopIdx,
    coords: currentDetailRoadCoords,
    forwardCoords: initialForwardCoords,
    forwardCameraCoords: initialForwardCameraCoords
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
    _bringLayerGroupToFront(detailPolylineLayer);
  } else if (polyPts.length >= 2) {
    detailPolylineLayer = isBusRoute
      ? buildDetailBusPolylineLayer(polyPts, stops, activeStopIdx, routeAccent).addTo(window.mapInstance)
      : L.polyline(polyPts, lineStyle).addTo(window.mapInstance);
    if (isBusRoute) _bringLayerGroupToFront(detailPolylineLayer);
    if (isBusRoute) {
      fetchRoadSnappedBusPolyline(group, stops).then((roadCoords) => {
        if (!roadCoords || myGeomToken !== _detailGeomToken || !window.mapInstance) return;
        if (typeof detailRouteGroup !== 'undefined' && detailRouteGroup?.key !== group.key) return;
        const curActive = (typeof detailExpandedStopIdx === 'number' && detailExpandedStopIdx >= 0) ? detailExpandedStopIdx : activeStopIdx;
        const curExit = _resolveActiveExitStopIdx(stops, curActive);
        if (detailPolylineLayer) {
          try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {}
        }
        currentDetailRoadCoords = roadCoords;
        const snappedForward = (typeof window.sliceForwardPolylineFromStop === 'function')
          ? window.sliceForwardPolylineFromStop(roadCoords, stops, curActive, 12.0, curExit)
          : roadCoords;
        const snappedForwardCam = (typeof window.sliceForwardPolylineFromStop === 'function')
          ? window.sliceForwardPolylineFromStop(roadCoords, stops, curActive, 45.0, curExit)
          : snappedForward;
        currentDetailCorridorMeta = {
          groupKey: group?.key || '',
          mode: group?.mode || 'BUS',
          isBusRoute: true,
          hasHighwaySpan,
          isRoadSnapped: true,
          activeStopIdx: curActive,
          exitStopIdx: curExit,
          coords: roadCoords,
          forwardCoords: snappedForward,
          forwardCameraCoords: snappedForwardCam
        };
        detailPolylineLayer = buildDetailBusPolylineLayer(roadCoords, stops, curActive, routeAccent).addTo(window.mapInstance);
        _bringLayerGroupToFront(detailPolylineLayer);
        // Re-run strict forward-only route traffic & camera filtering against the exact road-snapped polyline
        renderTrafficOverlayOnMap(window.mapInstance, true);
        if (typeof window.refreshStopByStopTrafficUI === 'function') {
          window.refreshStopByStopTrafficUI();
        }
        if (isBusRoute) {
          syncDetailRouteBusSpeedSegments(group, stops);
        }
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
    const isExit = (exitStopIdx !== null && idx === exitStopIdx);
    const bgCol = isAct ? routeAccent : (isExit ? '#16a34a' : (isLight ? '#FFFFFF' : '#2C2C2E'));
    const fgCol = (isAct || isExit) ? '#FFFFFF' : (isLight ? '#1C1C1E' : '#FFFFFF');
    const bdrCol = (isAct || isExit) ? '#FFFFFF' : routeAccent;
    const pinSz = (isAct || isExit) ? 22 : 16;
    const m = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'custom-stop-icon',
        html: `<div style="width:${pinSz}px;height:${pinSz}px;background:${bgCol};color:${fgCol};border:2.5px solid ${bdrCol};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.56rem;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${idx + 1}</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
      }),
      zIndexOffset: isAct ? 650 : (isExit ? 620 : 320)
    }).addTo(window.mapInstance);
    const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
    const exitSuffix = isExit ? (isZh ? ' · 下車站' : ' · Exit') : '';
    m.bindTooltip(`${idx + 1}. ${getStopName(s)}${exitSuffix}`, { direction: 'top', offset: [0, -8], className: 'kmb-map-stop-label' });
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
  if (isBusRoute) {
    syncDetailRouteBusSpeedSegments(group, stops);
  }
}

function highlightActiveStopMarkerOnMap(activeIdx) {
  if (!window.mapInstance || !detailRouteGroup) return;
  const stops = _getDetailStopsForGroup(detailRouteGroup);
  const exitStopIdx = _resolveActiveExitStopIdx(stops, activeIdx);
  const isLight = document.documentElement.classList.contains('light-mode');
  const routeAccent = detailRouteGroup?.colorHex || window.__GET_ROUTE_COLOR_HEX__(detailRouteGroup?.mode, detailRouteGroup?.company, detailRouteGroup?.routeNo);
  const isBusRoute = !detailRouteGroup?.mode || detailRouteGroup.mode === 'BUS';
  if (isBusRoute && Array.isArray(currentDetailRoadCoords) && currentDetailRoadCoords.length >= 2) {
    if (currentDetailCorridorMeta) {
      const fwdCoords = (typeof window.sliceForwardPolylineFromStop === 'function')
        ? window.sliceForwardPolylineFromStop(currentDetailRoadCoords, stops, activeIdx, 12.0, exitStopIdx)
        : currentDetailRoadCoords;
      const fwdCamCoords = (typeof window.sliceForwardPolylineFromStop === 'function')
        ? window.sliceForwardPolylineFromStop(currentDetailRoadCoords, stops, activeIdx, 45.0, exitStopIdx)
        : fwdCoords;
      currentDetailCorridorMeta = {
        ...currentDetailCorridorMeta,
        activeStopIdx: activeIdx,
        exitStopIdx,
        forwardCoords: fwdCoords,
        forwardCameraCoords: fwdCamCoords
      };
    }
    if (detailPolylineLayer) {
      try { window.mapInstance.removeLayer(detailPolylineLayer); } catch (e) {}
    }
    detailPolylineLayer = buildDetailBusPolylineLayer(currentDetailRoadCoords, stops, activeIdx, routeAccent).addTo(window.mapInstance);
    _bringLayerGroupToFront(detailPolylineLayer);
    renderTrafficOverlayOnMap(window.mapInstance, true);
  }
  Object.entries(mapMarkers).forEach(([idxStr, m]) => {
    const idx = Number(idxStr);
    const isAct = (idx === activeIdx);
    const isExit = (exitStopIdx !== null && idx === exitStopIdx);
    const bgCol = isAct ? routeAccent : (isExit ? '#16a34a' : (isLight ? '#FFFFFF' : '#2C2C2E'));
    const fgCol = (isAct || isExit) ? '#FFFFFF' : (isLight ? '#1C1C1E' : '#FFFFFF');
    const bdrCol = (isAct || isExit) ? '#FFFFFF' : routeAccent;
    const pinSz = (isAct || isExit) ? 22 : 16;
    m.setIcon(L.divIcon({
      className: 'custom-stop-icon',
      html: `<div style="width:${pinSz}px;height:${pinSz}px;background:${bgCol};color:${fgCol};border:2.5px solid ${bdrCol};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.56rem;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${idx + 1}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    }));
    if (typeof m.setZIndexOffset === 'function') m.setZIndexOffset(isAct ? 650 : (isExit ? 620 : 320));
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

function getGlobalTrafficLaneOffsetMeters(zoom = 13) {
  const z = Number.isFinite(Number(zoom)) ? Number(zoom) : 13;
  // Tight HK keep-left offset: 1.5m at z >= 15 and 2.5m at z < 15 so opposite carriageways stay strictly parallel and never cross
  return z >= 15 ? 1.5 : 2.5;
}

function getGlobalTrafficSpeedColorHex(spd, fallback = '#3b82f6') {
  if (spd !== null && spd !== undefined && Number.isFinite(Number(spd))) {
    const n = Number(spd);
    if (n < 20) return '#ef4444';
    if (n <= 40) return '#f59e0b';
    return '#22c55e';
  }
  const fb = String(fallback || '').toLowerCase();
  if (fb === '#16a34a') return '#22c55e';
  if (fb === '#dc2626') return '#ef4444';
  return fallback || '#3b82f6';
}

function _normalizeGlobalSpeedTier(spd, tierRaw = '') {
  if (spd !== null && spd !== undefined && Number.isFinite(Number(spd))) {
    const n = Number(spd);
    if (n < 20) return 'CONGESTED';
    if (n <= 40) return 'MODERATE';
    return 'SMOOTH';
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

    staged.push({
      feat,
      p: { ...p, isGapBridge: Boolean(p.isGapBridge), opacity: p.isGapBridge ? 0.55 : 0.95 },
      roadCore: roadCoreOf(p.roadEn),
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
  if (detPool.length >= 2) {
    const byRoad = new Map();
    for (let i = 0; i < detPool.length; i++) {
      const d = detPool[i];
      if (!d || !Number.isFinite(Number(d.lat)) || !Number.isFinite(Number(d.lon))) continue;
      if (!Number.isFinite(Number(d.rot))) continue;
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
        if (isGapBridge && tierA !== tierB) continue;

        const avgSpd = (Number.isFinite(Number(a.spd)) && Number.isFinite(Number(bestNext.spd)))
          ? Math.round((Number(a.spd) + Number(bestNext.spd)) * 0.5)
          : (a.spd ?? bestNext.spd ?? null);
        const rawBridgeCoords = [[aLon, aLat], [bLon, bLat]];
        const finalCoords = _applyKeepLeftOffsetAlongCoords(rawBridgeCoords, offsetM);
        existingPairKeys.add(pairCoordSig);
        if (pairIdKey) existingPairKeys.add(pairIdKey);

        const minLat = Math.min(finalCoords[0][1], finalCoords[1][1]);
        const maxLat = Math.max(finalCoords[0][1], finalCoords[1][1]);
        const minLon = Math.min(finalCoords[0][0], finalCoords[1][0]);
        const maxLon = Math.max(finalCoords[0][0], finalCoords[1][0]);

        staged.push({
          feat: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: finalCoords },
            properties: {}
          },
          p: {
            id: a.id || '',
            toId: bestNext.id || '',
            roadEn: a.roadEn || '',
            roadTc: a.roadTc || a.roadEn || '',
            dir: a.dir || '',
            rot: aRot,
            rotA: aRot,
            rotB: Number(bestNext.rot) || aRot,
            spd: avgSpd,
            occ: a.occ || 0,
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
          const spdTxt = (p.spd !== null && p.spd !== undefined && Number.isFinite(Number(p.spd)))
            ? `${Math.round(Number(p.spd))} km/h`
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
      if (typeof m.bindTooltip === 'function') {
        m.bindTooltip(`📷 ${cleanDesc}${orientTag ? ` (${orientTag})` : ''}`, { direction: 'top', offset: [0, -10], className: 'kmb-map-stop-label' });
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
            ? window.findNearestMatchingDetectorForCamera(cam, detectors)
            : (detectors.find(x => x.id === cam.key || x.camKey === cam.key) || null);
          if (matchedDet && typeof window.openTrafficDecisionModal === 'function') {
            window.openTrafficDecisionModal(matchedDet.id, _findOppositeTrafficDetectorId(matchedDet), '', false, { ...cam, bearingDeg });
          } else if (typeof window.openTrafficCameraModal === 'function') {
            window.openTrafficCameraModal({ ...cam, bearingDeg });
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

function _drawBusSpeedSegmentsIntoLayer(segments, layerGroup, routeLabel = '', drawnStretchMap = null, drawOpts = {}) {
  if (!layerGroup || typeof L === 'undefined' || !Array.isArray(segments) || !segments.length) return 0;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const tdDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const tdSpeedGeo = window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || window.__LAST_GLOBAL_SPEED_GEOJSON__ || null;
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
      allowNlbScheduledFallback: true
    });
    if (typeof drawOpts?.onAggregateResult === 'function') {
      drawOpts.onAggregateResult(agg);
    }
    const corridors = Array.isArray(agg?.corridors) ? agg.corridors : [];
    let drawn = 0;
    for (let i = 0; i < corridors.length; i++) {
      const c = corridors[i];
      if (!c || !Array.isArray(c.coords) || c.coords.length < 2) continue;
      const drawCoords = laneOffsetM > 0 ? _applyKeepLeftOffsetLatLngs(c.coords, laneOffsetM) : c.coords;
      const strokeColor = c.color || (typeof getBusSpeedLayerColorHex === 'function' ? getBusSpeedLayerColorHex(c.tier, c.speedKmh) : '#16a34a');

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
        const routesTag = routeLabel || (Array.isArray(c.routes) && c.routes.length ? c.routes.slice(0, 3).join('/') : (c.routeLabel || ''));
        const prefix = routesTag ? `${routesTag} · ` : '';
        const rawFrom = isZh ? (c.fromNameTc || c.fromNameEn) : (c.fromNameEn || c.fromNameTc);
        const rawTo = isZh ? (c.toNameTc || c.toNameEn) : (c.toNameEn || c.toNameTc);
        const fromNm = sanitizeBottleneckLabel(rawFrom || `Stop ${c.fromSeq || ((c.fromIdx || 0) + 1)}`);
        const toNm = sanitizeBottleneckLabel(rawTo || `Stop ${c.toSeq || ((c.toIdx || 0) + 2)}`);
        const flowTxt = c.tier === 'CONGESTED'
          ? (isZh ? '擠塞' : 'Heavy')
          : (c.tier === 'MODERATE'
            ? (isZh ? '緩慢' : 'Slow')
            : (isZh ? '暢順' : 'Flowing'));
        const schedNote = c.isScheduledFallback ? (isZh ? ' · 班次推算' : ' · headway est.') : '';
        line.bindTooltip(
          `🚌 ${prefix}${flowTxt}${schedNote} (${fromNm} → ${toNm})`,
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
    // Strict TD ground-truth priority (~100m, ±45°): never draw synthetic BUS_API where TD sensors/links cover the road
    if (seg.coveredByTd || seg.tdCovered || seg.source === 'TD') continue;
    if (!Array.isArray(seg.coords) || seg.coords.length < 2) continue;
    if (tdCoverFn && tdCoverFn(seg.coords, tdDetectors, tdSpeedGeo, { maxDistKm: 0.10, maxAngDeg: 45 })) continue;
    // Strictly require road-snapped polylines (never draw straight coastline-cutting chords)
    if (!seg.isRoadSnapped && seg.coords.length === 2 && typeof calculateDistanceKm === 'function') {
      const chordKm = calculateDistanceKm(seg.coords[0][0], seg.coords[0][1], seg.coords[1][0], seg.coords[1][1]);
      if (chordKm > 0.16) continue;
    }

    // Deduplicate overlapping bus routes on the exact same road stretch
    if (drawnStretchMap instanceof Map) {
      const stretchKey = _globalBusStretchDedupKey(seg.coords);
      if (stretchKey) {
        const sev = _busTierSeverityRank(seg.tier);
        const prevSev = drawnStretchMap.get(stretchKey) || 0;
        if (prevSev >= sev) continue;
        drawnStretchMap.set(stretchKey, sev);
      }
    }

    const strokeColor = seg.color || (typeof getBusSpeedLayerColorHex === 'function' ? getBusSpeedLayerColorHex(seg.tier, seg.speedKmh) : '#16a34a');
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
      const prefix = routeLabel ? `${routeLabel} · ` : '';
      const rawFrom = isZh ? (seg.fromNameTc || seg.fromNameEn) : (seg.fromNameEn || seg.fromNameTc);
      const rawTo = isZh ? (seg.toNameTc || seg.toNameEn) : (seg.toNameEn || seg.toNameTc);
      const fromNm = sanitizeBottleneckLabel(rawFrom || `Stop ${seg.fromSeq || ((seg.fromIdx || 0) + 1)}`);
      const toNm = sanitizeBottleneckLabel(rawTo || `Stop ${seg.toSeq || ((seg.toIdx || 0) + 2)}`);
      const flowTxt = seg.tier === 'CONGESTED'
        ? (isZh ? '擠塞' : 'Heavy')
        : (seg.tier === 'MODERATE'
          ? (isZh ? '緩慢' : 'Slow')
          : (isZh ? '暢順' : 'Flowing'));
      line.bindTooltip(
        `🚌 ${prefix}${flowTxt} (${fromNm} → ${toNm})`,
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
  const roadCoords = (Array.isArray(currentDetailRoadCoords) && currentDetailRoadCoords.length >= 2)
    ? currentDetailRoadCoords
    : stops.map(s => [parseFloat(s.latitude), parseFloat(s.longitude)]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));

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

  if (!etaByStopIdx || !Object.keys(etaByStopIdx).length) {
    window.__DETAIL_BUS_SPEED_SEGMENTS__ = [];
    if (typeof window.refreshStopByStopTrafficUI === 'function') window.refreshStopByStopTrafficUI();
    return [];
  }

  const isNlb = coUpper === 'NLB' || rId.startsWith('NLB_');
  const isKmb = coUpper === 'KMB' || coUpper === 'LWB' || rId.startsWith('KMB_') || rId.startsWith('LWB_');
  const segs = window.inferBusApiSegmentSpeeds(stops, etaByStopIdx, roadCoords, {
    tdDetectors,
    tdCameras,
    tdSpeedGeoJson: window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null,
    routeNo: group.routeNo || '',
    company: group.company || '',
    bound: dirChar,
    allowSparseBridge: !isKmb,
    allowNlbScheduledFallback: isNlb,
    nowMs: Date.now()
  });
  window.__DETAIL_BUS_SPEED_SEGMENTS__ = segs;
  if (window.trafficLayerEnabled && window.mapInstance && currentDetailCorridorMeta?.groupKey === (group?.key || '')) {
    _refreshDetailBusSpeedPolylineIfActive();
  }
  if (typeof window.onDetailBusSpeedReady === 'function') {
    window.onDetailBusSpeedReady(group?.key || '');
  }
  if (typeof window.refreshStopByStopTrafficUI === 'function') {
    window.refreshStopByStopTrafficUI();
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
  const tdSpeedGeo = window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || window.__LAST_GLOBAL_SPEED_GEOJSON__ || null;

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
    attachGlobalTrafficControlToBrowseMap(window.browseMapInstance);
    window.browseMapInstance.on('moveend', () => {
      scheduleBrowseMapPinDiff();
      if (window.globalTrafficLayerEnabled) {
        // Keep already-rendered Bus-API segments visible immediately while coalescing viewport fetches
        scheduleGlobalTrafficRefresh(window.browseMapInstance, {
          immediateBusRepaint: true,
          delayMs: 160
        });
      }
    });
    window.browseMapInstance.on('zoomend', () => {
      if (window.globalTrafficLayerEnabled) {
        // Immediately update TD lane offset + repaint cached Bus-API segments with zero blanking,
        // and coalesce the async fetch with Leaflet's trailing moveend event.
        scheduleGlobalTrafficRefresh(window.browseMapInstance, {
          immediateTdDashboard: true,
          immediateBusRepaint: true,
          delayMs: 160
        });
      }
    });
    attachMapResizeObserver('browse-map-canvas', window.browseMapInstance, () => {
      if (window.globalTrafficLayerEnabled) {
        clearAllActiveBrowseMarkers();
        renderGlobalTrafficDashboard(window.browseMapInstance);
        renderGlobalBusSpeedOverlay(window.browseMapInstance);
      } else {
        renderBrowseMapVisiblePins();
      }
    });

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
  if (window.globalTrafficLayerEnabled) {
    clearAllActiveBrowseMarkers();
    renderGlobalTrafficDashboard(window.browseMapInstance);
    renderGlobalBusSpeedOverlay(window.browseMapInstance);
  } else {
    renderBrowseMapVisiblePins();
  }
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
  updateUserMarkers();
  // De-cluttering Logic: while the unified Global Traffic overlay is ON,
  // suppress hollow white bus/rail stop circles so solid TD and dashed Bus-API road lines render seamlessly
  if (window.globalTrafficLayerEnabled) {
    clearAllActiveBrowseMarkers();
    return;
  }
  if (!browseMapStopGrid.size && allStops.length) rebuildBrowseMapSpatialGrid();

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
