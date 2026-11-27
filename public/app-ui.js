// ============================================================================
// public/app-ui.js
// App UI: nearby/search/route-detail/stop-list/traffic modals/favourites/sync/boot (extracted from index.html)
// Classic (non-module) script: shares global scope with hardcode.js, busspeed.js,
// map.js, planner.js and the other app scripts. Load order in index.html:
// hardcode.js → busspeed.js → map.js → planner.js → eta-engine.js → onboarding-pwa.js → app-ui.js
// ============================================================================

// ============================================================================
// PART 2: DYNAMIC INDEXING, 250M CLUSTER RADAR, LOAD PILLS, SMART RETURN & POLLING
// ============================================================================
function ensureStopsIndexedForGroup(g) {
  if (!g || indexedGroupKeys.has(g.key)) return;
  indexedGroupKeys.add(g.key);
  const gMode = g.mode || 'BUS';
  const gCo = g.company || '';
  if (!Array.isArray(g.activeWindows) || !g.activeWindows.length) {
    g.activeWindows = window.__DERIVE_DEFAULT_ACTIVE_WINDOWS__(g);
  }
  if (Array.isArray(g.routeIds) && g.routeIds.length > 1) {
    g.routeIds.sort((a, b) => (routeStopsCache[b]?.length || 0) - (routeStopsCache[a]?.length || 0));
  }
  (g.routeIds || []).forEach(rId => {
    (routeStopsCache[rId] || []).forEach(s => {
      if (!s?.stopName_e || isHiddenWaypointStop(s.stopName_e)) return;
      const isLrtStop = (gMode === 'MTR' && (gCo === 'LRT' || s.lrtCode || rId.startsWith('LRT_')));
      const lrtNumId = isLrtStop ? resolveLrtNumericId(s.lrtCode || s.stopId, s.stopName_e, s.name_tc) : '';
      if (isLrtStop && lrtNumId && typeof LRT_STATION_DIRECTORY !== 'undefined') {
        s.lrtCode = lrtNumId.padStart(3, '0');
        const refDir = LRT_STATION_DIRECTORY[lrtNumId];
        if (refDir) {
          s.stopName_e = `${refDir.en} Light Rail Stop`;
          s.name_tc = `${refDir.tc}輕鐵站`;
          s.latitude = refDir.lat.toFixed(6);
          s.longitude = refDir.lon.toFixed(6);
        }
      }

      const isHeavyMtr = (gMode === 'MTR' && !isLrtStop);
      const stCode = String(s.mtrCode || s.stopId || '').trim().toUpperCase();
      const pierCanon = normStationLookupKey(s.stopName_e) || getBaseStopNameKey(s.stopName_e);

      if (isHeavyMtr && stCode && typeof MTR_STATION_DIRECTORY !== 'undefined' && MTR_STATION_DIRECTORY[stCode]) {
        const mtrRef = MTR_STATION_DIRECTORY[stCode];
        s.latitude = mtrRef.lat.toFixed(6);
        s.longitude = mtrRef.lon.toFixed(6);
      } else if (gMode === 'FERRY' && typeof FERRY_PIER_DIRECTORY !== 'undefined' && FERRY_PIER_DIRECTORY[pierCanon]) {
        const pRef = FERRY_PIER_DIRECTORY[pierCanon];
        s.latitude = pRef.lat.toFixed(6);
        s.longitude = pRef.lon.toFixed(6);
      }

      const la = parseFloat(s.latitude), lo = parseFloat(s.longitude);
      if (!isValidRailOrFerryCoord(la, lo)) return;
      const baseKey = `${getBaseStopNameKey(s.stopName_e)}_${la.toFixed(4)}_${lo.toFixed(4)}`;
      const key = (isHeavyMtr && stCode)
        ? `MTR_STN_${stCode}`
        : (isLrtStop && lrtNumId
          ? `LRT_STN_${lrtNumId}`
          : (gMode === 'FERRY' ? `FERRY_PIER_${pierCanon}` : `${gMode === 'MTR' ? 'LRT_' : ''}${baseKey}`));
      s.stopKey = key;
      if (!stopMapIndex.has(key)) {
        const stopEntry = { ...s, stopKey: key, mode: gMode, company: gCo, groupKeys: new Set([g.key]), routeNos: new Set([g.routeNo]) };
        stopMapIndex.set(key, stopEntry);
        allStops.push(stopEntry);
      } else {
        const ex = stopMapIndex.get(key);
        ex.groupKeys.add(g.key);
        ex.routeNos.add(g.routeNo);
      }
    });
  });
}

function healSavedBookmarksAndCommuteSlots() {
  if (!stopMapIndex.size) return;
  let bmUpdated = false;
  bookmarkedStops.forEach(bm => {
    if (!bm || stopMapIndex.has(bm.stopKey)) return;
    const g = routeMapIndex.get(bm.groupKey);
    const targetBase = getBaseStopNameKey(bm.stopName_e || bm.stopKey.split('_')[0]);
    const targetPierCanon = normStationLookupKey(bm.stopName_e || bm.stopKey.split('_')[0]);
    const parts = String(bm.stopKey || '').split('_');
    const oldLat = parseFloat(parts[parts.length - 2]);
    const oldLon = parseFloat(parts[parts.length - 1]);

    if (g) {
      const rStops = getStopsForGroup(g);
      const match = rStops.find(s => {
        if (g.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon) return true;
        if (getBaseStopNameKey(s.stopName_e) !== targetBase) return false;
        if (Number.isFinite(oldLat) && Number.isFinite(oldLon)) {
          return calculateDistanceKm(oldLat, oldLon, parseFloat(s.latitude), parseFloat(s.longitude)) <= 0.25;
        }
        return true;
      });
      if (match && match.stopKey) {
        bm.stopKey = match.stopKey;
        bm.id = `${bm.groupKey}|${match.stopKey}`;
        bmUpdated = true;
        return;
      }
    }

    const globalMatch = allStops.find(s => {
      if (s.mode === 'FERRY' && targetPierCanon && normStationLookupKey(s.stopName_e) === targetPierCanon) return true;
      if (getBaseStopNameKey(s.stopName_e) !== targetBase) return false;
      if (Number.isFinite(oldLat) && Number.isFinite(oldLon)) {
        return calculateDistanceKm(oldLat, oldLon, parseFloat(s.latitude), parseFloat(s.longitude)) <= 0.25;
      }
      return false;
    });
    if (globalMatch) {
      bm.stopKey = globalMatch.stopKey;
      bm.id = `${bm.groupKey}|${globalMatch.stopKey}`;
      bmUpdated = true;
    }
  });
  if (bmUpdated) {
    SafeStorage.setItem('transit_stop_bookmarks_v1', JSON.stringify(bookmarkedStops));
  }

  let commuteUpdated = false;
  ['home', 'work'].forEach(slot => {
    const item = userCommuteProfile[slot];
    if (!item || item.nodeType === 'ADDRESS' || String(item.stopKey || '').startsWith('ALS_') || String(item.stopKey || '').startsWith('MAP_PIN_')) return;
    if (stopMapIndex.has(item.stopKey)) return;
    const targetBase = getBaseStopNameKey(item.stopName_e);
    const match = allStops.find(s =>
      getBaseStopNameKey(s.stopName_e) === targetBase &&
      calculateDistanceKm(item.lat || 0, item.lon || 0, parseFloat(s.latitude), parseFloat(s.longitude)) <= 0.25
    );
    if (match) {
      item.stopKey = match.stopKey;
      item.lat = parseFloat(match.latitude);
      item.lon = parseFloat(match.longitude);
      commuteUpdated = true;
    }
  });
  if (commuteUpdated) {
    lastXferSolvedSpec = null;
    SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  }
}

function enforceHardcodedLrtRoutes() {
  if (typeof HARDCODED_LRT_SEQUENCES === 'undefined' || typeof LRT_STATION_DIRECTORY === 'undefined') return;
  const minFare = String(window.__MIN_OCTOPUS_RAIL_FARE__ || '5.2');
  const byKey = new Map(groupedRoutes.map((g, i) => [g.key, i]));
  const quickList = [];
  const seenRNo = new Set();

  for (const [rNo, dirsObj] of Object.entries(HARDCODED_LRT_SEQUENCES)) {
    for (const [dir, stopCodeArr] of Object.entries(dirsObj)) {
      const rId = `LRT_${rNo}_${dir}`;
      const builtStops = stopCodeArr.map((padCode, idx) => {
        const numId = String(parseInt(padCode, 10));
        const stInfo = LRT_STATION_DIRECTORY[numId];
        if (!stInfo) return null;
        return {
          stopId: padCode,
          seq: idx + 1,
          stopName_e: `${stInfo.en} Light Rail Stop`,
          name_tc: `${stInfo.tc}輕鐵站`,
          latitude: stInfo.lat.toFixed(6),
          longitude: stInfo.lon.toFixed(6),
          lrtCode: padCode,
          lrtLine: rNo,
          fare: minFare
        };
      }).filter(Boolean);

      if (builtStops.length < 2) continue;
      routeStopsCache[rId] = builtStops;

      const firstInfo = LRT_STATION_DIRECTORY[String(parseInt(stopCodeArr[0], 10))];
      const lastInfo  = LRT_STATION_DIRECTORY[String(parseInt(stopCodeArr[stopCodeArr.length - 1], 10))];
      const isLoop = (rNo === '705' || rNo === '706');
      const isAmOnlyPeak = (rNo === '507P' || rNo === '610P');
      const isPeakShuttle = (rNo === '751P' || isAmOnlyPeak);
      const destEn = isLoop ? `${firstInfo.en} (Circular)` : lastInfo.en;
      const destTc = isLoop ? `${firstInfo.tc} (循環線)` : lastInfo.tc;

      const routeObj = {
        key: rId,
        mode: 'MTR',
        routeNo: rNo,
        company: 'LRT',
        company_tc: '輕鐵',
        colorHex: '#5856D6',
        orig_e: firstInfo.en,
        orig_tc: firstInfo.tc,
        dest_e: destEn,
        dest_tc: destTc,
        isCircular: isLoop,
        headwayMins: 7,
        serviceMode: isPeakShuttle ? 'PEAK_WEEKDAY_ONLY' : 'DAILY',
        operatingDays: isPeakShuttle ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6],
        includeHolidays: !isPeakShuttle,
        excludeHolidays: isPeakShuttle,
        activeWindows: isAmOnlyPeak ? [[430, 510]] : (isPeakShuttle ? [[435, 510], [1020, 1140]] : [[320, 1439], [0, 60]]),
        routeIds: [rId]
      };

      if (byKey.has(rId)) {
        groupedRoutes[byKey.get(rId)] = routeObj;
      } else {
        byKey.set(rId, groupedRoutes.length);
        groupedRoutes.push(routeObj);
      }

      if (!seenRNo.has(rNo)) {
        seenRNo.add(rNo);
        const sepArrow = isAmOnlyPeak ? '➔' : '⟷';
        quickList.push({
          key: rNo,
          badge: rNo,
          name_en: `${firstInfo.en} ${sepArrow} ${destEn}`,
          name_tc: `${firstInfo.tc} ${sepArrow} ${destTc}`,
          color: '#5856D6',
          stops: builtStops.map(s => s.stopId)
        });
      }
    }
  }
  quickList.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  window.QUICK_LRT_LINES = quickList;
}

function ensureAllStandaloneLrtStopsIndexed() {
  if (typeof LRT_STATION_DIRECTORY === 'undefined') return;
  for (const [numId, info] of Object.entries(LRT_STATION_DIRECTORY)) {
    const key = `LRT_STN_${numId}`;
    if (!stopMapIndex.has(key)) {
      const padCode = numId.padStart(3, '0');
      const stopEntry = {
        stopId: padCode,
        lrtCode: padCode,
        stopKey: key,
        stopName_e: `${info.en} Light Rail Stop`,
        name_tc: `${info.tc}輕鐵站`,
        latitude: info.lat.toFixed(6),
        longitude: info.lon.toFixed(6),
        mode: 'MTR',
        company: 'LRT',
        fare: String(window.__MIN_OCTOPUS_RAIL_FARE__ || '5.2'),
        groupKeys: new Set(),
        routeNos: new Set(['LRT'])
      };
      stopMapIndex.set(key, stopEntry);
      allStops.push(stopEntry);
    }
  }
}

function unifyDualTerminusMtrLines() {
  const existingStationByCode = new Map();
  for (const sList of Object.values(routeStopsCache)) {
    if (!Array.isArray(sList)) continue;
    for (const s of sList) {
      const c = String(s?.mtrCode || s?.stopId || '').toUpperCase();
      if (c && !existingStationByCode.has(c)) existingStationByCode.set(c, s);
    }
  }

  groupedRoutes = groupedRoutes.filter(g => !/^MTR_(EAL|TKL)_(LMC|LHP)_/.test(g.key));

  const DUAL_SPECS = [
    {
      line: 'EAL',
      titleEn: 'Lo Wu / Lok Ma Chau',
      titleTc: '羅湖 / 落馬洲',
      forkCode: 'SHS',
      nodes: [
        { stopId: 'LOW', mtrCode: 'LOW', mtrLine: 'EAL', stopName_e: 'Lo Wu MTR Station', name_tc: '羅湖港鐵站', latitude: '22.527639', longitude: '114.113235', fare: '0' },
        { stopId: 'LMC', mtrCode: 'LMC', mtrLine: 'EAL', stopName_e: 'Lok Ma Chau MTR Station', name_tc: '落馬洲港鐵站', latitude: '22.514465', longitude: '114.065693', fare: '0' }
      ]
    },
    {
      line: 'TKL',
      titleEn: 'Po Lam / LOHAS Park',
      titleTc: '寶琳 / 康城',
      forkCode: 'TKO',
      nodes: [
        { stopId: 'POA', mtrCode: 'POA', mtrLine: 'TKL', stopName_e: 'Po Lam MTR Station', name_tc: '寶琳港鐵站', latitude: '22.322559', longitude: '114.257872', fare: '0' },
        { stopId: 'LHP', mtrCode: 'LHP', mtrLine: 'TKL', stopName_e: 'LOHAS Park MTR Station', name_tc: '康城港鐵站', latitude: '22.295587', longitude: '114.268726', fare: '0' }
      ]
    }
  ];

  DUAL_SPECS.forEach(spec => {
    ['O', 'I'].forEach(dir => {
      const rId = `MTR_${spec.line}_${dir}`;
      const g = groupedRoutes.find(x => x.key === rId);
      const stops = routeStopsCache[rId];
      if (!g || !Array.isArray(stops) || stops.length < 2) return;

      const codeSet = new Set(spec.nodes.map(n => n.stopId));
      const existingNodes = new Map();
      stops.forEach(s => { if (codeSet.has(s.stopId)) existingNodes.set(s.stopId, s); });

      const dualStops = spec.nodes.map(n => existingNodes.get(n.stopId) || existingStationByCode.get(n.stopId) || { ...n });
      const trunk = stops.filter(s => !codeSet.has(s.stopId));
      const forkIdx = trunk.findIndex(s => s.stopId === spec.forkCode);
      const isForkAtEnd = forkIdx >= trunk.length / 2;

      const merged = isForkAtEnd ? [...trunk, ...dualStops] : [...dualStops, ...trunk];
      merged.forEach((s, idx) => { s.seq = idx + 1; });
      routeStopsCache[rId] = merged;

      if (isForkAtEnd) {
        g.dest_e = spec.titleEn;
        g.dest_tc = spec.titleTc;
      } else {
        g.orig_e = spec.titleEn;
        g.orig_tc = spec.titleTc;
      }
    });

    const qItem = (window.QUICK_MTR_LINES || []).find(q => q.key === spec.line);
    const outG = groupedRoutes.find(x => x.key === `MTR_${spec.line}_O`);
    if (qItem && outG) {
      qItem.name_en = `${outG.orig_e} ⟷ ${outG.dest_e}`;
      qItem.name_tc = `${outG.orig_tc} ⟷ ${outG.dest_tc}`;
    }
  });
}

function initRouteMapFast() {
  unifyDualTerminusMtrLines();
  enforceHardcodedLrtRoutes();
  routeMapIndex.clear();
  stopMapIndex.clear();
  indexedGroupKeys.clear();
  allStops = [];
  groupedRoutes.forEach(g => {
    if (Array.isArray(g.routeIds) && g.routeIds.length > 1) {
      g.routeIds.sort((a, b) => (routeStopsCache[b]?.length || 0) - (routeStopsCache[a]?.length || 0));
    }
    routeMapIndex.set(g.key, g);
    ensureStopsIndexedForGroup(g);
  });
  ensureAllStandaloneLrtStopsIndexed();
  if (typeof rebuildBrowseMapSpatialGrid === 'function') rebuildBrowseMapSpatialGrid();
  healSavedBookmarksAndCommuteSlots();
}

function buildNearbyStopsFast(pos) {
  if (!pos || !Number.isFinite(pos.lat)) return;
  const maxRadiusKm = activeAppMode === 'BUS' ? 3.5 : 45.0;
  const withDist = [];
  for (let i = 0; i < allStops.length; i++) {
    const s = allStops[i];
    const sMode = s.mode || 'BUS';
    if (sMode !== activeAppMode) continue;
    const sLat = parseFloat(s.latitude), sLon = parseFloat(s.longitude);
    if (!isValidRailOrFerryCoord(sLat, sLon)) continue;
    const dKm = calculateDistanceKm(pos.lat, pos.lon, sLat, sLon);
    if (dKm <= maxRadiusKm) withDist.push({ ...s, distKm: dKm });
  }
  withDist.sort((a, b) => a.distKm - b.distKm);
  nearbyStopsList = withDist.slice(0, 35);
}

function syncNearestStopFromGPS(lat, lon, forceSnap = false) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!forceSnap && Date.now() < userManualStopBrowseUntilMs && currentNearestStopKey) return false;
  buildNearbyStopsFast({ lat, lon });
  if (nearbyStopsList.length > 0) {
    const nearestKey = nearbyStopsList[0].stopKey;
    const changed = (nearestKey !== currentNearestStopKey);
    currentNearestStopKey = nearestKey;
    updateMainStopHeaderDisplay();
    return changed;
  }
  return false;
}

// ============================================================================
// 250M CLUSTER BUS ZONE RADAR + SMART RETURN + NODE-BASED HOME/WORK CARDS
// ============================================================================
let activeClusterSubStopKey = 'ALL';

function selectClusterSubStopFilter(stopKey) {
  triggerHaptic(8);
  activeClusterSubStopKey = stopKey || 'ALL';
  lastRenderedCenterStopKey = null;
  renderMainNearby(false);
}

function setHubQuickOverride(mode) {
  triggerHaptic(8);
  if (typeof SavedHubsManager === 'undefined') return;
  SavedHubsManager.manualOverrideMode = mode;
  lastRenderedCenterStopKey = null;
  renderMainNearby(false);
}

function dismissSmartReturnCard(ev) {
  if (ev) ev.stopPropagation();
  triggerHaptic(8);
  if (typeof SmartReturnManager !== 'undefined') SmartReturnManager.dismissCurrent();
  lastRenderedCenterStopKey = null;
  renderMainNearby(false);
}

window.toggleQuickReturnSuggestions = function toggleQuickReturnSuggestions() {
  if (typeof SmartReturnManager === 'undefined') return false;
  if (typeof triggerHaptic === 'function') triggerHaptic(10);
  const next = !SmartReturnManager.isEnabled();
  SmartReturnManager.setEnabled(next);
  if (typeof syncSettingsModalLabels === 'function') syncSettingsModalLabels();
  lastRenderedCenterStopKey = null;
  if (typeof currentView !== 'undefined' && currentView === 'main' && typeof renderMainNearby === 'function') {
    renderMainNearby(false);
  }
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (typeof showToast === 'function') {
    showToast(next
      ? (isZh ? '快捷回程建議：已開啟' : 'Quick Return Suggestions: On')
      : (isZh ? '快捷回程建議：已關閉' : 'Quick Return Suggestions: Off'));
  }
  return next;
};

function toggleSavedStopHub(slot, stopIdx) {
  if (!detailRouteGroup || typeof SavedHubsManager === 'undefined') return;
  triggerHaptic(14);
  const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
  const s = stops[stopIdx];
  if (!s) return;
  const stKey = s.stopKey || getGlobalStopKey(s);
  SavedHubsManager.setHub(slot, s, detailRouteGroup.mode || 'BUS', true);
  const isZh = (currentLang === 'zh');
  const slotLbl = slot === 'work' ? (isZh ? '公司' : 'Work') : (isZh ? '屋企' : 'Home');
  showToast(isZh
    ? `已將「${getStopName(s)}」設為${slotLbl}車站（可於設定修改）`
    : `Set "${getStopName(s)}" as ${slotLbl} stop (edit anytime in Settings)`);

  syncSettingsModalLabels();
  const expEl = document.getElementById(`detail-eta-expanded-${stopIdx}`);
  if (expEl && detailExpandedStopIdx === stopIdx) {
    expEl.innerHTML = generateExpandedETAsHtml(detailLastFetchedArrs, detailRouteGroup, stKey, stopIdx);
  }
}

