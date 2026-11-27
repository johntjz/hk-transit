// ============================================================================
// File: map.js (johntjz/Hk-Fleet — Unified Leaflet Geometry & Map Lifecycle Engine)
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
var detailMapHeightState = (typeof detailMapHeightState !== 'undefined') ? detailMapHeightState : 0;
var isDetailGpsLocked = (typeof isDetailGpsLocked !== 'undefined') ? isDetailGpsLocked : false;

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

function _ensureBusPolylineCoversStopsMap(coords, stops = []) {
  if (!Array.isArray(coords) || coords.length < 2) return coords;
  if (typeof window !== 'undefined' && typeof window.ensureRoutePolylineCoversStops === 'function' && Array.isArray(stops) && stops.length >= 2) {
    return window.ensureRoutePolylineCoversStops(coords, stops);
  }
  return coords;
}

function getCachedBusRoutePolyline(group, stops = []) {
  if (!group || (group.mode && group.mode !== 'BUS')) return null;
  if (group.key && Array.isArray(window.__ROUTE_GEOM_CACHE__[group.key]) && window.__ROUTE_GEOM_CACHE__[group.key].length >= 2) {
    const repaired = _ensureBusPolylineCoversStopsMap(window.__ROUTE_GEOM_CACHE__[group.key], stops);
    if (repaired !== window.__ROUTE_GEOM_CACHE__[group.key]) {
      window.__ROUTE_GEOM_CACHE__[group.key] = repaired;
    }
    return repaired;
  }
  const ck = buildBusGeomCacheKey(group, stops);
  const store = _readBusGeomStorageMap();
  const entry = store[ck];
  if (entry && Array.isArray(entry.coords) && entry.coords.length >= 2) {
    const repaired = _ensureBusPolylineCoversStopsMap(entry.coords, stops);
    if (group.key) window.__ROUTE_GEOM_CACHE__[group.key] = repaired;
    return repaired;
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
      const rawCoords = Array.isArray(data?.coords) ? data.coords : [];
      if (rawCoords.length < 2) return null;

      // Sanity check endpoints sit within 2.5km of route origin & destination
      const dStart = calculateDistanceKm(rawCoords[0][0], rawCoords[0][1], sampled[0][0], sampled[0][1]);
      const dEnd = calculateDistanceKm(rawCoords[rawCoords.length - 1][0], rawCoords[rawCoords.length - 1][1], sampled[sampled.length - 1][0], sampled[sampled.length - 1][1]);
      if (dStart > 2.5 || dEnd > 2.5) return null;

      // Prepend/splice any missing consecutive stop spans (e.g. truncated CSDI upstream stops or bypassed town detours)
      const coords = _ensureBusPolylineCoversStopsMap(rawCoords, stops);
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
      ? (isZh ? `單車路線 ${cachedRoute.distM}m (${cachedRoute.mins}分)` : `Bike ${cachedRoute.distM}m (${cachedRoute.mins}m)`)
      : (isZh ? `步行路線 ${cachedRoute.distM}m (${cachedRoute.mins}分)` : `Walk ${cachedRoute.distM}m (${cachedRoute.mins}m)`);
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
        ? (isZh ? `單車路線 ${res.distM}m (${res.mins}分)` : `Bike ${res.distM}m (${res.mins}m)`)
        : (isZh ? `步行路線 ${res.distM}m (${res.mins}分)` : `Walk ${res.distM}m (${res.mins}m)`);
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
function setDetailSheetDetent(detent = 'half') {
  const mapEl = document.getElementById('map-container');
  const viewEl = document.getElementById('view-detail');
  const handle = document.getElementById('mapSheetHandle');
  if (!mapEl) return;
  const target = String(detent || 'half').toLowerCase();
  mapEl.style.transition = '';
  if (target === 'top') {
    detailMapHeightState = 2;
    mapEl.style.height = '0px';
    viewEl?.classList?.add('sheet-expanded-top');
    handle?.setAttribute?.('data-sheet-detent', 'top');
    return;
  }
  if (target === 'map') {
    detailMapHeightState = 1;
    mapEl.style.height = '64dvh';
    viewEl?.classList?.remove('sheet-expanded-top');
    handle?.setAttribute?.('data-sheet-detent', 'map');
    setTimeout(() => window.mapInstance?.invalidateSize(false), 120);
    return;
  }
  detailMapHeightState = 0;
  mapEl.style.height = '35dvh';
  viewEl?.classList?.remove('sheet-expanded-top');
  handle?.setAttribute?.('data-sheet-detent', 'half');
  setTimeout(() => window.mapInstance?.invalidateSize(false), 120);
}

function expandDetailSheetToTop() {
  setDetailSheetDetent('top');
}

function restoreDetailSheetSplitMap() {
  setDetailSheetDetent('half');
}

function cycleMapSheetHeight() {
  if (detailMapHeightState === 2) {
    setDetailSheetDetent('half');
    return;
  }
  if (detailMapHeightState === 0) {
    setDetailSheetDetent('map');
    return;
  }
  setDetailSheetDetent('half');
}

function initDetailMapSheetDragResize() {
  const handle = document.getElementById('mapSheetHandle');
  const mapEl = document.getElementById('map-container');
  if (!handle || !mapEl || handle._dragBound) return;
  handle._dragBound = true;

  let activePointerId = null;
  let activeTouchId = null;
  let startY = 0;
  let lastY = 0;
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
    return { minH: 0, maxH: Math.max(260, Math.round(vh * 0.74)), vh };
  };

  const getStartHeightPx = () => {
    if (detailMapHeightState === 2) return 0;
    if (typeof mapEl.offsetHeight === 'number' && mapEl.offsetHeight >= 0 && mapEl.style.height !== '0px') {
      if (mapEl.offsetHeight > 0) return mapEl.offsetHeight;
    }
    const parsed = parseFloat(mapEl.style.height);
    if (Number.isFinite(parsed) && parsed >= 0) {
      if (String(mapEl.style.height).includes('vh')) {
        return Math.round((getBoundsPx().vh * parsed) / 100);
      }
      return parsed;
    }
    return Math.round(getBoundsPx().vh * 0.35);
  };

  const applyDragHeight = (clientY) => {
    lastY = Number(clientY) || startY;
    const dy = lastY - startY;
    movedPx = Math.max(movedPx, Math.abs(dy));
    const { minH, maxH } = getBoundsPx();
    const newH = Math.max(minH, Math.min(maxH, Math.round(startH + dy)));
    mapEl.style.height = `${newH}px`;
    const viewEl = document.getElementById('view-detail');
    viewEl?.classList?.toggle('sheet-expanded-top', newH <= 16);
    if (newH > 0) scheduleInvalidate();
  };

  const commitDragEnd = (allowTapToggle) => {
    handle.classList?.remove('is-dragging');
    document.body?.classList?.remove('map-sheet-dragging');
    if (rafId && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(rafId); rafId = 0; }
    mapEl.style.transition = '';

    if (allowTapToggle && movedPx < 5) {
      if (detailMapHeightState === 2) {
        restoreDetailSheetSplitMap();
      } else {
        expandDetailSheetToTop();
      }
      return;
    }

    const { vh } = getBoundsPx();
    const parsedInline = parseFloat(mapEl.style.height);
    const curH = Number.isFinite(parsedInline) && String(mapEl.style.height).endsWith('px')
      ? parsedInline
      : ((typeof mapEl.offsetHeight === 'number' && mapEl.offsetHeight >= 0) ? mapEl.offsetHeight : startH);
    const ratio = vh > 0 ? (curH / vh) : 0.35;
    const netDy = lastY - startY;

    if (curH <= 24 || (netDy <= -36 && ratio < 0.34)) {
      setDetailSheetDetent('top');
      return;
    }
    if (startH <= 24 && netDy >= 36) {
      setDetailSheetDetent(ratio >= 0.50 ? 'map' : 'half');
      return;
    }
    const viewEl = document.getElementById('view-detail');
    if (ratio <= 0.22) {
      setDetailSheetDetent('top');
      return;
    }
    viewEl?.classList?.remove('sheet-expanded-top');
    detailMapHeightState = ratio >= 0.50 ? 1 : 0;
    handle?.setAttribute?.('data-sheet-detent', detailMapHeightState === 1 ? 'map' : 'half');
    window.mapInstance?.invalidateSize(false);
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
    commitDragEnd(allowTapToggle);
  };

  handle.addEventListener('dragstart', (e) => { if (e && typeof e.preventDefault === 'function') e.preventDefault(); });
  handle.addEventListener('pointerdown', (e) => {
    if (!e) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('#mapSheetToggleBtn')) return;
    if (e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    activeTouchId = null;
    activePointerId = (e.pointerId !== undefined) ? e.pointerId : 1;
    startY = Number(e.clientY) || 0;
    lastY = startY;
    startH = getStartHeightPx();
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
    applyDragHeight(e.clientY);
  });
  handle.addEventListener('pointerup', (e) => finishDrag(e, true));
  handle.addEventListener('pointercancel', (e) => finishDrag(e, false));

  // Explicit touchstart / touchmove / touchend fallback for iOS/mobile touch browsers & sheet header gestures
  const getTrackedTouch = (e) => {
    const list = e?.changedTouches || e?.touches;
    if (!list || !list.length) return null;
    if (activeTouchId === null) return list[0];
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === activeTouchId) return list[i];
    }
    return null;
  };
  handle.addEventListener('touchstart', (e) => {
    if (!e || activePointerId !== null) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('#mapSheetToggleBtn')) return;
    const t0 = e.touches?.[0] || e.changedTouches?.[0];
    if (!t0) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    activeTouchId = t0.identifier !== undefined ? t0.identifier : 0;
    startY = Number(t0.clientY) || 0;
    lastY = startY;
    startH = getStartHeightPx();
    movedPx = 0;
    mapEl.style.transition = 'none';
    handle.classList?.add('is-dragging');
    document.body?.classList?.add('map-sheet-dragging');
  }, { passive: false });
  handle.addEventListener('touchmove', (e) => {
    if (activeTouchId === null || activePointerId !== null || !e) return;
    const t = getTrackedTouch(e);
    if (!t) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    applyDragHeight(t.clientY);
  }, { passive: false });
  handle.addEventListener('touchend', (e) => {
    if (activeTouchId === null || activePointerId !== null) return;
    const t = getTrackedTouch(e);
    if (t) lastY = Number(t.clientY) || lastY;
    activeTouchId = null;
    commitDragEnd(true);
  });
  handle.addEventListener('touchcancel', () => {
    if (activeTouchId === null || activePointerId !== null) return;
    activeTouchId = null;
    commitDragEnd(false);
  });
}

