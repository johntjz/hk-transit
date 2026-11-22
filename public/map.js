// ============================================================================
// File: map.js (johntjz/Hk-Fleet — Unified Leaflet Geometry & Map Engine)
// ============================================================================

window.mapInstance = null;
window.browseMapInstance = null;
window.xferMapInstance = null;

var detailPolylineLayer = null;
var mapMarkers = {};
var currentDetailRoadCoords = [];
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
  if (typeof L === 'undefined') return;
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
  }
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

  currentDetailRoadCoords = polyPts;

  const lineStyle = { color: routeAccent, weight: 5, opacity: 0.92, lineJoin: 'round', lineCap: 'round' };

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
  } else if (polyPts.length >= 2) {
    detailPolylineLayer = L.polyline(polyPts, lineStyle).addTo(window.mapInstance);
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
      zIndexOffset: isAct ? 600 : 200
    }).addTo(window.mapInstance);
    m.bindTooltip(`${idx + 1}. ${getStopName(s)}`, { direction: 'top', offset: [0, -8], className: 'kmb-map-stop-label' });
    m.on('click', () => expandStop(idx, false, false, false));
    mapMarkers[idx] = m;
  });

  isDetailGpsLocked = false;
  syncDetailGpsLockBtnUI();
  updateUserMarkers();

  if (polyPts.length >= 2) {
    try {
      window.mapInstance.invalidateSize(false);
      window.mapInstance.fitBounds(L.latLngBounds(polyPts), { paddingTopLeft: [36, 36], paddingBottomRight: [36, 44], maxZoom: 16 });
    } catch (e) {}
  }
}

function highlightActiveStopMarkerOnMap(activeIdx) {
  if (!window.mapInstance || !detailRouteGroup) return;
  const stops = getStopsForGroup(detailRouteGroup, detailTargetStopKey);
  const isLight = document.documentElement.classList.contains('light-mode');
  const routeAccent = detailRouteGroup?.colorHex || window.__GET_ROUTE_COLOR_HEX__(detailRouteGroup?.mode, detailRouteGroup?.company, detailRouteGroup?.routeNo);
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
  if (typeof L === 'undefined') return;
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
  let startY = 0, startH = 220, dragging = false, rafId = 0;
  const onStart = (y) => { dragging = true; startY = y; startH = wrap.offsetHeight; wrap.style.transition = 'none'; };
  const onMove = (y) => {
    if (!dragging) return;
    const newH = Math.max(140, Math.min(Math.round(window.innerHeight * 0.72), startH + (y - startY)));
    wrap.style.height = `${newH}px`;
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        window.xferMapInstance?.invalidateSize(false);
      });
    }
  };
  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    wrap.style.transition = 'height 0.25s ease';
    isXferMapExpanded = wrap.offsetHeight > 320;
    window.xferMapInstance?.invalidateSize(false);
  };
  handle.addEventListener('touchstart', e => { if (e.touches[0]) onStart(e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchmove', e => { if (dragging && e.touches[0]) onMove(e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchend', onEnd);
  handle.addEventListener('mousedown', e => { e.preventDefault(); onStart(e.clientY); });
  window.addEventListener('mousemove', e => onMove(e.clientY));
  window.addEventListener('mouseup', onEnd);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initXferMapDragResize);
} else {
  initXferMapDragResize();
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
  if (typeof L === 'undefined') return null;
  initXferMapDragResize();
  if (!window.xferMapInstance) {
    const startLat = (typeof lastKnownPos !== 'undefined' && lastKnownPos?.lat) ? lastKnownPos.lat : 22.302;
    const startLon = (typeof lastKnownPos !== 'undefined' && lastKnownPos?.lon) ? lastKnownPos.lon : 114.170;
    window.xferMapInstance = L.map('xfer-map-canvas', { zoomControl: false, preferCanvas: true }).setView([startLat, startLon], 12);
    window.attachStandardMapLayers(window.xferMapInstance);
    // Do NOT attach click/contextmenu tap-to-pin listeners on Planner map so panning/zooming stays clean.
    attachMapResizeObserver('xferMapWrapper', window.xferMapInstance, () => fitTransferPlannerMapBounds());
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
    const pts = stopPts.map(x => x.pt);
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
      xferMapLegPolylines.push({ poly, casing, pts, isFerry, color: col });

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
    return pts;
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
}