function buildSmartTopOverlayHtml(activeStopContext = null) {
  const isZh = (currentLang === 'zh');
  let html = '';
  let smartReturnCand = null;

  const hubEval = (typeof SavedHubsManager !== 'undefined')
    ? SavedHubsManager.evaluateSuggestion(lastKnownPos)
    : null;

  if (hubEval && (hubEval.hubs.home || hubEval.hubs.work)) {
    const ov = SavedHubsManager.manualOverrideMode;
    html += `<div class="hub-quick-strip">`;
    if (hubEval.hubs.home) {
      const activeCls = (ov === 'HOME' || (ov === 'AUTO' && hubEval.targetSlot === 'home')) ? 'active' : '';
      html += `<button class="hub-chip ${activeCls}" onclick="setHubQuickOverride('${ov === 'HOME' ? 'AUTO' : 'HOME'}')">🏠 ${isZh ? `返屋企 (${escapeHtml(hubEval.hubs.home.nameTc)})` : `Go Home (${escapeHtml(hubEval.hubs.home.nameEn)})`}</button>`;
    }
    if (hubEval.hubs.work) {
      const activeCls = (ov === 'WORK' || (ov === 'AUTO' && hubEval.targetSlot === 'work')) ? 'active' : '';
      html += `<button class="hub-chip ${activeCls}" onclick="setHubQuickOverride('${ov === 'WORK' ? 'AUTO' : 'WORK'}')">💼 ${isZh ? `返工 (${escapeHtml(hubEval.hubs.work.nameTc)})` : `To Work (${escapeHtml(hubEval.hubs.work.nameEn)})`}</button>`;
    }
    html += `<button class="hub-chip ${ov === 'NEARBY' ? 'active' : ''}" onclick="setHubQuickOverride('NEARBY')">📍 ${isZh ? '附近車站' : 'Nearby'}</button>`;
    html += `</div>`;

    if (hubEval.targetSlot && hubEval.targetHub) {
      const th = hubEval.targetHub;
      const isWork = hubEval.targetSlot === 'work';
      const titleTxt = isWork
        ? (isZh ? `💼 準備返工？往 ${th.nameTc}` : `💼 Heading to Work? (${th.nameEn})`)
        : (isZh ? `🏠 準備返屋企？往 ${th.nameTc}` : `🏠 Route to Home (${th.nameEn})`);
      const subTxt = isZh ? '僅儲存於本機車站捷徑 · 點擊即時規劃最快路線' : 'Stored on device · Tap for live multi-modal departures';
      html += `
        <div class="hub-shortcut-card" onclick="SavedHubsManager.launchRouteToHub('${hubEval.targetSlot}')">
          <div class="smart-return-top">
            <span class="smart-return-badge">${isWork ? (isZh ? '上班捷徑' : 'WORK SHORTCUT') : (isZh ? '回家捷徑' : 'HOME SHORTCUT')}</span>
            <span style="font-size:0.72rem;color:var(--ios-blue);font-weight:700;">${isZh ? '即時規劃 ›' : 'Plan Now ›'}</span>
          </div>
          <div style="font-weight:800;font-size:0.96rem;color:var(--text-main);">${escapeHtml(titleTxt)}</div>
          <div style="font-size:0.73rem;color:var(--text-sub);margin-top:3px;">${escapeHtml(subTxt)}</div>
        </div>`;
    }
  }

  if (typeof SmartReturnManager !== 'undefined' && (!hubEval || hubEval.mode !== 'NEARBY')) {
    smartReturnCand = SmartReturnManager.evaluateCandidate(lastKnownPos, activeStopContext);
  }
  if (smartReturnCand) {
    const { trip, returnGroup, returnStop, returnStopIdx, returnStopKey, walkDistM, walkMins } = smartReturnCand;
    const dispBadge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(returnGroup) : returnGroup.routeNo;
    const retOriginLabel = isZh ? (trip.originNameTc || trip.originNameEn) : (trip.originNameEn || trip.originNameTc);
    const stopLabel = getStopName(returnStop);
    const walkUrl = `https://www.google.com/maps/dir/?api=1&destination=${parseFloat(returnStop.latitude)},${parseFloat(returnStop.longitude)}&travelmode=walking`;

    html += `
      <div class="smart-return-card" id="smartReturnCard" style="display:none;" onclick="if(!isUserSelectingText())openRouteDetail('${escapeJsAttr(returnGroup.key)}', '${escapeJsAttr(returnStopKey)}', ${returnStopIdx})">
        <div class="smart-return-top">
          <span class="smart-return-badge">↩️ ${isZh ? '快捷回程' : 'QUICK RETURN'}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:0.70rem;color:var(--text-sub);font-weight:600;">🚶 ${walkMins}${t('minsUnit')} • ${walkDistM}m</span>
            <button class="smart-return-dismiss" onclick="dismissSmartReturnCard(event)" title="Dismiss">✕</button>
          </div>
        </div>
        <div class="smart-return-body">
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:baseline;gap:8px;">
              <span style="font-weight:800;font-size:1.22rem;color:${returnGroup.colorHex || 'var(--ios-blue)'};">${escapeHtml(dispBadge)}</span>
              <span style="font-weight:700;font-size:0.94rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${isZh ? `返回 ${escapeHtml(retOriginLabel)}` : `Return to ${escapeHtml(retOriginLabel)}`}</span>
            </div>
            <div style="font-size:0.74rem;color:var(--text-sub);margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;" id="smart-return-sub-line">
              <span>${isZh ? `上車站：${escapeHtml(stopLabel)}（本機路線記憶）` : `Board @ ${escapeHtml(stopLabel)} • Saved on device`}</span>
            </div>
          </div>
          <div class="route-eta-col" id="smart-return-eta-col" style="min-width:84px;">
            <div class="eta-time" style="color:var(--text-sub);font-size:1.1rem;">···</div>
          </div>
        </div>
        <div class="smart-return-actions" onclick="event.stopPropagation()">
          <a href="${walkUrl}" target="_blank" rel="noopener" class="stop-action-pill" style="flex:0 0 auto;padding:5px 11px;font-size:0.71rem;">🚶 ${isZh ? `步行去車站 (${walkDistM}m) ↗` : `Walk to Stop (${walkDistM}m) ↗`}</a>
        </div>
      </div>`;
  }

  return { html, smartReturnCand };
}

function updateMainStopHeaderDisplay(clusterBaysCount = 1) {
  const txtEl = document.getElementById('currentLocationText');
  const distEl = document.getElementById('currentStopDistPill');
  const stopObj = stopMapIndex.get(currentNearestStopKey);
  if (!txtEl) return;
  if (!stopObj) {
    txtEl.innerText = t('noNearbyStations');
    if (distEl) distEl.style.display = 'none';
    return;
  }
  const isZh = (currentLang === 'zh');
  let dispStopName = getStopName(stopObj);
  if (stopObj.mode === 'FERRY') {
    const canon = normStationLookupKey(stopObj.stopName_e);
    if (canon === 'central') dispStopName = isZh ? '中環渡輪碼頭 (2–8號碼頭)' : 'Central Ferry Piers';
    else if (canon === 'muiwo') dispStopName = isZh ? '梅窩渡輪碼頭' : 'Mui Wo Ferry Pier';
  }
  const distTag = getStopDistrictTag(stopObj);
  const clusterBadge = (activeAppMode === 'BUS' && clusterBaysCount > 1)
    ? `<span class="district-tag" style="background:rgba(0,122,255,0.12);color:var(--ios-blue);font-weight:700;">+${clusterBaysCount - 1} ${isZh ? '鄰近站台' : 'bays'}</span>`
    : '';
  txtEl.innerHTML = `${escapeHtml(dispStopName)}${distTag ? ` <span style="opacity:0.55;font-weight:500;font-size:0.86rem;">· ${escapeHtml(distTag)}</span>` : ''} ${clusterBadge}`;
  if (distEl && lastKnownPos?.hasLiveFix && Number(lastKnownPos.acc) <= 450) {
    const dStr = formatStopDistance(stopObj);
    if (dStr) { distEl.innerText = dStr; distEl.style.display = 'inline-block'; }
    else distEl.style.display = 'none';
  } else if (distEl) {
    distEl.style.display = 'none';
  }
}

function refreshGPS(timeoutMs = 3500, highAcc = true) {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(lastKnownPos);
    navigator.geolocation.getCurrentPosition(
      pos => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 15;
        if (Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0) {
          userCompassHeadingDeg = pos.coords.heading;
        }
        const isRealGps = acc <= 450;
        if (isRealGps) {
          SignalHealthMonitor.recordGpsFix(acc);
          lastKnownPos = { lat, lon, acc: Math.round(acc), hasLiveFix: true };
          SafeStorage.setItem('transit_last_gps_pos_v2', JSON.stringify(lastKnownPos));
        } else if (!lastKnownPos && acc <= 1500) {
          lastKnownPos = { lat, lon, acc: Math.round(acc), hasLiveFix: false };
        }
        if (typeof updateUserMarkers === 'function') updateUserMarkers();
        resolve(lastKnownPos);
      },
      () => resolve(lastKnownPos),
      { enableHighAccuracy: highAcc, timeout: timeoutMs, maximumAge: 5000 }
    );
  });
}

let gpsWatchId = null;
function autoAcquireLiveGpsAndSnap(forceSnap = false) {
  refreshGPS(3200, true).then(pos => {
    if (pos && pos.hasLiveFix) {
      const changed = syncNearestStopFromGPS(pos.lat, pos.lon, forceSnap);
      if (changed && currentView === 'main') renderMainNearby(false);
    }
  });
  if (!gpsWatchId && navigator.geolocation) {
    gpsWatchId = navigator.geolocation.watchPosition(
      pos => {
        const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 15;
        const isRealGps = acc <= 450;
        if (!isCompassListening && Number.isFinite(pos.coords.heading) && pos.coords.heading >= 0) {
          userCompassHeadingDeg = pos.coords.heading;
        }
        if (isRealGps) {
          SignalHealthMonitor.recordGpsFix(acc);
          lastKnownPos = { lat, lon, acc: Math.round(acc), hasLiveFix: true };
          SafeStorage.setItem('transit_last_gps_pos_v2', JSON.stringify(lastKnownPos));
          if (typeof updateUserMarkers === 'function') updateUserMarkers();
          if (Date.now() > userManualStopBrowseUntilMs) {
            const changed = syncNearestStopFromGPS(lat, lon, false);
            if (currentView === 'main' && !isStopSearchOpen()) {
              if (changed) renderMainNearby(false);
              else updateMainStopHeaderDisplay();
            }
          }
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 2500, timeout: 6000 }
    );
  }
}

let mainNearbyRenderToken = 0;

function cycleStopDirectionFilter() {
  triggerHaptic(10);
  if (stopDirectionFilterMode === 'BOTH') stopDirectionFilterMode = 'OUTBOUND';
  else if (stopDirectionFilterMode === 'OUTBOUND') stopDirectionFilterMode = 'INBOUND';
  else stopDirectionFilterMode = 'BOTH';

  const txt = document.getElementById('dirFilterToggleText');
  const isZh = (currentLang === 'zh');
  if (txt) {
    if (stopDirectionFilterMode === 'BOTH') txt.innerText = isZh ? '⇄ 雙向' : '⇄ Both';
    else if (stopDirectionFilterMode === 'OUTBOUND') txt.innerText = isZh ? '➔ A側' : '➔ Dir A';
    else txt.innerText = isZh ? '⬅ B側' : '⬅ Dir B';
  }
  renderMainNearby(false);
}

let _selfHealInFlight = false;
async function forceSelfHealDatabaseAndReload() {
  if (_selfHealInFlight) return;
  _selfHealInFlight = true;
  try {
    if (navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
    }
    if (window.caches?.keys) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
    const r = await fetch(`bus_index.min.json?v=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) {
      const rawJson = await r.json();
      await window.__TRANSIT_IDB__.set('bus_index_data', rawJson);
      await window.__TRANSIT_IDB__.set('bus_index_meta', {
        schemaVersion: window.__TRANSIT_SCHEMA_VERSION__,
        lastUpdated: rawJson.lastUpdated || '',
        tdLastUpdated: rawJson.tdLastUpdated || ''
      });
      const db = window.__UNPACK_TRANSIT_DB__(rawJson);
      if (db) {
        routeStopsCache = db.routeStopsCache || {};
        groupedRoutes = Array.isArray(db.groupedRoutes) ? db.groupedRoutes : [];
        filterToMainlineFerriesOnly();
        initRouteMapFast();
        if (lastKnownPos) syncNearestStopFromGPS(lastKnownPos.lat, lastKnownPos.lon, true);
        _selfHealInFlight = false;
        renderMainNearby(false);
        return;
      }
    }
  } catch (e) {}
  _selfHealInFlight = false;
}

async function renderMainNearby(isSilentRefresh = false) {
  const listEl = document.getElementById('mainRouteList');
  if (!listEl || isStopSearchOpen()) return;
  if (!routeMapIndex.size) initRouteMapFast();

  buildNearbyStopsFast(lastKnownPos);
  let centerStop = stopMapIndex.get(currentNearestStopKey);
  if (!centerStop || (centerStop.mode || 'BUS') !== activeAppMode) {
    centerStop = nearbyStopsList[0];
  }
  if (!centerStop) {
    if (isHydratingInitialData && !window.__INITIAL_STOPS_GPS_RESOLVED__) {
      listEl.innerHTML = renderBootLoadingSkeletonHtml(4);
      return;
    }
    if (allStops.filter(s => (s.mode || 'BUS') === 'BUS').length === 0) {
      if (isHydratingInitialData) {
        listEl.innerHTML = renderBootLoadingSkeletonHtml(4);
        forceSelfHealDatabaseAndReload();
        return;
      }
      forceSelfHealDatabaseAndReload();
    }
    setHydratingInitialData(false);
    listEl.innerHTML = `<div class="text-center">${t('noNearbyStations')}</div>` + renderMtrStyleReportFooterHtml();
    return;
  }
  if (currentNearestStopKey !== centerStop.stopKey) {
    activeClusterSubStopKey = 'ALL';
  }
  currentNearestStopKey = centerStop.stopKey;

  const centerBase = getBaseStopNameKey(centerStop.stopName_e);
  const centerCore = getNormalizedVillageOrStopKey(centerStop.stopName_e);
  const centerPierCanon = normStationLookupKey(centerStop.stopName_e);
  const centerLat = parseFloat(centerStop.latitude), centerLon = parseFloat(centerStop.longitude);
  const isGpsFollowMode = Date.now() >= userManualStopBrowseUntilMs && lastKnownPos?.hasLiveFix && Number(lastKnownPos.acc) <= 450;
  const refLat = isGpsFollowMode ? lastKnownPos.lat : centerLat;
  const refLon = isGpsFollowMode ? lastKnownPos.lon : centerLon;

  const rawClusterStops = allStops.filter(s => {
    if ((s.mode || 'BUS') !== activeAppMode) return false;
    const sLat = parseFloat(s.latitude), sLon = parseFloat(s.longitude);
    if (!isValidRailOrFerryCoord(sLat, sLon)) return false;
    const dCenterKm = calculateDistanceKm(centerLat, centerLon, sLat, sLon);
    const dRefKm = calculateDistanceKm(refLat, refLon, sLat, sLon);

    if (activeAppMode === 'FERRY') {
      return dCenterKm <= 0.85 || (centerPierCanon && normStationLookupKey(s.stopName_e) === centerPierCanon);
    }
    if (window.crossesWaterBarrier(centerLat, centerLon, sLat, sLon)) return false;

    if (Math.min(dCenterKm, dRefKm) <= 0.25) return true;
    if (dCenterKm <= 0.35) {
      const sb = getBaseStopNameKey(s.stopName_e);
      const sc = getNormalizedVillageOrStopKey(s.stopName_e);
      return sb === centerBase || (sc && sc === centerCore);
    }
    return false;
  }).sort((a, b) => {
    const dA = calculateDistanceKm(refLat, refLon, parseFloat(a.latitude), parseFloat(a.longitude));
    const dB = calculateDistanceKm(refLat, refLon, parseFloat(b.latitude), parseFloat(b.longitude));
    return dA - dB;
  });

  const clusterBaysMap = new Map();
  rawClusterStops.forEach(s => {
    const bKey = getBaseStopNameKey(s.stopName_e);
    if (!clusterBaysMap.has(bKey)) clusterBaysMap.set(bKey, s);
  });
  const uniqueClusterBays = Array.from(clusterBaysMap.values());
  if (activeClusterSubStopKey !== 'ALL' && !clusterBaysMap.has(activeClusterSubStopKey)) {
    activeClusterSubStopKey = 'ALL';
  }

  updateMainStopHeaderDisplay(uniqueClusterBays.length);

  let activeClusterStops = activeClusterSubStopKey === 'ALL'
    ? rawClusterStops
    : rawClusterStops.filter(s => getBaseStopNameKey(s.stopName_e) === activeClusterSubStopKey);

  // GPS Direction Toggle Fix: when Dir A / Dir B is toggled, aggregate all opposite-side twin poles
  // sharing the normalized stop name within 200m (0.20 km) so users don't get empty lists across the street.
  if (stopDirectionFilterMode !== 'BOTH' && typeof window.collectDirectionClusterStops === 'function') {
    const dirAnchor = (activeClusterSubStopKey === 'ALL') ? centerStop : (activeClusterStops[0] || centerStop);
    const pairedStops = window.collectDirectionClusterStops(allStops, dirAnchor, activeAppMode, 0.20, { refLat, refLon });
    if (pairedStops.length > 0) {
      const mergedMap = new Map();
      activeClusterStops.forEach(s => mergedMap.set(s.stopKey || getGlobalStopKey(s), s));
      pairedStops.forEach(s => {
        const k = s.stopKey || getGlobalStopKey(s);
        if (!mergedMap.has(k)) mergedMap.set(k, s);
      });
      activeClusterStops = Array.from(mergedMap.values()).sort((a, b) => {
        const dA = calculateDistanceKm(refLat, refLon, parseFloat(a.latitude), parseFloat(a.longitude));
        const dB = calculateDistanceKm(refLat, refLon, parseFloat(b.latitude), parseFloat(b.longitude));
        return dA - dB;
      });
    }
  }

  const hkNow = getHongKongNow();
  const minsNow = hkNow.getHours() * 60 + hkNow.getMinutes();
  const isOvernightWin = (minsNow <= 360 || minsNow >= 1410);
  const candidatePairs = [];
  const seenRouteDirSig = new Set();

  activeClusterStops.forEach(st => {
    const stBase = getBaseStopNameKey(st.stopName_e);
    const stPairedKey = (typeof window.normalizePairedStopNameKey === 'function')
      ? window.normalizePairedStopNameKey(st.stopName_e, st.name_tc)
      : stBase;
    const stPierCanon = normStationLookupKey(st.stopName_e);
    (st.groupKeys || []).forEach(gk => {
      const g = routeMapIndex.get(gk);
      if (!g || (g.mode || 'BUS') !== activeAppMode) return;
      if ((!g.mode || g.mode === 'BUS') && !isRouteOperatingToday(g, isOvernightWin, hkNow)) return;

      const bCode = extractRouteBoundCode(g);
      if (stopDirectionFilterMode !== 'BOTH') {
        if (stopDirectionFilterMode === 'OUTBOUND' && bCode !== 'O') return;
        if (stopDirectionFilterMode === 'INBOUND' && bCode !== 'I') return;
      }

      const gStops = getStopsForGroup(g, st.stopKey);
      const allowFinalStop = isCircularRoute(g, gStops);
      const isPenultimateDualBranch = (g.mode === 'MTR' && gStops.length >= 3 && isParallelRailTerminusPair(gStops[gStops.length - 2]?.stopId, gStops[gStops.length - 1]?.stopId));
      const maxBoardIdx = isPenultimateDualBranch ? gStops.length - 3 : gStops.length - 2;

      // Match exact source pole stopKey first so paired opposite-side poles preserve their true physical stop & walking distance
      let boardingIdx = gStops.findIndex((x, idx) =>
        (idx <= maxBoardIdx || gStops.length === 1 || allowFinalStop) &&
        x.stopKey === st.stopKey
      );
      if (boardingIdx === -1) {
        boardingIdx = gStops.findIndex((x, idx) =>
          (idx <= maxBoardIdx || gStops.length === 1 || allowFinalStop) &&
          (
            getBaseStopNameKey(x.stopName_e) === stBase ||
            (stPairedKey && typeof window.normalizePairedStopNameKey === 'function' && window.normalizePairedStopNameKey(x.stopName_e, x.name_tc) === stPairedKey) ||
            (g.mode === 'FERRY' && stPierCanon && normStationLookupKey(x.stopName_e) === stPierCanon)
          )
        );
      }
      if (boardingIdx === -1) return;
      if (g.mode === 'FERRY' && !allowFinalStop && boardingIdx >= gStops.length - 1) return;

      const routeDirSig = g.mode === 'FERRY'
        ? `FERRY_${g.company}_${normStationLookupKey(st.stopName_e)}_${normStationLookupKey(g.dest_e)}`
        : `${g.company}_${g.routeNo}_${bCode}_${getBaseStopNameKey(g.dest_e)}`;
      if (seenRouteDirSig.has(routeDirSig)) return;

      seenRouteDirSig.add(routeDirSig);
      candidatePairs.push({ group: g, stop: gStops[boardingIdx] || st, sourceStop: st, boardingIdx });
    });
  });

  const isZh = (currentLang === 'zh');
  const activeAnchorStop = (activeClusterSubStopKey === 'ALL') ? centerStop : (activeClusterStops[0] || centerStop);
  const smartTop = buildSmartTopOverlayHtml({
    centerStop: activeAnchorStop,
    activeStops: activeClusterStops,
    activeSubStopKey: activeClusterSubStopKey
  });
  const bayFilterBarHtml = (activeAppMode === 'BUS' && uniqueClusterBays.length > 1)
    ? `<div class="ferry-hub-tabs" style="padding:8px 12px 2px 12px; max-width:760px; margin:0 auto; width:100%;">
         <button class="ferry-hub-tab ${activeClusterSubStopKey === 'ALL' ? 'active' : ''}" onclick="selectClusterSubStopFilter('ALL')">
           ${isZh ? `全部鄰近站 (${uniqueClusterBays.length})` : `All Nearby (${uniqueClusterBays.length})`}
         </button>
         ${uniqueClusterBays.map(bay => {
           const bKey = getBaseStopNameKey(bay.stopName_e);
           const bDist = formatStopDistance(bay);
           return `<button class="ferry-hub-tab ${activeClusterSubStopKey === bKey ? 'active' : ''}" onclick="selectClusterSubStopFilter('${escapeJsAttr(bKey)}')">
             ${escapeHtml(getStopName(bay))}${bDist ? ` · ${escapeHtml(bDist)}` : ''}
           </button>`;
         }).join('')}
       </div>`
    : '';

  if (!candidatePairs.length) {
    if (isHydratingInitialData && !window.__INITIAL_STOPS_GPS_RESOLVED__) {
      listEl.innerHTML = renderBootLoadingSkeletonHtml(4);
      return;
    }
    setHydratingInitialData(false);
    listEl.innerHTML = smartTop.html + bayFilterBarHtml + `<div class="text-center">${t('noRoutesFound')}</div>` + renderMtrStyleReportFooterHtml();
    const srCardEmpty = document.getElementById('smartReturnCard');
    if (srCardEmpty) srCardEmpty.style.display = '';
    return;
  }

  const smartSig = smartTop.smartReturnCand ? smartTop.smartReturnCand.returnStopKey : 'NONE';
  const smartEnSig = (typeof SmartReturnManager !== 'undefined' && SmartReturnManager.isEnabled) ? (SmartReturnManager.isEnabled() ? '1' : '0') : '0';
  const hubOv = typeof SavedHubsManager !== 'undefined' ? SavedHubsManager.manualOverrideMode : 'AUTO';
  const savedHubsObj = typeof SavedHubsManager !== 'undefined' ? SavedHubsManager.getHubs() : {};
  const hubSig = `${savedHubsObj.home?.stopKey || ''}_${savedHubsObj.work?.stopKey || ''}`;
  const sigKey = `${activeAppMode}|${centerStop.stopKey}|${activeClusterSubStopKey}|${candidatePairs.length}|${stopDirectionFilterMode}|${currentLang}|${smartSig}|${smartEnSig}|${hubOv}|${hubSig}`;
  if (!isSilentRefresh || lastRenderedCenterStopKey !== sigKey || !listEl.querySelector('.route-list-item')) {
    lastRenderedCenterStopKey = sigKey;
    listEl.innerHTML = smartTop.html + bayFilterBarHtml + `<div id="mainRouteCardsWrap">` + candidatePairs.map((pair, idx) => {
      const g = pair.group, st = pair.stop, distStop = pair.sourceStop || pair.stop;
      const isFerry = (g.mode === 'FERRY');
      const escKey = escapeJsAttr(st.stopKey || getGlobalStopKey(st));
      const dispBadge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(g) : g.routeNo;
      const cleanDest = cleanFerryLabel(getRouteName(g)).replace(/\s+at\s+.*$/i, '').split(',')[0].trim();
      const pierTag = isFerry ? extractPierNumberBadge(st.stopName_e, st.name_tc, g.dest_e) : '';
      const pierBadgeHtml = pierTag ? ` <span class="ferry-pier-tag" style="margin-left:4px;">${escapeHtml(pierTag)}</span>` : '';
      const stDist = formatStopDistance(distStop);
      const stopSubLabel = `${getStopName(st)}${stDist ? ` · ${stDist}` : ''}`;
      return `
        <div class="route-list-item ${isFerry ? 'ferry-card' : ''}" id="main-route-card-${idx}" data-sort-ms="9999999999999" onclick="if(!isUserSelectingText())openRouteDetail('${escapeJsAttr(g.key)}', '${escKey}', ${pair.boardingIdx})">
          <div class="route-no-col">
            <div class="route-no-text" style="color:${g.colorHex || 'var(--text-main)'};">${escapeHtml(dispBadge)}</div>
            <div class="route-co-tag">${escapeHtml(getCompanyName(g))}</div>
          </div>
          <div class="route-info-col">
            <div class="route-dest"><span class="to-prefix">${t('to')}</span><span>${escapeHtml(cleanDest)}</span>${pierBadgeHtml}</div>
            <div class="route-sub" id="main-route-sub-${idx}"><span>${escapeHtml(stopSubLabel)}</span></div>
          </div>
          <div class="route-eta-col" id="main-route-eta-${idx}">
            <div class="eta-time" style="color:var(--text-sub);font-size:1.1rem;">···</div>
          </div>
        </div>`;
    }).join('') + `</div>` + renderMtrStyleReportFooterHtml();
  }

  const myToken = ++mainNearbyRenderToken;
  let srFirstArr = null;
  const resolvedNearbyArrivals = [];

  const smartReturnPromise = smartTop.smartReturnCand ? (async () => {
    const sr = smartTop.smartReturnCand;
    const arrs = await fetchEtaRaw(sr.returnGroup, sr.returnStopKey, false, Date.now(), sr.returnStopIdx, true);
    if (myToken !== mainNearbyRenderToken || currentView !== 'main') return;
    const etaCol = document.getElementById('smart-return-eta-col');
    const subLine = document.getElementById('smart-return-sub-line');
    const srCard = document.getElementById('smartReturnCard');
    if (!etaCol) return;
    if (arrs[0]) {
      srFirstArr = { targetMs: arrs[0].targetMs, groupKey: sr.returnGroup.key };
      const ui = formatEtaUI(arrs[0], sr.returnGroup);
      const nowMs = Date.now();
      const followUps = arrs.slice(1, 3).map(nx => {
        const m = Math.max(1, Math.floor((nx.targetMs - nowMs) / 60000));
        return `${m}${t('minsUnit')}`;
      });
      const subParts = [ui.clockStr, ...followUps].filter(Boolean).join(' · ');
      etaCol.innerHTML = `<div class="eta-time">${ui.mainTimeStr}</div>${subParts ? `<div class="eta-clock-sub">${subParts}</div>` : ''}`;
      if (subLine && arrs[0].loadEstimate) {
        const stopLabel = getStopName(sr.returnStop);
        subLine.innerHTML = `${formatLoadPillHtml(arrs[0].loadEstimate, true)}<span>${isZh ? `上車站：${escapeHtml(stopLabel)}` : `Board @ ${escapeHtml(stopLabel)}`}</span>`;
      }
      // If imminent (<= 20m), reveal immediately without waiting for all nearby cards
      const srWaitMins = (arrs[0].targetMs - nowMs) / 60000;
      if (srCard && srWaitMins <= (SmartReturnManager.MAX_WAIT_WITH_IMMINENT_LOCAL_MINS || 20)) {
        srCard.style.display = '';
      }
    } else {
      etaCol.innerHTML = `<div class="eta-time" style="color:var(--text-sub);">-</div>`;
    }
  })() : Promise.resolve();

  await Promise.all([
    smartReturnPromise,
    ...candidatePairs.map(async (pair, idx) => {
      const g = pair.group, st = pair.stop;
      const stKey = st.stopKey || getGlobalStopKey(st);
      const arrs = await fetchEtaRaw(g, stKey, false, Date.now(), pair.boardingIdx);
      if (myToken !== mainNearbyRenderToken || currentView !== 'main') return;
      const etaEl = document.getElementById(`main-route-eta-${idx}`);
      const subEl = document.getElementById(`main-route-sub-${idx}`);
      const cardEl = document.getElementById(`main-route-card-${idx}`);
      if (!etaEl || !subEl || !cardEl) return;

      const stDist = formatStopDistance(st);
      const stopSubLabel = `${getStopName(st)}${stDist ? ` · ${stDist}` : ''}`;
      const isDiffBayFromHeader = getBaseStopNameKey(st.stopName_e) !== centerBase;

      if (arrs[0]) {
        const stLat = parseFloat(st.latitude ?? st.lat), stLon = parseFloat(st.longitude ?? st.lon);
        const pairDistM = (lastKnownPos?.hasLiveFix && isValidRailOrFerryCoord(stLat, stLon))
          ? Math.round(calculateDistanceKm(lastKnownPos.lat, lastKnownPos.lon, stLat, stLon) * 1000)
          : null;
        resolvedNearbyArrivals.push({ targetMs: arrs[0].targetMs, distM: pairDistM, groupKey: g.key });

        const ui = formatEtaUI(arrs[0], g);
        const nowMs = Date.now();
        const nextFollowUps = arrs.slice(1, 3).map(nx => {
          const m = Math.max(1, g?.mode === 'MTR' ? Math.round((nx.targetMs - nowMs) / 60000) : Math.floor((nx.targetMs - nowMs) / 60000));
          return m >= 120 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}${t('minsUnit')}`;
        });
        const subTimeParts = [ui.clockStr, ...nextFollowUps].filter(Boolean).join(' · ');
        // Compact Bus/MTR/LRT/Ferry load factor pill
        const loadPillHtml = arrs[0].loadEstimate
          ? formatLoadPillHtml(arrs[0].loadEstimate, true)
          : '';

        etaEl.innerHTML = `<div class="eta-time">${ui.mainTimeStr}</div>${subTimeParts ? `<div class="eta-clock-sub">${subTimeParts}</div>` : ''}`;
        const subText = (activeAppMode === 'BUS' && (uniqueClusterBays.length > 1 || isDiffBayFromHeader))
          ? `${stopSubLabel}${arrs[0].remark ? ` · ${arrs[0].remark}` : ''}`
          : (arrs[0].remark || stopSubLabel);
        subEl.innerHTML = `${loadPillHtml}<span>${escapeHtml(subText)}</span>`;
        cardEl.classList.remove('inactive-route');
        const sortScore = arrs[0].targetMs + (arrs[0].isSched ? 90000 : 0);
        cardEl.setAttribute('data-sort-ms', String(sortScore));
      } else {
        etaEl.innerHTML = `<div class="eta-time" style="color:var(--text-sub);">-</div>`;
        subEl.innerHTML = `<span>${escapeHtml(stopSubLabel)}</span>`;
        cardEl.classList.add('inactive-route');
        cardEl.setAttribute('data-sort-ms', '9999999999999');
      }
    })
  ]);

  if (window.__INITIAL_STOPS_GPS_RESOLVED__) {
    setHydratingInitialData(false);
  }
  if (myToken !== mainNearbyRenderToken || currentView !== 'main') return;

  if (smartTop.smartReturnCand) {
    const srCard = document.getElementById('smartReturnCard');
    if (srCard) {
      const check = (typeof SmartReturnManager !== 'undefined' && SmartReturnManager.shouldSuppressByWaitTime)
        ? SmartReturnManager.shouldSuppressByWaitTime(srFirstArr, resolvedNearbyArrivals, smartTop.smartReturnCand.rawDistM, Date.now())
        : { suppress: false };
      if (check.suppress) {
        srCard.remove();
      } else {
        srCard.style.display = '';
      }
    }
  }

  const wrapEl = document.getElementById('mainRouteCardsWrap');
  if (wrapEl) {
    const currentChildren = Array.from(wrapEl.children);
    const sorted = [...currentChildren].sort((a, b) => Number(a.getAttribute('data-sort-ms') || 9999999999999) - Number(b.getAttribute('data-sort-ms') || 9999999999999));
    const orderChanged = sorted.some((el, i) => el !== currentChildren[i]);
    if (orderChanged) {
      sorted.forEach(c => wrapEl.appendChild(c));
    }
  }
}