window.setDetailSheetDetent = setDetailSheetDetent;
window.expandDetailSheetToTop = expandDetailSheetToTop;
window.restoreDetailSheetSplitMap = restoreDetailSheetSplitMap;
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
    window.__DETAIL_STOP_SEGMENTS__ = [];
    window.__LAST_DETAIL_STOP_SEGS_SIG__ = '';
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
    routeNo: group?.routeNo || '',
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
      fetchRoadSnappedBusPolyline(group, stops).then((rawRoadCoords) => {
        if (!rawRoadCoords || myGeomToken !== _detailGeomToken || !window.mapInstance) return;
        if (typeof detailRouteGroup !== 'undefined' && detailRouteGroup?.key !== group.key) return;
        const roadCoords = _ensureBusPolylineCoversStopsMap(rawRoadCoords, stops);
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
          routeNo: group?.routeNo || '',
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
    pushWalk(originPt, destPt, wb.isBike, `${wb.isBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${wb.distM}m (${wb.totalMins}m)`);
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

if (typeof window !== 'undefined') {
  window.findNearestPolylineIndex = findNearestPolylineIndex;
  window.getStopLatLon = getStopLatLon;
  window.matchStopIndexInSequence = matchStopIndexInSequence;
  window.sliceRouteStopPoints = sliceRouteStopPoints;
  window.sliceRouteStops = sliceRouteStops;
  window.buildGentleCurvePoints = buildGentleCurvePoints;
  window.fetchOsrmStreetGeometry = fetchOsrmStreetGeometry;
  window.fetchOsrmBikeGeometry = fetchOsrmBikeGeometry;
  window.drawWalkingLeg = drawWalkingLeg;
  window.cycleMapSheetHeight = cycleMapSheetHeight;
  window.syncDetailGpsLockBtnUI = syncDetailGpsLockBtnUI;
  window.toggleDetailGpsLock = toggleDetailGpsLock;
  window.zoomMapIn = zoomMapIn;
  window.zoomMapOut = zoomMapOut;
  window.drawRouteOnMap = drawRouteOnMap;
  window.highlightActiveStopMarkerOnMap = highlightActiveStopMarkerOnMap;
  window.rebuildBrowseMapSpatialGrid = rebuildBrowseMapSpatialGrid;
  window.initAndRenderBrowseMap = initAndRenderBrowseMap;
  window.renderBrowseMapVisiblePins = renderBrowseMapVisiblePins;
  window.recenterBrowseMapToGps = recenterBrowseMapToGps;
  window.setXferMapHeightPx = setXferMapHeightPx;
  window.toggleXferMapFullScreen = toggleXferMapFullScreen;
  window.initXferMapDragResize = initXferMapDragResize;
  window.ensureXferMapInitialized = ensureXferMapInitialized;
  window.fitTransferPlannerMapBounds = fitTransferPlannerMapBounds;
  window.drawTransferCorridorOnMap = drawTransferCorridorOnMap;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getCachedBusRoutePolyline,
    fetchRoadSnappedBusPolyline,
    findNearestPolylineIndex,
    sliceRoadPolylineBetweenStops,
    attachMapResizeObserver,
    updateUserMarkers,
    autoStartCompassCone,
    getStopLatLon,
    matchStopIndexInSequence,
    sliceRouteStopPoints,
    sliceRouteStops,
    buildGentleCurvePoints,
    fetchOsrmStreetGeometry,
    fetchOsrmBikeGeometry,
    drawWalkingLeg,
    setDetailSheetDetent,
    expandDetailSheetToTop,
    restoreDetailSheetSplitMap,
    cycleMapSheetHeight,
    initDetailMapSheetDragResize,
    drawRouteOnMap,
    highlightActiveStopMarkerOnMap,
    rebuildBrowseMapSpatialGrid,
    initAndRenderBrowseMap,
    renderBrowseMapVisiblePins,
    recenterBrowseMapToGps,
    clearTransferPlannerMapLayers,
    handleXferMapSpotClick,
    ensureXferMapInitialized,
    recenterXferMapToGps,
    highlightPlannerMapLeg,
    focusPlannerMapLeg,
    fitTransferPlannerMapBounds,
    drawTransferCorridorOnMap
  };
}