function isStopSearchOpen() {
  const c = document.getElementById('stopSearchResultsContainer');
  return Boolean(c && c.style.display !== 'none');
}

function focusStopSearchInput() {
  const inp = document.getElementById('stopSearchInput');
  if (inp) { inp.focus(); onStopSearchInput(); }
}

function clearStopSearchInput() {
  const inp = document.getElementById('stopSearchInput');
  const clr = document.getElementById('stopSearchClearBtn');
  const res = document.getElementById('stopSearchResultsContainer');
  const main = document.getElementById('mainRouteList');
  if (inp) inp.value = '';
  if (clr) clr.style.display = 'none';
  if (res) res.style.display = 'none';
  if (main) main.style.display = 'block';
  updateTopBackButtonVisibility();
}

let lrtSearchDrawerOpen = false;
let activeFerryHubTab = 'CENTRAL';

function toggleLrtSearchDrawer(ev) {
  if (ev) ev.stopPropagation();
  triggerHaptic(10);
  lrtSearchDrawerOpen = !lrtSearchDrawerOpen;
  document.getElementById('lrtQuickHubDrawer')?.classList.toggle('open', lrtSearchDrawerOpen);
}

function setFerryHubTab(tab, ev) {
  if (ev) ev.stopPropagation();
  triggerHaptic(8);
  activeFerryHubTab = tab;
  onStopSearchInput();
}

function onStopSearchInput() {
  const inp = document.getElementById('stopSearchInput');
  const clr = document.getElementById('stopSearchClearBtn');
  const res = document.getElementById('stopSearchResultsContainer');
  const main = document.getElementById('mainRouteList');
  if (!inp || !res || !main) return;
  const q = inp.value.trim().toLowerCase();
  const isZh = (currentLang === 'zh');
  if (clr) clr.style.display = 'block';
  res.style.display = 'block';
  main.style.display = 'none';
  updateTopBackButtonVisibility();

  let html = '';

  if (!q && recentStopSearches.length > 0) {
    html += `
      <div class="section-bar">
        <span>${isZh ? '最近搜尋記錄' : 'RECENT SEARCHES'}</span>
        <button class="header-pill-btn" onclick="recentStopSearches=[];SafeStorage.setItem('transit_recent_stops_v1','[]');onStopSearchInput();" style="height:26px;padding:0 9px;font-size:0.66rem;">${isZh ? '清除' : 'Clear'}</button>
      </div>
      <div class="recent-search-bar" style="flex-wrap:nowrap; overflow-x:auto;">
        ${recentStopSearches.slice(0, 6).map(r => {
          const escK = escapeJsAttr(r.stopKey || '');
          return `<div class="recent-search-chip" style="flex-shrink:0;" onclick="if(!isUserSelectingText())selectStopFromSearch('${escK}')"><span>${escapeHtml(stripPlatformCodeFromDisplay(isZh && r.name_tc ? r.name_tc : r.stopName_e))}</span></div>`;
        }).join('')}
      </div>
    `;
  }

  if (!q && activeAppMode === 'MTR' && window.QUICK_MTR_LINES?.length) {
    html += `<div class="section-bar"><span>${isZh ? `港鐵 (${window.QUICK_MTR_LINES.length}條路綫) 及輕鐵 (${(window.QUICK_LRT_LINES || []).length}條路綫)` : `MTR (${window.QUICK_MTR_LINES.length} LINES) & LIGHT RAIL (${(window.QUICK_LRT_LINES || []).length} ROUTES)`}</span></div>`;
    html += `<div class="quick-line-grid">` + window.QUICK_MTR_LINES.map(l => `
      <div class="quick-line-chip" style="border-left: 4px solid ${l.color || 'var(--ios-blue)'} !important;" onclick="if(!isUserSelectingText()){clearStopSearchInput(); openRouteDetail('MTR_${escapeJsAttr(l.key)}_O');}">
        <span style="color:${l.color || 'var(--text-main)'};">${escapeHtml(isZh ? (l.name_tc || l.badge) : l.badge)}</span>
        <span style="font-size:0.68rem;color:var(--text-sub);font-weight:500;">${escapeHtml(isZh ? l.badge : (l.name_en || l.badge))}</span>
      </div>
    `).join('') + (window.QUICK_LRT_LINES?.length ? `
      <div class="quick-line-chip" style="border-left: 4px solid var(--ios-indigo) !important;" onclick="toggleLrtSearchDrawer(event)">
        <span style="color:var(--ios-indigo);">${isZh ? '輕鐵網絡 ▾' : 'Light Rail Network ▾'}</span>
        <span style="font-size:0.65rem;color:var(--text-sub);font-weight:500;">${isZh ? `全${window.QUICK_LRT_LINES.length}條路綫 (展開)` : `All ${window.QUICK_LRT_LINES.length} Routes (Tap)`}</span>
      </div>` : '') + `</div>`;

    if (window.QUICK_LRT_LINES?.length) {
      html += `<div id="lrtQuickHubDrawer" class="lrt-hub-drawer ${lrtSearchDrawerOpen ? 'open' : ''}">` + window.QUICK_LRT_LINES.map(lr => `
        <div class="quick-line-chip" style="border-left: 3.5px solid var(--ios-indigo) !important;" onclick="if(!isUserSelectingText()){clearStopSearchInput(); openRouteDetail('LRT_${escapeJsAttr(lr.key)}_O');}">
          <span style="color:var(--ios-indigo);">${escapeHtml(lr.badge)}</span>
          <span style="font-size:0.64rem;color:var(--text-sub);font-weight:500;">${escapeHtml(isZh ? lr.name_tc : lr.name_en)}</span>
        </div>
      `).join('') + `</div>`;
    }
  } else if (!q && activeAppMode === 'FERRY' && window.QUICK_FERRY_LINES?.length) {
    const CENTRAL_PIER_MAP = {
      'discovery bay': ['Pier 3', '3號碼頭'],
      'sok kwu wan':   ['Pier 4', '4號碼頭'],
      'yung shue wan': ['Pier 4', '4號碼頭'],
      'cheung chau':   ['Pier 5', '5號碼頭'],
      'mui wo':        ['Pier 6', '6號碼頭'],
      'peng chau':     ['Pier 6', '6號碼頭'],
      'ma wan':        ['Pier 2', '2號碼頭'],
      'tsim sha tsui': ['Pier 7', '7號碼頭'],
      'hung hom':      ['Pier 8', '8號碼頭']
    };

    const normFerryEndpoint = (s) => cleanFerryLabel(s)
      .replace(/\s+at\s+.*$/i, '')
      .split(',')[0]
      .replace(/\b(central\s*(?:ferry\s*)?pier\s*(?:no\.?\s*)?\d+|ferry\s*pier|public\s*pier|ferry\s*terminal|promenade\s*landing\s*steps|landing\s*steps|new\s*development\s*ferry\s*pier|pier\s*no\.?\s*\d+|pier)\b/gi, m => /central/i.test(m) ? 'Central' : '')
      .replace(/(中環[一二三四五六七八九十\d]+號碼頭|新發展碼頭|海濱長廊登岸梯級|渡輪碼頭|公眾碼頭|客運碼頭|登岸梯級|碼頭)/g, m => m.includes('中環') ? '中環' : '')
      .replace(/\s+/g, ' ').trim();

    const seenFerrySig = new Set();
    const buckets = { CENTRAL: [], HARBOUR: [], LANTAU: [] };

    window.QUICK_FERRY_LINES.forEach(f => {
      const partsEn = String(f.title_en || f.badge || '').split(/\s*⟷\s*/).map(normFerryEndpoint);
      const partsZh = String(f.title_zh || f.badge_tc || f.title_en || '').split(/\s*⟷\s*/).map(normFerryEndpoint);
      if (partsEn.length < 2) return;

      const sig = [...partsEn].map(x => x.toLowerCase()).sort().join('⟷');
      if (seenFerrySig.has(sig)) return;
      seenFerrySig.add(sig);

      const joined = partsEn.join(' ⟷ ');
      const low = joined.toLowerCase();

      if (partsEn.some(p => /^central$/i.test(p)) && /cheung chau|mui wo|peng chau|yung shue wan|sok kwu wan|discovery bay|ma wan/.test(low)) {
        const destIdx = /^central$/i.test(partsEn[0]) ? 1 : 0;
        const destEn = partsEn[destIdx], destZh = partsZh[destIdx] || destEn;
        const pierHit = Object.entries(CENTRAL_PIER_MAP).find(([k]) => destEn.toLowerCase().includes(k));
        buckets.CENTRAL.push({
          ...f,
          shortEn: destEn,
          shortZh: destZh,
          tag: pierHit ? (isZh ? pierHit[1][1] : pierHit[1][0]) : (isZh ? '中環出發' : 'Central')
        });
      } else if (/tsim sha tsui|wan chai|north point|hung hom|kowloon city|kwun tong|sai wan ho|sam ka tsuen/.test(low)) {
        buckets.HARBOUR.push({ ...f, shortEn: partsEn.join(' ⟷ '), shortZh: partsZh.join(' ⟷ '), tag: '' });
      } else {
        const isTuenMun = /tuen mun|tai o|tung chung|sha lo wan/.test(low);
        buckets.LANTAU.push({
          ...f,
          shortEn: partsEn.join(' ⟷ '),
          shortZh: partsZh.join(' ⟷ '),
          tag: isTuenMun ? (isZh ? '屯門/大澳' : 'TM/Tai O') : (isZh ? '橫水渡' : 'Inter-Island')
        });
      }
    });

    const tabs = [
      { id: 'CENTRAL', lbl: isZh ? `中環離島 (${buckets.CENTRAL.length})` : `From Central (${buckets.CENTRAL.length})` },
      { id: 'HARBOUR', lbl: isZh ? `維港航線 (${buckets.HARBOUR.length})` : `Harbour (${buckets.HARBOUR.length})` },
      { id: 'LANTAU',  lbl: isZh ? `橫水渡/大嶼山 (${buckets.LANTAU.length})` : `Inter-Islands & Lantau (${buckets.LANTAU.length})` }
    ].filter(tb => (buckets[tb.id]?.length || 0) > 0);

    if (!tabs.some(tb => tb.id === activeFerryHubTab) && tabs[0]) {
      activeFerryHubTab = tabs[0].id;
    }

    html += `<div class="ferry-hub-tabs">` + tabs.map(tb =>
      `<button class="ferry-hub-tab ${activeFerryHubTab === tb.id ? 'active' : ''}" onclick="setFerryHubTab('${tb.id}', event)">${escapeHtml(tb.lbl)}</button>`
    ).join('') + `</div>`;

    const activeList = buckets[activeFerryHubTab] || buckets.CENTRAL;
    html += `<div class="ferry-pill-grid">` + activeList.map(f => `
      <div class="ferry-compact-pill" onclick="if(!isUserSelectingText()){clearStopSearchInput(); openRouteDetail('${escapeJsAttr(f.key)}_O');}">
        <span class="ferry-pill-label">${escapeHtml(isZh ? f.shortZh : f.shortEn)}</span>
        ${f.tag ? `<span class="ferry-pier-tag">${escapeHtml(f.tag)}</span>` : `<span style="color:var(--ios-blue);font-size:0.75rem;">›</span>`}
      </div>`).join('') + `</div>`;
  }

  if (!q) {
    buildNearbyStopsFast(lastKnownPos);
    const dedupNearby = (typeof deduplicatePlannerAutocompleteStops === 'function'
      ? deduplicatePlannerAutocompleteStops(nearbyStopsList.slice(0, 48), lastKnownPos?.lat, lastKnownPos?.lon, '', 0.22)
      : nearbyStopsList).slice(0, 16);
    html += `<div class="section-bar"><span>${t('nearestStopsHeader')}</span></div>`;
    html += `<div style="margin:0 12px 16px 12px;border-radius:16px;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-white);box-shadow:var(--card-shadow);">` + dedupNearby.map(s => {
      const distTag = s._distTag || getStopDistrictTag(s);
      const dStr = Number.isFinite(s._distKm)
        ? (s._distKm < 1 ? `${Math.round(s._distKm * 1000)}m` : `${s._distKm.toFixed(1)}km`)
        : formatStopDistance(s);
      const rList = (s.mergedRouteNos && s.mergedRouteNos.length ? s.mergedRouteNos : Array.from(s.routeNos || [])).slice(0, 8);
      const escKey = escapeJsAttr(s.stopKey);
      return `
        <div class="route-list-item" onclick="if(!isUserSelectingText())selectStopFromSearch('${escKey}')">
          <div class="route-info-col">
            <div class="route-dest"><span>${escapeHtml(getStopName(s))}</span> ${distTag ? `<span class="district-tag">${escapeHtml(distTag)}</span>` : ''}</div>
            <div class="route-sub"><span>${escapeHtml(rList.join(', '))}</span></div>
          </div>
          <div class="route-eta-col">${dStr ? `<span class="location-dist-pill">${escapeHtml(dStr)}</span>` : ''}</div>
        </div>`;
    }).join('') + `</div>`;
  } else {
    const parsedGps = typeof parseHkGpsCoordinates === 'function' ? parseHkGpsCoordinates(inp.value) : null;
    if (parsedGps) {
      const gpsLat = parsedGps.lat;
      const gpsLon = parsedGps.lon;
      const gpsCoordLabel = `${gpsLat.toFixed(5)}, ${gpsLon.toFixed(5)}`;
      const gpsDistTag = getStopDistrictTag({ latitude: gpsLat, longitude: gpsLon });
      html += `
        <div class="section-bar"><span>${isZh ? '📍 GPS 座標定位' : '📍 GPS Coordinate Pin'}</span></div>
        <div class="gps-search-pin-card" data-testid="gps-search-pin-card">
          <div>
            <div style="font-weight:800; font-size:0.92rem; color:var(--text-main);">
              📍 ${escapeHtml(gpsCoordLabel)} ${gpsDistTag ? `<span class="district-tag">${escapeHtml(gpsDistTag)}</span>` : ''}
            </div>
            <div style="font-size:0.74rem; color:var(--text-sub); margin-top:3px;">
              ${isZh ? '已識別香港座標 · 可直接規劃路線或查看附近車站' : 'Hong Kong GPS coordinate recognized · Plan directly or inspect nearby stops below'}
            </div>
          </div>
          <div class="gps-search-pin-actions">
            <button type="button" class="gps-search-pin-btn primary" onclick="planToGpsCoordinate(${gpsLat}, ${gpsLon})">🧭 ${isZh ? '規劃前往此座標' : 'Plan to this spot'}</button>
            <button type="button" class="gps-search-pin-btn" onclick="showGpsCoordinateOnMap(${gpsLat}, ${gpsLon})">🗺️ ${isZh ? '地圖查看' : 'Show on Map'}</button>
          </div>
        </div>`;

      const nearbyGpsRaw = allStops
        .map(s => ({
          ...s,
          _distKm: calculateDistanceKm(gpsLat, gpsLon, parseFloat(s.latitude), parseFloat(s.longitude))
        }))
        .filter(s => Number.isFinite(s._distKm) && s._distKm <= 3.5)
        .sort((a, b) => a._distKm - b._distKm)
        .slice(0, 48);
      const dedupGpsStops = (typeof deduplicatePlannerAutocompleteStops === 'function'
        ? deduplicatePlannerAutocompleteStops(nearbyGpsRaw, gpsLat, gpsLon, '', 0.16)
        : nearbyGpsRaw)
        .sort((a, b) => (a._distKm ?? 999) - (b._distKm ?? 999))
        .slice(0, 16);

      if (dedupGpsStops.length) {
        html += `<div class="section-bar"><span>${isZh ? '附近車站（按座標距離排序）' : 'Nearest Transit Stops to Pin'}</span></div>` +
          `<div style="margin:0 12px 16px 12px;border-radius:16px;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-white);box-shadow:var(--card-shadow);">` +
          dedupGpsStops.map(s => {
            const distTag = s._distTag || getStopDistrictTag(s);
            const dStr = s._distKm < 1 ? `${Math.round(s._distKm * 1000)}m` : `${s._distKm.toFixed(1)}km`;
            const rList = (s.mergedRouteNos && s.mergedRouteNos.length ? s.mergedRouteNos : Array.from(s.routeNos || [])).slice(0, 8);
            const escKey = escapeJsAttr(s.stopKey);
            return `
              <div class="route-list-item" onclick="if(!isUserSelectingText())selectStopFromSearch('${escKey}')">
                <div class="route-info-col">
                  <div class="route-dest"><span>${escapeHtml(getStopName(s))}</span> ${distTag ? `<span class="district-tag">${escapeHtml(distTag)}</span>` : ''}</div>
                  <div class="route-sub"><span>${escapeHtml(rList.join(', '))}</span></div>
                </div>
                <div class="route-eta-col"><span class="location-dist-pill">${escapeHtml(dStr)}</span></div>
              </div>`;
          }).join('') + `</div>`;
      }
      res.innerHTML = html;
      return;
    }

    const qTokens = q.split(/\s+/).filter(Boolean);
    const matchesAllTokens = (textStr) => {
      const low = String(textStr || '').toLowerCase();
      return qTokens.every(tok => low.includes(tok));
    };

    const matchedRoutes = groupedRoutes.filter(g => {
      const firstRId = g.routeIds?.[0];
      const stopNamesJoined = (routeStopsCache[firstRId] || []).map(s => `${s.stopName_e || ''} ${s.name_tc || ''}`).join(' ');
      const haystack = `${g.routeNo || ''} ${g.routeNo_tc || ''} ${g.orig_e || ''} ${g.orig_tc || ''} ${g.dest_e || ''} ${g.dest_tc || ''} ${stopNamesJoined}`;
      return matchesAllTokens(haystack);
    }).sort((a, b) => {
      const modeMatchA = ((a.mode || 'BUS') === activeAppMode) ? 1 : 0;
      const modeMatchB = ((b.mode || 'BUS') === activeAppMode) ? 1 : 0;
      if (modeMatchA !== modeMatchB) return modeMatchB - modeMatchA;

      const rA = a.routeNo.toLowerCase(), rB = b.routeNo.toLowerCase();
      const exactA = (rA === q) ? 1 : 0, exactB = (rB === q) ? 1 : 0;
      if (exactA !== exactB) return exactB - exactA;
      const endpointMatchA = matchesAllTokens(`${a.orig_e} ${a.dest_e} ${a.orig_tc} ${a.dest_tc}`) ? 1 : 0;
      const endpointMatchB = matchesAllTokens(`${b.orig_e} ${b.dest_e} ${b.orig_tc} ${b.dest_tc}`) ? 1 : 0;
      if (endpointMatchA !== endpointMatchB) return endpointMatchB - endpointMatchA;
      const prefA = rA.startsWith(q) ? 1 : 0, prefB = rB.startsWith(q) ? 1 : 0;
      if (prefA !== prefB) return prefB - prefA;
      if (rA.length !== rB.length) return rA.length - rB.length;
      return rA.localeCompare(rB, undefined, { numeric: true });
    }).slice(0, 32);

    const matchedStopsRaw = [];
    for (let i = 0; i < allStops.length; i++) {
      const s = allStops[i];
      const lrtInfo = (s.mode === 'MTR' && s.lrtCode && typeof LRT_STATION_DIRECTORY !== 'undefined') ? LRT_STATION_DIRECTORY[String(parseInt(s.lrtCode, 10))] : null;
      const lrtAlias = lrtInfo ? `${lrtInfo.code || ''} ${lrtInfo.altEn || ''} ${lrtInfo.altTc || ''}` : '';
      const distTag = getStopDistrictTag(s);
      const hay = `${s.stopName_e || ''} ${s.name_tc || ''} ${distTag} ${lrtAlias} ${s.mode === 'FERRY' ? 'ferry pier 碼頭' : ''}`;
      if (matchesAllTokens(hay)) matchedStopsRaw.push(s);
    }
    const dedupMatched = typeof deduplicatePlannerAutocompleteStops === 'function'
      ? deduplicatePlannerAutocompleteStops(matchedStopsRaw, lastKnownPos?.lat, lastKnownPos?.lon, q, 0.22)
      : matchedStopsRaw;
    dedupMatched.sort((a, b) => {
      const mA = ((a.mode || 'BUS') === activeAppMode) ? 1 : 0;
      const mB = ((b.mode || 'BUS') === activeAppMode) ? 1 : 0;
      if (mA !== mB) return mB - mA;
      const dA = Number.isFinite(a._distKm) ? a._distKm : 9999;
      const dB = Number.isFinite(b._distKm) ? b._distKm : 9999;
      return dA - dB;
    });
    const matchedStops = dedupMatched.slice(0, 20);

    const isRouteCodeIntent = /^(?:[a-z]{0,2}\d+[a-z]?|eal|tml|twl|isl|ktl|tkl|tcl|ael|sil|drl)$/i.test(q);

    const routesSectionHtml = matchedRoutes.length
      ? `<div class="section-bar"><span>${t('busRoutesHeader')}</span></div>` +
        `<div style="margin:0 12px 12px 12px;border-radius:16px;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-white);box-shadow:var(--card-shadow);">` + matchedRoutes.map(g => {
          const dispBadge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(g) : g.routeNo;
          const origTxt = cleanFerryLabel(isZh && g.orig_tc ? g.orig_tc : g.orig_e);
          return `
            <div class="route-list-item ${g.mode === 'FERRY' ? 'ferry-card' : ''}" onclick="if(!isUserSelectingText()){clearStopSearchInput(); openRouteDetail('${escapeJsAttr(g.key)}');}">
              <div class="route-no-col"><div class="route-no-text" style="color:${g.colorHex || 'var(--text-main)'};">${escapeHtml(dispBadge)}</div><div class="route-co-tag">${escapeHtml(getCompanyName(g))}</div></div>
              <div class="route-info-col">
                <div class="route-dest"><span class="to-prefix">${t('to')}</span>${escapeHtml(getRouteName(g))}</div>
                ${origTxt ? `<div class="route-sub"><span>${isZh ? '由 ' : 'From '}${escapeHtml(origTxt)}</span></div>` : ''}
              </div>
            </div>`;
        }).join('') + `</div>`
      : '';

    const stopsSectionHtml = matchedStops.length
      ? `<div class="section-bar"><span>${t('busStopsHeader')}</span></div>` +
        `<div style="margin:0 12px 16px 12px;border-radius:16px;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-white);box-shadow:var(--card-shadow);">` + matchedStops.map(s => {
          const distTag = s._distTag || getStopDistrictTag(s);
          const dStr = Number.isFinite(s._distKm)
            ? (s._distKm < 1 ? `${Math.round(s._distKm * 1000)}m` : `${s._distKm.toFixed(1)}km`)
            : formatStopDistance(s);
          const rList = (s.mergedRouteNos && s.mergedRouteNos.length ? s.mergedRouteNos : Array.from(s.routeNos || [])).slice(0, 8);
          const escKey = escapeJsAttr(s.stopKey);
          return `
            <div class="route-list-item" onclick="if(!isUserSelectingText())selectStopFromSearch('${escKey}')">
              <div class="route-info-col">
                <div class="route-dest"><span>${escapeHtml(getStopName(s))}</span> ${distTag ? `<span class="district-tag">${escapeHtml(distTag)}</span>` : ''}</div>
                <div class="route-sub"><span>${escapeHtml(rList.join(', '))}</span></div>
              </div>
              <div class="route-eta-col">${dStr ? `<span class="location-dist-pill">${escapeHtml(dStr)}</span>` : ''}</div>
            </div>`;
        }).join('') + `</div>`
      : '';

    html += isRouteCodeIntent
      ? (routesSectionHtml + stopsSectionHtml)
      : (stopsSectionHtml + routesSectionHtml);

    if (!matchedRoutes.length && !matchedStops.length) {
      html += `<div class="text-center">${t('noStopsFound')}</div>`;
    }
  }
  res.innerHTML = html;
}

function planToGpsCoordinate(lat, lon) {
  triggerHaptic(12);
  const label = `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
  const destObj = {
    stopKey: `GPS_${Number(lat).toFixed(5)}_${Number(lon).toFixed(5)}`,
    stopName_e: `GPS Pin (${label})`,
    name_tc: `GPS 座標 (${label})`,
    lat: Number(lat),
    lon: Number(lon),
    nodeType: 'ADDRESS'
  };
  if (typeof userCommuteProfile !== 'undefined') {
    if (!userCommuteProfile.home) {
      const curSt = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
      if (curSt) {
        userCommuteProfile.home = {
          stopKey: curSt.stopKey,
          stopName_e: curSt.stopName_e,
          name_tc: curSt.name_tc || curSt.stopName_e,
          lat: parseFloat(curSt.latitude),
          lon: parseFloat(curSt.longitude)
        };
      }
    }
    userCommuteProfile.work = destObj;
    if (typeof saveCommuteProfile === 'function') saveCommuteProfile();
  }
  clearStopSearchInput();
  if (typeof openTransferPlannerFromTop === 'function') openTransferPlannerFromTop();
}

function showGpsCoordinateOnMap(lat, lon) {
  triggerHaptic(12);
  clearStopSearchInput();
  switchView('map', true);
  setTimeout(async () => {
    if (typeof window.ensureLeafletLoaded === 'function') await window.ensureLeafletLoaded();
    if (window.browseMapInstance && typeof L !== 'undefined') {
      window.browseMapInstance.setView([lat, lon], 16, { animate: false });
      if (typeof renderBrowseMapVisiblePins === 'function') renderBrowseMapVisiblePins();
      if (browseMapClickedSpotMarker) {
        try { window.browseMapInstance.removeLayer(browseMapClickedSpotMarker); } catch (e) {}
      }
      browseMapClickedSpotMarker = L.circleMarker([lat, lon], {
        radius: 9, fillColor: '#FF9500', color: '#FFFFFF', weight: 2.5, fillOpacity: 0.95
      }).addTo(window.browseMapInstance);
      if (typeof buildBrowseMapActionPopupHtml === 'function') {
        browseMapClickedSpotMarker.bindPopup(buildBrowseMapActionPopupHtml({
          stopKey: `GPS_${Number(lat).toFixed(5)}_${Number(lon).toFixed(5)}`,
          nameEn: `GPS Pin (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`,
          nameTc: `GPS 座標 (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`,
          lat: Number(lat), lon: Number(lon), nodeType: 'ADDRESS', hasStopRadar: false
        }), { closeButton: true, offset: [0, -4] }).openPopup();
      }
    }
  }, 120);
}

function _buildTrafficModalSubHtml(dirSource, isZh, segmentNote = '', camKeyFallback = '') {
  const dirMeta = (typeof extractCardinalDirectionMeta === 'function')
    ? extractCardinalDirectionMeta(dirSource, isZh)
    : null;
  const badgeText = dirMeta?.code
    ? (isZh ? `${dirMeta.arrowGlyph} ${dirMeta.code} ${dirMeta.labelTc}` : `${dirMeta.arrowGlyph} ${dirMeta.code}`)
    : '';
  const badgeHtml = badgeText
    ? `<span class="traffic-dir-badge" data-dir-code="${escapeHtml(dirMeta.code)}" style="background:${dirMeta.badgeBg};">${escapeHtml(badgeText)}</span>`
    : '';
  const capAt = window.__LIVE_TRAFFIC_CAPTURED_AT__ || '';
  const textParts = [capAt, segmentNote || (!dirMeta?.code ? camKeyFallback : '')].filter(Boolean);
  const textHtml = textParts.length ? `<span>${escapeHtml(textParts.join(' · '))}</span>` : '';
  return `${badgeHtml}${textHtml}`;
}

window.openTrafficDecisionModal = function(detId, oppDetId = '', segmentNote = '', isApproaching = false, camOverride = null) {
  triggerHaptic(10);
  const modal = document.getElementById('trafficDecisionModal');
  const bodyEl = document.getElementById('trafficModalBody');
  if (!modal || !bodyEl) return;
  const isZh = (currentLang === 'zh');
  const list = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const det = list.find(d => d.id === detId);
  const opp = oppDetId ? list.find(d => d.id === oppDetId) : null;
  if (!det) return;

  const _cleanRoadText = (s) => {
    const base = (typeof sanitizeBottleneckLabel === 'function')
      ? sanitizeBottleneckLabel(s)
      : String(s || '').replace(/\s*[·•]?\s*\b\d{1,3}\s*(?:°|deg|["″”]|'')\s*$/gi, '').trim();
    return base
      .replace(/\bSouththbound\b/gi, 'Southbound')
      .replace(/\bNorththbound\b/gi, 'Northbound')
      .replace(/\bEastthbound\b/gi, 'Eastbound')
      .replace(/\bWestthbound\b/gi, 'Westbound');
  };
  const baseRoadName = _cleanRoadText(isZh ? (det.roadTc || det.roadEn || '主要幹道') : (det.roadEn || det.roadTc || 'Major Road')) || (isZh ? '主要幹道' : 'Major Road');
  const roadName = (camOverride && camOverride.desc) ? (_cleanRoadText(camOverride.desc) || baseRoadName) : baseRoadName;
  segmentNote = _cleanRoadText(segmentNote);
  const detSpdAbs = Math.abs(Number(det.spd) || 0);
  const detOccAbs = Math.abs(Number(det.occ) || 0);
  const detEffStatus = detSpdAbs >= 40 ? 'SMOOTH' : (det.tier || 'SMOOTH');
  const oppSpdAbs = opp ? Math.abs(Number(opp.spd) || 0) : 0;
  const oppOccAbs = opp ? Math.abs(Number(opp.occ) || 0) : 0;
  const oppEffStatus = opp ? (oppSpdAbs >= 40 ? 'SMOOTH' : (opp.tier || 'SMOOTH')) : 'SMOOTH';
  const sameGrp = {
    status: detEffStatus,
    avgSpd: detSpdAbs,
    minSpd: detSpdAbs,
    maxOcc: detOccAbs,
    worstDet: det
  };
  const oppGrp = opp ? {
    status: oppEffStatus,
    avgSpd: oppSpdAbs,
    minSpd: oppSpdAbs,
    maxOcc: oppOccAbs,
    worstDet: opp
  } : null;
  const rawDec = typeof synthesizeTrafficDecision === 'function'
    ? synthesizeTrafficDecision(sameGrp, oppGrp, isZh)
    : null;
  const dec = rawDec ? {
    tone: rawDec.tone || (detEffStatus === 'JAMMED' ? 'jammed' : (detEffStatus === 'SLOW' ? 'slow' : 'smooth')),
    verdict: isZh ? (rawDec.verdictTc || rawDec.verdictEn) : (rawDec.verdictEn || rawDec.verdictTc),
    actionTip: isZh ? (rawDec.actionTc || rawDec.actionEn || '') : (rawDec.actionEn || rawDec.actionTc || ''),
    delayLabel: isZh ? (rawDec.delayLabelTc || rawDec.delayLabelEn || '0m') : (rawDec.delayLabelEn || rawDec.delayLabelTc || '0m'),
    densityLabel: isZh ? (rawDec.densityTc || rawDec.densityEn || '車流密度') : (rawDec.densityEn || rawDec.densityTc || 'Lane Load')
  } : {
    tone: detEffStatus === 'JAMMED' ? 'jammed' : (detEffStatus === 'SLOW' ? 'slow' : 'smooth'),
    verdict: detEffStatus === 'JAMMED' ? (isZh ? '前路擠塞 · 預計慢 10–18 分鐘' : 'Traffic jam · Expect +10–18m') : (isZh ? '前路暢順 · 預計無延誤' : 'Clear ahead · No delay'),
    delayLabel: detEffStatus === 'JAMMED' ? '+10–18m' : (detEffStatus === 'SLOW' ? '+4–8m' : '0m'),
    densityLabel: isZh ? `佔用率 ${Math.round(detOccAbs)}%` : `${Math.round(detOccAbs)}% load`,
    actionTip: ''
  };

  const titleEl = document.getElementById('trafficModalTitle');
  const subEl = document.getElementById('trafficModalSub');
  const closeEl = document.getElementById('trafficModalCloseBtn');
  if (titleEl) titleEl.innerText = roadName;
  const dirSource = camOverride ? { desc: _cleanRoadText(camOverride.desc), dir: _cleanRoadText(camOverride.dir || det.dir), roadEn: _cleanRoadText(det.roadEn), roadTc: _cleanRoadText(det.roadTc), rot: det.rot } : { ...det, roadEn: _cleanRoadText(det.roadEn), roadTc: _cleanRoadText(det.roadTc), dir: _cleanRoadText(det.dir) };
  if (subEl) subEl.innerHTML = _buildTrafficModalSubHtml(dirSource, isZh, segmentNote, camOverride?.key || det.camKey || '');
  if (closeEl) closeEl.innerText = isZh ? '✕ 關閉' : '✕ Close';

  const toneDot = dec.tone === 'jammed' ? '🔴' : (dec.tone === 'slow' ? '🟠' : '🟢');
  const oppHtml = opp
    ? `<button type="button" class="traffic-opp-switch-btn" onclick="switchToOppositeTrafficCamera('${escapeJsAttr(opp.id)}', '${escapeJsAttr(det.id)}')">
         <span>${oppEffStatus === 'JAMMED'
           ? (isZh ? `ℹ️ 對面線擠塞 (${Math.round(oppSpdAbs)} km/h)，不影響你搭乘方向。` : `ℹ️ Opposite bound is jammed (${Math.round(oppSpdAbs)} km/h) — does not affect your direction.`)
           : (isZh ? `ℹ️ 對面線車速約 ${Math.round(oppSpdAbs)} km/h。` : `ℹ️ Opposite carriageway moving at about ${Math.round(oppSpdAbs)} km/h.`)}</span>
         <span class="traffic-opp-switch-cta">${isZh ? '切換鏡頭 ⇄' : 'Switch cam ⇄'}</span>
       </button>`
    : '';

  const effectiveCamKey = (camOverride && camOverride.key) ? camOverride.key : (det.camKey || '');
  const camUrl = effectiveCamKey ? buildTrafficCamProxyUrl(effectiveCamKey, Math.floor(Date.now() / 60000)) : '';
  const camHtml = camUrl
    ? `<div class="traffic-cam-frame" id="trafficDecisionCamFrame">
         <img id="trafficDecisionCamImg" src="${camUrl}" alt="${escapeHtml(roadName)} TD live camera snapshot" loading="eager" data-cam-key="${escapeHtml(effectiveCamKey)}" onload="handleTrafficCamImageLoad(this, '${escapeJsAttr(effectiveCamKey)}')" onerror="handleTrafficCamImageError(this, '${escapeJsAttr(effectiveCamKey)}')">
         <div id="trafficCamStatusBanner" class="traffic-cam-status-banner" role="status" aria-live="polite"></div>
       </div>
       <div class="traffic-cam-caption">
         <span id="trafficCamCaptionText">📷 ${isZh ? '運輸署實時路況快拍' : 'HKSAR TD Live Road Snapshot'} (${escapeHtml(effectiveCamKey)})</span>
         <button type="button" style="border:none; background:none; color:var(--ios-blue); font-weight:700; font-size:0.72rem; cursor:pointer; padding:2px 4px;" onclick="refreshTrafficDecisionCam('${escapeJsAttr(effectiveCamKey)}')">↻ ${isZh ? '更新圖片' : 'Refresh'}</button>
       </div>
       <div id="trafficCamHintNote" class="traffic-cam-hint-note" style="display:none;"></div>`
    : `<div style="font-size:0.76rem; color:var(--text-sub); text-align:center; padding:12px; border-radius:11px; background:var(--bg-surface);">
         ${isZh ? '此路段感應器未配對運輸署鏡頭，以上為實時車速及佔用率數據。' : 'No TD camera paired at this sensor — verdict uses live road speed & occupancy telemetry.'}
       </div>`;

  const segTagHtml = segmentNote
    ? `<div style="font-size:0.73rem; font-weight:700; opacity:0.9; margin-top:3px;">📍 ${escapeHtml(segmentNote)}</div>`
    : '';
  const canJumpMap = currentView === 'detail' && typeof focusTrafficDetectorOnDetailMap === 'function';
  bodyEl.innerHTML = `
    <div class="traffic-verdict-banner tone-${dec.tone}">
      <div class="traffic-verdict-title">${toneDot} ${escapeHtml(dec.verdict)}</div>
      ${segTagHtml}
      ${dec.actionTip ? `<div class="traffic-verdict-tip">${escapeHtml(dec.actionTip)}</div>` : ''}
    </div>
    <div class="traffic-metrics-grid">
      <div class="traffic-metric-box">
        <div class="traffic-metric-val">${Math.round(detSpdAbs)} km/h</div>
        <div class="traffic-metric-lbl">${isZh ? '實時車速' : 'Live Speed'}</div>
      </div>
      <div class="traffic-metric-box">
        <div class="traffic-metric-val">${escapeHtml(dec.delayLabel || '0m')}</div>
        <div class="traffic-metric-lbl">${isZh ? '預計延誤' : 'Est. Delay'}</div>
      </div>
      <div class="traffic-metric-box">
        <div class="traffic-metric-val">${Math.round(detOccAbs)}%</div>
        <div class="traffic-metric-lbl">${escapeHtml(dec.densityLabel || (isZh ? '車流密度' : 'Lane Load'))}</div>
      </div>
    </div>
    ${oppHtml}
    ${camHtml}
    <div class="traffic-modal-actions">
      ${canJumpMap ? `<button type="button" class="traffic-modal-btn" onclick="closeTrafficDecisionModal(); focusTrafficDetectorOnDetailMap(${det.lat}, ${det.lon}, '${escapeJsAttr(det.id)}');">🗺️ ${isZh ? '在地圖標示' : 'Show on Map'}</button>` : ''}
      <button type="button" class="traffic-modal-btn primary" onclick="closeTrafficDecisionModal()">${isZh ? '知道了' : 'Got it'}</button>
    </div>
  `;
  modal.style.display = 'flex';
};

function buildTrafficCamProxyUrl(camKey, cacheBust = Date.now()) {
  return `${HK_UNIFIED_API_BASE}?action=cam_img&key=${encodeURIComponent(camKey)}&t=${encodeURIComponent(cacheBust)}`;
}
window.buildTrafficCamProxyUrl = buildTrafficCamProxyUrl;

// Pure pixel-based detector for HKSAR TD "Video Lost" / offline dark/flat placeholder frames (no OCR)
function detectVideoLostFromPixels(rgba, width, height) {
  if (!rgba || !width || !height || width < 16 || height < 16) {
    return { isVideoLost: true, reason: 'invalid_dimensions' };
  }
  const totalPx = width * height;
  if (rgba.length < totalPx * 4) {
    return { isVideoLost: true, reason: 'short_buffer' };
  }
  let nearBlackCount = 0;
  let sumLum = 0;
  let sumLumSq = 0;
  const borderLums = [];
  let borderLowSatCount = 0;

  const yTop = Math.floor(height * 0.24);
  const yBot = Math.ceil(height * 0.76);
  const xLeft = Math.floor(width * 0.16);
  const xRight = Math.ceil(width * 0.84);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      sumLum += lum;
      sumLumSq += lum * lum;
      if (lum < 26 && sat < 20) nearBlackCount++;
      const isBorder = (y < yTop || y >= yBot || x < xLeft || x >= xRight);
      if (isBorder) {
        borderLums.push(lum);
        if (sat < 22) borderLowSatCount++;
      }
    }
  }

  const meanLum = sumLum / totalPx;
  const overallVar = Math.max(0, (sumLumSq / totalPx) - (meanLum * meanLum));
  const overallStd = Math.sqrt(overallVar);
  const nearBlackRatio = nearBlackCount / totalPx;

  let borderMean = 0;
  for (let i = 0; i < borderLums.length; i++) borderMean += borderLums[i];
  borderMean = borderLums.length ? borderMean / borderLums.length : meanLum;
  let borderVarSum = 0;
  let borderUniformCount = 0;
  for (let i = 0; i < borderLums.length; i++) {
    const diff = borderLums[i] - borderMean;
    borderVarSum += diff * diff;
    if (Math.abs(diff) <= 14) borderUniformCount++;
  }
  const borderStd = borderLums.length ? Math.sqrt(borderVarSum / borderLums.length) : overallStd;
  const borderUniformRatio = borderLums.length ? (borderUniformCount / borderLums.length) : 0;
  const borderLowSatRatio = borderLums.length ? (borderLowSatCount / borderLums.length) : 0;

  // Signature 1: Classic HKSAR TD black "Video Lost" placeholder (solid black border + optional small center text)
  if (nearBlackRatio >= 0.78 && borderStd < 12) {
    return { isVideoLost: true, reason: 'dark_frame', nearBlackRatio, borderStd, meanLum };
  }
  // Signature 2: Uniform flat-gray / monochrome "Video Lost" / "Feed Unavailable" slate
  if (borderUniformRatio >= 0.90 && borderLowSatRatio >= 0.88 && borderStd < 7.5 && meanLum < 165) {
    return { isVideoLost: true, reason: 'uniform_placeholder', borderUniformRatio, borderStd, meanLum };
  }
  // Signature 3: Completely flat dead signal
  if (overallStd < 5.5) {
    return { isVideoLost: true, reason: 'flat_signal', overallStd, meanLum };
  }
  return { isVideoLost: false, reason: 'live', nearBlackRatio, borderStd, overallStd, meanLum };
}
window.detectVideoLostFromPixels = detectVideoLostFromPixels;

function detectVideoLostOnCanvas(imgEl) {
  if (!imgEl || !imgEl.complete || !imgEl.naturalWidth || !imgEl.naturalHeight) {
    return { isVideoLost: true, reason: 'broken_image' };
  }
  if (imgEl.naturalWidth < 32 || imgEl.naturalHeight < 24) {
    return { isVideoLost: true, reason: 'tiny_placeholder' };
  }
  try {
    const w = 64, h = 48;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { isVideoLost: false, unreadable: true };
    ctx.drawImage(imgEl, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    return detectVideoLostFromPixels(imgData.data, w, h);
  } catch (e) {
    return { isVideoLost: false, unreadable: true, reason: 'cors_tainted' };
  }
}
window.detectVideoLostOnCanvas = detectVideoLostOnCanvas;

function _renderTrafficCamStatusBanner(show, camKey, isOfflineFallback = false) {
  const banner = document.getElementById('trafficCamStatusBanner');
  const hint = document.getElementById('trafficCamHintNote');
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (banner) {
    if (show) {
      const msg = isZh
        ? '⚠️ 鏡頭訊號暫停（無影像 / Video Lost）'
        : '⚠️ Feed Offline / Video Lost';
      banner.innerHTML = `<span>${msg}</span><button type="button" class="traffic-cam-retry-btn" onclick="refreshTrafficDecisionCam('${escapeJsAttr(camKey || '')}')">↻ ${isZh ? '重試' : 'Retry'}</button>`;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
      banner.innerHTML = '';
    }
  }
  if (hint) {
    if (isOfflineFallback) {
      hint.style.display = 'block';
      hint.innerText = isZh
        ? '提示：若畫面顯示「Video Lost」或黑屏，代表運輸署鏡頭正在維護，可稍後按「更新圖片」。'
        : 'Feed Offline / Video Lost? HKSAR TD cameras occasionally pause for maintenance — tap Refresh to retry.';
    } else {
      hint.style.display = 'none';
      hint.innerText = '';
    }
  }
}

window.handleTrafficCamImageLoad = function(imgEl, camKey) {
  const res = detectVideoLostOnCanvas(imgEl);
  if (res.isVideoLost) {
    _renderTrafficCamStatusBanner(true, camKey, false);
  } else if (res.unreadable) {
    _renderTrafficCamStatusBanner(false, camKey, true);
  } else {
    _renderTrafficCamStatusBanner(false, camKey, false);
  }
};

window.handleTrafficCamImageError = function(imgEl, camKey) {
  if (imgEl && camKey && imgEl.dataset.fallbackTried !== '1') {
    imgEl.dataset.fallbackTried = '1';
    imgEl.src = `https://tdcctv.data.one.gov.hk/${encodeURIComponent(camKey)}.JPG?t=${Date.now()}`;
    return;
  }
  _renderTrafficCamStatusBanner(true, camKey, true);
};

window.refreshTrafficDecisionCam = function(camKey) {
  const img = document.getElementById('trafficDecisionCamImg');
  if (img && camKey) {
    img.dataset.fallbackTried = '0';
    _renderTrafficCamStatusBanner(false, camKey, false);
    img.src = buildTrafficCamProxyUrl(camKey, Date.now());
  }
};

window.openTrafficCameraByKey = function(camKey, fallbackDesc = '') {
  if (!camKey) return;
  const cams = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : [];
  const found = cams.find(c => c && c.key === camKey);
  if (found) {
    window.openTrafficCameraModal(found);
    return;
  }
  window.openTrafficCameraModal({ key: camKey, desc: fallbackDesc || camKey });
};

window.openTrafficCameraModal = function(cam) {
  if (!cam || !cam.key) return;
  const list = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  let matchedDet = null;
  if (!cam.suppressDetectorSpeed) {
    if (cam.matchedDetId) {
      matchedDet = list.find(d => d.id === cam.matchedDetId) || null;
    }
    if (!matchedDet) {
      matchedDet = (typeof window.findNearestMatchingDetectorForCamera === 'function')
        ? window.findNearestMatchingDetectorForCamera(cam, list)
        : (list.find(d => d.camKey === cam.key || d.id === cam.key) || null);
    }
  }
  if (matchedDet && typeof window.openTrafficDecisionModal === 'function') {
    const oppId = (typeof _findOppositeTrafficDetectorId === 'function') ? _findOppositeTrafficDetectorId(matchedDet) : '';
    window.openTrafficDecisionModal(matchedDet.id, oppId, '', false, cam);
    return;
  }

  const modal = document.getElementById('trafficDecisionModal');
  const bodyEl = document.getElementById('trafficModalBody');
  if (!modal || !bodyEl) return;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const titleEl = document.getElementById('trafficModalTitle');
  const subEl = document.getElementById('trafficModalSub');
  const closeEl = document.getElementById('trafficModalCloseBtn');
  const cleanTitle = (typeof sanitizeBottleneckLabel === 'function' ? sanitizeBottleneckLabel(cam.desc || cam.key) : (cam.desc || cam.key));
  if (titleEl) titleEl.innerText = cleanTitle || (isZh ? '運輸署實時路況鏡頭' : 'HKSAR TD Traffic Camera');
  if (subEl) subEl.innerHTML = _buildTrafficModalSubHtml(cam, isZh, '', cam.key);
  if (closeEl) closeEl.innerText = isZh ? '✕ 關閉' : '✕ Close';
  const camUrl = buildTrafficCamProxyUrl(cam.key, Math.floor(Date.now() / 60000));
  bodyEl.innerHTML = `
    <div class="traffic-cam-frame" id="trafficDecisionCamFrame">
      <img id="trafficDecisionCamImg" src="${camUrl}" alt="${escapeHtml(cleanTitle)} TD live camera snapshot" loading="eager" data-cam-key="${escapeHtml(cam.key)}" onload="handleTrafficCamImageLoad(this, '${escapeJsAttr(cam.key)}')" onerror="handleTrafficCamImageError(this, '${escapeJsAttr(cam.key)}')">
      <div id="trafficCamStatusBanner" class="traffic-cam-status-banner" role="status" aria-live="polite"></div>
    </div>
    <div class="traffic-cam-caption">
      <span id="trafficCamCaptionText">📷 ${isZh ? '運輸署實時路況快拍' : 'HKSAR TD Live Road Snapshot'} (${escapeHtml(cam.key)})</span>
      <button type="button" style="border:none; background:none; color:var(--ios-blue); font-weight:700; font-size:0.72rem; cursor:pointer; padding:2px 4px;" onclick="refreshTrafficDecisionCam('${escapeJsAttr(cam.key)}')">↻ ${isZh ? '更新圖片' : 'Refresh'}</button>
    </div>
    <div id="trafficCamHintNote" class="traffic-cam-hint-note" style="display:none;"></div>
    <div class="traffic-modal-actions">
      <button type="button" class="traffic-modal-btn primary" onclick="closeTrafficDecisionModal()">${isZh ? '知道了' : 'Got it'}</button>
    </div>
  `;
  modal.style.display = 'flex';
};

window.switchToOppositeTrafficCamera = function(oppDetId, curDetId = '') {
  if (!oppDetId) return;
  const detList = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
  const camList = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : [];
  const oppDet = detList.find(d => d.id === oppDetId) || null;
  const oppCam = oppDet
    ? (camList.find(c => c.key === oppDet.id) || camList.find(c => oppDet.camKey && c.key === oppDet.camKey) || null)
    : null;
  try {
    document.querySelectorAll('.global-traffic-cam-marker.cam-selected').forEach((el) => el.classList.remove('cam-selected'));
    if (oppCam && oppCam.key) {
      const targetPin = document.querySelector(`.global-traffic-cam-marker[data-cam-key="${CSS.escape ? CSS.escape(oppCam.key) : oppCam.key}"]`);
      if (targetPin) targetPin.classList.add('cam-selected');
    }
  } catch (e) {}
  if (typeof window.openTrafficDecisionModal === 'function') {
    window.openTrafficDecisionModal(oppDetId, curDetId, '', false, oppCam);
  }
};

window.closeTrafficDecisionModal = function() {
  const modal = document.getElementById('trafficDecisionModal');
  if (modal) modal.style.display = 'none';
  try {
    document.querySelectorAll('.global-traffic-cam-marker.cam-selected').forEach((el) => el.classList.remove('cam-selected'));
  } catch (e) {}
};

function selectStopFromSearch(stopKey) {
  triggerHaptic(12);
  const st = stopMapIndex.get(stopKey);
  if (st) {
    if (st.mode && st.mode !== activeAppMode) {
      activeAppMode = st.mode;
    }
    const stBaseKey = getBaseStopNameKey(st.stopName_e);
    recentStopSearches = [
      { stopKey: st.stopKey, stopName_e: st.stopName_e, name_tc: st.name_tc || st.stopName_e, lat: parseFloat(st.latitude), lon: parseFloat(st.longitude) },
      ...recentStopSearches.filter(r => r.stopKey !== st.stopKey && getBaseStopNameKey(r.stopName_e) !== stBaseKey)
    ].slice(0, 10);
    SafeStorage.setItem('transit_recent_stops_v1', JSON.stringify(recentStopSearches));
  }
  userManualStopBrowseUntilMs = Date.now() + 300000;
  currentNearestStopKey = stopKey;
  activeClusterSubStopKey = 'ALL';
  lastRenderedCenterStopKey = null;
  clearStopSearchInput();
  syncTopNavHighlights();
  updateTopBackButtonVisibility();
  updateMainStopHeaderDisplay();
  renderMainNearby(false);
}

function jumpToMainStopFromDetail(stopKey) {
  triggerHaptic(12);
  switchView('main', false);
  selectStopFromSearch(stopKey);
}

let lastGpsErrCode = 0;

async function relockToNearestGpsStop() {
  triggerHaptic(15);
  navHistoryStack.length = 0;
  userManualStopBrowseUntilMs = 0;
  activeClusterSubStopKey = 'ALL';
  stopDirectionFilterMode = 'BOTH';
  if (typeof SavedHubsManager !== 'undefined') SavedHubsManager.manualOverrideMode = 'AUTO';
  clearStopSearchInput();
  updateTopBackButtonVisibility();

  if (navigator.geolocation) {
    await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          lastGpsErrCode = 0;
          const lat = pos.coords.latitude, lon = pos.coords.longitude, acc = pos.coords.accuracy || 15;
          if (acc <= 450) {
            SignalHealthMonitor.recordGpsFix(acc);
            lastKnownPos = { lat, lon, acc: Math.round(acc), hasLiveFix: true };
            SafeStorage.setItem('transit_last_gps_pos_v2', JSON.stringify(lastKnownPos));
          }
          if (typeof updateUserMarkers === 'function') updateUserMarkers();
          resolve();
        },
        err => {
          lastGpsErrCode = err?.code || 2;
          resolve();
        },
        { enableHighAccuracy: true, timeout: 4000, maximumAge: 0 }
      );
    });
  }

  if (!lastKnownPos?.hasLiveFix) {
    if (lastGpsErrCode === 1) {
      showToast(currentLang === 'zh'
        ? '⚠️ 定位權限被拒：請按網址列 [=] 或 aA ➔ 網站設定 ➔ 位置改為「允許」'
        : '⚠️ Location blocked: Tap [=] or aA in address bar ➔ Website Settings ➔ Allow Location');
    } else {
      showToast(currentLang === 'zh'
        ? '⚠️ 暫時未能獲取精確 GPS，已顯示預設或最後位置車站'
        : '⚠️ Precise GPS unavailable right now — showing default/last stop');
    }
    renderMainNearby(false);
    return;
  }
  syncNearestStopFromGPS(lastKnownPos.lat, lastKnownPos.lon, true);
  renderMainNearby(false);
  showToast(currentLang === 'zh' ? '🎯 已重新鎖定最近 GPS 位置' : '🎯 Locked to nearest GPS stop');
}

function switchView(viewName, skipHistoryPush = false, forcePushSameView = false) {
  if (!skipHistoryPush && (currentView !== viewName || forcePushSameView)) {
    const activeEl = document.getElementById(`view-${currentView}`);
    const mapCenter = (currentView === 'map' && window.browseMapInstance) ? window.browseMapInstance.getCenter() : null;
    navHistoryStack.push({
      view: currentView,
      mode: activeAppMode,
      scrollTop: activeEl ? activeEl.scrollTop : 0,
      nearestStopKey: currentNearestStopKey,
      manualStopUntil: userManualStopBrowseUntilMs,
      groupKey: currentView === 'detail' && detailRouteGroup ? detailRouteGroup.key : null,
      stopKey: currentView === 'detail' ? (detailBoardStopKey || detailTargetStopKey) : null,
      stopIdx: currentView === 'detail' ? detailExpandedStopIdx : null,
      mapLat: mapCenter ? mapCenter.lat : null,
      mapLon: mapCenter ? mapCenter.lng : null,
      mapZoom: (currentView === 'map' && window.browseMapInstance) ? window.browseMapInstance.getZoom() : 15
    });
    try { history.pushState({ transitBackDepth: navHistoryStack.length }, ''); } catch (e) {}
  }

  currentView = viewName;
  countdown = getAdaptiveRefreshIntervalSec();
  document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add('active');

  syncTopNavHighlights();
  updateTopBackButtonVisibility();

  if (viewName !== 'detail' && typeof window.hideDetailBackToStopPill === 'function') {
    window.hideDetailBackToStopPill();
  }

  if (viewName === 'detail') {
    requestAnimationFrame(() => window.mapInstance?.invalidateSize(false));
  } else if (viewName === 'xfer') {
    requestAnimationFrame(() => {
      window.xferMapInstance?.invalidateSize(false);
      if (typeof fitTransferPlannerMapBounds === 'function') fitTransferPlannerMapBounds();
    });
  } else if (viewName === 'map') {
    requestAnimationFrame(() => initAndRenderBrowseMap());
  } else if (viewName === 'fav') {
    renderFavList(false);
  }
}

let _suppressNextPopstate = false;

function handleBackClick(fromUiButton = false) {
  triggerHaptic(10);

  if (isStopSearchOpen()) {
    clearStopSearchInput();
    return;
  }

  if (fromUiButton && navHistoryStack.length > 0 && window.history.state?.transitBackDepth) {
    _suppressNextPopstate = true;
    try { history.back(); } catch (e) { _suppressNextPopstate = false; }
  }

  if (navHistoryStack.length > 0) {
    const prev = navHistoryStack.pop();
    if (prev.mode && prev.mode !== activeAppMode) {
      activeAppMode = prev.mode;
    }
    if (prev.nearestStopKey) currentNearestStopKey = prev.nearestStopKey;
    if (Number.isFinite(prev.manualStopUntil)) userManualStopBrowseUntilMs = prev.manualStopUntil;

    if (prev.view === 'detail' && prev.groupKey) {
      openRouteDetail(prev.groupKey, prev.stopKey, prev.stopIdx, true);
      return;
    }

    switchView(prev.view, true);

    if (prev.view === 'map' && prev.mapLat && prev.mapLon) {
      setTimeout(() => {
        if (window.browseMapInstance) {
          window.browseMapInstance.setView([prev.mapLat, prev.mapLon], prev.mapZoom || 15, { animate: false });
          renderBrowseMapVisiblePins();
        }
      }, 60);
      return;
    }

    if (prev.view === 'main') {
      updateMainStopHeaderDisplay();
      renderMainNearby(true);
    } else if (prev.view === 'fav') {
      renderFavList(true);
    }
    setTimeout(() => {
      const el = document.getElementById(`view-${prev.view}`);
      if (el && Number.isFinite(prev.scrollTop)) el.scrollTop = prev.scrollTop;
    }, 30);
    return;
  }

  if (currentView !== 'main') {
    switchView('main', true);
    renderMainNearby(true);
    return;
  }

  if (Date.now() < userManualStopBrowseUntilMs) {
    relockToNearestGpsStop();
  }
}

window.addEventListener('popstate', () => {
  if (_suppressNextPopstate) {
    _suppressNextPopstate = false;
    return;
  }
  handleBackClick(false);
});

function openFavTabFromTop() {
  triggerHaptic(10);
  if (currentView === 'fav') return;
  switchView('fav', false);
  renderFavList(false);
}

function openMapBrowserFromTop() {
  triggerHaptic(10);
  if (currentView === 'map') return;
  switchView('map', false);
}

function updateKmbDetailHeader() {
  if (!detailRouteGroup) return;
  const chip = document.getElementById('kmbRouteTitleChip');
  const dispBadge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(detailRouteGroup) : detailRouteGroup.routeNo;
  const cleanDest = cleanFerryLabel(getRouteName(detailRouteGroup)).replace(/\s+at\s+.*$/i, '').split(',')[0].trim();
  const titleMain = String(dispBadge).includes('⟷')
    ? `${t('to')}${cleanDest}`
    : `${dispBadge} ${t('to')}${cleanDest}`;
  if (chip) chip.innerText = `${titleMain} • ${getCompanyName(detailRouteGroup)}`;
}

function openRouteDetail(groupKey, targetStopKey = null, explicitStopIdx = null, isBackRestore = false) {
  triggerHaptic(12);
  if (!routeMapIndex.size) initRouteMapFast();
  let group = routeMapIndex.get(groupKey);
  if (!group && /^MTR_(EAL|TKL)_(LMC|LHP)_/.test(String(groupKey))) {
    group = routeMapIndex.get(String(groupKey).replace(/_(LMC|LHP)_/, '_'));
  }
  if (!group) return;

  const isSameViewDifferentRoute = (currentView === 'detail' && detailRouteGroup && detailRouteGroup.key !== group.key);
  detailRouteGroup = group;
  detailBoardStopKey = targetStopKey;
  detailTargetStopKey = null;
  window.detailTargetStopKey = null;
  detailSelectedEtaBusIdx = 0;
  detailLastFetchedArrs = [];
  if (typeof window.hideDetailBackToStopPill === 'function') window.hideDetailBackToStopPill();

  switchView('detail', isBackRestore, isSameViewDifferentRoute);

  const stops = getStopsForGroup(group, targetStopKey);
  const allowFinalStop = isCircularRoute(group, stops);
  const isPenultimateDualBranch = (group.mode === 'MTR' && stops.length >= 3 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId));
  const maxBoardIdx = isPenultimateDualBranch ? stops.length - 3 : stops.length - 2;

  let targetIdx = (explicitStopIdx !== null && explicitStopIdx >= 0 && explicitStopIdx < stops.length) ? explicitStopIdx : -1;
  if (targetIdx === -1 && targetStopKey) {
    const cleanKey = String(targetStopKey).replace(/^(MTR_STN_|MTR_HUB_|MTR_|LRT_STN_|LRT_|FERRY_PIER_|FERRY_)/, '');
    const tb = getBaseStopNameKey(cleanKey.split('_')[0]);
    const tp = normStationLookupKey(cleanKey.split('_')[0]);
    targetIdx = stops.findIndex((s, idx) => (idx <= maxBoardIdx || stops.length === 1 || allowFinalStop) && (s.stopKey === targetStopKey || s.stopId === targetStopKey || String(s.mtrCode || s.lrtCode || s.stopId || '').toUpperCase() === cleanKey.toUpperCase() || getBaseStopNameKey(s.stopName_e) === tb || (group.mode === 'FERRY' && tp && normStationLookupKey(s.stopName_e) === tp)));
    if (targetIdx === -1) {
      targetIdx = stops.findIndex(s => s.stopKey === targetStopKey || s.stopId === targetStopKey || String(s.mtrCode || s.lrtCode || s.stopId || '').toUpperCase() === cleanKey.toUpperCase() || getBaseStopNameKey(s.stopName_e) === tb || (group.mode === 'FERRY' && tp && normStationLookupKey(s.stopName_e) === tp));
    }
  }
  if (targetIdx === -1 && lastKnownPos?.hasLiveFix) targetIdx = findNearestStopIdx(stops, lastKnownPos);
  if (targetIdx < 0) targetIdx = 0;

  if (!allowFinalStop && stops.length >= 2 && targetIdx > maxBoardIdx) {
    targetIdx = 0;
  }

  if (!isBackRestore && typeof SmartReturnManager !== 'undefined' && stops[targetIdx]) {
    SmartReturnManager.recordInboundTrip(group, stops[targetIdx], stops);
  }

  updateKmbDetailHeader();
  if (typeof window.restoreDetailSheetSplitMap === 'function') window.restoreDetailSheetSplitMap();
  if (typeof window.initDetailMapSheetDragResize === 'function') window.initDetailMapSheetDragResize();
  renderStopList();
  const token = ++detailOpenToken;
  drawRouteOnMap(group, targetIdx, token);
  expandStop(targetIdx, false, true, false);

  if (group.company === 'NLB') {
    ensureNlbHolidayFaresLoaded(group).then(updated => {
      if (updated && currentView === 'detail' && detailRouteGroup?.key === group.key) {
        renderStopList();
        expandStop(detailExpandedStopIdx >= 0 ? detailExpandedStopIdx : targetIdx, true, false, true);
      }
    });
  }
}

// ============================================================================
// SWISS TABULAR DOWNSTREAM ALIGHT TIME ENGINE
// ============================================================================
async function updateDownstreamAlightTimes(group, boardIdx, arrs, selectedBusIdx = 0, expectedToken = null) {
  if (!group) return;
  const stops = getStopsForGroup(group, detailBoardStopKey || detailTargetStopKey);
  if (!stops.length) return;

  const allowFinal = isCircularRoute(group, stops);
  const isPenDual = (group?.mode === 'MTR' && stops.length >= 3 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId));
  const maxBoardIdx = isPenDual ? stops.length - 3 : stops.length - 2;
  const isAlightOnlyTerminus = !allowFinal && stops.length >= 2 && boardIdx > maxBoardIdx;

  for (let i = 0; i < stops.length; i++) {
    const colEl = document.getElementById(`stop-alight-col-${i}`);
    if (!colEl) continue;
    if (i < boardIdx) {
      colEl.innerHTML = '';
    } else if (i === boardIdx) {
      colEl.innerHTML = isAlightOnlyTerminus
        ? `<span class="stop-board-badge" style="background:var(--text-sub);">${t('alightBadge')}</span>`
        : `<span class="stop-board-badge">${t('boardBadge')}</span>`;
    } else if (!arrs || !arrs.length) {
      colEl.innerHTML = '';
    }
  }

  if (isAlightOnlyTerminus || !arrs || !arrs.length || boardIdx < 0 || boardIdx >= stops.length - 1) return;

  const pickedIdx = Math.min(selectedBusIdx, Math.min(group?.mode === 'MTR' ? 3 : 2, arrs.length - 1));
  const pickedArr = arrs[pickedIdx];
  if (!pickedArr) return;

  let prevMs = pickedArr.rawTargetMs || pickedArr.targetMs;
  if (!Number.isFinite(prevMs)) return;

  const rId = group.routeIds?.[0] || '';
  let kmbBulkMap = null;
  let kmbDirChar = 'O';
  if (rId.startsWith('KMB_') || rId.startsWith('LWB_')) {
    const parts = rId.split('_');
    kmbDirChar = parts[2] || 'O';
    kmbBulkMap = await fetchKmbRouteBulkEta(parts[1], parts[3] || '1', false);
    if ((expectedToken !== null && expectedToken !== expandStopRequestToken) || detailExpandedStopIdx !== boardIdx || currentView !== 'detail') {
      return;
    }
    if (kmbBulkMap && kmbBulkMap.size > 0 && typeof window.syncDetailRouteBusSpeedSegments === 'function') {
      const preEtaByStopIdx = {};
      for (let sIdx = 0; sIdx < stops.length; sIdx++) {
        const seqNum = stops[sIdx]?.seq || (sIdx + 1);
        const list = kmbBulkMap.get(`${kmbDirChar}_${seqNum}`);
        if (Array.isArray(list) && list.length) preEtaByStopIdx[sIdx] = list;
      }
      if (Object.keys(preEtaByStopIdx).length) {
        window.syncDetailRouteBusSpeedSegments(group, stops, preEtaByStopIdx);
      }
    }
  }

  const boardStopCode = stops[boardIdx]?.stopId;
  const arrivalMsAtIdx = new Array(stops.length).fill(null);
  arrivalMsAtIdx[boardIdx] = prevMs;
  let lastValidIdx = boardIdx;

  const isDualEndLine = (group?.mode === 'MTR' && stops.length >= 4 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId));
  const forkStopIdx = isDualEndLine
    ? ((group.routeNo === 'TKL' && stops.findIndex(s => s.stopId === 'TKO') !== -1)
        ? stops.findIndex(s => s.stopId === 'TKO')
        : (stops.length - 3))
    : -1;

  for (let i = boardIdx + 1; i < stops.length; i++) {
    const colEl = document.getElementById(`stop-alight-col-${i}`);
    const curStopCode = stops[i]?.stopId;

    if (group?.mode === 'MTR' && isParallelRailTerminusPair(boardStopCode, curStopCode)) {
      if (colEl) colEl.innerHTML = '';
      continue;
    }

    if (isDualEndLine && i >= stops.length - 2) {
      const branchTrain = (pickedArr.destCode === curStopCode)
        ? pickedArr
        : arrs.find(a => a.destCode === curStopCode);

      if (!branchTrain) {
        if (colEl) colEl.innerHTML = `<span class="stop-alight-time" style="color:var(--text-sub);opacity:0.55;">—</span>`;
        continue;
      }

      const branchDepShiftMs = (branchTrain.rawTargetMs || branchTrain.targetMs) - (pickedArr.rawTargetMs || pickedArr.targetMs);
      const baseForkIdx = (forkStopIdx >= boardIdx && arrivalMsAtIdx[forkStopIdx] !== null) ? forkStopIdx : boardIdx;
      const baseForkMs = (arrivalMsAtIdx[baseForkIdx] || (pickedArr.rawTargetMs || pickedArr.targetMs)) + branchDepShiftMs;
      const branchKin = computeInterStopKinematics(group, stops, baseForkIdx, i);
      const branchArrMs = baseForkMs + Math.max(45000, branchKin.transitSec * 1000);
      arrivalMsAtIdx[i] = branchArrMs;
      if (colEl) {
        colEl.innerHTML = `<span class="stop-alight-time">${formatHkArrivalClock(branchArrMs)}</span>`;
      }
      continue;
    }

    const fromStepIdx = lastValidIdx;
    const stepKin = computeInterStopKinematics(group, stops, fromStepIdx, i);
    let ferryStepSec = stepKin.transitSec;
    if (group?.mode === 'FERRY') {
      const rmkDurMatch = String(pickedArr.remark || '').match(/(?:~|約)(\d+)\s*(?:m|分)/i);
      const fallbackVesselDur = pickedArr.vesselClass === 'ORD'
        ? (Number(group.ferryMeta?.durOrd) || 55)
        : (Number(group.ferryMeta?.durFast || group.ferryMeta?.dur) || 35);
      const totalDurMins = rmkDurMatch ? Number(rmkDurMatch[1]) : fallbackVesselDur;
      ferryStepSec = Math.round((totalDurMins * 60) / Math.max(1, stops.length - 1 - boardIdx));
    }
    const estStepMs = group?.mode === 'FERRY'
      ? Math.max(300000, ferryStepSec * 1000)
      : Math.max(25000, stepKin.transitSec * 1000);
    let nextMs = prevMs + estStepMs;

    if (kmbBulkMap) {
      const seqNum = stops[i].seq || (i + 1);
      const candList = (kmbBulkMap.get(`${kmbDirChar}_${seqNum}`) || [])
        .map(e => ({ ms: new Date(e.eta).getTime(), etaSeq: e.eta_seq }))
        .filter(x => Number.isFinite(x.ms) && x.ms >= prevMs - 45000)
        .sort((a, b) => a.ms - b.ms);

      if (candList.length > 0) {
        let bestCand = null, bestDiff = Infinity;
        for (const c of candList) {
          const diffFromExpected = Math.abs(c.ms - (prevMs + estStepMs));
          if (c.ms >= prevMs - 30000 && diffFromExpected <= Math.max(480000, estStepMs * 1.45)) {
            if (diffFromExpected < bestDiff) {
              bestDiff = diffFromExpected;
              bestCand = c.ms;
            }
          }
        }
        if (bestCand !== null) {
          nextMs = Math.max(prevMs, bestCand);
        }
      }
    }

    arrivalMsAtIdx[i] = nextMs;
    prevMs = nextMs;
    lastValidIdx = i;
    if (colEl) {
      const clk = formatHkArrivalClock(nextMs);
      colEl.innerHTML = `<span class="stop-alight-time">${clk}</span>`;
    }
  }
}

function syncDetailExitStopButtonsUI() {
  if (!detailRouteGroup) return;
  const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  for (let i = 0; i < stops.length; i++) {
    const btn = document.getElementById(`stop-exit-btn-${i}`);
    if (!btn) continue;
    const isDownstream = (detailExpandedStopIdx >= 0 && i > detailExpandedStopIdx);
    btn.style.display = isDownstream ? 'inline-flex' : 'none';
    const stKey = stops[i]?.stopKey || getGlobalStopKey(stops[i]);
    const isSelectedExit = Boolean(isDownstream && detailTargetStopKey && (detailTargetStopKey === stKey || detailTargetStopKey === stops[i]?.stopId));
    btn.classList.toggle('active', isSelectedExit);
    btn.setAttribute('aria-pressed', isSelectedExit ? 'true' : 'false');
    btn.innerText = isSelectedExit ? (isZh ? '下車 ✓' : 'Exit ✓') : (isZh ? '下車' : 'Exit');
  }
}

function toggleDetailExitStop(idx) {
  if (!detailRouteGroup) return;
  const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
  if (!stops[idx] || idx <= detailExpandedStopIdx) return;
  triggerHaptic(10);
  const stKey = stops[idx].stopKey || getGlobalStopKey(stops[idx]);
  const isSame = Boolean(detailTargetStopKey && (detailTargetStopKey === stKey || detailTargetStopKey === stops[idx].stopId));
  detailTargetStopKey = isSame ? null : stKey;
  window.detailTargetStopKey = detailTargetStopKey;
  syncDetailExitStopButtonsUI();
  highlightActiveStopMarkerOnMap(detailExpandedStopIdx);
  const boardStop = stops[detailExpandedStopIdx];
  const boardKey = boardStop?.stopKey || getGlobalStopKey(boardStop);
  const expEl = document.getElementById(`detail-eta-expanded-${detailExpandedStopIdx}`);
  if (expEl && boardStop) {
    expEl.innerHTML = generateExpandedETAsHtml(detailLastFetchedArrs, detailRouteGroup, boardKey, detailExpandedStopIdx);
  }
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  if (typeof showToast === 'function') {
    showToast(detailTargetStopKey
      ? (isZh ? `已鎖定第 ${idx + 1} 站為下車點，僅顯示此路段路況及鏡頭` : `Clamped traffic & cameras to Exit Stop ${idx + 1}`)
      : (isZh ? '已取消下車站範圍鎖定' : 'Exit stop clamp cleared'));
  }
}
window.toggleDetailExitStop = toggleDetailExitStop;
window.syncDetailExitStopButtonsUI = syncDetailExitStopButtonsUI;

async function expandStop(idx, isSilent = false, autoScrolled = false, skipMapPan = false) {
  if (!detailRouteGroup) return;
  const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
  if (!stops[idx]) return;
  if (!isSilent && !autoScrolled) {
    triggerHaptic(8);
    if (typeof window.expandDetailSheetToTop === 'function') window.expandDetailSheetToTop();
  }
  if (!isSilent && typeof window.hideDetailBackToStopPill === 'function') window.hideDetailBackToStopPill();

  if (detailExpandedStopIdx !== idx) {
    detailSelectedEtaBusIdx = 0;
  }
  detailExpandedStopIdx = idx;
  detailBoardStopKey = stops[idx].stopKey || getGlobalStopKey(stops[idx]);
  if (detailTargetStopKey) {
    const exitIdx = stops.findIndex(s => s && (s.stopKey === detailTargetStopKey || s.stopId === detailTargetStopKey));
    if (exitIdx <= idx) {
      detailTargetStopKey = null;
      window.detailTargetStopKey = null;
    }
  }
  document.querySelectorAll('#stop-list-container .stop-item').forEach((el, i) => el.classList.toggle('active-stop', i === idx));
  document.querySelectorAll('#stop-list-container .eta-expanded-container').forEach((el, i) => el.classList.toggle('active', i === idx));
  syncDetailExitStopButtonsUI();

  updateDownstreamAlightTimes(detailRouteGroup, idx, [], 0);

  const expEl = document.getElementById(`detail-eta-expanded-${idx}`);
  if (expEl && !isSilent) expEl.innerHTML = `<div class="last60-hud-box"><div style="font-size:0.8rem;color:var(--text-sub);text-align:center;">${t('loadingTimes')}</div></div>`;

  const itemEl = document.getElementById(`detail-stop-item-${idx}`);
  const listBox = document.getElementById('stop-list-container');
  if (itemEl && listBox && !isSilent) {
    setTimeout(() => {
      listBox.scrollTo({ top: Math.max(0, itemEl.offsetTop - 8), behavior: 'smooth' });
    }, 40);
  }

  highlightActiveStopMarkerOnMap(idx);
  if (!skipMapPan && window.mapInstance && mapMarkers[idx]) {
    const ll = mapMarkers[idx].getLatLng();
    const targetZ = Math.min(Math.max(window.mapInstance.getZoom() || 15, 15), 16);
    window.mapInstance.setView(ll, targetZ, { animate: true });
  }

  const stKey = stops[idx].stopKey || getGlobalStopKey(stops[idx]);
  const reqToken = ++expandStopRequestToken;
  const arrs = await fetchEtaRaw(detailRouteGroup, stKey, true, Date.now(), idx);
  if (reqToken !== expandStopRequestToken || currentView !== 'detail') return;

  detailLastFetchedArrs = arrs;
  if (detailRouteGroup.mode === 'FERRY' && arrs.length > 0) {
    const picked = arrs[Math.min(detailSelectedEtaBusIdx, arrs.length - 1)] || arrs[0];
    if (picked?.vesselClass) {
      if (!detailRouteGroup.ferryMeta) detailRouteGroup.ferryMeta = {};
      detailRouteGroup.ferryMeta._activeVesselClass = picked.vesselClass;
      const fareLblEl = document.getElementById(`stop-fare-lbl-${idx}`);
      if (fareLblEl) {
        const fVal = getEffectiveStopFare(detailRouteGroup, stops[idx], stops[stops.length - 1], isHongKongHolidayFareDay(), picked.vesselClass);
        if (fVal > 0) fareLblEl.innerText = `${t('farePrefix')}${fVal.toFixed(1)}`;
      }
    }
  }
  if (expEl) expEl.innerHTML = generateExpandedETAsHtml(arrs, detailRouteGroup, stKey, idx);
  updateDownstreamAlightTimes(detailRouteGroup, idx, arrs, detailSelectedEtaBusIdx, reqToken);
  if ((!detailRouteGroup.mode || detailRouteGroup.mode === 'BUS') && typeof window.syncDetailRouteBusSpeedSegments === 'function') {
    window.syncDetailRouteBusSpeedSegments(detailRouteGroup, stops);
  }
  if (typeof window.refreshStopByStopTrafficUI === 'function') {
    window.refreshStopByStopTrafficUI();
  }
}

function reverseCurrentRouteDirection() {
  if (!detailRouteGroup) return;
  triggerHaptic(12);
  if (typeof window.hideDetailBackToStopPill === 'function') window.hideDetailBackToStopPill();
  let opposite = null;
  if (typeof findOppositeDirectionGroup === 'function') {
    opposite = findOppositeDirectionGroup(detailRouteGroup, groupedRoutes);
  } else {
    const curBound = extractRouteBoundCode(detailRouteGroup);
    const curKeyBase = String(detailRouteGroup.key || '').replace(/_(O|I)(_\d+)?$/, '');
    const candidates = groupedRoutes.filter(g =>
      g.routeNo === detailRouteGroup.routeNo &&
      g.company === detailRouteGroup.company &&
      g.key !== detailRouteGroup.key &&
      extractRouteBoundCode(g) !== curBound
    );
    opposite =
      candidates.find(g => String(g.key || '').replace(/_(O|I)(_\d+)?$/, '') === curKeyBase && /_1$/.test(g.routeIds?.[0] || '')) ||
      candidates.find(g => String(g.key || '').replace(/_(O|I)(_\d+)?$/, '') === curKeyBase) ||
      candidates.find(g => /_1$/.test(g.routeIds?.[0] || '')) ||
      candidates[0];
  }

  if (opposite) {
    const curStops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
    const activeStop = curStops[detailExpandedStopIdx];
    const preserveKey = activeStop ? (activeStop.stopKey || getGlobalStopKey(activeStop)) : (detailBoardStopKey || detailTargetStopKey);
    openRouteDetail(opposite.key, preserveKey, null, true);
  } else {
    showToast(currentLang === 'zh' ? '此路線為單向或循環線' : 'Single direction / circular route');
  }
}

function toggleStopBookmark(idx) {
  if (!detailRouteGroup) return;
  triggerHaptic(15);
  const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
  const s = stops[idx];
  if (!s) return;
  const stKey = s.stopKey || getGlobalStopKey(s);
  const bmId = `${detailRouteGroup.key}|${stKey}`;
  const exIdx = bookmarkedStops.findIndex(b => b.id === bmId);
  const btn = document.getElementById(`stop-bm-btn-${idx}`);
  if (exIdx >= 0) {
    bookmarkedStops.splice(exIdx, 1);
    if (btn) { btn.classList.remove('saved'); btn.innerText = '☆'; }
    showToast(t('bookmarkRemoved'));
  } else {
    bookmarkedStops.push({ id: bmId, groupKey: detailRouteGroup.key, stopKey: stKey, stopName_e: s.stopName_e, stopName_tc: s.name_tc || s.stopName_e });
    if (btn) { btn.classList.add('saved'); btn.innerText = '★'; }
    showToast(t('bookmarkAdded'));
  }
  SafeStorage.setItem('transit_stop_bookmarks_v1', JSON.stringify(bookmarkedStops));
}

function removeStopBookmark(bmId) {
  triggerHaptic(12);
  bookmarkedStops = bookmarkedStops.filter(b => b.id !== bmId);
  SafeStorage.setItem('transit_stop_bookmarks_v1', JSON.stringify(bookmarkedStops));
  renderFavList(false);
}

function flipFavoriteBookmarksOrder() {
  triggerHaptic(12);
  bookmarkedStops.reverse();
  SafeStorage.setItem('transit_stop_bookmarks_v1', JSON.stringify(bookmarkedStops));
  renderFavList(false);
}

function cycleFavBookmarkPosition(idx) {
  triggerHaptic(12);
  if (bookmarkedStops.length < 2) return;
  const item = bookmarkedStops.splice(idx, 1)[0];
  bookmarkedStops.splice((idx + 1) % (bookmarkedStops.length + 1), 0, item);
  SafeStorage.setItem('transit_stop_bookmarks_v1', JSON.stringify(bookmarkedStops));
  renderFavList(false);
}

function tickLiveEtasInDOM() {
  if (document.hidden) return;
  const hktStr = getLiveHktTimeString();
  const c1 = document.getElementById('liveHktClockMain');
  const c2 = document.getElementById('liveHktClockDetail');
  if (c1) c1.innerText = hktStr;
  if (c2) c2.innerText = hktStr;
}
setInterval(tickLiveEtasInDOM, 1000);


function renderStopList() {
  const container = document.getElementById('stop-list-container');
  if (!container || !detailRouteGroup) return;
  const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
  const allowFinalStop = isCircularRoute(detailRouteGroup, stops);
  const isHol = isHongKongHolidayFareDay();
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const isPenultimateDualBranch = (detailRouteGroup.mode === 'MTR' && stops.length >= 3 && isParallelRailTerminusPair(stops[stops.length - 2]?.stopId, stops[stops.length - 1]?.stopId));
  const maxFareIdx = isPenultimateDualBranch ? stops.length - 3 : stops.length - 2;

  const isBusDetailMode = !detailRouteGroup.mode || detailRouteGroup.mode === 'BUS';

  container.innerHTML = stops.map((s, idx) => {
    const stKey = s.stopKey || getGlobalStopKey(s);
    const bmId = `${detailRouteGroup.key}|${stKey}`;
    const isSaved = bookmarkedStops.some(b => b.id === bmId);
    const isDownstream = (detailExpandedStopIdx >= 0 && idx > detailExpandedStopIdx);
    const isExit = Boolean(isDownstream && detailTargetStopKey && (detailTargetStopKey === stKey || detailTargetStopKey === s.stopId));
    const dStr = formatStopDistance(s);
    const fareProf = analyzeStopSectionFareProfile(detailRouteGroup, stops, idx, isHol);
    const fareHtml = (fareProf.fullFare > 0 && (idx <= maxFareIdx || allowFinalStop))
      ? `<span id="stop-fare-lbl-${idx}">${escapeHtml(fareProf.labelText)}</span>${fareProf.secBadge ? ` <span class="state-pill sched-ghost" style="padding:1px 6px;font-size:0.62rem;">${escapeHtml(fareProf.secBadge)}</span>` : ''}`
      : '';
    const hospBadge = isHospitalBranchStop(s) ? `<span class="state-pill">${t('viaHospitalTag')}</span>` : '';
    const exitLbl = isExit ? (isZh ? '下車 ✓' : 'Exit ✓') : (isZh ? '下車' : 'Exit');
    const segSlotHtml = (isBusDetailMode && idx < stops.length - 1)
      ? `<div class="stop-seg-speed-slot" id="stop-seg-speed-slot-${idx}"></div>`
      : '';
    return `
      <div class="stop-item" id="detail-stop-item-${idx}" onclick="if(!isUserSelectingText())expandStop(${idx}, false, false, false)">
        <div class="stop-alight-col" id="stop-alight-col-${idx}"></div>
        <div class="stop-header-row">
          <div class="stop-title-group">
            <div class="stop-name"><span>${idx + 1}. ${escapeHtml(getStopName(s))}</span> ${hospBadge}</div>
            ${(fareHtml || dStr) ? `<div class="stop-fare-sub">${fareHtml}${dStr ? `<span class="location-dist-pill">· ${escapeHtml(dStr)}</span>` : ''}</div>` : ''}
            ${segSlotHtml}
          </div>
          <div class="stop-meta-right">
            <button type="button" class="stop-exit-pill ${isExit ? 'active' : ''}" id="stop-exit-btn-${idx}" style="display:${isDownstream ? 'inline-flex' : 'none'};" aria-pressed="${isExit ? 'true' : 'false'}" onclick="event.stopPropagation(); toggleDetailExitStop(${idx});">${exitLbl}</button>
            <button class="stop-bm-btn ${isSaved ? 'saved' : ''}" id="stop-bm-btn-${idx}" onclick="event.stopPropagation(); toggleStopBookmark(${idx});">${isSaved ? '★' : '☆'}</button>
          </div>
        </div>
        <div class="eta-expanded-container" id="detail-eta-expanded-${idx}"></div>
      </div>`;
  }).join('') + renderMtrStyleReportFooterHtml();

  if (isBusDetailMode && typeof window.refreshStopByStopTrafficUI === 'function') {
    window.refreshStopByStopTrafficUI();
  }
}

window.__DETAIL_STOP_SEGMENTS__ = [];

window.refreshStopByStopTrafficUI = function() {
  try {
    if (currentView !== 'detail' || !detailRouteGroup) return;
    if (detailRouteGroup.mode && detailRouteGroup.mode !== 'BUS') {
      window.__DETAIL_STOP_SEGMENTS__ = [];
      return;
    }
    if (typeof window.buildStopByStopSegmentTraffic !== 'function') return;
    const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
    if (!Array.isArray(stops) || stops.length < 2) return;

    const roadPoly = (typeof window.getCurrentDetailRoadPolyline === 'function')
      ? window.getCurrentDetailRoadPolyline(detailRouteGroup.key)
      : null;
    const tdDetectors = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) ? window.__LIVE_TRAFFIC_DETECTORS__ : [];
    const tdCameras = Array.isArray(window.__LIVE_TRAFFIC_CAMERAS__) ? window.__LIVE_TRAFFIC_CAMERAS__ : [];
    const busSegs = Array.isArray(window.__DETAIL_BUS_SPEED_SEGMENTS__) ? window.__DETAIL_BUS_SPEED_SEGMENTS__ : [];

    const segs = window.buildStopByStopSegmentTraffic(stops, roadPoly, tdDetectors, tdCameras, busSegs, {
      tdSpeedGeoJson: window.__LIVE_TRAFFIC_SPEED_GEOJSON__ || null,
      routeNo: detailRouteGroup?.routeNo || ''
    });
    window.__DETAIL_STOP_SEGMENTS__ = segs;
    const segSig = `${detailRouteGroup?.key || ''}|${segs.map(s => `${s.source}:${s.tier}:${s.speedKmh ?? ''}`).join(',')}`;
    if (window.trafficLayerEnabled && window.__LAST_DETAIL_STOP_SEGS_SIG__ !== segSig) {
      window.__LAST_DETAIL_STOP_SEGS_SIG__ = segSig;
      if (typeof window._refreshDetailBusSpeedPolylineIfActive === 'function') {
        window._refreshDetailBusSpeedPolylineIfActive();
      }
    }
    const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
    const exitIdxRaw = detailTargetStopKey
      ? stops.findIndex(s => s && (s.stopKey === detailTargetStopKey || s.stopId === detailTargetStopKey))
      : -1;

    for (let i = 0; i < segs.length; i++) {
      const ownSeg = segs[i];
      const rowEl = document.getElementById(`detail-stop-item-${i}`);
      const slotEl = document.getElementById(`stop-seg-speed-slot-${i}`);
      if (!rowEl || !slotEl) continue;

      const exitStopIdx = (exitIdxRaw > i) ? exitIdxRaw : null;
      const worstPick = (typeof window.selectWorstAheadStopSegment === 'function')
        ? window.selectWorstAheadStopSegment(segs, stops, i, { exitStopIdx })
        : null;
      const seg = worstPick ? worstPick.seg : ownSeg;
      let dispTier = worstPick ? worstPick.tier : (ownSeg?.tier || 'UNKNOWN');
      if (seg && (seg.source === 'BUS_EST' || seg.isSyntheticFallback)) {
        const estSpd = Number(seg.speedKmh);
        dispTier = (Number.isFinite(estSpd) && Math.abs(estSpd) >= 18) ? 'SMOOTH' : 'MODERATE';
      } else if (seg && seg.source === 'BUS_API') {
        if (typeof window.capBusApiTierHardcode === 'function') {
          dispTier = window.capBusApiTierHardcode(dispTier, seg.speedKmh, {
            isTerminusApproach: Boolean(seg.isTerminusApproach),
            isScheduledFallback: Boolean(seg.isScheduledFallback),
            isVerifiedMultiBusStall: Boolean(seg.isVerifiedMultiBusStall)
          });
        } else if (!seg.isVerifiedMultiBusStall && dispTier === 'CONGESTED') {
          dispTier = (Number.isFinite(Number(seg.speedKmh)) && Math.abs(Number(seg.speedKmh)) >= 18) ? 'SMOOTH' : 'MODERATE';
        }
      }
      const modalFromIdx = worstPick ? worstPick.fromIdx : i;

      rowEl.classList.remove('seg-tone-smooth', 'seg-tone-moderate', 'seg-tone-congested');
      if (dispTier === 'CONGESTED') rowEl.classList.add('seg-tone-congested');
      else if (dispTier === 'MODERATE') rowEl.classList.add('seg-tone-moderate');
      else if (dispTier === 'SMOOTH') rowEl.classList.add('seg-tone-smooth');

      if (!seg || seg.source === 'NONE') {
        slotEl.innerHTML = '';
        continue;
      }

      const toneCls = seg.source === 'CAM_ONLY'
        ? 'tone-cam'
        : (dispTier === 'CONGESTED' ? 'tone-congested' : (dispTier === 'MODERATE' ? 'tone-moderate' : 'tone-smooth'));
      const srcCls = seg.source === 'TD'
        ? 'source-td'
        : (seg.source === 'BUS_API'
          ? 'source-bus-api'
          : ((seg.source === 'BUS_EST' || seg.isSyntheticFallback) ? 'source-bus-est' : 'source-cam'));
      const dot = seg.source === 'CAM_ONLY'
        ? '📷'
        : (dispTier === 'CONGESTED' ? '🔴' : (dispTier === 'MODERATE' ? '🟠' : '🟢'));

      const flowTxt = dispTier === 'CONGESTED'
        ? (isZh ? '擠塞' : 'Jammed')
        : (dispTier === 'MODERATE'
          ? (isZh ? '緩慢' : 'Slow')
          : (isZh ? '暢通' : 'Clear'));

      let labelTxt = '';
      if (seg.source === 'TD') {
        const srcTag = seg.camKey ? '📷' : 'TD';
        labelTxt = `${dot} ${flowTxt} · ${srcTag}`;
      } else if (seg.source === 'BUS_API') {
        const busSpdVal = Number(seg.speedKmh);
        const hasBusSpd = Number.isFinite(busSpdVal) && busSpdVal > 0 && !seg.isScheduledFallback;
        const busTag = hasBusSpd
          ? (isZh ? `🚌 巴士推算 • ${Math.abs(Math.round(busSpdVal))} km/h` : `🚌 Bus API • ${Math.abs(Math.round(busSpdVal))} km/h`)
          : '🚌';
        const srcTag = seg.camKey ? `${busTag} 📷` : busTag;
        labelTxt = `${dot} ${flowTxt} · ${srcTag}`;
      } else if (seg.source === 'BUS_EST' || seg.isSyntheticFallback) {
        const estSpdVal = Number(seg.speedKmh);
        const hasEstSpd = Number.isFinite(estSpdVal) && estSpdVal > 0;
        const estTag = hasEstSpd
          ? (isZh ? `🚌 路況估算 • ${Math.abs(Math.round(estSpdVal))} km/h` : `🚌 Bus Est. • ${Math.abs(Math.round(estSpdVal))} km/h`)
          : (isZh ? '🚌 路況估算' : '🚌 Bus Est.');
        const srcTag = seg.camKey ? `${estTag} 📷` : estTag;
        labelTxt = `${dot} ${flowTxt} · ${srcTag}`;
      } else {
        labelTxt = isZh ? '📷 路段鏡頭' : '📷 Road Cam';
      }

      const spanFrom = Number(seg.fromSeq || (modalFromIdx + 1));
      const spanTo = Number(seg.toSeq || (modalFromIdx + 2));
      const ariaDesc = isZh
        ? `第 ${spanFrom} 至 ${spanTo} 站路況：${labelTxt}`
        : `Traffic from stop ${spanFrom} to ${spanTo}: ${labelTxt}`;
      slotEl.innerHTML = `<button type="button" class="stop-seg-speed-pill ${toneCls} ${srcCls}" data-seg-source="${escapeHtml(seg.source)}" data-seg-tier="${escapeHtml(dispTier)}" aria-label="${escapeHtml(ariaDesc)}" onclick="event.stopPropagation(); openStopSegmentTrafficModal(${modalFromIdx});">${escapeHtml(labelTxt)} ›</button>`;
    }
  } catch (e) {}
};

window.toggleTrafficInlineBreakdown = function(stopIdx, triggerEl = null) {
  try {
    if (typeof triggerHaptic === 'function') triggerHaptic(8);
    const panel = document.getElementById(`traffic-inline-breakdown-${stopIdx}`);
    if (!panel) return false;
    const isHidden = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = isHidden ? 'block' : 'none';
    if (isHidden && typeof window.expandDetailSheetToTop === 'function') {
      window.expandDetailSheetToTop();
    }
    if (triggerEl && typeof triggerEl.setAttribute === 'function') {
      triggerEl.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      const cta = typeof triggerEl.querySelector === 'function' ? triggerEl.querySelector('.traffic-road-cta') : null;
      if (cta && typeof cta.textContent === 'string') {
        cta.textContent = isHidden
          ? cta.textContent.replace('›', '⌄')
          : cta.textContent.replace('⌄', '›');
      }
    }
    return isHidden;
  } catch (e) {
    return false;
  }
};

window.openStopSegmentTrafficModal = function(fromIdx) {
  triggerHaptic(10);
  const segs = Array.isArray(window.__DETAIL_STOP_SEGMENTS__) ? window.__DETAIL_STOP_SEGMENTS__ : [];
  const seg = segs.find(s => Number(s.fromIdx) === Number(fromIdx));
  if (!seg) return;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const fromLbl = isZh ? (seg.fromNameTc || seg.fromNameEn) : (seg.fromNameEn || seg.fromNameTc);
  const toLbl = isZh ? (seg.toNameTc || seg.toNameEn) : (seg.toNameEn || seg.toNameTc);
  const spanLabel = `${seg.fromSeq}. ${fromLbl} → ${seg.toSeq}. ${toLbl}`;

  // Tier 1: TD Speed Detector (+ matched TD camera if available)
  if (seg.source === 'TD' && seg.detId && typeof window.openTrafficDecisionModal === 'function') {
    window.openTrafficDecisionModal(seg.detId, '', spanLabel, false, seg.cam || null);
    return;
  }

  // Tier 3: TD Camera only
  if (seg.source === 'CAM_ONLY' && seg.camKey && typeof window.openTrafficCameraByKey === 'function') {
    window.openTrafficCameraByKey(seg.camKey, seg.camDesc || spanLabel);
    return;
  }

  // Tier 2 / Tier 2.5 (BUS_API, BUS_EST, or Unmonitored leg tapped from horizontal journey bar): Breakdown modal
  const modal = document.getElementById('trafficDecisionModal');
  const bodyEl = document.getElementById('trafficModalBody');
  if (!modal || !bodyEl) return;

  const titleEl = document.getElementById('trafficModalTitle');
  const subEl = document.getElementById('trafficModalSub');
  const closeEl = document.getElementById('trafficModalCloseBtn');
  const isUnmonitored = seg.source === 'NONE' || seg.speedKmh === null || seg.speedKmh === undefined;
  const isBusEst = Boolean(!isUnmonitored && (seg.source === 'BUS_EST' || seg.isSyntheticFallback));
  if (titleEl) {
    titleEl.innerText = isUnmonitored
      ? (isZh ? `路段路況 (${seg.fromSeq}→${seg.toSeq}站)` : `Route Stretch (#${seg.fromSeq}→#${seg.toSeq})`)
      : (isBusEst
        ? (isZh ? `🚌 道路估算路況 (${seg.fromSeq}→${seg.toSeq}站)` : `🚌 Bus Est. Segment (#${seg.fromSeq}→#${seg.toSeq})`)
        : (isZh ? `🚌 巴士實測路況 (${seg.fromSeq}→${seg.toSeq}站)` : `🚌 Bus Speed Segment (#${seg.fromSeq}→#${seg.toSeq})`));
  }
  if (subEl) subEl.innerHTML = `<span>${escapeHtml(spanLabel)}</span>`;
  if (closeEl) closeEl.innerText = isZh ? '✕ 關閉' : '✕ Close';

  const modalTier = isUnmonitored
    ? 'SMOOTH'
    : (isBusEst
      ? ((Number.isFinite(Number(seg.speedKmh)) && Math.abs(Number(seg.speedKmh)) >= 18) ? 'SMOOTH' : 'MODERATE')
      : (seg.source === 'BUS_API' && typeof window.capBusApiTierHardcode === 'function'
        ? window.capBusApiTierHardcode(seg.tier, seg.speedKmh, {
            isTerminusApproach: Boolean(seg.isTerminusApproach),
            isScheduledFallback: Boolean(seg.isScheduledFallback),
            isVerifiedMultiBusStall: Boolean(seg.isVerifiedMultiBusStall)
          })
        : (seg.source === 'BUS_API' && !seg.isVerifiedMultiBusStall && seg.tier === 'CONGESTED' ? 'MODERATE' : seg.tier)));
  const tone = isUnmonitored ? 'smooth' : (modalTier === 'CONGESTED' ? 'jammed' : (modalTier === 'MODERATE' ? 'slow' : 'smooth'));
  const toneDot = isUnmonitored ? '⚪' : (modalTier === 'CONGESTED' ? '🔴' : (modalTier === 'MODERATE' ? '🟠' : '🟢'));
  const verdict = isUnmonitored
    ? (isZh ? '此路段暫無實時測速監測' : 'Unmonitored stretch (no live TD sensor or bus ETA pair)')
    : (isBusEst
      ? (modalTier === 'MODERATE'
        ? (isZh ? '此路段按道路類型估算稍慢' : 'Estimated slower road-class flow on this stretch')
        : (isZh ? '此路段按道路類型估算暢通' : 'Estimated clear road-class flow on this stretch'))
      : (modalTier === 'CONGESTED'
        ? (isZh ? '此路段巴士多班受阻' : 'Jammed bus flow (multi-bus stall)')
        : (modalTier === 'MODERATE'
          ? (isZh ? '此路段車流稍慢' : 'Slow bus flow on this stretch')
          : (isZh ? '此路段巴士行車暢通' : 'Clear bus traffic on this stretch'))));
  const absDistKm = Math.abs(Number(seg.roadDistKm) || 0);
  const distTxt = absDistKm < 1 ? `${Math.round(absDistKm * 1000)}m` : `${absDistKm.toFixed(2)} km`;
  const absDeltaSec = Math.abs(Number(seg.deltaSec));
  const etaDeltaTxt = (seg.deltaSec !== null && seg.deltaSec !== undefined && Number.isFinite(absDeltaSec))
    ? (absDeltaSec >= 60 ? `${(absDeltaSec / 60).toFixed(1)}m` : `${Math.round(absDeltaSec)}s`)
    : '—';
  const expectedTxt = (seg.expectedKmh !== null && seg.expectedKmh !== undefined && Number.isFinite(Number(seg.expectedKmh)))
    ? `${Math.abs(Math.round(Number(seg.expectedKmh)))} km/h`
    : '—';
  const speedDisplayTxt = isUnmonitored
    ? '—'
    : `${Math.abs(Math.round(Number(seg.speedKmh) || 0))} km/h`;

  const camUrl = seg.camKey ? buildTrafficCamProxyUrl(seg.camKey, Math.floor(Date.now() / 60000)) : '';
  const camHtml = camUrl
    ? `<div class="traffic-cam-frame" id="trafficDecisionCamFrame">
         <img id="trafficDecisionCamImg" src="${camUrl}" alt="${escapeHtml(seg.camDesc || spanLabel)} TD live camera snapshot" loading="eager" data-cam-key="${escapeHtml(seg.camKey)}" onload="handleTrafficCamImageLoad(this, '${escapeJsAttr(seg.camKey)}')" onerror="handleTrafficCamImageError(this, '${escapeJsAttr(seg.camKey)}')">
         <div id="trafficCamStatusBanner" class="traffic-cam-status-banner" role="status" aria-live="polite"></div>
       </div>
       <div class="traffic-cam-caption">
         <span id="trafficCamCaptionText">📷 ${isZh ? '附近運輸署實時快拍' : 'Nearby HKSAR TD Live Snapshot'} (${escapeHtml(seg.camKey)})</span>
         <button type="button" style="border:none; background:none; color:var(--ios-blue); font-weight:700; font-size:0.72rem; cursor:pointer; padding:2px 4px;" onclick="refreshTrafficDecisionCam('${escapeJsAttr(seg.camKey)}')">↻ ${isZh ? '更新圖片' : 'Refresh'}</button>
       </div>`
    : `<div style="font-size:0.76rem; color:var(--text-sub); text-align:center; padding:12px; border-radius:11px; background:var(--bg-surface);">
         ${isBusEst
           ? (isZh
             ? '此路段暫無運輸署車速感應器或實時站間配對，車速按站間距離及香港道路類型估算（僅顯示暢通／稍慢）。'
             : 'No HKSAR TD road sensor or live bus ETA pair covers this stretch — speed is estimated from span distance and road class (capped at Clear/Slow).')
           : (isZh
             ? '此路段暫無運輸署車速感應器或鏡頭覆蓋，以上車速由實時巴士站間到站時間（扣除上落客及燈位停頓）推算。'
             : 'No HKSAR TD road sensor or camera covers this stretch — speed is calibrated from live bus stop-to-stop ETAs (dwell & signal adjusted).')}
       </div>`;

  const verdictSourceTip = isUnmonitored
    ? (isZh ? '未有實時感應器或站間到站數據' : 'No live sensor or paired stop ETA available yet')
    : (isBusEst
      ? (isZh ? `數據來源：路況估算 • ${speedDisplayTxt}（無運輸署感應器及實時站間配對）` : `Source: Bus Est. • ${speedDisplayTxt} (road-class estimate)`)
      : (isZh ? `數據來源：巴士推算 • ${speedDisplayTxt}（未有運輸署感應器路段）` : `Source: Bus API • ${speedDisplayTxt} (non-TD road)`));

  bodyEl.innerHTML = `
    <div class="traffic-verdict-banner tone-${tone}">
      <div class="traffic-verdict-title">${toneDot} ${escapeHtml(verdict)}</div>
      <div class="traffic-verdict-tip">${escapeHtml(verdictSourceTip)}</div>
    </div>
    <div class="traffic-metrics-grid">
      <div class="traffic-metric-box">
        <div class="traffic-metric-val">${escapeHtml(speedDisplayTxt)}</div>
        <div class="traffic-metric-lbl">${isZh ? '推算車速' : 'Est. Speed'}</div>
      </div>
      <div class="traffic-metric-box">
        <div class="traffic-metric-val">${escapeHtml(distTxt)}</div>
        <div class="traffic-metric-lbl">${isZh ? '站間距離' : 'Span Dist'}</div>
      </div>
      <div class="traffic-metric-box">
        <div class="traffic-metric-val">${escapeHtml(etaDeltaTxt)}</div>
        <div class="traffic-metric-lbl">${isZh ? `站間時間 (正常 ${expectedTxt})` : `ETA Δ (Typ ${expectedTxt})`}</div>
      </div>
    </div>
    ${camHtml}
    <div class="traffic-modal-actions">
      <button type="button" class="traffic-modal-btn primary" onclick="closeTrafficDecisionModal()">${isZh ? '知道了' : 'Got it'}</button>
    </div>
  `;
  modal.style.display = 'flex';
};

// ============================================================================
// SAVED BOOKMARKS VIEW
// ============================================================================
let favRenderToken = 0;

function formatCompactBookmarkDest(destName, isZh = false) {
  let txt = String(destName || '').trim();
  if (!txt) return '';
  if (isZh) {
    txt = txt
      .replace(/巴士總站/g, '總站')
      .replace(/公共運輸交匯處/g, '交匯處');
    return txt;
  }
  txt = txt
    .replace(/\bPublic Transport Interchange\b/gi, 'PTI')
    .replace(/\bBus Terminus\b/gi, 'B/T')
    .replace(/\bFerry Pier\b/gi, 'Pier')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return txt;
}
window.formatCompactBookmarkDest = formatCompactBookmarkDest;

async function renderFavList(isSilentRefresh = false) {
  const listEl = document.getElementById('favList');
  if (!listEl) return;
  if (!routeMapIndex.size) initRouteMapFast();

  if (!bookmarkedStops.length) {
    listEl.innerHTML = `<div class="text-center">${t('noSavedRoutes')}</div>`;
    return;
  }

  if (!isSilentRefresh || !listEl.querySelector('.route-list-item')) {
    listEl.innerHTML = bookmarkedStops.map((bm, idx) => {
      const g = routeMapIndex.get(bm.groupKey);
      if (!g) return '';
      const dispBadge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(g) : g.routeNo;
      const stName = stripPlatformCodeFromDisplay(currentLang === 'zh' && bm.stopName_tc ? bm.stopName_tc : bm.stopName_e);
      const compactDest = formatCompactBookmarkDest(getRouteName(g), currentLang === 'zh');
      return `
        <div class="route-list-item ${g.mode === 'FERRY' ? 'ferry-card' : ''}" onclick="if(!isUserSelectingText())openRouteDetail('${escapeJsAttr(g.key)}', '${escapeJsAttr(bm.stopKey)}')">
          <div class="route-no-col">
            <div class="route-no-text" style="color:${g.colorHex || 'var(--text-main)'};">${escapeHtml(dispBadge)}</div>
            <div class="route-co-tag">${escapeHtml(getCompanyName(g))}</div>
          </div>
          <div class="route-info-col">
            <div class="route-dest" title="${escapeHtml(getRouteName(g))}"><span class="to-prefix">${t('to')}</span><span class="route-dest-name">${escapeHtml(compactDest)}</span></div>
            <div class="route-sub" id="fav-sub-${idx}"><span>${escapeHtml(stName)}</span></div>
          </div>
          <div class="route-eta-col" id="fav-eta-${idx}">
            <div class="eta-time" style="color:var(--text-sub);font-size:1.1rem;">···</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;margin-left:4px;" onclick="event.stopPropagation()">
            <button class="fav-grip-btn" onclick="cycleFavBookmarkPosition(${idx})" title="Move">⇅</button>
            <button class="del-fav-btn" onclick="removeStopBookmark('${escapeJsAttr(bm.id)}')" title="Remove">✕</button>
          </div>
        </div>`;
    }).join('');
  }

  const myToken = ++favRenderToken;
  await Promise.all(bookmarkedStops.map(async (bm, idx) => {
    const g = routeMapIndex.get(bm.groupKey);
    if (!g) return;
    const arrs = await fetchEtaRaw(g, bm.stopKey, false, Date.now(), null);
    if (myToken !== favRenderToken || currentView !== 'fav') return;
    const etaEl = document.getElementById(`fav-eta-${idx}`);
    const subEl = document.getElementById(`fav-sub-${idx}`);
    if (!etaEl || !subEl) return;
    const stName = stripPlatformCodeFromDisplay(currentLang === 'zh' && bm.stopName_tc ? bm.stopName_tc : bm.stopName_e);
    if (arrs[0]) {
      const ui = formatEtaUI(arrs[0], g);
      const loadPillHtml = arrs[0].loadEstimate
        ? formatLoadPillHtml(arrs[0].loadEstimate, true)
        : '';
      etaEl.innerHTML = `<div class="eta-time">${ui.mainTimeStr}</div>${ui.clockStr ? `<div class="eta-clock-sub">${ui.clockStr}</div>` : ''}`;
      subEl.innerHTML = `${loadPillHtml}<span>${escapeHtml(stName)}</span>`;
    } else {
      etaEl.innerHTML = `<div class="eta-time" style="color:var(--text-sub);">-</div>`;
      subEl.innerHTML = `<span>${escapeHtml(stName)}</span>`;
    }
  }));
}

// ============================================================================
// STATUS & WATCHDOG MODAL
// ============================================================================
function auditLoadedTransitDatabase() {
  const EXPECTED_MTR = ['AEL', 'TCL', 'TML', 'TKL', 'EAL', 'SIL', 'TWL', 'ISL', 'KTL', 'DRL'];
  const EXPECTED_LRT = ['505', '507', '610', '614', '614P', '615', '615P', '705', '706', '751', '751P', '761P'];

  const presentMtr = new Set(groupedRoutes.filter(g => g.mode === 'MTR' && g.company === 'MTR').map(g => g.routeNo));
  const presentLrt = new Set(groupedRoutes.filter(g => g.mode === 'MTR' && g.company === 'LRT').map(g => g.routeNo));
  const missingMtr = EXPECTED_MTR.filter(x => !presentMtr.has(x));
  const missingLrt = EXPECTED_LRT.filter(x => !presentLrt.has(x));

  const ferryRoutes = groupedRoutes.filter(g => g.mode === 'FERRY');
  let ferryWithLiveKey = 0, ferryWithSched = 0, ferryDead = 0;

  ferryRoutes.forEach(g => {
    const lk = resolveFerryLiveEtaKeyClient(g.orig_e, g.dest_e) || g.liveEtaKey;
    const rStops = getStopsForGroup(g);
    const pairHdr = `${normStationLookupKey(g.orig_e)}_${normStationLookupKey(g.dest_e)}`;
    const pairStop = rStops.length >= 2
      ? `${normStationLookupKey(rStops[0].stopName_e)}_${normStationLookupKey(rStops[rStops.length - 1].stopName_e)}`
      : pairHdr;
    const isInterIslands = /pengchau|muiwo|chimawan|cheungchau/.test(pairStop);

    const sch = liveFerryApiCache.data?.csvSchedules?.[pairHdr]
      || liveFerryApiCache.data?.csvSchedules?.[pairStop]
      || g.ferryMeta?.sched
      || (isInterIslands ? liveFerryApiCache.data?.csvSchedules?.['pengchau_cheungchau'] : null);

    const hasSlots = sch && ((sch.wk?.length || 0) + (sch.sat?.length || 0) + (sch.hol?.length || 0) > 0);
    if (lk) ferryWithLiveKey++;
    if (hasSlots) ferryWithSched++;
    if (!lk && !hasSlots) ferryDead++;
  });

  let invalidCoordStops = 0;
  for (const g of groupedRoutes) {
    const rId = g.routeIds?.[0];
    if (!rId) continue;
    (routeStopsCache[rId] || []).forEach(s => {
      if (String(s?.stopId || '').startsWith('SYNTH_')) return;
      const la = parseFloat(s?.latitude), lo = parseFloat(s?.longitude);
      if (la === 0 && lo === 0) return;
      if (!isValidRailOrFerryCoord(la, lo)) invalidCoordStops++;
    });
  }

  const mtrMatrixExactTucLop = window.getExactMtrFare ? window.getExactMtrFare('TUC', 'LOP') : 0;
  const mtrEngineTucLop = typeof MTR_ENGINE !== 'undefined'
    ? MTR_ENGINE.lookupExactHeavyRailFare('TUC', 'LOP', window.getExactMtrFare)
    : 0;

  const issues = [];
  if (missingMtr.length) issues.push(`Missing MTR Lines: ${missingMtr.join(', ')}`);
  if (missingLrt.length) issues.push(`Missing LRT Routes: ${missingLrt.join(', ')}`);
  if (mtrMatrixExactTucLop <= 0) issues.push(`MTR O-D matrix pending v9 Action rebuild (using MTR_ENGINE calibrated fallback: TUC->LOP ≈ $${mtrEngineTucLop.toFixed(1)})`);
  if (!ferryRoutes.length) issues.push(`0 Ferry routes loaded!`);
  else if (ferryWithSched === 0 && ferryWithLiveKey === 0) issues.push(`Ferry Timetables Unhydrated: 0/${ferryRoutes.length} routes have matched schedules`);
  if (invalidCoordStops > 0) issues.push(`${invalidCoordStops} active stops have invalid/missing HK coordinates`);
  const edgeSt = SignalHealthMonitor.byOperator.EDGE;
  if (edgeSt.calls > 8) issues.push(`Edge Worker Loop Detected: ${edgeSt.calls} calls (${edgeSt.ms}ms last RTT)`);

  const hktTodayYmd = getHongKongDateYYYYMMDD();
  const reviewDate = typeof INTER_ISLANDS_REVIEW_AFTER !== 'undefined' ? INTER_ISLANDS_REVIEW_AFTER : '2027-01-10';
  const watchdogAlerts = [
    ...(Array.isArray(window.__DATA_DRIFT_ALERTS__) ? window.__DATA_DRIFT_ALERTS__ : []),
    ...Array.from((window.__LIVE_FERRY_DRIFT_ALERTS__ || new Map()).values())
  ];
  if (hktTodayYmd >= reviewDate && !watchdogAlerts.some(a => a.category === 'TEMP_WORKS_EXPIRY')) {
    watchdogAlerts.push({
      category: 'TEMP_WORKS_EXPIRY',
      date: hktTodayYmd,
      message: `Mui Wo Northern Berth 2.5-month temporary works window (${reviewDate}) has elapsed — check if Sun Ferry Inter-Islands has resumed normal schedule.`
    });
  }

  return {
    missingMtr, missingLrt,
    mtrMatrixExactTucLop, mtrEngineTucLop,
    ferryTotal: ferryRoutes.length, ferryWithLiveKey, ferryWithSched, ferryDead,
    invalidCoordStops, issues, watchdogAlerts
  };
}

async function openBuiltInStatusModal() {
  triggerHaptic(10);
  const modal = document.getElementById('builtInStatusModal');
  if (modal) modal.style.display = 'flex';

  const sumEl = document.getElementById('builtInStatusSummary');
  const rowsEl = document.getElementById('builtInStatusRows');
  const isZh = (currentLang === 'zh');

  const gpsSt = SignalHealthMonitor.getGpsStatus();
  const cellSt = SignalHealthMonitor.getCellStatus();
  const audit = auditLoadedTransitDatabase();

  const mtrCount = groupedRoutes.filter(g => g.mode === 'MTR' && g.company === 'MTR').length;
  const lrtCount = groupedRoutes.filter(g => g.mode === 'MTR' && g.company === 'LRT' && !/^(507P|610P)$/.test(g.routeNo)).length;
  const busCount = groupedRoutes.filter(g => !g.mode || g.mode === 'BUS').length;

  const overallHealthy = audit.issues.length === 0;
  const bannerStyle = overallHealthy
    ? 'background:rgba(52,199,89,0.14);border:1px solid rgba(52,199,89,0.45);color:var(--ios-green);'
    : 'background:rgba(255,149,0,0.14);border:1px solid rgba(255,149,0,0.45);color:var(--ios-orange);';

  const issuesHtml = audit.issues.length
    ? `<div style="${bannerStyle}border-radius:10px;padding:8px 10px;margin-top:7px;font-size:0.75rem;line-height:1.45;font-weight:700;">
         <div>⚠️ ${isZh ? `發現 ${audit.issues.length} 項數據提示：` : `${audit.issues.length} Notice(s) Detected:`}</div>
         ${audit.issues.map(x => `<div style="margin-top:2px;">• ${escapeHtml(x)}</div>`).join('')}
       </div>`
    : `<div style="${bannerStyle}border-radius:10px;padding:7px 10px;margin-top:7px;font-size:0.75rem;font-weight:700;">
         ✅ ${isZh ? `所有 10 條港鐵 (TUC➔LOP $${audit.mtrMatrixExactTucLop.toFixed(1)})、輕鐵、巴士及主線渡輪數據正常` : `All 10 MTR (TUC➔LOP $${audit.mtrMatrixExactTucLop.toFixed(1)}), LRT, Bus & Ferry tables verified`}
       </div>`;

  const reviewDate = typeof INTER_ISLANDS_REVIEW_AFTER !== 'undefined' ? INTER_ISLANDS_REVIEW_AFTER : '2027-01-10';
  const watchdogHtml = audit.watchdogAlerts.length > 0
    ? `<div style="background:rgba(255,149,0,0.15);border:1px solid rgba(255,149,0,0.45);color:var(--ios-orange);border-radius:10px;padding:8px 10px;margin-top:7px;font-size:0.74rem;line-height:1.45;font-weight:700;">
         <div>🔔 ${isZh ? `車資及時間表變動監察 (${audit.watchdogAlerts.length} 項)：` : `Schedule & Fare Drift Watchdog (${audit.watchdogAlerts.length} Notice):`}</div>
         ${audit.watchdogAlerts.map(a => `<div style="margin-top:3px;">• [${escapeHtml(a.category)}] ${escapeHtml(a.message)}</div>`).join('')}
       </div>`
    : `<div style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:10px;padding:7px 10px;margin-top:7px;font-size:0.72rem;color:var(--text-sub);line-height:1.4;">
         <div>🛡️ <strong>${isZh ? '自動監察運作正常' : 'Fare & Schedule Drift Watchdog Active'}</strong>: ${isZh ? '每週自動比對港鐵車資表、輕鐵及渡輪 CSV，如有變動會自動於 GitHub 發出電郵通知。' : 'Weekly Action & Live API canary monitor MTR fares, LRT CSVs and Ferry schedules (emails on drift).'}</div>
         <div style="margin-top:3px;color:var(--ios-orange);">🛠️ ${isZh ? `生效中臨時調整：橫水渡梅窩北面泊位工程時間表 (將於 ${reviewDate} 提醒覆核)` : `Active Temp Schedule: Inter-Islands Mui Wo N. Berth works (review reminder set for ${reviewDate})`}</div>
       </div>`;

  if (sumEl) {
    sumEl.innerHTML = `
      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <span class="state-pill ${gpsSt.grade === 'GOOD' ? 'live-gps' : 'sched-ghost'}">🎯 GPS: ${escapeHtml(gpsSt.label)}</span>
        <span class="state-pill ${cellSt.grade === 'GOOD' ? 'live-gps' : 'sched-ghost'}">📶 Net: ${escapeHtml(cellSt.label)}</span>
        <button class="header-pill-btn gps-reset-pill" onclick="runLiveTruthProbe()" style="height:26px;padding:0 9px;font-size:0.7rem;">🔬 ${isZh ? '實時抽樣及對照' : 'Run Live Probe'}</button>
      </div>
      <div style="font-size:0.73rem; color:var(--text-sub); margin-top:6px; line-height:1.4;">
        🚌 Bus: <strong>${busCount}</strong> •
        🚇 MTR: <strong style="color:${mtrCount >= 20 ? 'var(--ios-green)' : 'var(--ios-red)'}">${mtrCount}/20</strong> •
        🚋 LRT: <strong style="color:${lrtCount >= 24 ? 'var(--ios-green)' : 'var(--ios-red)'}">${lrtCount}/24</strong> (69 Stops) •
        ⛴️ Ferry: <strong>${audit.ferryTotal}</strong> (Live:${audit.ferryWithLiveKey} / Sched:<strong style="color:${audit.ferryWithSched > 0 ? 'var(--ios-green)' : 'var(--ios-red)'}">${audit.ferryWithSched}</strong>)
      </div>
      ${issuesHtml}
      ${watchdogHtml}`;
  }

  if (rowsEl) {
    const opLabels = {
      KMB:   'KMB / LWB (etabus.gov.hk)',
      CTB:   'Citybus (rt.data.gov.hk)',
      NLB:   'New Lantao Bus (rt.data.gov.hk)',
      GMB:   'Green Minibus (etagmb.gov.hk)',
      MTR:   'MTR Heavy Rail (getSchedule)',
      LRT:   'Light Rail (lrt/getSchedule)',
      FERRY: 'Ferry Live + Timetable Yield',
      EDGE:  'Cloudflare Edge (/api/worker)'
    };

    rowsEl.innerHTML = Object.entries(opLabels).map(([k, title]) => {
      const st = SignalHealthMonitor.byOperator[k] || { calls: 0, ms: 0, errors: 0, emptyPayloads: 0, lastYieldCount: null };
      let cls = 'district-tag', txt = isZh ? '未呼叫' : 'Untested';

      if (st.calls > 0) {
        const errRate = st.errors / st.calls;
        const isLoopingEdge = (k === 'EDGE' && st.calls > 8);
        const isZeroYield = (st.lastYieldCount === 0 && st.emptyPayloads >= 1);
        const isSlow = st.ms > 2000;

        if (errRate >= 0.35 || isLoopingEdge) {
          cls = 'load-full';
          txt = isLoopingEdge ? `LOOP (${st.calls} req • ${st.ms}ms)` : `ERR ${st.errors}/${st.calls} (${st.ms}ms)`;
        } else if (isZeroYield) {
          cls = 'sched-ghost';
          txt = `0 ETAs (${st.ms}ms • ${st.calls} req)`;
        } else if (isSlow || st.errors > 0) {
          cls = 'sched-ghost';
          txt = `${st.ms}ms (${st.calls} req)`;
        } else {
          cls = 'live-gps';
          const yieldTag = st.lastYieldCount !== null ? ` • ${st.lastYieldCount} ETA✓` : '';
          txt = `${st.ms}ms (${st.calls} req${yieldTag})`;
        }
      }

      return `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:7px 10px; background:var(--bg-surface); border-radius:10px;">
        <span style="font-size:0.77rem;">${escapeHtml(title)}</span>
        <span class="state-pill ${cls}">${escapeHtml(txt)}</span>
      </div>`;
    }).join('');
  }
}

function closeBuiltInStatusModal() {
  const modal = document.getElementById('builtInStatusModal');
  if (modal) modal.style.display = 'none';
}

async function runLiveTruthProbe() {
  triggerHaptic(14);
  showToast(currentLang === 'zh' ? '🔬 正在實測港鐵、輕鐵、巴士及渡輪時間表對照...' : '🔬 Probing live MTR, LRT, Bus & Ferry schedules...');
  const samples = [
    groupedRoutes.find(g => g.mode === 'MTR' && g.routeNo === 'TCL'),
    groupedRoutes.find(g => g.mode === 'MTR' && g.company === 'LRT' && g.routeNo === '505') || groupedRoutes.find(g => g.mode === 'MTR' && g.company === 'LRT'),
    groupedRoutes.find(g => g.company === 'KMB'),
    groupedRoutes.find(g => g.company === 'NLB' && g.routeNo === '3M'),
    groupedRoutes.find(g => g.mode === 'FERRY' && /mui wo/i.test(g.orig_e) && /central/i.test(g.dest_e)),
    groupedRoutes.find(g => g.mode === 'FERRY' && /peng chau/i.test(g.orig_e) && /mui wo|cheung chau/i.test(g.dest_e))
  ].filter(Boolean);

  await Promise.all(samples.map(async (g) => {
    const stops = getStopsForGroup(g);
    const s0 = g.company === 'LRT'
      ? (stops.find((s, idx) => idx < stops.length - 1 && resolveLrtNumericId(s.lrtCode || s.stopId, s.stopName_e, s.name_tc)) || stops[0])
      : stops[0];
    if (s0) await fetchStopSingleRaw(g, s0, true);
  }));
  syncSettingsModalLabels();
  openBuiltInStatusModal();
}

function applyLanguage() {
  if (document.documentElement) {
    document.documentElement.lang = (currentLang === 'zh') ? 'zh-Hant-HK' : 'en';
  }
  document.title = t('docTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (k) el.innerText = t(k);
  });
  const sInp = document.getElementById('stopSearchInput');
  if (sInp) sInp.placeholder = t('searchStopPlaceholder');
  const mapTitle = document.getElementById('mapBrowserHeaderTitle');
  if (mapTitle) mapTitle.innerText = t('mapTapHint');

  syncSettingsModalLabels();
  syncTrafficToggleButtonsUI();
  updateTopBackButtonVisibility();
  updateCommuteBarUI();
  updateMainStopHeaderDisplay();
  if (typeof window.syncTrafficOverlaysAllMaps === 'function') {
    window.syncTrafficOverlaysAllMaps();
  }
  if (document.getElementById('tutorialModal')?.style.display === 'flex' && typeof renderTutorialStep === 'function') {
    renderTutorialStep();
  }

  if (currentView === 'main') renderMainNearby(false);
  else if (currentView === 'detail' && detailRouteGroup) {
    updateKmbDetailHeader();
    renderStopList();
    if (detailExpandedStopIdx >= 0) expandStop(detailExpandedStopIdx, true, false, true);
  } else if (currentView === 'xfer') renderTransferPlannerView();
  else if (currentView === 'fav') renderFavList(false);
}

let _lastCorridorsSig = '';
async function syncEdgeTrafficCorridors() {
  if (document.hidden) return;
  try {
    const [d, tdLive] = await Promise.all([
      fetchEdgeApiJSON('', 3500, false).catch(() => null),
      fetchEdgeApiJSON('?action=traffic_live', 4800, false).catch(() => null)
    ]);

    if (d?.ok) {
      if (d.highwayCorridors && typeof d.highwayCorridors === 'object') {
        const nextSig = Object.entries(d.highwayCorridors)
          .filter(([k]) => k !== 'TM_CLK_TUNNEL')
          .map(([k, v]) => `${k}:${v?.status || 'SMOOTH'}`)
          .join('|');
        window.__LIVE_CORRIDORS__ = d.highwayCorridors;
        window.__LIVE_HIGHWAY_KMH__ = Number(d.highwayCorridors.LANTAU_TM?.speedKmh || d.highwayCorridors.TM_CLK_TUNNEL?.speedKmh) || 70;
        if (_lastCorridorsSig && _lastCorridorsSig !== nextSig && typeof window.invalidateRaptorGraph === 'function') {
          window.invalidateRaptorGraph();
        }
        _lastCorridorsSig = nextSig;
      }

      if (d.weather && typeof d.weather === 'object') {
        window.__HKO_WEATHER__ = d.weather;
      }

      if (typeof syncRelevantCorridorPillUI === 'function') {
        syncRelevantCorridorPillUI();
      }
    }

    if (tdLive?.ok && Array.isArray(tdLive.detectors)) {
      const hadDetectorsBefore = Array.isArray(window.__LIVE_TRAFFIC_DETECTORS__) && window.__LIVE_TRAFFIC_DETECTORS__.length > 0;
      window.__LIVE_TRAFFIC_DETECTORS__ = tdLive.detectors;
      if (Array.isArray(tdLive.cameras)) window.__LIVE_TRAFFIC_CAMERAS__ = tdLive.cameras;
      if (tdLive.speedMapGeoJson && tdLive.speedMapGeoJson.type === 'FeatureCollection') {
        window.__LIVE_TRAFFIC_SPEED_GEOJSON__ = tdLive.speedMapGeoJson;
      }
      window.__LIVE_TRAFFIC_CAPTURED_AT__ = tdLive.capturedAt || '';
      if (typeof window.syncTrafficOverlaysAllMaps === 'function') {
        window.syncTrafficOverlaysAllMaps();
      }
      if (typeof window.refreshStopByStopTrafficUI === 'function') {
        window.refreshStopByStopTrafficUI();
      }
      if (currentView === 'detail' && detailRouteGroup && detailExpandedStopIdx >= 0 && Array.isArray(detailLastFetchedArrs)) {
        const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
        const stObj = stops[detailExpandedStopIdx];
        const stKey = stObj?.stopKey || getGlobalStopKey(stObj);
        const expEl = document.getElementById(`detail-eta-expanded-${detailExpandedStopIdx}`);
        if (expEl && stObj) {
          expEl.innerHTML = generateExpandedETAsHtml(detailLastFetchedArrs, detailRouteGroup, stKey, detailExpandedStopIdx);
        }
      } else if (!hadDetectorsBefore && currentView === 'xfer' && userCommuteProfile?.home && userCommuteProfile?.work && typeof renderTransferPlannerView === 'function') {
        renderTransferPlannerView();
      }
    }
  } catch (e) {}
}

window.onBusRouteGeometryReady = function(groupKey) {
  try {
    if (currentView === 'detail' && detailRouteGroup && detailRouteGroup.key === groupKey) {
      if (typeof window.refreshStopByStopTrafficUI === 'function') {
        window.refreshStopByStopTrafficUI();
      }
      if (detailExpandedStopIdx >= 0 && Array.isArray(detailLastFetchedArrs)) {
        const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
        const stObj = stops[detailExpandedStopIdx];
        const stKey = stObj?.stopKey || getGlobalStopKey(stObj);
        const expEl = document.getElementById(`detail-eta-expanded-${detailExpandedStopIdx}`);
        if (expEl && stObj) {
          expEl.innerHTML = generateExpandedETAsHtml(detailLastFetchedArrs, detailRouteGroup, stKey, detailExpandedStopIdx);
        }
      }
    }
  } catch (e) {}
};

window.onDetailBusSpeedReady = function(groupKey) {
  try {
    if (currentView === 'detail' && detailRouteGroup && detailRouteGroup.key === groupKey) {
      if (typeof window.refreshStopByStopTrafficUI === 'function') {
        window.refreshStopByStopTrafficUI();
      }
      if (detailExpandedStopIdx >= 0 && Array.isArray(detailLastFetchedArrs)) {
        const stops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
        const stObj = stops[detailExpandedStopIdx];
        const stKey = stObj?.stopKey || getGlobalStopKey(stObj);
        const expEl = document.getElementById(`detail-eta-expanded-${detailExpandedStopIdx}`);
        if (expEl && stObj) {
          expEl.innerHTML = generateExpandedETAsHtml(detailLastFetchedArrs, detailRouteGroup, stKey, detailExpandedStopIdx);
        }
      }
    }
  } catch (e) {}
};

async function executeSync(forceManual = false) {
  if (document.hidden && !forceManual) return;
  if (isSyncing && !forceManual) return;
  isSyncing = true;
  const dot = document.getElementById('bgSyncDot');
  dot?.classList.add('syncing');

  try {
    if (currentView === 'main' && !isStopSearchOpen()) {
      await renderMainNearby(true);
    } else if (currentView === 'detail' && detailRouteGroup && detailExpandedStopIdx >= 0) {
      await expandStop(detailExpandedStopIdx, true, false, true);
    } else if (currentView === 'fav') {
      await renderFavList(true);
    }
  } catch (e) {}

  setTimeout(() => dot?.classList.remove('syncing'), 280);
  isSyncing = false;
}

window.openCompanionAppAtCurrentStop = function(target) {
  let st = null;
  if (currentView === 'detail' && detailRouteGroup) {
    const rStops = getStopsForGroup(detailRouteGroup, detailBoardStopKey || detailTargetStopKey);
    st = rStops[detailExpandedStopIdx >= 0 ? detailExpandedStopIdx : 0];
  }
  if (!st) {
    st = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
  }
  const lat = st ? parseFloat(st.latitude) : (lastKnownPos?.lat || 22.2819);
  const lon = st ? parseFloat(st.longitude) : (lastKnownPos?.lon || 114.1556);
  const targetUrl = target === 'property'
    ? `https://hkproperty.pages.dev/#lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&from=transit`
    : (target === 'sundry'
      ? 'https://hksundry.pages.dev/'
      : (target === 'layer'
        ? 'https://hklayer.pages.dev/'
        : 'https://hkway.pages.dev/'));
  const a = document.createElement('a');
  a.href = targetUrl;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

(async function boot() {
  applyLanguage();

  // Recover Home & Work stops from IndexedDB backup if localStorage & cookie were both cleared
  if (typeof SavedHubsManager !== 'undefined' && window.__TRANSIT_IDB__?.get) {
    const curHubs = SavedHubsManager.getHubs();
    if (!curHubs.home && !curHubs.work) {
      window.__TRANSIT_IDB__.get('transit_saved_hubs_v1').then((idbHubs) => {
        if (idbHubs && (idbHubs.home || idbHubs.work)) {
          if (idbHubs.home) SavedHubsManager.setHub('home', idbHubs.home);
          if (idbHubs.work) SavedHubsManager.setHub('work', idbHubs.work);
          if (typeof syncSettingsModalLabels === 'function') syncSettingsModalLabels();
          if (typeof renderCommuteShortcutChips === 'function') renderCommuteShortcutChips();
        }
      }).catch(() => {});
    }
  }
  // Pre-warm Leaflet asynchronously after initial paint (never blocks boot)
  setTimeout(() => { if (typeof window.ensureLeafletLoaded === 'function') window.ensureLeafletLoaded(); }, 180);

  if (!liveFerryApiCache.data) {
    liveFerryApiCache.data = { liveEtas: {}, csvSchedules: {}, keyTs: {} };
  }
  liveFerryApiCache.data.csvSchedules = mergeVerifiedMainlineSchedules(liveFerryApiCache.data.csvSchedules);

  const [earlyIdx, earlyGps] = await Promise.all([
    window.__EARLY_INDEX_PROMISE__,
    window.__EARLY_GPS_PROMISE__
  ]);

  if (earlyGps && Number.isFinite(earlyGps.lat) && earlyGps.acc <= 450) {
    SignalHealthMonitor.recordGpsFix(earlyGps.acc);
    lastKnownPos = { lat: earlyGps.lat, lon: earlyGps.lon, acc: Math.round(earlyGps.acc), hasLiveFix: true };
    SafeStorage.setItem('transit_last_gps_pos_v2', JSON.stringify(lastKnownPos));
  }

  if (earlyIdx?.data) {
    const db = earlyIdx.data;
    routeStopsCache = db.routeStopsCache || {};
    groupedRoutes = Array.isArray(db.groupedRoutes) ? db.groupedRoutes : [];
    window.__LAST_TD_UPDATED__ = db.tdLastUpdated || db.lastUpdated || '';
    if (Array.isArray(db.dataDriftAlerts)) {
      window.__DATA_DRIFT_ALERTS__ = db.dataDriftAlerts;
    }
    window.MULTI_MODAL_HUBS_DIRECTORY = Array.isArray(db.multiModalHubs) ? db.multiModalHubs : [];
    const seedExits = Array.isArray(window.MTR_EXITS_SEED) ? window.MTR_EXITS_SEED : [];
    window.MTR_EXITS_DIRECTORY = (Array.isArray(db.mtrExits) && db.mtrExits.length > 0) ? db.mtrExits : seedExits;
    window.QUICK_MTR_LINES = (db.quickMtrLines || []).map(x => ({ ...x, color: window.__GET_ROUTE_COLOR_HEX__('MTR', 'MTR', x.key || x.badge) }));
    window.QUICK_LRT_LINES = (db.quickLrtLines || []).map(x => ({ ...x, color: '#5856D6' }));
    window.QUICK_FERRY_LINES = (db.quickFerryLines || []).map(x => ({ ...x, color: '#0090D9' }));
    liveFerryApiCache.data.csvSchedules = mergeVerifiedMainlineSchedules(db.csvSchedules || {});
    filterToMainlineFerriesOnly();
    initRouteMapFast();
    syncSettingsModalLabels();
  }

  window.__INITIAL_STOPS_GPS_RESOLVED__ = true;
  setTimeout(() => {
    if (isHydratingInitialData) setHydratingInitialData(false);
  }, 6000);

  const urlParams = new URLSearchParams(window.location.search || window.location.hash.replace(/^#/, ''));
  const extLat = parseFloat(urlParams.get('lat'));
  const extLng = parseFloat(urlParams.get('lng') || urlParams.get('lon'));
  const extZoom = parseInt(urlParams.get('z'), 10) || 16;
  const openMapTab = urlParams.get('view') === 'map' || Boolean(urlParams.get('from'));

  if (isValidRailOrFerryCoord(extLat, extLng)) {
    lastKnownPos = { lat: extLat, lon: extLng, acc: 15, hasLiveFix: true };
    userManualStopBrowseUntilMs = Date.now() + 600000;
    syncNearestStopFromGPS(extLat, extLng, true);
    renderMainNearby(false);
    if (openMapTab) {
      switchView('map', true);
      setTimeout(() => {
        if (window.browseMapInstance) {
          window.browseMapInstance.setView([extLat, extLng], Math.min(18, Math.max(14, extZoom)), { animate: false });
          renderBrowseMapVisiblePins();
          if (browseMapClickedSpotMarker) {
            try { window.browseMapInstance.removeLayer(browseMapClickedSpotMarker); } catch (e) {}
          }
          browseMapClickedSpotMarker = L.circleMarker([extLat, extLng], {
            radius: 9, fillColor: '#FF9500', color: '#FFFFFF', weight: 2.5, fillOpacity: 0.95
          }).addTo(window.browseMapInstance);
          browseMapClickedSpotMarker.bindPopup(buildBrowseMapActionPopupHtml({
            stopKey: `EXT_PIN_${extLat.toFixed(5)}_${extLng.toFixed(5)}`,
            nameEn: `Linked Spot (${extLat.toFixed(4)}, ${extLng.toFixed(4)})`,
            nameTc: `跨平台連結位置 (${extLat.toFixed(4)}, ${extLng.toFixed(4)})`,
            lat: extLat, lon: extLng, nodeType: 'ADDRESS', hasStopRadar: false
          }), { closeButton: true, offset: [0, -4] }).openPopup();
        }
      }, 95);
    }
  } else {
    syncNearestStopFromGPS(lastKnownPos.lat, lastKnownPos.lon, true);
    renderMainNearby(false);
    autoAcquireLiveGpsAndSnap(false);
  }

  setTimeout(() => {
    syncEdgeTrafficCorridors();
    triggerIosStandaloneTopBarReflow();
  }, 350);

  setTimeout(() => {
    maybeShowFirstVisitOnboarding(isValidRailOrFerryCoord(extLat, extLng));
  }, 600);

  window.addEventListener('pageshow', (ev) => {
    triggerIosStandaloneTopBarReflow();
    if (ev.persisted || allStops.length === 0) {
      executeSync(true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tickLiveEtasInDOM();
      countdown = getAdaptiveRefreshIntervalSec();
      executeSync(false);
    }
  });

  countdown = getAdaptiveRefreshIntervalSec();
  setInterval(() => {
    if (document.hidden) return;
    countdown--;
    if (countdown <= 0) {
      countdown = getAdaptiveRefreshIntervalSec();
      executeSync(false);
    }
  }, 1000);

  setInterval(syncEdgeTrafficCorridors, 60000);
})();
