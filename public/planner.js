// ============================================================================
// File: planner.js (johntjz/Hk-Fleet — Multi-Modal Behavioral Routing Engine)
// ============================================================================

var userCommuteProfile = { home: null, work: null };
try {
  const savedCommute = JSON.parse(localStorage.getItem('transit_commute_profile_v1') || 'null');
  if (savedCommute && typeof savedCommute === 'object') userCommuteProfile = savedCommute;
} catch (e) {}

var activeCommutePickerSlot = 'home'; // 'home' | 'work' | 'hub_home' | 'hub_work'
var lastXferSolvedSpec = null;
var activeXferCorridorIdx = 0;
var activeXferStopNodeIdx = 0;
var activeUnifiedCardKey = '';
var xferTimeMode = 'NOW';
var xferPlannedHHMM = null;
var xferLocoBikeEnabled = false;
var xferSortPref = 'BULLETPROOF'; // 'BULLETPROOF' | 'FASTEST' | 'EASY' | 'CHEAPEST'
var alsAddressSearchResults = [];
var alsSearchDebounceTimer = null;
var alsReqSeq = 0;
var activePlannerInlineSlot = null; // 'home' | 'work' | null
var plannerInlineAlsResults = [];
var plannerInlineDebounce = null;
var plannerInlineReqSeq = 0;
var _raptorGraph = null;
var _raptorGraphRouteCount = 0;
var xferRenderToken = 0;
var xferTimeChangeDebounce = null;

var recentCommutePlaces = [];
try {
  const savedRecPlaces = JSON.parse(localStorage.getItem('transit_recent_commute_places_v1') || '[]');
  if (Array.isArray(savedRecPlaces)) recentCommutePlaces = savedRecPlaces;
} catch (e) { recentCommutePlaces = []; }

window.invalidateRaptorGraph = function() {
  _raptorGraph = null;
  _raptorGraphRouteCount = 0;
};

function getNormalizedVillageOrStopKey(name) {
  return getBaseStopNameKey(name)
    .replace(/(longpingroad|shuntungroad|castlepeakroad|kwongfukroad|tattungroad|朗屏路|順東路|青山公路|廣福道|達東路)$/i, '')
    .trim();
}

function savePlaceToRecentCommuteHistory(placeObj) {
  if (!placeObj || !placeObj.stopName_e) return;
  recentCommutePlaces = [
    placeObj,
    ...recentCommutePlaces.filter(p => p.stopName_e !== placeObj.stopName_e && p.stopKey !== placeObj.stopKey)
  ].slice(0, 12);
  SafeStorage.setItem('transit_recent_commute_places_v1', JSON.stringify(recentCommutePlaces));
}

function cleanAlsAddressLabel(raw) {
  return String(raw || '')
    .replace(/^(BLOCK|TOWER|FLAT|ROOM|UNIT|FLOOR|PHASE)\s+[A-Z0-9-]+\s*,\s*/i, '')
    .toLowerCase()
    .replace(/\b[a-z]/g, c => c.toUpperCase())
    .replace(/\bRoad\b/g, 'Rd')
    .replace(/\bStreet\b/g, 'St')
    .replace(/\bAvenue\b/g, 'Ave')
    .replace(/\b(Hkg|Hkia|Ifc|Icc|Hku|Hkust|Cuhk|Hzmb)\b/gi, m => m.toUpperCase())
    .trim();
}

// ============================================================================
// SMART RETURN (45m–12h Dwell Gate) & NODE-BASED HOME/WORK HUB MANAGERS
// ============================================================================
const SmartReturnManager = {
  storageKey: 'transit_last_trip_v1',
  dismissedTs: 0,

  recordInboundTrip(group, boardStop, stopsList = []) {
    if (!group || !boardStop) return;
    const bLat = parseFloat(boardStop.lat ?? boardStop.latitude);
    const bLon = parseFloat(boardStop.lon ?? boardStop.longitude);
    if (!isValidRailOrFerryCoord(bLat, bLon)) return;

    const stops = (Array.isArray(stopsList) && stopsList.length) ? stopsList : getStopsForGroup(group, boardStop.stopKey);
    const destStop = stops.length ? stops[stops.length - 1] : null;
    const dLat = parseFloat(destStop?.lat ?? destStop?.latitude ?? bLat);
    const dLon = parseFloat(destStop?.lon ?? destStop?.longitude ?? bLon);

    const trip = {
      routeNo: String(group.routeNo || ''),
      company: String(group.company || ''),
      mode: String(group.mode || 'BUS'),
      groupKey: String(group.key || ''),
      bound: extractRouteBoundCode(group),
      originStopKey: boardStop.stopKey || getGlobalStopKey(boardStop),
      originNameEn: stripPlatformCodeFromDisplay(boardStop.stopName_e || ''),
      originNameTc: stripPlatformCodeFromDisplay(boardStop.name_tc || boardStop.stopName_e || ''),
      originLat: Number(bLat.toFixed(6)),
      originLon: Number(bLon.toFixed(6)),
      destNameEn: stripPlatformCodeFromDisplay(destStop?.stopName_e || group.dest_e || ''),
      destNameTc: stripPlatformCodeFromDisplay(destStop?.name_tc || group.dest_tc || group.dest_e || ''),
      destLat: Number(dLat.toFixed(6)),
      destLon: Number(dLon.toFixed(6)),
      timestamp: Date.now()
    };
    SafeStorage.setItem(this.storageKey, JSON.stringify(trip));
  },

  getLastTrip() {
    try {
      const raw = SafeStorage.getItem(this.storageKey);
      if (!raw) return null;
      const trip = JSON.parse(raw);
      if (!trip || !trip.timestamp || !trip.routeNo) return null;
      const ageMs = Date.now() - Number(trip.timestamp);
      if (ageMs > 12 * 3600000 || ageMs < 0) {
        SafeStorage.setItem(this.storageKey, '');
        return null;
      }
      return trip;
    } catch (e) { return null; }
  },

  dismissCurrent() {
    const trip = this.getLastTrip();
    if (trip) this.dismissedTs = trip.timestamp;
    SafeStorage.setItem(this.storageKey, '');
  },

  evaluateCandidate(userPos) {
    if (!userPos || !userPos.hasLiveFix || Number(userPos.acc) > 450) return null;
    const trip = this.getLastTrip();
    if (!trip || trip.timestamp === this.dismissedTs) return null;

    const elapsedMs = Date.now() - trip.timestamp;
    if (elapsedMs < 45 * 60000 || elapsedMs > 12 * 3600000) return null;

    const distFromOriginKm = calculateDistanceKm(userPos.lat, userPos.lon, trip.originLat, trip.originLon);
    const distFromDestKm   = calculateDistanceKm(userPos.lat, userPos.lon, trip.destLat, trip.destLon);

    if (distFromOriginKm < 0.70) return null;
    if (distFromDestKm > 1.20 && distFromOriginKm < 1.20) return null;

    const oppGroups = groupedRoutes.filter(g =>
      g.routeNo === trip.routeNo &&
      g.company === trip.company &&
      (g.mode || 'BUS') === trip.mode &&
      g.key !== trip.groupKey &&
      extractRouteBoundCode(g) !== trip.bound
    );
    const returnGroup = oppGroups.find(g => /_1$/.test(g.routeIds?.[0] || '')) || oppGroups[0];
    if (!returnGroup) return null;

    const rStops = getStopsForGroup(returnGroup);
    if (rStops.length < 2) return null;
    const allowFinal = isCircularRoute(returnGroup, rStops);
    const maxBoardIdx = allowFinal ? rStops.length - 1 : rStops.length - 2;

    let bestStop = null, bestIdx = -1, bestDistKm = Infinity;
    for (let i = 0; i <= maxBoardIdx; i++) {
      const s = rStops[i];
      const sLat = parseFloat(s.latitude), sLon = parseFloat(s.longitude);
      if (!isValidRailOrFerryCoord(sLat, sLon)) continue;
      if (window.crossesWaterBarrier(userPos.lat, userPos.lon, sLat, sLon)) continue;
      const dKm = calculateDistanceKm(userPos.lat, userPos.lon, sLat, sLon);
      if (dKm < bestDistKm) {
        bestDistKm = dKm;
        bestStop = s;
        bestIdx = i;
      }
    }

    if (!bestStop || bestDistKm > 1.50) return null;
    const walkDistM = Math.max(20, Math.round(bestDistKm * 1000 * 1.18));
    const walkMins = Math.max(1, Math.round(walkDistM / 75));
    return {
      trip,
      returnGroup,
      returnStop: bestStop,
      returnStopIdx: bestIdx,
      returnStopKey: bestStop.stopKey || getGlobalStopKey(bestStop),
      walkDistM,
      walkMins
    };
  }
};

const SavedHubsManager = {
  storageKey: 'transit_saved_hubs_v1',
  manualOverrideMode: 'AUTO', // 'AUTO' | 'HOME' | 'WORK' | 'NEARBY'

  getHubs() {
    try {
      const raw = JSON.parse(SafeStorage.getItem(this.storageKey) || 'null');
      if (raw && typeof raw === 'object') {
        return { home: raw.home || null, work: raw.work || null };
      }
    } catch (e) {}
    return { home: null, work: null };
  },

  setHub(slot, stopObj, mode = 'BUS', forceSet = false) {
    const key = slot === 'work' ? 'work' : 'home';
    const hubs = this.getHubs();
    const sKey = stopObj.stopKey || getGlobalStopKey(stopObj);
    const la = parseFloat(stopObj.lat ?? stopObj.latitude);
    const lo = parseFloat(stopObj.lon ?? stopObj.longitude);
    if (!sKey || !isValidRailOrFerryCoord(la, lo)) return hubs;

    if (!forceSet && hubs[key] && hubs[key].stopKey === sKey) {
      hubs[key] = null;
    } else {
      hubs[key] = {
        stopKey: sKey,
        mode: stopObj.mode || mode || 'BUS',
        nameEn: stripPlatformCodeFromDisplay(stopObj.stopName_e || ''),
        nameTc: stripPlatformCodeFromDisplay(stopObj.name_tc || stopObj.stopName_e || ''),
        lat: Number(la.toFixed(6)),
        lon: Number(lo.toFixed(6))
      };
    }
    SafeStorage.setItem(this.storageKey, JSON.stringify(hubs));
    return hubs;
  },

  clearHub(slot) {
    const key = slot === 'work' ? 'work' : 'home';
    const hubs = this.getHubs();
    hubs[key] = null;
    SafeStorage.setItem(this.storageKey, JSON.stringify(hubs));
    return hubs;
  },

  isSavedAs(slot, stopKey) {
    const hubs = this.getHubs();
    return Boolean(hubs[slot] && hubs[slot].stopKey === stopKey);
  },

  evaluateSuggestion(userPos) {
    const hubs = this.getHubs();
    if (!hubs.home && !hubs.work) return null;
    if (this.manualOverrideMode === 'NEARBY') return { mode: 'NEARBY', hubs, targetSlot: null };

    if (this.manualOverrideMode === 'HOME' && hubs.home) {
      return { mode: 'MANUAL', hubs, targetSlot: 'home', targetHub: hubs.home };
    }
    if (this.manualOverrideMode === 'WORK' && hubs.work) {
      return { mode: 'MANUAL', hubs, targetSlot: 'work', targetHub: hubs.work };
    }

    if (userPos && userPos.hasLiveFix && Number(userPos.acc) <= 450) {
      if (hubs.home && hubs.work) {
        const dHome = calculateDistanceKm(userPos.lat, userPos.lon, hubs.home.lat, hubs.home.lon);
        const dWork = calculateDistanceKm(userPos.lat, userPos.lon, hubs.work.lat, hubs.work.lon);
        if (dHome <= 0.50 && dWork > 0.50) {
          return { mode: 'AUTO', hubs, targetSlot: 'work', targetHub: hubs.work, fromHub: hubs.home };
        }
        if (dWork <= 0.50 && dHome > 0.50) {
          return { mode: 'AUTO', hubs, targetSlot: 'home', targetHub: hubs.home, fromHub: hubs.work };
        }
      }
    }
    return { mode: 'IDLE', hubs, targetSlot: null };
  },

  launchRouteToHub(slot) {
    const hubs = this.getHubs();
    const target = hubs[slot === 'work' ? 'work' : 'home'];
    if (!target) return;
    triggerHaptic(14);

    const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
    if (lastKnownPos?.hasLiveFix && Number(lastKnownPos.acc) <= 450) {
      userCommuteProfile.home = {
        stopKey: curStop?.stopKey || `GPS_${lastKnownPos.lat.toFixed(5)}_${lastKnownPos.lon.toFixed(5)}`,
        stopName_e: curStop ? curStop.stopName_e : 'Current GPS Location',
        name_tc: curStop ? (curStop.name_tc || curStop.stopName_e) : '目前位置',
        lat: lastKnownPos.lat,
        lon: lastKnownPos.lon,
        nodeType: curStop?.mode || 'ADDRESS'
      };
    } else if (curStop) {
      userCommuteProfile.home = {
        stopKey: curStop.stopKey,
        stopName_e: curStop.stopName_e,
        name_tc: curStop.name_tc || curStop.stopName_e,
        lat: parseFloat(curStop.latitude),
        lon: parseFloat(curStop.longitude),
        nodeType: curStop.mode || 'BUS'
      };
    }

    userCommuteProfile.work = {
      stopKey: target.stopKey,
      stopName_e: target.nameEn,
      name_tc: target.nameTc || target.nameEn,
      lat: target.lat,
      lon: target.lon,
      nodeType: target.mode || 'BUS'
    };

    SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
    xferTimeMode = 'NOW';
    updateCommuteBarUI();
    if (currentView !== 'xfer') switchView('xfer', false);
    requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
  }
};

function openSavedHubPickerFromSettings(slot) {
  triggerHaptic(10);
  if (typeof closeSettingsModal === 'function') closeSettingsModal();
  activeCommutePickerSlot = (slot === 'work') ? 'hub_work' : 'hub_home';
  alsAddressSearchResults = [];

  const isZh = (currentLang === 'zh');
  const titleEl = document.getElementById('commutePickerTitle');
  const inputEl = document.getElementById('commutePickerSearchInput');
  if (titleEl) {
    titleEl.innerText = activeCommutePickerSlot === 'hub_work'
      ? (isZh ? '💼 選擇公司常用車站 (巴士站 / 港鐵站 / 碼頭)' : '💼 Set Work Transit Hub (Stop / MTR / Pier)')
      : (isZh ? '🏠 選擇屋企常用車站 (巴士站 / 港鐵站 / 碼頭)' : '🏠 Set Home Transit Hub (Stop / MTR / Pier)');
  }
  if (inputEl) {
    inputEl.value = '';
    inputEl.placeholder = isZh ? '搜尋公共巴士站、港鐵站或渡輪碼頭...' : 'Search public bus stop, MTR station or ferry pier...';
  }
  const modal = document.getElementById('commutePickerModal');
  if (modal) modal.style.display = 'flex';
  renderCommutePickerList();
}

function clearSavedHubFromSettings(slot) {
  triggerHaptic(10);
  const key = slot === 'work' ? 'work' : 'home';
  SavedHubsManager.clearHub(key);
  closeCommuteStopPicker();
  if (typeof syncSettingsModalLabels === 'function') syncSettingsModalLabels();
  lastRenderedCenterStopKey = null;
  if (currentView === 'main') renderMainNearby(false);
  const isZh = (currentLang === 'zh');
  showToast(key === 'work'
    ? (isZh ? '已清除公司車站捷徑' : 'Cleared Work hub shortcut')
    : (isZh ? '已清除屋企車站捷徑' : 'Cleared Home hub shortcut'));
}

window.SmartReturnManager = SmartReturnManager;
window.SavedHubsManager = SavedHubsManager;
window.openSavedHubPickerFromSettings = openSavedHubPickerFromSettings;
window.clearSavedHubFromSettings = clearSavedHubFromSettings;

// ============================================================================
// GOLDEN INTERCHANGE HUBS, BBI DISCOUNTS, ANTI-RIPOFF & LOAD FACTOR HELPERS
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

function formatLegLoadPillHtml(loadEst) {
  if (!loadEst || !loadEst.cssClass) return '';
  const isZh = (currentLang === 'zh');
  const txt = isZh ? loadEst.labelTc : loadEst.labelEn;
  const titleAttr = (isZh ? loadEst.tipTc : loadEst.tipEn) || `${loadEst.pct}%`;
  return ` <span class="load-pill ${escapeHtml(loadEst.cssClass)}" style="padding:1px 6px;font-size:0.61rem;" title="${escapeHtml(titleAttr)}">${escapeHtml(txt)}</span>`;
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

// Last-bus / last-ferry service-hours cutoff detector (flags departures within 20 min of daily cutoff)
function getLegServiceCutoffWarning(group, depMs, isZh = false) {
  if (!group || !Number.isFinite(depMs)) return null;
  if (group.mode === 'MTR' && group.company === 'MTR') return null;

  const hk = getHongKongNow(depMs);
  const depMin = hk.getHours() * 60 + hk.getMinutes();

  const fmtMin = (m) => {
    const norm = ((Math.round(m) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(norm / 60)).padStart(2, '0');
    const mm = String(norm % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };

  let closingMin = null;
  const wins = Array.isArray(group.activeWindows) ? group.activeWindows : [];
  if (wins.length > 0) {
    // Find the active window containing depMin (skip full-day overnight 0..1439 routes that run 24h)
    const is24h = wins.some(([s, e]) => s <= 15 && e >= 1425) && wins.some(([s]) => s <= 60);
    if (!is24h) {
      let bestEnd = null;
      for (const w of wins) {
        if (!Array.isArray(w) || w.length < 2) continue;
        const [s, e] = w;
        if (depMin >= s - 15 && depMin <= e + 5) {
          // If another window starts right after midnight (e.g. [0, 60]), extend closing time past midnight
          const wrapsPastMidnight = (e >= 1435) && wins.some(([s2, e2]) => s2 === 0 && e2 > 0 && e2 <= 180);
          if (wrapsPastMidnight) {
            const afterMid = wins.find(([s2, e2]) => s2 === 0 && e2 > 0 && e2 <= 180);
            bestEnd = 1440 + afterMid[1];
          } else {
            bestEnd = e;
          }
          break;
        }
      }
      if (bestEnd !== null) closingMin = bestEnd;
    }
  }

  if (closingMin === null) return null;
  const minsRemaining = closingMin - depMin;
  if (minsRemaining >= -5 && minsRemaining <= 20) {
    const cutoffLabel = fmtMin(closingMin);
    const isFerry = group.mode === 'FERRY';
    return {
      isLastSoon: true,
      minsRemaining: Math.max(0, Math.round(minsRemaining)),
      cutoffLabel,
      labelEn: isFerry ? `Last ferry ~${cutoffLabel}` : `Last bus ~${cutoffLabel}`,
      labelTc: isFerry ? `尾班船 ~${cutoffLabel}` : `尾班車 ~${cutoffLabel}`
    };
  }
  return null;
}

window.getLegServiceCutoffWarning = getLegServiceCutoffWarning;

function getPeriodHeadwaySecs(group, targetEpochMs, liveArrsSample = []) {
  if (Array.isArray(liveArrsSample) && liveArrsSample.length >= 2) {
    const firstMs = liveArrsSample[0].rawTargetMs || liveArrsSample[0].targetMs;
    const lastMs = liveArrsSample[liveArrsSample.length - 1].rawTargetMs || liveArrsSample[liveArrsSample.length - 1].targetMs;
    const empSec = Math.round(((lastMs - firstMs) / (liveArrsSample.length - 1)) / 1000);
    if (empSec >= 120 && empSec <= 5400) {
      const baseSec = (Number(group?.headwayMins) || 15) * 60;
      return Math.round(empSec * 0.65 + baseSec * 0.35);
    }
  }

  const hk = getHongKongNow(targetEpochMs);
  const h = hk.getHours();
  const baseMins = Number(group?.headwayMins) || (group?.mode === 'MTR' ? 4 : (group?.mode === 'FERRY' ? 35 : 15));

  if (group?.mode === 'MTR') {
    if (group.company === 'LRT') return ((h >= 7 && h < 9) || (h >= 17 && h < 19)) ? 360 : 480;
    if (group.routeNo === 'AEL' || group.routeNo === 'DRL') return 600;
    if (h >= 21 || h < 7) return 360; // Evening/late-night MTR ~6m headway
    return ((h >= 7 && h < 9) || (h >= 17 && h < 19)) ? 180 : 270;
  }

  let mult = 1.0;
  if (h >= 7 && h < 10) mult = 0.80;
  else if (h >= 10 && h < 17) mult = 1.0;
  else if (h >= 17 && h < 20) mult = 0.85;
  else if (h >= 20 && h < 23) mult = 1.20;
  else mult = 1.45;

  return Math.max(180, Math.min(5400, Math.round(baseMins * 60 * mult)));
}

// ============================================================================
// MTR EXIT-AWARE WALKING HELPER
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

// ============================================================================
// CORRIDOR-SCOPED HIGHWAY & HKO WEATHER PILLS + DISMISSIBLE ALERT BANNER
// ============================================================================
var dismissedPlannerAlertKey = '';
var currentPlannerAlertKey = '';

function collectSelectedCardCorridors(home, work, selectedCard) {
  const foundById = new Map();
  const corList = Array.isArray(window.HK_STRATEGIC_CORRIDORS) ? window.HK_STRATEGIC_CORRIDORS : [];

  const checkCrossHarbourOrRelevant = (aLa, aLo, bLa, bLo) => {
    if (!isValidRailOrFerryCoord(aLa, aLo) || !isValidRailOrFerryCoord(bLa, bLo)) return;
    if (typeof resolveRelevantCorridorForTrip === 'function') {
      const rel = resolveRelevantCorridorForTrip(aLa, aLo, bLa, bLo);
      if (rel?.id) foundById.set(rel.id, rel);
    }
    // Also detect short cross-harbour trips (e.g. Central <-> TST ~2.3km) where resolveRelevantCorridorForTrip skips <2.5km
    const isHkA = aLa < 22.293 && aLo >= 114.110 && aLo <= 114.265;
    const isHkB = bLa < 22.293 && bLo >= 114.110 && bLo <= 114.265;
    if (isHkA !== isHkB) {
      const ht = corList.find(c => c.id === 'HARBOUR_TUNS');
      if (ht) foundById.set(ht.id, ht);
    }
  };

  if (home && work) {
    checkCrossHarbourOrRelevant(Number(home.lat), Number(home.lon), Number(work.lat), Number(work.lon));
  }

  const checkSegment = (a, b) => {
    const aLa = Number(a?.lat ?? a?.latitude), aLo = Number(a?.lon ?? a?.longitude);
    const bLa = Number(b?.lat ?? b?.latitude), bLo = Number(b?.lon ?? b?.longitude);
    if (!isValidRailOrFerryCoord(aLa, aLo) || !isValidRailOrFerryCoord(bLa, bLo)) return;
    checkCrossHarbourOrRelevant(aLa, aLo, bLa, bLo);
    const pts = [
      [(aLa + bLa) / 2, (aLo + bLo) / 2],
      [aLa * 0.7 + bLa * 0.3, aLo * 0.7 + bLo * 0.3],
      [aLa * 0.3 + bLa * 0.7, aLo * 0.3 + bLo * 0.7]
    ];
    for (const cor of corList) {
      if (foundById.has(cor.id)) continue;
      for (const [pLa, pLo] of pts) {
        if (calculateDistanceKm(pLa, pLo, cor.lat, cor.lon) <= cor.radiusKm) {
          foundById.set(cor.id, cor);
          break;
        }
      }
    }
  };

  if (selectedCard?.type === 'DIRECT' && selectedCard.item) {
    const dp = selectedCard.item;
    if (!dp.group || dp.group.mode !== 'MTR') {
      checkSegment(dp.boardStopObj, dp.alightStopObj);
    }
  } else if (selectedCard?.type === 'XFER' && selectedCard.item) {
    const cor = selectedCard.item;
    const node = cor.xferStopNodes?.[0];
    if (node) {
      if (!cor.leg1Group || cor.leg1Group.mode !== 'MTR') {
        checkSegment(cor.board1StopObj, node.alight1StopObj);
      }
      const leg2End = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
      if (!cor.leg2Group || cor.leg2Group.mode !== 'MTR') {
        checkSegment(node.board2StopObj, leg2End);
      }
      (cor.leg3Options || []).forEach(l3 => {
        if (!l3.group || l3.group.mode !== 'MTR') {
          checkSegment(l3.boardStopObj, l3.alightStopObj);
        }
      });
    }
  }

  return Array.from(foundById.values());
}

function evaluatePlannerAlertBannerState(wx, liveCorridors, home, work, selectedCard = null, isZh = false) {
  const codes = Array.isArray(wx?.warningCodes) ? wx.warningCodes.map(c => String(c || '').toUpperCase()) : [];
  const labelEnStr = String(wx?.labelEn || '');
  const hasTc8Plus = Boolean(wx?.typhoon) || codes.some(c => /^TC(8|9|10)/.test(c)) || /TC(8|9|10)/i.test(labelEnStr);
  const hasBlackRain = codes.includes('WRAINB') || /black\s*rain/i.test(labelEnStr);

  const weatherParts = [];
  const keyParts = [];

  if (hasTc8Plus) {
    const tcCode = codes.find(c => /^TC(8|9|10)/.test(c)) || 'TC8+';
    keyParts.push(`WX_${tcCode}`);
    weatherParts.push(isZh ? (wx?.labelTc || '八號或以上烈風或暴風信號生效') : (wx?.labelEn || `Typhoon Signal ${tcCode} Active`));
  }
  if (hasBlackRain) {
    keyParts.push('WX_WRAINB');
    weatherParts.push(isZh ? '黑色暴雨警告生效' : 'Black Rainstorm Warning (WRAINB)');
  }

  const incidentCorridors = [];
  const corMap = liveCorridors || {};
  const usedCorridors = collectSelectedCardCorridors(home, work, selectedCard);
  for (const cor of usedCorridors) {
    const st = corMap[cor.id];
    if (st && st.status === 'INCIDENT') {
      keyParts.push(`COR_${cor.id}_INCIDENT`);
      incidentCorridors.push({
        id: cor.id,
        label: isZh ? (cor.tc || cor.en) : (cor.en || cor.tc),
        headline: String(st.headline || '').trim()
      });
    }
  }

  if (!weatherParts.length && !incidentCorridors.length) {
    return { active: false, alertKey: '', severity: 'none', title: '', detail: '' };
  }

  const isSevereWx = weatherParts.length > 0;
  const corSummary = incidentCorridors.map(c => c.label).join(' · ');
  const firstHeadline = incidentCorridors.find(c => c.headline)?.headline || '';

  let title = '';
  let detail = '';

  if (isSevereWx && incidentCorridors.length) {
    title = isZh
      ? `${weatherParts.join(' · ')} ｜ ${corSummary} 受阻`
      : `${weatherParts.join(' · ')} · ${corSummary} Incident`;
    detail = firstHeadline || (isZh
      ? '港鐵服務可能調整，地面巴士及渡輪或會暫停或受阻。'
      : 'Surface bus & ferry services may be suspended or heavily delayed; rail preferred.');
  } else if (isSevereWx) {
    title = weatherParts.join(' · ');
    detail = hasTc8Plus
      ? (isZh ? '天文台已發出八號或以上熱帶氣旋警告，巴士及渡輪服務可能陸續暫停。' : 'HKO severe tropical cyclone warning in force — bus & ferry services may suspend.')
      : (isZh ? '天文台黑色暴雨警告生效，已優先減步行及室內鐵路路線。' : 'HKO Black Rainstorm warning in force — prioritizing sheltered rail & shorter walks.');
  } else {
    title = isZh ? `${corSummary} 交通受阻` : `Traffic Incident: ${corSummary}`;
    detail = firstHeadline || (isZh ? '運輸署特別交通消息：此路段現正受阻，建議考慮鐵路替代路線。' : 'TD Special Traffic News: active incident on this route corridor.');
  }

  return {
    active: true,
    alertKey: keyParts.join('|'),
    severity: isSevereWx ? 'severe' : 'incident',
    icon: isSevereWx ? (hasTc8Plus ? '🌀' : '⛈️') : '⚠️',
    title,
    detail
  };
}

function dismissPlannerAlertBanner() {
  if (currentPlannerAlertKey) dismissedPlannerAlertKey = currentPlannerAlertKey;
  const el = document.getElementById('plannerAlertBanner');
  if (el) el.style.display = 'none';
}

function syncPlannerAlertBannerUI(selectedCard = null) {
  const el = document.getElementById('plannerAlertBanner');
  if (!el) return;
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');
  const activeCard = selectedCard
    || (lastXferSolvedSpec?._unifiedCards?.find(c => c.key === activeUnifiedCardKey) || lastXferSolvedSpec?._unifiedCards?.[0])
    || null;
  const state = evaluatePlannerAlertBannerState(
    window.__HKO_WEATHER__,
    window.__LIVE_CORRIDORS__,
    userCommuteProfile.home,
    userCommuteProfile.work,
    activeCard,
    isZh
  );

  currentPlannerAlertKey = state.alertKey || '';
  if (!state.active || (dismissedPlannerAlertKey && dismissedPlannerAlertKey === state.alertKey)) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  el.className = `planner-alert-banner severity-${state.severity}`;
  el.innerHTML = `
    <span class="planner-alert-icon" aria-hidden="true">${state.icon}</span>
    <span class="planner-alert-body">
      <span class="planner-alert-title">${escapeHtml(state.title)}</span>
      ${state.detail ? `<span class="planner-alert-detail">${escapeHtml(state.detail)}</span>` : ''}
    </span>
    <button type="button" class="planner-alert-dismiss" onclick="dismissPlannerAlertBanner()" aria-label="${isZh ? '關閉提示' : 'Dismiss alert'}">✕</button>`;
  el.style.display = 'flex';
}

window.evaluatePlannerAlertBannerState = evaluatePlannerAlertBannerState;
window.syncPlannerAlertBannerUI = syncPlannerAlertBannerUI;
window.dismissPlannerAlertBanner = dismissPlannerAlertBanner;

function syncRelevantCorridorPillUI() {
  const pill = document.getElementById('xferHighwaySpeedPill');
  const wPill = document.getElementById('xferWeatherAlertPill');
  const isZh = (typeof currentLang !== 'undefined' && currentLang === 'zh');

  if (pill) {
    const h = userCommuteProfile.home, w = userCommuteProfile.work;
    const relCor = (h && w && typeof resolveRelevantCorridorForTrip === 'function')
      ? resolveRelevantCorridorForTrip(h.lat, h.lon, w.lat, w.lon)
      : null;

    if (!relCor) {
      pill.style.display = 'none';
    } else {
      const liveMap = window.__LIVE_CORRIDORS__ || {};
      const st = liveMap[relCor.id] || { status: 'SMOOTH', speedKmh: 70, headline: '' };
      const corLabel = isZh ? relCor.tc : relCor.en;
      const isInc = st.status === 'INCIDENT';
      const isSlow = st.status === 'SLOW';

      pill.style.display = 'inline-flex';
      pill.className = `state-pill ${isInc ? 'load-full' : (isSlow ? 'sched-ghost' : 'live-gps')}`;
      pill.title = st.headline || (isZh ? `實時運輸署 ${corLabel} 交通狀況` : `Live TD ${corLabel} corridor status`);
      if (isInc) {
        pill.innerText = isZh ? `⚠️ ${corLabel} 受阻` : `⚠️ ${corLabel} Incident`;
      } else if (isSlow) {
        pill.innerText = isZh ? `🟠 ${corLabel} 緩慢` : `🟠 ${corLabel} Slow`;
      } else {
        pill.innerText = isZh ? `🛣️ ${corLabel} 暢順` : `🛣️ ${corLabel} Smooth`;
      }
    }
  }

  if (wPill) {
    const wx = window.__HKO_WEATHER__;
    if (wx && (wx.heavyRain || wx.rainAdvisory)) {
      wPill.style.display = 'inline-flex';
      wPill.className = `state-pill ${wx.heavyRain ? 'load-full' : 'sched-ghost'}`;
      const lbl = isZh ? (wx.labelTc || '惡劣天氣') : (wx.labelEn || 'Heavy Rain');
      wPill.innerText = wx.heavyRain
        ? (isZh ? `⛈️ ${lbl} · 減步行` : `⛈️ ${lbl} · Less Walk`)
        : (isZh ? `🌧️ ${lbl}` : `🌧️ ${lbl}`);
    } else {
      wPill.style.display = 'none';
    }
  }

  syncPlannerAlertBannerUI();
}

window.syncRelevantCorridorPillUI = syncRelevantCorridorPillUI;

// ============================================================================
// UI CONTROLS & ADDRESS / STOP PICKER
// ============================================================================
function openTransferPlannerFromTop() {
  triggerHaptic(10);
  if (currentView === 'xfer') return;
  switchView('xfer', false);
  const c = document.getElementById('xferResultsContainer');
  if (c && userCommuteProfile.home && userCommuteProfile.work && !c.children.length) {
    c.innerHTML = `<div class="text-center" style="padding:28px;">${currentLang === 'zh' ? '正在計算最佳跨工具路線...' : 'Finding best multi-modal routes...'}</div>`;
  }
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function sendMapPointToTransferPlanner(slot, stopKey, stopName_e, name_tc, lat, lon, nodeType = 'BUS') {
  triggerHaptic(14);
  const placeItem = {
    stopKey: stopKey || `MAP_PIN_${Number(lat).toFixed(5)}_${Number(lon).toFixed(5)}`,
    stopName_e: stopName_e,
    name_tc: name_tc || stopName_e,
    lat: Number(lat),
    lon: Number(lon),
    nodeType
  };

  if (slot === 'work') {
    userCommuteProfile.work = placeItem;
    if (!userCommuteProfile.home) {
      const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
      if (curStop) {
        userCommuteProfile.home = {
          stopKey: curStop.stopKey,
          stopName_e: curStop.stopName_e,
          name_tc: curStop.name_tc || curStop.stopName_e,
          lat: parseFloat(curStop.latitude),
          lon: parseFloat(curStop.longitude),
          nodeType: curStop.mode || 'BUS'
        };
      }
    }
  } else {
    userCommuteProfile.home = placeItem;
  }

  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  savePlaceToRecentCommuteHistory(placeItem);
  window.browseMapInstance?.closePopup();
  window.xferMapInstance?.closePopup();
  updateCommuteBarUI();
  if (currentView !== 'xfer') switchView('xfer', false);
  if (userCommuteProfile.home && userCommuteProfile.work && typeof isXferMapExpanded !== 'undefined' && isXferMapExpanded) {
    setXferMapHeightPx(220, false);
  }
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function bindTimeInputListeners() {
  const timeInp = document.getElementById('xferDepartTimeInput');
  if (timeInp && !timeInp._boundListeners) {
    timeInp._boundListeners = true;
    timeInp.addEventListener('input', onXferPlannedTimeChange);
    timeInp.addEventListener('change', onXferPlannedTimeChange);
  }
}

function setXferTimeMode(mode) {
  triggerHaptic(10);
  bindTimeInputListeners();
  xferTimeMode = (mode === 'PLAN' || mode === 'ARRIVE') ? mode : 'NOW';
  document.getElementById('xferTimeNowBtn')?.classList.toggle('active-opt', xferTimeMode === 'NOW');
  document.getElementById('xferTimePlanBtn')?.classList.toggle('active-opt', xferTimeMode === 'PLAN');
  document.getElementById('xferTimeArriveBtn')?.classList.toggle('active-opt', xferTimeMode === 'ARRIVE');
  const timeInp = document.getElementById('xferDepartTimeInput');
  if (timeInp) {
    if (xferTimeMode === 'PLAN' || xferTimeMode === 'ARRIVE') {
      timeInp.style.display = 'inline-block';
      if (!timeInp.value) {
        const hk = getHongKongNow();
        if (xferTimeMode === 'ARRIVE') hk.setMinutes(hk.getMinutes() + 60);
        timeInp.value = `${String(hk.getHours()).padStart(2, '0')}:${String(hk.getMinutes()).padStart(2, '0')}`;
      }
      xferPlannedHHMM = timeInp.value;
    } else {
      timeInp.style.display = 'none';
      xferPlannedHHMM = null;
    }
  }
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function setXferSortPref(pref) {
  triggerHaptic(8);
  const p = String(pref || '').toUpperCase();
  if (p === 'LESS_WALK') xferSortPref = 'EASY';
  else if (p === 'BULLETPROOF' || p === 'FASTEST' || p === 'EASY' || p === 'CHEAPEST') xferSortPref = p;
  else xferSortPref = 'BULLETPROOF';
  syncXferSubbarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function onXferPlannedTimeChange() {
  const timeInp = document.getElementById('xferDepartTimeInput');
  if (timeInp?.value) {
    xferPlannedHHMM = timeInp.value;
    clearTimeout(xferTimeChangeDebounce);
    xferTimeChangeDebounce = setTimeout(() => {
      renderTransferPlannerView();
    }, 80);
  }
}

function toggleXferLocoBikeMode() {
  triggerHaptic(10);
  xferLocoBikeEnabled = !xferLocoBikeEnabled;
  syncXferSubbarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function syncXferSubbarUI() {
  const isZh = (currentLang === 'zh');
  const bikeBtn = document.getElementById('xferBikeToggleBtn');
  const bikeLbl = document.getElementById('xferBikeToggleLbl');

  const h = userCommuteProfile.home, w = userCommuteProfile.work;
  const inBikeArea = !h || !w
    || isInSharedBikeZone(h?.lat, h?.lon)
    || isInSharedBikeZone(w?.lat, w?.lon);
  if (bikeBtn && bikeLbl) {
    bikeBtn.style.display = (inBikeArea || xferLocoBikeEnabled) ? 'inline-flex' : 'none';
    bikeBtn.classList.toggle('active-opt', xferLocoBikeEnabled);
    bikeLbl.innerText = xferLocoBikeEnabled
      ? (isZh ? '🚲 單車: 開' : '🚲 Bike: ON')
      : (isZh ? '🚲 單車' : '🚲 Bike');
  }

  const nowBtn = document.getElementById('xferTimeNowBtn');
  const planBtn = document.getElementById('xferTimePlanBtn');
  const arrBtn = document.getElementById('xferTimeArriveBtn');
  if (nowBtn) nowBtn.innerText = isZh ? '即時' : 'Leave Now';
  if (planBtn) planBtn.innerText = isZh ? '出發時間' : 'Depart At';
  if (arrBtn) arrBtn.innerText = isZh ? '抵達時間' : 'Arrive By';

  const pBullet = document.getElementById('xferPrefBulletBtn');
  const pFast   = document.getElementById('xferPrefFastBtn');
  const pEasy   = document.getElementById('xferPrefEasyBtn') || document.getElementById('xferPrefWalkBtn');
  const pCheap  = document.getElementById('xferPrefCheapBtn');

  if (pBullet) {
    pBullet.innerText = isZh ? '最佳' : 'Best';
    pBullet.classList.toggle('active-opt', xferSortPref === 'BULLETPROOF');
  }
  if (pFast) {
    pFast.innerText = isZh ? '最快' : 'Fastest';
    pFast.classList.toggle('active-opt', xferSortPref === 'FASTEST');
  }
  if (pEasy) {
    pEasy.innerText = isZh ? '少步行' : 'Less Walk';
    pEasy.classList.toggle('active-opt', xferSortPref === 'EASY');
  }
  if (pCheap) {
    pCheap.innerText = isZh ? '最平' : 'Cheapest';
    pCheap.classList.toggle('active-opt', xferSortPref === 'CHEAPEST');
  }

  syncRelevantCorridorPillUI();
}

var plannerInputDirtyClearedMap = false;

function clearCommuteSlot(slot) {
  triggerHaptic(10);
  const key = slot === 'work' ? 'work' : 'home';
  userCommuteProfile[key] = null;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  lastXferSolvedSpec = null;
  activeUnifiedCardKey = '';
  plannerInputDirtyClearedMap = false;
  if (typeof window.clearTransferPlannerMapLayers === 'function') {
    window.clearTransferPlannerMapLayers();
  }
  const inp = document.getElementById(key === 'work' ? 'plannerToInput' : 'plannerFromInput');
  if (inp) inp.value = '';
  updateCommuteBarUI();
  renderTransferPlannerView();
}

function formatPlannerSlotDisplay(placeObj) {
  if (!placeObj) return '';
  const isZh = (currentLang === 'zh');
  return stripPlatformCodeFromDisplay(isZh && placeObj.name_tc ? placeObj.name_tc : placeObj.stopName_e) || '';
}

function updateCommuteBarUI() {
  const isZh = (currentLang === 'zh');
  const h = userCommuteProfile.home;
  const w = userCommuteProfile.work;

  const fromInput = document.getElementById('plannerFromInput');
  const toInput = document.getElementById('plannerToInput');
  const clearHomeBtn = document.getElementById('clearHomeStopBtn');
  const clearWorkBtn = document.getElementById('clearWorkStopBtn');

  if (fromInput) {
    fromInput.placeholder = isZh ? '起點：地址、港鐵站、巴士站或碼頭' : 'Origin: address, MTR, stop or pier';
    if (document.activeElement !== fromInput || activePlannerInlineSlot !== 'home') {
      fromInput.value = formatPlannerSlotDisplay(h);
    }
  }
  if (toInput) {
    toInput.placeholder = isZh ? '目的地：想去邊度？' : 'Destination: where to?';
    if (document.activeElement !== toInput || activePlannerInlineSlot !== 'work') {
      toInput.value = formatPlannerSlotDisplay(w);
    }
  }
  if (clearHomeBtn) clearHomeBtn.style.display = h ? 'inline-flex' : 'none';
  if (clearWorkBtn) clearWorkBtn.style.display = w ? 'inline-flex' : 'none';

  // Legacy slot buttons fallback (if present)
  const homeBtn = document.getElementById('favHomeStopBtn');
  const homeLbl = document.getElementById('favHomeStopLbl');
  const workBtn = document.getElementById('favWorkStopBtn');
  const workLbl = document.getElementById('favWorkStopLbl');
  if (homeBtn && homeLbl) {
    homeBtn.classList.toggle('set', Boolean(h));
    const hName = h ? formatPlannerSlotDisplay(h) : (isZh ? '選擇起點' : 'Select Origin');
    homeLbl.innerText = `${isZh ? '起點' : 'From'}: ${hName}`;
  }
  if (workBtn && workLbl) {
    workBtn.classList.toggle('set', Boolean(w));
    const wName = w ? formatPlannerSlotDisplay(w) : (isZh ? '選擇終點' : 'Address / MTR / Stop');
    workLbl.innerText = `${isZh ? '終點' : 'To'}: ${wName}`;
  }
  syncXferSubbarUI();
}

function swapHomeAndWorkCommuteStops() {
  triggerHaptic(12);
  const tmp = userCommuteProfile.home;
  userCommuteProfile.home = userCommuteProfile.work;
  userCommuteProfile.work = tmp;
  plannerInputDirtyClearedMap = false;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  closePlannerInlineDropdown();
  updateCommuteBarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function closePlannerInlineDropdown() {
  const shouldRestoreRoute = plannerInputDirtyClearedMap;
  plannerInputDirtyClearedMap = false;
  activePlannerInlineSlot = null;
  const dd = document.getElementById('plannerInlineDropdown');
  if (dd) dd.style.display = 'none';
  updateCommuteBarUI();
  if (shouldRestoreRoute && userCommuteProfile.home && userCommuteProfile.work && lastXferSolvedSpec?._unifiedCards?.length && typeof drawTransferCorridorOnMap === 'function') {
    const activeCard = lastXferSolvedSpec._unifiedCards.find(c => c.key === activeUnifiedCardKey) || lastXferSolvedSpec._unifiedCards[0];
    if (activeCard) drawTransferCorridorOnMap(lastXferSolvedSpec, activeCard);
  }
}

function focusPlannerInlineInput(slot) {
  activePlannerInlineSlot = slot === 'work' ? 'work' : 'home';
  plannerInlineAlsResults = [];
  const inp = document.getElementById(activePlannerInlineSlot === 'work' ? 'plannerToInput' : 'plannerFromInput');
  if (inp && inp.value) {
    try { inp.select(); } catch (e) {}
  }
  renderPlannerInlineDropdown('');
}

function onPlannerInlineInput(slot) {
  activePlannerInlineSlot = slot === 'work' ? 'work' : 'home';
  const inp = document.getElementById(activePlannerInlineSlot === 'work' ? 'plannerToInput' : 'plannerFromInput');
  const q = (inp?.value || '').trim();
  const committedLabel = formatPlannerSlotDisplay(userCommuteProfile[activePlannerInlineSlot]).trim();

  // Clear stale route polylines & destination pins immediately while user edits or clears Origin/Destination
  if (q !== committedLabel) {
    plannerInputDirtyClearedMap = true;
    if (typeof window.clearTransferPlannerMapLayers === 'function') {
      window.clearTransferPlannerMapLayers();
    }
  }

  plannerInlineAlsResults = [];
  renderPlannerInlineDropdown(q);

  clearTimeout(plannerInlineDebounce);
  const hasCjk = /[\u4e00-\u9fa5]/.test(q);
  if ((!hasCjk && q.length < 2) || (hasCjk && q.length < 1)) return;

  const seq = ++plannerInlineReqSeq;
  plannerInlineDebounce = setTimeout(async () => {
    try {
      const data = await fetchEdgeApiJSON(`?action=address_lookup&q=${encodeURIComponent(q)}&client=hk-fleet`, 3500, false);
      if (seq !== plannerInlineReqSeq || !activePlannerInlineSlot) return;
      if (Array.isArray(data?.results) && data.results.length > 0) {
        plannerInlineAlsResults = data.results;
        renderPlannerInlineDropdown(q);
      }
    } catch (e) {}
  }, 200);
}

function onPlannerInlineKeydown(event, slot) {
  if (event.key === 'Escape') {
    closePlannerInlineDropdown();
    event.target?.blur();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const dd = document.getElementById('plannerInlineDropdown');
    const firstOpt = dd?.querySelector('button.planner-ac-item[data-pick="1"]');
    if (firstOpt) firstOpt.click();
  }
}

async function useGpsForPlannerSlot(slot = 'home') {
  triggerHaptic(14);
  const targetSlot = slot === 'work' ? 'work' : 'home';
  const pos = await refreshGPS(3000, true);
  if (pos && Number.isFinite(pos.lat)) syncNearestStopFromGPS(pos.lat, pos.lon, false);
  const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
  if (pos && pos.hasLiveFix && Number(pos.acc) <= 600) {
    selectPlannerInlineOption(
      targetSlot,
      curStop?.stopKey || `GPS_${pos.lat.toFixed(5)}_${pos.lon.toFixed(5)}`,
      curStop ? curStop.stopName_e : 'Current Location',
      curStop ? (curStop.name_tc || curStop.stopName_e) : '目前位置',
      pos.lat,
      pos.lon,
      curStop?.mode || 'ADDRESS'
    );
  } else if (curStop) {
    selectPlannerInlineOption(
      targetSlot,
      curStop.stopKey,
      curStop.stopName_e,
      curStop.name_tc || curStop.stopName_e,
      parseFloat(curStop.latitude),
      parseFloat(curStop.longitude),
      curStop.mode || 'BUS'
    );
  } else {
    showToast(currentLang === 'zh' ? '未能獲取定位，請輸入起點名稱' : 'GPS unavailable — type a starting point');
  }
}

function selectPlannerInlineOption(slot, stopKey, stopName_e, name_tc, lat = 0, lon = 0, nodeType = 'BUS') {
  triggerHaptic(12);
  const targetSlot = slot === 'work' ? 'work' : 'home';
  const parts = String(stopKey || '').split('_');
  const parsedLat = Number(lat) || parseFloat(parts[parts.length - 2]) || 0;
  const parsedLon = Number(lon) || parseFloat(parts[parts.length - 1]) || 0;
  const cleanEn = nodeType === 'ADDRESS' ? cleanAlsAddressLabel(stopName_e) : stopName_e;
  const placeItem = { stopKey, stopName_e: cleanEn, name_tc: name_tc || cleanEn, lat: parsedLat, lon: parsedLon, nodeType };

  userCommuteProfile[targetSlot] = placeItem;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  savePlaceToRecentCommuteHistory(placeItem);

  plannerInputDirtyClearedMap = false;
  activePlannerInlineSlot = null;
  const dd = document.getElementById('plannerInlineDropdown');
  if (dd) dd.style.display = 'none';
  updateCommuteBarUI();

  if (targetSlot === 'home' && !userCommuteProfile.work) {
    const toInp = document.getElementById('plannerToInput');
    if (toInp) setTimeout(() => toInp.focus(), 60);
  }

  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

var _cachedPlannerHubs = null;
var _cachedPlannerHubsRouteCount = 0;

function getPlannerHubDirectory() {
  const existing = Array.isArray(window.MULTI_MODAL_HUBS_DIRECTORY) ? window.MULTI_MODAL_HUBS_DIRECTORY : [];
  if (_cachedPlannerHubs && _cachedPlannerHubsRouteCount === groupedRoutes.length && _cachedPlannerHubs.length >= existing.length) {
    return _cachedPlannerHubs;
  }
  const byKey = new Map();
  for (const h of existing) {
    if (!h?.name_en) continue;
    const key = `${h.mode || 'MTR'}_${normStationLookupKey(h.name_en)}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...h, _lines: new Set(h.badge ? [h.badge] : []) });
    }
  }
  for (let i = 0; i < groupedRoutes.length; i++) {
    const g = groupedRoutes[i];
    const isHeavyMtr = (g.mode === 'MTR' && g.company === 'MTR');
    const isFerry = (g.mode === 'FERRY');
    if (!isHeavyMtr && !isFerry) continue;
    const stops = getStopsForGroup(g);
    for (let j = 0; j < stops.length; j++) {
      const s = stops[j];
      const la = parseFloat(s.latitude ?? s.lat);
      const lo = parseFloat(s.longitude ?? s.lon);
      if (!isValidRailOrFerryCoord(la, lo)) continue;
      const stCode = String(s.mtrCode || s.stopId || '').trim().toUpperCase();
      const nameEn = stripPlatformCodeFromDisplay(s.stopName_e || '');
      const nameTc = stripPlatformCodeFromDisplay(s.name_tc || nameEn);
      if (!nameEn) continue;
      const dedupKey = isHeavyMtr && stCode
        ? `MTR_${stCode}`
        : `FERRY_${normStationLookupKey(nameEn)}`;
      if (!byKey.has(dedupKey)) {
        byKey.set(dedupKey, {
          id: isHeavyMtr && stCode ? `MTR_${stCode}` : (s.stopKey || dedupKey),
          name_en: nameEn,
          name_tc: nameTc,
          lat: la,
          lon: lo,
          mode: isHeavyMtr ? 'MTR' : 'FERRY',
          badge: '',
          _lines: new Set()
        });
      }
      const entry = byKey.get(dedupKey);
      if (isHeavyMtr && g.routeNo) entry._lines.add(g.routeNo);
      else if (isFerry) entry._lines.add(g.company || 'Ferry');
    }
  }
  const list = Array.from(byKey.values()).map(h => ({
    id: h.id,
    name_en: h.name_en,
    name_tc: h.name_tc,
    lat: h.lat,
    lon: h.lon,
    mode: h.mode,
    badge: h.badge || Array.from(h._lines).slice(0, 4).join(' · ') || h.mode
  }));
  _cachedPlannerHubs = list;
  _cachedPlannerHubsRouteCount = groupedRoutes.length;
  if (!existing.length && list.length) {
    window.MULTI_MODAL_HUBS_DIRECTORY = list;
  }
  return list;
}

window.getPlannerHubDirectory = getPlannerHubDirectory;

function quickPickPlannerHub(hubId) {
  triggerHaptic(12);
  const hubs = getPlannerHubDirectory();
  const qLower = String(hubId || '').toLowerCase();
  const hub = hubs.find(h => h.id === hubId)
    || hubs.find(h => h.name_en.toLowerCase().includes(qLower.replace(/^(mtr_|ferry_)/, '')))
    || (hubId === 'FERRY_CC' ? hubs.find(h => /cheung chau/i.test(h.name_en)) : null);
  if (!hub) return;

  const placeItem = {
    stopKey: hub.id,
    stopName_e: hub.name_en,
    name_tc: hub.name_tc || hub.name_en,
    lat: Number(hub.lat),
    lon: Number(hub.lon),
    nodeType: hub.mode || 'MTR'
  };

  if (!userCommuteProfile.home) {
    const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
    if (curStop && calculateDistanceKm(parseFloat(curStop.latitude), parseFloat(curStop.longitude), placeItem.lat, placeItem.lon) > 0.35) {
      userCommuteProfile.home = {
        stopKey: curStop.stopKey,
        stopName_e: curStop.stopName_e,
        name_tc: curStop.name_tc || curStop.stopName_e,
        lat: parseFloat(curStop.latitude),
        lon: parseFloat(curStop.longitude),
        nodeType: curStop.mode || 'BUS'
      };
      userCommuteProfile.work = placeItem;
    } else {
      userCommuteProfile.home = placeItem;
    }
  } else if (userCommuteProfile.home.stopKey !== placeItem.stopKey) {
    userCommuteProfile.work = placeItem;
  } else {
    userCommuteProfile.home = placeItem;
  }

  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  savePlaceToRecentCommuteHistory(placeItem);
  closePlannerInlineDropdown();
  updateCommuteBarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function getPlannerAutocompleteRefPoint() {
  if (typeof lastKnownPos !== 'undefined' && lastKnownPos && isValidRailOrFerryCoord(Number(lastKnownPos.lat), Number(lastKnownPos.lon))) {
    return { lat: Number(lastKnownPos.lat), lon: Number(lastKnownPos.lon), source: 'gps' };
  }
  const xferCenter = window.xferMapInstance && typeof window.xferMapInstance.getCenter === 'function'
    ? window.xferMapInstance.getCenter()
    : null;
  if (xferCenter && isValidRailOrFerryCoord(Number(xferCenter.lat), Number(xferCenter.lng))) {
    return { lat: Number(xferCenter.lat), lon: Number(xferCenter.lng), source: 'map' };
  }
  const browseCenter = window.browseMapInstance && typeof window.browseMapInstance.getCenter === 'function'
    ? window.browseMapInstance.getCenter()
    : null;
  if (browseCenter && isValidRailOrFerryCoord(Number(browseCenter.lat), Number(browseCenter.lng))) {
    return { lat: Number(browseCenter.lat), lon: Number(browseCenter.lng), source: 'map' };
  }
  return null;
}

function formatCompactDistanceLabel(distKm) {
  if (!Number.isFinite(distKm) || distKm < 0) return '';
  if (distKm < 1.0) {
    const meters = Math.max(10, Math.round((distKm * 1000) / 10) * 10);
    if (meters >= 1000) return '1.0 km';
    return `${meters}m`;
  }
  return distKm < 10 ? `${distKm.toFixed(1)} km` : `${Math.round(distKm)} km`;
}

function sortRouteNosNatural(routeNos) {
  return Array.from(routeNos || []).sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  );
}

function deduplicatePlannerAutocompleteStops(stops, refLat = null, refLon = null, rawQ = '', maxMergeKm = 0.22) {
  const hasRef = isValidRailOrFerryCoord(Number(refLat), Number(refLon));
  const q = String(rawQ || '').trim().toLowerCase();
  const clusters = [];

  for (const s of (stops || [])) {
    if (!s) continue;
    const lat = parseFloat(s.latitude ?? s.lat);
    const lon = parseFloat(s.longitude ?? s.lon);
    if (!isValidRailOrFerryCoord(lat, lon)) continue;

    const baseKey = getBaseStopNameKey(s.stopName_e || s.name_tc || '');
    const distTag = typeof getStopDistrictTag === 'function' ? getStopDistrictTag(s) : '';
    const dRefKm = hasRef ? calculateDistanceKm(Number(refLat), Number(refLon), lat, lon) : Infinity;

    let merged = null;
    for (const c of clusters) {
      if (c._baseKey !== baseKey) continue;
      if (c._distTag && distTag && c._distTag !== distTag) continue;
      const dClusterKm = calculateDistanceKm(c._lat, c._lon, lat, lon);
      if (dClusterKm <= maxMergeKm) {
        merged = c;
        break;
      }
    }

    const rIter = s.routeNos ? Array.from(s.routeNos) : [];
    if (!merged) {
      clusters.push({
        ...s,
        latitude: lat,
        longitude: lon,
        _lat: lat,
        _lon: lon,
        _baseKey: baseKey,
        _distTag: distTag,
        _distKm: dRefKm,
        routeNos: new Set(rIter)
      });
    } else {
      for (const rNo of rIter) merged.routeNos.add(rNo);
      if (dRefKm < merged._distKm) {
        merged.stopKey = s.stopKey;
        merged.stopName_e = s.stopName_e || merged.stopName_e;
        merged.name_tc = s.name_tc || merged.name_tc;
        merged.latitude = lat;
        merged.longitude = lon;
        merged._lat = lat;
        merged._lon = lon;
        merged._distKm = dRefKm;
      }
    }
  }

  const stopMatchTier = (s) => {
    if (!q) return 0;
    const en = String(s.stopName_e || '').toLowerCase();
    const tc = String(s.name_tc || '').toLowerCase();
    if (en === q || tc === q) return 0;
    if (en.startsWith(q) || tc.startsWith(q)) return 1;
    return 2;
  };

  return clusters
    .map(c => ({
      ...c,
      mergedRouteNos: sortRouteNosNatural(c.routeNos)
    }))
    .sort((a, b) => {
      const tierDiff = stopMatchTier(a) - stopMatchTier(b);
      if (tierDiff !== 0) return tierDiff;
      const aDist = Number.isFinite(a._distKm) ? a._distKm : 9999;
      const bDist = Number.isFinite(b._distKm) ? b._distKm : 9999;
      if (Math.abs(aDist - bDist) > 0.01) return aDist - bDist;
      return (b.mergedRouteNos?.length || 0) - (a.mergedRouteNos?.length || 0);
    });
}

function getPlannerAutocompleteSectionOrder() {
  // Strict fixed order: transit hubs and deduplicated bus/minibus stops stay pinned above async HK Addresses & Landmarks
  return ['HUBS', 'STOPS', 'ALS'];
}

function renderPlannerInlineDropdown(rawQ = '') {
  const dd = document.getElementById('plannerInlineDropdown');
  if (!dd || !activePlannerInlineSlot) return;

  const slot = activePlannerInlineSlot;
  const q = String(rawQ || '').trim().toLowerCase();
  const isZh = (currentLang === 'zh');
  const savedHubs = SavedHubsManager.getHubs();
  const refPt = getPlannerAutocompleteRefPoint();
  const distKmFromRef = (lat, lon) => {
    const la = Number(lat), lo = Number(lon);
    if (!refPt || !isValidRailOrFerryCoord(la, lo)) return Infinity;
    return calculateDistanceKm(refPt.lat, refPt.lon, la, lo);
  };
  const renderDistBadge = (dKm) => {
    const lbl = formatCompactDistanceLabel(dKm);
    return lbl ? `<span class="planner-ac-dist">${escapeHtml(lbl)}</span>` : '';
  };

  let html = '';

  if (!q) {
    html += `
      <button type="button" class="planner-ac-item planner-ac-gps" onmousedown="event.preventDefault()" onclick="useGpsForPlannerSlot('${slot}')">
        <span class="planner-ac-icon">🎯</span>
        <span class="planner-ac-body">
          <span class="planner-ac-title">${isZh ? '使用目前位置 (GPS)' : 'Your current location (GPS)'}</span>
        </span>
      </button>`;

    if (savedHubs.home || savedHubs.work) {
      if (savedHubs.home) {
        const h = savedHubs.home;
        html += `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(h.stopKey)}', '${escapeJsAttr(h.nameEn)}', '${escapeJsAttr(h.nameTc)}', ${h.lat}, ${h.lon}, '${escapeJsAttr(h.mode || 'BUS')}')">
          <span class="planner-ac-icon">🏠</span>
          <span class="planner-ac-body"><span class="planner-ac-title">${isZh ? '屋企' : 'Home'} · ${escapeHtml(isZh ? h.nameTc : h.nameEn)}</span></span>
          ${renderDistBadge(distKmFromRef(h.lat, h.lon))}
        </button>`;
      }
      if (savedHubs.work) {
        const w = savedHubs.work;
        html += `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(w.stopKey)}', '${escapeJsAttr(w.nameEn)}', '${escapeJsAttr(w.nameTc)}', ${w.lat}, ${w.lon}, '${escapeJsAttr(w.mode || 'BUS')}')">
          <span class="planner-ac-icon">💼</span>
          <span class="planner-ac-body"><span class="planner-ac-title">${isZh ? '公司' : 'Work'} · ${escapeHtml(isZh ? w.nameTc : w.nameEn)}</span></span>
          ${renderDistBadge(distKmFromRef(w.lat, w.lon))}
        </button>`;
      }
    }

    const recList = recentCommutePlaces.slice(0, 4);
    if (recList.length) {
      html += `<div class="planner-ac-sec">${isZh ? '最近地點' : 'Recent'}</div>`;
      html += recList.map(r => {
        const disp = stripPlatformCodeFromDisplay(isZh && r.name_tc ? r.name_tc : r.stopName_e);
        const distTag = getStopDistrictTag({ stopName_e: r.stopName_e, latitude: r.lat, longitude: r.lon });
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(r.stopKey)}', '${escapeJsAttr(r.stopName_e)}', '${escapeJsAttr(r.name_tc || r.stopName_e)}', ${Number(r.lat) || 0}, ${Number(r.lon) || 0}, '${escapeJsAttr(r.nodeType || 'BUS')}')">
          <span class="planner-ac-icon">🕒</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(disp)}</span>
            ${distTag ? `<span class="planner-ac-sub">${escapeHtml(distTag)}</span>` : ''}
          </span>
          ${renderDistBadge(distKmFromRef(r.lat, r.lon))}
        </button>`;
      }).join('');
    }
  }

  // 1. MTR Stations & Ferry Piers (relevance tier, then proximity to GPS / map center)
  const allHubs = getPlannerHubDirectory();
  const normHubScore = (h) => {
    if (!q) return 0;
    const en = String(h.name_en || '').toLowerCase();
    const enCore = en.replace(/\s+(station|mtr|ferry\s+pier|pier)$/i, '').trim();
    const tc = String(h.name_tc || '');
    const tcCore = tc.replace(/(港鐵站|站|渡輪碼頭|碼頭)$/, '').trim();
    if (en === q || enCore === q || tc === q || tcCore === q) return 0;
    if (en.startsWith(q) || enCore.startsWith(q) || tc.startsWith(q)) return 1;
    return 2;
  };
  const matchedHubs = allHubs
    .filter(h => !q || h.name_en.toLowerCase().includes(q) || (h.name_tc && h.name_tc.includes(q)) || (h.badge && h.badge.toLowerCase().includes(q)))
    .map(h => ({ ...h, _distKm: distKmFromRef(h.lat, h.lon) }))
    .sort((a, b) => {
      const sDiff = normHubScore(a) - normHubScore(b);
      if (sDiff !== 0) return sDiff;
      return a._distKm - b._distKm;
    })
    .slice(0, q ? 6 : 6);

  const renderHubsSection = () => {
    if (!matchedHubs.length) return '';
    return `<div class="planner-ac-sec" data-ac-sec="HUBS">${isZh ? '港鐵站及碼頭' : 'MTR Stations & Ferry Piers'}</div>` +
      matchedHubs.map(h => {
        const disp = isZh && h.name_tc ? h.name_tc : h.name_en;
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(h.id)}', '${escapeJsAttr(h.name_en)}', '${escapeJsAttr(h.name_tc || h.name_en)}', ${h.lat}, ${h.lon}, '${escapeJsAttr(h.mode || 'MTR')}')">
          <span class="planner-ac-icon">${h.mode === 'FERRY' ? '⛴️' : '🚇'}</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(disp)}</span>
            <span class="planner-ac-sub">${escapeHtml(h.badge || h.mode)}</span>
          </span>
          ${renderDistBadge(h._distKm)}
        </button>`;
      }).join('');
  };

  // 2. Deduplicated Bus & Minibus Stops (merged opposite-side stops within ~220m, distance-ranked)
  buildNearbyStopsFast(refPt || (typeof lastKnownPos !== 'undefined' ? lastKnownPos : null));
  const rawStopMatches = q
    ? allStops.filter(s => s.mode !== 'MTR' && s.mode !== 'FERRY' && `${s.stopName_e || ''} ${s.name_tc || ''}`.toLowerCase().includes(q))
    : nearbyStopsList.slice(0, 18);
  const stopPool = deduplicatePlannerAutocompleteStops(rawStopMatches, refPt?.lat, refPt?.lon, q, 0.22).slice(0, q ? 8 : 6);

  const renderStopsSection = () => {
    if (!stopPool.length) return '';
    return `<div class="planner-ac-sec" data-ac-sec="STOPS">${q ? (isZh ? '巴士 / 小巴站' : 'Bus & Minibus Stops') : (isZh ? '附近車站' : 'Nearby Stops')}</div>` +
      stopPool.map(s => {
        const distTag = s._distTag || getStopDistrictTag(s);
        const rNos = (s.mergedRouteNos || sortRouteNosNatural(s.routeNos)).slice(0, 6).join(', ');
        const subParts = [distTag, rNos].filter(Boolean).join(' · ');
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(s.stopKey)}', '${escapeJsAttr(s.stopName_e)}', '${escapeJsAttr(s.name_tc || s.stopName_e)}', ${parseFloat(s.latitude)}, ${parseFloat(s.longitude)}, '${escapeJsAttr(s.mode || 'BUS')}')">
          <span class="planner-ac-icon">🚌</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(getStopName(s))}</span>
            ${subParts ? `<span class="planner-ac-sub">${escapeHtml(subParts)}</span>` : ''}
          </span>
          ${renderDistBadge(s._distKm)}
        </button>`;
      }).join('');
  };

  // 3. Async HK Addresses & Landmarks (ALWAYS rendered below Bus & Minibus Stops to prevent dropdown jumping)
  const sortedAls = plannerInlineAlsResults
    .map(a => ({ ...a, _distKm: distKmFromRef(a.lat, a.lon) }))
    .sort((a, b) => a._distKm - b._distKm)
    .slice(0, 5);

  const renderAlsSection = () => {
    if (!sortedAls.length) return '';
    return `<div class="planner-ac-sec" data-ac-sec="ALS">${isZh ? '香港街道地址 / 大廈' : 'HK Addresses & Landmarks'}</div>` +
      sortedAls.map((a, idx) => {
        const dispName = isZh ? (a.name_zh || a.name_en) : (a.name_en || a.name_zh);
        const distName = isZh ? (a.district_zh || a.district_en) : (a.district_en || a.district_zh);
        const stopKey = `ALS_${idx}_${a.lat}_${a.lon}`;
        return `<button type="button" class="planner-ac-item" data-pick="1" onmousedown="event.preventDefault()" onclick="selectPlannerInlineOption('${slot}', '${escapeJsAttr(stopKey)}', '${escapeJsAttr(a.name_en || dispName)}', '${escapeJsAttr(a.name_zh || dispName)}', ${a.lat}, ${a.lon}, 'ADDRESS')">
          <span class="planner-ac-icon">📍</span>
          <span class="planner-ac-body">
            <span class="planner-ac-title">${escapeHtml(dispName)}</span>
            ${distName ? `<span class="planner-ac-sub">${escapeHtml(distName)}</span>` : ''}
          </span>
          ${renderDistBadge(a._distKm)}
        </button>`;
      }).join('');
  };

  // Strict fixed section order prevents layout jumping when async ALS results arrive
  const sectionRenderers = {
    HUBS: renderHubsSection,
    STOPS: renderStopsSection,
    ALS: renderAlsSection
  };
  for (const secKey of getPlannerAutocompleteSectionOrder()) {
    html += sectionRenderers[secKey]();
  }

  if (!html) {
    html = `<div style="padding:14px;text-align:center;font-size:0.8rem;color:var(--text-sub);">${isZh ? '找不到相符地點，可嘗試輸入區域名稱、港鐵站或街道名稱' : 'No matching places — try a district, MTR station, or street name'}</div>`;
  }

  dd.innerHTML = html;
  dd.style.display = 'block';
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!activePlannerInlineSlot) return;
    const box = document.getElementById('plannerSearchBox');
    if (box && !box.contains(e.target)) {
      closePlannerInlineDropdown();
    }
  });
}

window.getPlannerAutocompleteRefPoint = getPlannerAutocompleteRefPoint;
window.formatCompactDistanceLabel = formatCompactDistanceLabel;
window.deduplicatePlannerAutocompleteStops = deduplicatePlannerAutocompleteStops;
window.getPlannerAutocompleteSectionOrder = getPlannerAutocompleteSectionOrder;
window.focusPlannerInlineInput = focusPlannerInlineInput;
window.onPlannerInlineInput = onPlannerInlineInput;
window.onPlannerInlineKeydown = onPlannerInlineKeydown;
window.selectPlannerInlineOption = selectPlannerInlineOption;
window.closePlannerInlineDropdown = closePlannerInlineDropdown;
window.useGpsForPlannerSlot = useGpsForPlannerSlot;
window.quickPickPlannerHub = quickPickPlannerHub;

function openCommuteStopPicker(slot) {
  triggerHaptic(10);
  activeCommutePickerSlot = slot === 'work' ? 'work' : 'home';
  alsAddressSearchResults = [];
  if (userCommuteProfile.home) savePlaceToRecentCommuteHistory(userCommuteProfile.home);
  if (userCommuteProfile.work) savePlaceToRecentCommuteHistory(userCommuteProfile.work);

  const isZh = (currentLang === 'zh');
  const titleEl = document.getElementById('commutePickerTitle');
  const inputEl = document.getElementById('commutePickerSearchInput');
  if (titleEl) titleEl.innerText = activeCommutePickerSlot === 'work' ? (isZh ? '🏁 選擇終點 (附近車站 / 碼頭 / 地址)' : '🏁 Select Destination (Nearby Stop / Address)') : (isZh ? '📍 選擇起點 (直接點選附近下一站 / 地址)' : '📍 Select Origin (Pick Nearby Stop / Address)');
  if (inputEl) {
    inputEl.value = '';
    inputEl.placeholder = isZh ? '搜尋香港地址、機場(HKG)、港鐵或點選下方車站...' : 'Search HK address, HKG, MTR or tap a stop below...';
  }
  const modal = document.getElementById('commutePickerModal');
  if (modal) modal.style.display = 'flex';
  renderCommutePickerList();
}

function closeCommuteStopPicker() {
  const modal = document.getElementById('commutePickerModal');
  if (modal) modal.style.display = 'none';
}

function onCommutePickerInput() {
  alsAddressSearchResults = [];
  renderCommutePickerList();
  clearTimeout(alsSearchDebounceTimer);
  if (activeCommutePickerSlot === 'hub_home' || activeCommutePickerSlot === 'hub_work') return;

  const q = (document.getElementById('commutePickerSearchInput')?.value || '').trim();
  const hasCjk = /[\u4e00-\u9fa5]/.test(q);
  if ((!hasCjk && q.length < 2) || (hasCjk && q.length < 1)) return;

  const seq = ++alsReqSeq;
  alsSearchDebounceTimer = setTimeout(async () => {
    try {
      const data = await fetchEdgeApiJSON(`?action=address_lookup&q=${encodeURIComponent(q)}&client=hk-fleet`, 3500, false);
      if (seq !== alsReqSeq) return;
      if (Array.isArray(data?.results) && data.results.length > 0) {
        alsAddressSearchResults = data.results;
      }
      renderCommutePickerList();
    } catch (e) {}
  }, 220);
}

async function selectCurrentGpsForCommutePicker() {
  triggerHaptic(15);
  const pos = await refreshGPS(3000, true);
  if (pos && Number.isFinite(pos.lat)) syncNearestStopFromGPS(pos.lat, pos.lon, false);
  const curStop = stopMapIndex.get(currentNearestStopKey) || nearbyStopsList[0];
  if (curStop) {
    selectCommuteStopOption(curStop.stopKey, curStop.stopName_e, curStop.name_tc || curStop.stopName_e, parseFloat(curStop.latitude), parseFloat(curStop.longitude), curStop.mode || 'BUS');
  }
}

function selectCommuteStopOption(stopKey, stopName_e, name_tc, lat = 0, lon = 0, nodeType = 'BUS') {
  triggerHaptic(15);
  const parts = String(stopKey || '').split('_');
  const parsedLat = Number(lat) || parseFloat(parts[parts.length - 2]) || 0;
  const parsedLon = Number(lon) || parseFloat(parts[parts.length - 1]) || 0;
  const cleanEn = nodeType === 'ADDRESS' ? cleanAlsAddressLabel(stopName_e) : stopName_e;
  const placeItem = { stopKey, stopName_e: cleanEn, name_tc: name_tc || cleanEn, lat: parsedLat, lon: parsedLon, nodeType };

  if (activeCommutePickerSlot === 'hub_home' || activeCommutePickerSlot === 'hub_work') {
    const hubSlot = (activeCommutePickerSlot === 'hub_work') ? 'work' : 'home';
    SavedHubsManager.setHub(hubSlot, placeItem, nodeType === 'ADDRESS' ? 'BUS' : nodeType, true);
    closeCommuteStopPicker();
    if (typeof syncSettingsModalLabels === 'function') syncSettingsModalLabels();
    lastRenderedCenterStopKey = null;
    if (currentView === 'main') renderMainNearby(false);
    const isZh = (currentLang === 'zh');
    const disp = stripPlatformCodeFromDisplay(isZh && placeItem.name_tc ? placeItem.name_tc : placeItem.stopName_e);
    showToast(hubSlot === 'work'
      ? (isZh ? `💼 已設定公司車站：${disp}（僅存本機）` : `💼 Work hub set: ${disp} (saved on device)`)
      : (isZh ? `🏠 已設定屋企車站：${disp}（僅存本機）` : `🏠 Home hub set: ${disp} (saved on device)`));
    return;
  }

  userCommuteProfile[activeCommutePickerSlot] = placeItem;
  SafeStorage.setItem('transit_commute_profile_v1', JSON.stringify(userCommuteProfile));
  savePlaceToRecentCommuteHistory(placeItem);
  closeCommuteStopPicker();
  updateCommuteBarUI();
  requestAnimationFrame(() => setTimeout(() => renderTransferPlannerView(), 0));
}

function renderCommutePickerList() {
  const listEl = document.getElementById('commutePickerList');
  const rawQ = (document.getElementById('commutePickerSearchInput')?.value || '').trim();
  const q = rawQ.toLowerCase();
  if (!listEl) return;

  const isZh = (currentLang === 'zh');
  const isHubSlot = (activeCommutePickerSlot === 'hub_home' || activeCommutePickerSlot === 'hub_work');
  const hubKey = activeCommutePickerSlot === 'hub_work' ? 'work' : 'home';
  const savedHubs = SavedHubsManager.getHubs();

  let html = '';

  if (isHubSlot) {
    html += `<div style="padding:8px 14px; font-size:0.74rem; color:var(--text-sub); background:var(--bg-surface); border-bottom:1px solid var(--border-color);">
      🔒 ${isZh ? '僅儲存公共車站／港鐵站／碼頭於本機瀏覽器，絕不上傳私人位置。' : 'Anchors only to a public stop, station, or pier — stored 100% locally on your device.'}
    </div>`;
    if (savedHubs[hubKey]) {
      const curHub = savedHubs[hubKey];
      html += `
        <div class="route-list-item" style="padding:10px 14px;" onclick="clearSavedHubFromSettings('${hubKey}')">
          <div class="route-info-col">
            <div class="route-dest" style="font-size:0.84rem; color:var(--ios-red);">✕ ${isZh ? `移除目前設定 (${escapeHtml(curHub.nameTc)})` : `Clear Current (${escapeHtml(curHub.nameEn)})`}</div>
          </div>
        </div>`;
    }
  }

  html += `
    <div class="route-list-item" style="padding:10px 14px; background:var(--bg-surface);" onclick="selectCurrentGpsForCommutePicker()">
      <div class="route-info-col"><div class="route-dest" style="font-size:0.84rem; color:var(--ios-blue);">🎯 ${isZh ? '使用我目前最近的公共車站' : 'Use Nearest Public Stop to My GPS'}</div></div>
    </div>
  `;

  if (!isHubSlot && !q && (savedHubs.home || savedHubs.work)) {
    html += `<div class="section-bar"><span>${isZh ? '常用車站捷徑 (本機儲存)' : 'SAVED HUB SHORTCUTS (ON DEVICE)'}</span></div>`;
    if (savedHubs.home) {
      const h = savedHubs.home;
      html += `<div class="route-list-item" style="padding:9px 14px;" onclick="selectCommuteStopOption('${escapeJsAttr(h.stopKey)}', '${escapeJsAttr(h.nameEn)}', '${escapeJsAttr(h.nameTc)}', ${h.lat}, ${h.lon}, '${escapeJsAttr(h.mode || 'BUS')}')">
        <div class="route-info-col"><div class="route-dest" style="font-size:0.84rem;"><span>🏠 ${isZh ? '屋企' : 'Home'}: ${escapeHtml(isZh ? h.nameTc : h.nameEn)}</span></div></div>
      </div>`;
    }
    if (savedHubs.work) {
      const w = savedHubs.work;
      html += `<div class="route-list-item" style="padding:9px 14px;" onclick="selectCommuteStopOption('${escapeJsAttr(w.stopKey)}', '${escapeJsAttr(w.nameEn)}', '${escapeJsAttr(w.nameTc)}', ${w.lat}, ${w.lon}, '${escapeJsAttr(w.mode || 'BUS')}')">
        <div class="route-info-col"><div class="route-dest" style="font-size:0.84rem;"><span>💼 ${isZh ? '公司' : 'Work'}: ${escapeHtml(isZh ? w.nameTc : w.nameEn)}</span></div></div>
      </div>`;
    }
  }

  if (!isHubSlot) {
    const combinedRecents = [];
    const seenRec = new Set();
    for (const r of [...recentCommutePlaces, ...(typeof recentStopSearches !== 'undefined' ? recentStopSearches : [])]) {
      if (!r?.stopName_e) continue;
      const k = `${getBaseStopNameKey(r.stopName_e)}_${Math.round((r.lat || 0) * 1000)}`;
      if (seenRec.has(k)) continue;
      seenRec.add(k);
      combinedRecents.push(r);
    }
    if (combinedRecents.length > 0) {
      const filteredRec = combinedRecents.filter(r => !q || r.stopName_e.toLowerCase().includes(q) || (r.name_tc && r.name_tc.includes(q)));
      if (filteredRec.length > 0) {
        html += `
          <div class="section-bar">
            <span>${isZh ? '最近輸入位置' : 'RECENTLY ENTERED'}</span>
            ${!q ? `<button class="header-pill-btn" onclick="recentCommutePlaces=[];recentStopSearches=[];SafeStorage.setItem('transit_recent_commute_places_v1','[]');SafeStorage.setItem('transit_recent_stops_v1','[]');renderCommutePickerList();" style="height:24px;padding:0 8px;font-size:0.66rem;">${isZh ? '清除' : 'Clear'}</button>` : ''}
          </div>
        ` + filteredRec.slice(0, 6).map(r => {
          const distTag = getStopDistrictTag({ stopName_e: r.stopName_e, latitude: r.lat, longitude: r.lon });
          const disp = stripPlatformCodeFromDisplay(isZh && r.name_tc ? r.name_tc : r.stopName_e);
          return `
            <div class="route-list-item" style="padding:9px 14px;" onclick="selectCommuteStopOption('${escapeJsAttr(r.stopKey)}', '${escapeJsAttr(r.stopName_e)}', '${escapeJsAttr(r.name_tc || r.stopName_e)}', ${Number(r.lat) || 0}, ${Number(r.lon) || 0}, '${r.nodeType || 'BUS'}')">
              <div class="route-info-col">
                <div class="route-dest" style="font-size:0.84rem;"><span>🕒 ${escapeHtml(disp)}</span> ${distTag ? `<span class="district-tag">${escapeHtml(distTag)}</span>` : ''}</div>
              </div>
            </div>`;
        }).join('');
      }
    }

    if (alsAddressSearchResults.length > 0) {
      html += `<div class="section-bar"><span>${isZh ? '香港街道地址 / 大廈 (政府地理空間數據)' : 'HK STREET ADDRESSES & BUILDINGS'}</span></div>`;
      html += alsAddressSearchResults.map((a, idx) => {
        const dispName = isZh ? (a.name_zh || a.name_en) : (a.name_en || a.name_zh);
        const distName = isZh ? (a.district_zh || a.district_en) : (a.district_en || a.district_zh);
        const stopKey = `ALS_${idx}_${a.lat}_${a.lon}`;
        return `
          <div class="route-list-item" style="padding:10px 14px;" onclick="selectCommuteStopOption('${escapeJsAttr(stopKey)}', '${escapeJsAttr(a.name_en || dispName)}', '${escapeJsAttr(a.name_zh || dispName)}', ${a.lat}, ${a.lon}, 'ADDRESS')">
            <div class="route-info-col">
              <div class="route-dest" style="font-size:0.84rem;"><span>🏢 ${escapeHtml(dispName)}</span> ${distName ? `<span class="district-tag">${escapeHtml(distName)}</span>` : ''}</div>
            </div>
          </div>`;
      }).join('');
    }
  }

  const matchedHubs = getPlannerHubDirectory().filter(h =>
    !q || h.name_en.toLowerCase().includes(q) || (h.name_tc && h.name_tc.includes(q)) || (h.badge && h.badge.toLowerCase().includes(q))
  ).slice(0, q ? 12 : 8);

  if (matchedHubs.length > 0) {
    html += `<div class="section-bar"><span>${isZh ? '港鐵站及渡輪碼頭' : 'MTR STATIONS & FERRY PIERS'}</span></div>`;
    html += matchedHubs.map(h => {
      const disp = isZh && h.name_tc ? h.name_tc : h.name_en;
      return `
        <div class="route-list-item" style="padding:10px 14px;" onclick="selectCommuteStopOption('${escapeJsAttr(h.id)}', '${escapeJsAttr(h.name_en)}', '${escapeJsAttr(h.name_tc || h.name_en)}', ${h.lat}, ${h.lon}, '${h.mode || 'MTR'}')">
          <div class="route-info-col">
            <div class="route-dest" style="font-size:0.84rem;"><span>${h.mode === 'FERRY' ? '⛴️' : '🚇'} ${escapeHtml(disp)}</span> <span class="district-tag">${escapeHtml(h.badge || h.mode)}</span></div>
          </div>
        </div>`;
    }).join('');
  }

  buildNearbyStopsFast(lastKnownPos);
  const qTokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const rawStopPool = q
    ? allStops.filter(s => {
        const distTag = typeof getStopDistrictTag === 'function' ? getStopDistrictTag(s) : '';
        const routesStr = Array.from(s.routeNos || []).join(' ');
        const hay = `${s.stopName_e || ''} ${s.name_tc || ''} ${distTag} ${routesStr}`.toLowerCase();
        return qTokens.every(tok => hay.includes(tok));
      })
    : nearbyStopsList.slice(0, 48);

  const stopPool = deduplicatePlannerAutocompleteStops(
    rawStopPool,
    lastKnownPos?.lat,
    lastKnownPos?.lon,
    q,
    0.22
  ).slice(0, q ? 20 : 14);

  if (stopPool.length > 0) {
    html += `<div class="section-bar"><span>${q ? (isZh ? '符合的車站' : 'MATCHING STOPS') : (isZh ? '附近車站' : 'NEARBY STOPS')}</span></div>`;
    html += stopPool.map(s => {
      const distTag = s._distTag || getStopDistrictTag(s);
      const dStr = Number.isFinite(s._distKm)
        ? (s._distKm < 1 ? `${Math.round(s._distKm * 1000)}m` : `${s._distKm.toFixed(1)}km`)
        : formatStopDistance(s);
      const rList = (s.mergedRouteNos && s.mergedRouteNos.length ? s.mergedRouteNos : Array.from(s.routeNos || [])).slice(0, 8);
      return `
        <div class="route-list-item" style="padding:10px 14px;" onclick="selectCommuteStopOption('${escapeJsAttr(s.stopKey)}', '${escapeJsAttr(s.stopName_e)}', '${escapeJsAttr(s.name_tc || s.stopName_e)}', ${parseFloat(s.latitude)}, ${parseFloat(s.longitude)}, '${s.mode || 'BUS'}')">
          <div class="route-info-col">
            <div class="route-dest" style="font-size:0.84rem;"><span>${escapeHtml(getStopName(s))}</span> ${distTag ? `<span class="district-tag">${escapeHtml(distTag)}</span>` : ''}</div>
            <div class="route-sub" style="font-size:0.72rem;"><span>${escapeHtml(rList.join(', '))}</span></div>
          </div>
          <div class="route-eta-col">${dStr ? `<span class="location-dist-pill">${escapeHtml(dStr)}</span>` : ''}</div>
        </div>`;
    }).join('');
  }

  listEl.innerHTML = html;
}

// ============================================================================
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

  const baseWalkW = mode === 'EASY' ? 2.40 : (mode === 'BULLETPROOF' ? 0.85 : (mode === 'CHEAPEST' ? 0.55 : 0.40));
  const W_walk = baseWalkW * weatherWalkMult;
  const W_fare = mode === 'CHEAPEST' ? 1.55 : (mode === 'BULLETPROOF' ? 0.25 : (mode === 'EASY' ? 0.20 : 0.15));
  const fareCap = mode === 'CHEAPEST' ? 110.0 : 28.0;

  const totalWalkSec = accessWalkSec + egressWalkSec + transferWalkSec;
  const longWalkOverhangMins = (!xferLocoBikeEnabled && totalWalkSec > 510)
    ? ((totalWalkSec - 510) / 60) * (mode === 'EASY' ? 1.65 : 1.15) * weatherWalkMult
    : 0;

  let penaltyMins = (totalWalkSec / 60) * W_walk + longWalkOverhangMins;

  // Prefer true door-to-door / direct terminus arrivals (<=120m final walk) over nearby stops requiring 300m-450m+ final walks
  const finalEgressDistM = Number.isFinite(Number(ctx.egressWalkDistM))
    ? Number(ctx.egressWalkDistM)
    : Math.round((Number(egressWalkSec) || 0) * (ctx.egressByBike ? 4.16 : 1.25));
  if (!ctx.egressByBike) {
    if (finalEgressDistM <= 120) {
      penaltyMins -= (mode === 'EASY' ? 5.0 : (mode === 'BULLETPROOF' ? 3.5 : (mode === 'CHEAPEST' ? 2.0 : 1.5)));
    } else if (finalEgressDistM >= 300) {
      const extra100m = (finalEgressDistM - 250) / 100;
      const finalWalkW = mode === 'EASY' ? 2.8 : (mode === 'BULLETPROOF' ? 1.9 : (mode === 'CHEAPEST' ? 1.0 : 0.9));
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
      // Modest reliability preference for heavy rail trunk (>= 2 stops) without distorting real travel time
      if (mode === 'BULLETPROOF' && hw <= 6 && mtrStopsRidden >= 2 && !rewardedMtrBonus) {
        penaltyMins -= 3.0;
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
          penaltyMins += baseTx * Math.pow(1.5, nonRailTransfers - 1) + (isLongWalkStn ? 4.0 : 0);
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
          let isSuppressedLongBus = false;
          if (suppressLongHaulBusKm > 0 && isBusRoute) {
            const bObj = rt.stObjs[boardSeq], aObj = rt.stObjs[seq];
            const hopKm = calculateDistanceKm(bObj.lat, bObj.lon, aObj.lat, aObj.lon);
            if (hopKm > suppressLongHaulBusKm) isSuppressedLongBus = true;
          }

          if (!isMicroBusHop && !isSuppressedLongBus) {
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
        const canBoardBetter = candArrSec < INF && (
          boardSeq === -1 ||
          candArrSec < boardTime + (rt.cumSecs[seq] - rt.cumSecs[boardSeq])
        );
        if (canBoardBetter) {
          const candBoardDate = new Date(queryDateObj.getTime() + (candArrSec + waitPenaltySec) * 1000);
          if (isRouteActiveAtPlannerTime(rt.group, candBoardDate)) {
            boardSeq = seq;
            boardTime = candArrSec;
            boardPrevRound = bestRound[k - 1][u];
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

  const directRoutes = [];
  const parallelGroupMap = new Map();
  for (const dp of rawDirectRoutes) {
    const isBus = (!dp.group.mode || dp.group.mode === 'BUS');
    if (isBus) {
      const pKey = `${getBaseStopNameKey(dp.boardStopObj.stopName_e)}_${getBaseStopNameKey(dp.alightStopObj.stopName_e)}`;
      if (parallelGroupMap.has(pKey)) {
        const primary = parallelGroupMap.get(pKey);
        if (primary.parallelRoutes.length < 3) {
          primary.parallelRoutes.push(dp.group.routeNo);
          if (xferSortPref === 'BULLETPROOF') {
            primary.disruptionScore = Number(Math.max(1, primary.disruptionScore - 2.2).toFixed(1));
          }
        }
        continue;
      }
      parallelGroupMap.set(pKey, dp);
    }
    directRoutes.push(dp);
  }
  directRoutes.sort((a, b) => a.disruptionScore - b.disruptionScore);

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
    directRoutes: directRoutes.slice(0, 5),
    transferCorridors: selectedCorridors
  };
}

// ============================================================================
// STATIC SCHEDULE + LEG-1 LIVE ANCHOR + LEAVE-NOW GHOST BUS FILTER
// ============================================================================
function resolveStaticFerrySlot(group, earliestBoardMs, fallbackDriveSec) {
  const fMeta = group?.ferryMeta || {};
  const dirKey = `${normStationLookupKey(group.orig_e)}_${normStationLookupKey(group.dest_e)}`;
  const sched = fMeta.sched || (typeof VERIFIED_MAINLINE_FERRIES !== 'undefined' ? VERIFIED_MAINLINE_FERRIES[dirKey] : null);
  if (!sched) return null;

  const hkRef = getHongKongNow(earliestBoardMs);
  const isHol = isHongKongHolidayFareDay(hkRef);
  const dayKey = isHol ? 'hol' : (hkRef.getDay() === 6 ? 'sat' : 'wk');
  const slots = (Array.isArray(sched[dayKey]) && sched[dayKey].length)
    ? sched[dayKey]
    : ((Array.isArray(sched.wk) && sched.wk.length) ? sched.wk : (sched.sat || sched.hol || []));
  if (!slots.length) return null;

  const nowSecOfDay = hkRef.getHours() * 3600 + hkRef.getMinutes() * 60 + hkRef.getSeconds();
  let bestSlot = null, bestWaitSec = Infinity;

  for (const entry of slots) {
    const depMin = Array.isArray(entry) ? Number(entry[0]) : Number(entry);
    const slotDur = (Array.isArray(entry) && entry[1]) ? Number(entry[1]) : 0;
    if (!Number.isFinite(depMin)) continue;
    let diffSec = depMin * 60 - nowSecOfDay;
    if (diffSec < -60 && nowSecOfDay >= 72000 && depMin < 180) diffSec += 86400;
    if (diffSec >= -30 && diffSec < bestWaitSec) {
      bestWaitSec = diffSec;
      bestSlot = { depMin, slotDur };
    }
  }
  if (!bestSlot) return null;

  const depMs = earliestBoardMs + Math.max(0, bestWaitSec) * 1000;
  const isOrd = bestSlot.slotDur >= 50;
  const vClass = isOrd ? 'ORD' : 'FAST';
  const durMins = bestSlot.slotDur || (isOrd ? fMeta.durOrd : fMeta.durFast) || fMeta.dur || Math.round(fallbackDriveSec / 60);
  const depDate = getHongKongNow(depMs);
  const loadEstimate = inferPlannerLegLoad(group, null, depDate, isHongKongHolidayFareDay(depDate), 0, {
    vesselClass: vClass,
    isSched: true
  });
  return {
    depMs,
    arrMs: depMs + durMins * 60000,
    isLive: false,
    signalType: 'SCHED',
    headwayMins: 0,
    hasSignal: true,
    isDeadGhost: false,
    vesselClass: vClass,
    loadEstimate
  };
}

function resolveStaticDownstreamLegWindow(group, earliestBoardMs, driveSec, boardStopObj = null, alightStopObj = null) {
  if (group?.mode === 'FERRY') {
    const ferrySlot = resolveStaticFerrySlot(group, earliestBoardMs, driveSec);
    if (ferrySlot) return ferrySlot;
  }
  const hwSec = getPeriodHeadwaySecs(group, earliestBoardMs);
  const expectedWaitSec = Math.min(900, Math.round(hwSec * 0.50));
  const depMs = earliestBoardMs + expectedWaitSec * 1000;
  const depDate = getHongKongNow(depMs);
  const loadEstimate = inferPlannerLegLoad(group, boardStopObj, depDate, isHongKongHolidayFareDay(depDate), hwSec, { alightStopObj, isSched: true });
  return {
    depMs,
    arrMs: depMs + driveSec * 1000,
    isLive: false,
    signalType: 'HEADWAY_PROJ',
    headwayMins: Math.round(hwSec / 60),
    hasSignal: true,
    isDeadGhost: false,
    vesselClass: null,
    loadEstimate
  };
}

function getOperatorAuditKeyForGroup(group) {
  if (!group) return 'KMB';
  if (group.mode === 'FERRY') return 'FERRY';
  if (group.company === 'LRT') return 'LRT';
  if (group.mode === 'MTR') return 'MTR';
  if (String(group.company).startsWith('GMB')) return 'GMB';
  if (group.company === 'LWB') return 'KMB';
  return group.company || 'KMB';
}

async function checkDownstreamBusRouteHasLiveFleet(group, boardStopObj, fleetCheckCache) {
  if (!group || (group.mode && group.mode !== 'BUS')) return true;
  if (xferTimeMode !== 'NOW' || navigator.onLine === false) return true;

  const rId = group.routeIds?.[0] || '';
  const cacheKey = `${group.key}|${boardStopObj?.stopId || ''}`;
  if (fleetCheckCache.has(cacheKey)) return fleetCheckCache.get(cacheKey);

  const now = Date.now();
  const opKey = getOperatorAuditKeyForGroup(group);

  const checkPromise = (async () => {
    try {
      if (rId.startsWith('KMB_') || rId.startsWith('LWB_')) {
        const parts = rId.split('_');
        const routeNo = parts[1], dirChar = parts[2] || 'O', srvType = parts[3] || '1';
        const byStopSeq = await fetchKmbRouteBulkEta(routeNo, srvType, false);
        const kmbUrl = `https://data.etabus.gov.hk/v1/transport/kmb/route-eta/${routeNo}/${srvType}`;
        if (!requestCache.get(kmbUrl)?.data) return true;

        const prefix = `${dirChar}_`;
        for (const [k, items] of byStopSeq.entries()) {
          if (!k.startsWith(prefix)) continue;
          for (const e of items) {
            const tMs = new Date(e.eta).getTime();
            if (Number.isFinite(tMs) && tMs >= now - 60000 && tMs <= now + 120 * 60000) {
              return true;
            }
          }
        }
        return false;
      }

      if (rId.startsWith('CTB_') || rId.startsWith('NLB_') || rId.startsWith('GMB_') || rId.startsWith('MTRB_')) {
        const stops = getStopsForGroup(group);
        const probeStop = boardStopObj || stops[0];
        if (!probeStop) return true;
        const arrs = await fetchStopSingleRaw(group, probeStop, false, now);
        if (arrs.length > 0) return true;

        if (stops[0] && stops[0].stopId !== probeStop.stopId) {
          const origArrs = await fetchStopSingleRaw(group, stops[0], false, now);
          if (origArrs.length > 0) return true;
        }

        const opSt = SignalHealthMonitor.byOperator[opKey];
        if (opSt?.okMs && (Date.now() - opSt.okMs) < 10000) {
          return false;
        }
        return true;
      }
    } catch (e) {}
    return true;
  })();

  fleetCheckCache.set(cacheKey, checkPromise);
  return checkPromise;
}

function isBusLegOnIncidentCorridor(group, boardStopObj = null, alightStopObj = null) {
  if (group?.mode && group.mode !== 'BUS') return false;
  const bLat = Number(boardStopObj?.lat ?? boardStopObj?.latitude);
  const bLon = Number(boardStopObj?.lon ?? boardStopObj?.longitude);
  const aLat = Number(alightStopObj?.lat ?? alightStopObj?.latitude);
  const aLon = Number(alightStopObj?.lon ?? alightStopObj?.longitude);
  const hasB = isValidRailOrFerryCoord(bLat, bLon);
  const hasA = isValidRailOrFerryCoord(aLat, aLon);
  if (!hasB && !hasA) return false;

  const liveMap = (typeof window !== 'undefined' && window.__LIVE_CORRIDORS__) ? window.__LIVE_CORRIDORS__ : {};
  const corList = (typeof window !== 'undefined' && Array.isArray(window.HK_STRATEGIC_CORRIDORS)) ? window.HK_STRATEGIC_CORRIDORS : [];

  if (typeof getCorridorLiveStatusAt === 'function') {
    const probePts = [];
    if (hasB) probePts.push([bLat, bLon]);
    if (hasA) probePts.push([aLat, aLon]);
    if (hasB && hasA) probePts.push([(bLat + aLat) / 2, (bLon + aLon) / 2]);
    for (const [pLat, pLon] of probePts) {
      const st = getCorridorLiveStatusAt(pLat, pLon);
      if (st?.status === 'INCIDENT') return true;
    }
  }

  if (hasB && hasA && typeof resolveRelevantCorridorForTrip === 'function') {
    const relCor = resolveRelevantCorridorForTrip(bLat, bLon, aLat, aLon);
    if (relCor?.id && liveMap[relCor.id]?.status === 'INCIDENT') return true;
  }

  const samplePts = [];
  if (hasB) samplePts.push([bLat, bLon]);
  if (hasA) samplePts.push([aLat, aLon]);
  if (hasB && hasA) {
    samplePts.push([(bLat + aLat) / 2, (bLon + aLon) / 2]);
    samplePts.push([bLat * 0.7 + aLat * 0.3, bLon * 0.7 + aLon * 0.3]);
    samplePts.push([bLat * 0.3 + aLat * 0.7, bLon * 0.3 + aLon * 0.7]);
  }
  for (const cor of corList) {
    if (liveMap[cor.id]?.status !== 'INCIDENT') continue;
    for (const [pLat, pLon] of samplePts) {
      if (calculateDistanceKm(pLat, pLon, cor.lat, cor.lon) <= cor.radiusKm) {
        return true;
      }
    }
  }

  if (liveMap.LANTAU_TM?.status === 'INCIDENT' && typeof isLantauOrAirportZone === 'function') {
    if ((hasB && isLantauOrAirportZone(bLat, bLon, boardStopObj?.stopName_e || '')) ||
        (hasA && isLantauOrAirportZone(aLat, aLon, alightStopObj?.stopName_e || ''))) {
      return true;
    }
  }

  return false;
}

window.isBusLegOnIncidentCorridor = isBusLegOnIncidentCorridor;

async function resolveLiveOrStaticLegWindow(group, boardStopKey, earliestBoardMs, driveSec, boardStopObj = null, isFirstLeg = true, alightStopObj = null) {
  const now = Date.now();
  const horizonMins = isFirstLeg ? 25 : 35;
  const deltaMs = earliestBoardMs - now;
  const isWithinLiveHorizon = deltaMs <= horizonMins * 60000 && deltaMs >= -5 * 60000;

  if (isWithinLiveHorizon && (isFirstLeg || (xferTimeMode === 'NOW' && navigator.onLine !== false))) {
    try {
      const arrs = await fetchEtaRaw(group, boardStopKey, false, earliestBoardMs, null);

      // Reject "scheduled-only ghost buses" when the route's road corridor has an active INCIDENT
      if (
        isFirstLeg &&
        xferTimeMode === 'NOW' &&
        (!group?.mode || group.mode === 'BUS') &&
        Array.isArray(arrs) &&
        arrs.length > 0 &&
        arrs.every(a => Boolean(a?.isSched)) &&
        isBusLegOnIncidentCorridor(group, boardStopObj, alightStopObj)
      ) {
        return {
          depMs: earliestBoardMs,
          arrMs: earliestBoardMs + driveSec * 1000,
          isLive: false,
          signalType: 'NO_SERVICE',
          headwayMins: 0,
          hasSignal: false,
          isDeadGhost: true,
          vesselClass: null,
          loadEstimate: null
        };
      }

      const valid = arrs.find(a => a.targetMs >= earliestBoardMs - (isFirstLeg ? 30000 : 20000));
      if (valid) {
        const depMs = Math.max(earliestBoardMs, valid.targetMs);
        let effDriveSec = driveSec;
        if (group?.mode === 'FERRY') {
          const rmkDur = String(valid.remark || '').match(/(?:~|約)(\d+)\s*(?:m|分)/i);
          if (rmkDur) effDriveSec = Number(rmkDur[1]) * 60;
          else if (valid.vesselClass === 'ORD') effDriveSec = (group.ferryMeta?.durOrd || 55) * 60;
          else if (valid.vesselClass === 'FAST') effDriveSec = (group.ferryMeta?.durFast || group.ferryMeta?.dur || 35) * 60;
        }
        return {
          depMs,
          arrMs: depMs + effDriveSec * 1000,
          isLive: !valid.isSched,
          signalType: valid.isSched ? 'SCHED' : 'LIVE',
          headwayMins: Math.round(getPeriodHeadwaySecs(group, depMs, arrs) / 60),
          hasSignal: true,
          isDeadGhost: false,
          vesselClass: valid.vesselClass || null,
          loadEstimate: valid.loadEstimate || inferPlannerLegLoad(group, boardStopObj, getHongKongNow(depMs), isHongKongHolidayFareDay(getHongKongNow(depMs)), 0, { vesselClass: valid.vesselClass, alightStopObj, isSched: Boolean(valid.isSched) })
        };
      }
    } catch (e) {}

    if (isFirstLeg && xferTimeMode === 'NOW' && navigator.onLine !== false) {
      if (group?.mode === 'FERRY') {
        const ferrySlot = resolveStaticFerrySlot(group, earliestBoardMs, driveSec);
        if (ferrySlot) return ferrySlot;
        return { depMs: earliestBoardMs, arrMs: earliestBoardMs + driveSec * 1000, isLive: false, signalType: 'NO_SERVICE', headwayMins: 0, hasSignal: false, isDeadGhost: true, vesselClass: null, loadEstimate: null };
      }
      const opKey = getOperatorAuditKeyForGroup(group);
      const opSt = SignalHealthMonitor.byOperator[opKey];
      const apiConfirmedOk = Boolean(opSt?.okMs && (Date.now() - opSt.okMs) < 10000);
      if (apiConfirmedOk) {
        return {
          depMs: earliestBoardMs,
          arrMs: earliestBoardMs + driveSec * 1000,
          isLive: false,
          signalType: 'NO_SERVICE',
          headwayMins: 0,
          hasSignal: false,
          isDeadGhost: true,
          vesselClass: null,
          loadEstimate: null
        };
      }
    }
  }

  return resolveStaticDownstreamLegWindow(group, earliestBoardMs, driveSec, boardStopObj, alightStopObj);
}

async function resolveFirstLegWindow(group, boardStopKey, earliestBoardMs, driveSec, boardStopObj = null, alightStopObj = null) {
  return resolveLiveOrStaticLegWindow(group, boardStopKey, earliestBoardMs, driveSec, boardStopObj, true, alightStopObj);
}

// ============================================================================
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

function applyCpmsFilterToUnifiedCards(cards) {
  if (!Array.isArray(cards) || cards.length < 2) return;
  const pricedCards = cards.filter(c => c.type !== 'WALK_BIKE' && (c.item?.fareHkd || 0) > 0);
  if (pricedCards.length < 2) return;

  const cheapest = [...pricedCards].sort((a, b) => (a.item.fareHkd || 0) - (b.item.fareHkd || 0))[0];
  const baseFare = cheapest.item.fareHkd || 0;
  const baseMins = cheapest.item.totalMins || 60;

  for (const c of pricedCards) {
    if (c === cheapest) continue;
    const extraFare = (c.item.fareHkd || 0) - baseFare;
    const minsSaved = baseMins - (c.item.totalMins || 60);
    if (extraFare >= 14.0 && minsSaved < 12) {
      const cpmsPenalty = xferSortPref === 'CHEAPEST' ? 35.0 : (xferSortPref === 'FASTEST' ? 3.0 : 14.0);
      c.score = Number((c.score + cpmsPenalty).toFixed(1));
    }
  }
}

function formatLegSignalTagHtml(sigType, headwayMins = 0, isFreeFeeder = false, loadEst = null, cutoffWarn = null) {
  const isZh = (currentLang === 'zh');
  const parts = [];
  if (sigType === 'LIVE') {
    parts.push(`<span class="planner-sig-live">● ${isZh ? '實時' : 'Live'}</span>`);
  } else if (sigType === 'SCHED') {
    parts.push(`<span class="planner-sig-sched">${isZh ? '班次表' : 'Scheduled'}</span>`);
  } else if (sigType === 'HEADWAY_PROJ') {
    const hwTxt = headwayMins > 0 ? (isZh ? `約${headwayMins}分一班` : `every ~${headwayMins}m`) : (isZh ? '預計' : 'Est');
    parts.push(`<span class="planner-sig-est">${escapeHtml(hwTxt)}</span>`);
  }
  if (isFreeFeeder) {
    parts.push(`<span class="planner-sig-live">${isZh ? '免費轉乘' : 'Free xfer'}</span>`);
  }
  if (loadEst && loadEst.pct >= 75 && !loadEst.firstClassWarning) {
    parts.push(`<span class="planner-sig-warn">${escapeHtml(isZh ? loadEst.labelTc : loadEst.labelEn)}</span>`);
  }
  if (cutoffWarn && cutoffWarn.isLastSoon) {
    parts.push(`<span class="planner-sig-cutoff">⚠ ${escapeHtml(isZh ? cutoffWarn.labelTc : cutoffWarn.labelEn)}</span>`);
  }
  return parts.join(' · ');
}

function getLegStopDisplayName(group, stopObj) {
  const isZh = (currentLang === 'zh');
  if (group?.mode === 'FERRY' && typeof getFerryPierBerthLabel === 'function') {
    const berth = getFerryPierBerthLabel(group, stopObj, isZh);
    if (berth) return berth;
  }
  return getStopName(stopObj);
}

function collectLoadNoticesFromList(loadList) {
  const out = [];
  let addedEal = false;
  for (const ld of (loadList || [])) {
    if (!ld) continue;
    if (ld.firstClassWarning && ld.tipEn && !addedEal) {
      addedEal = true;
      out.push({ type: 'eal_first_class', routeNo: 'EAL', en: ld.tipEn, tc: ld.tipTc || ld.tipEn });
    } else if (!ld.firstClassWarning && ld.pct >= 75 && ld.tipEn && out.length < 1) {
      out.push({ type: 'load_tip', routeNo: ld.lineCode || '', en: ld.tipEn, tc: ld.tipTc || ld.tipEn });
    }
  }
  return out;
}

function renderSectionalNoticesHtml(notices) {
  if (!Array.isArray(notices) || !notices.length) return '';
  const isZh = (currentLang === 'zh');
  return notices.slice(0, 2).map(n => {
    const isWarn = n.type === 'driver_override' || n.type === 'strict_boarding_only' || n.type === 'eal_first_class';
    const fareMath = (n.rebateAmount > 0 && n.upfrontFare > n.netFare)
      ? (isZh
          ? `（先拍 $${n.upfrontFare.toFixed(1)} → 實付 $${n.netFare.toFixed(1)}）`
          : ` (Tap $${n.upfrontFare.toFixed(1)} → Net $${n.netFare.toFixed(1)})`)
      : '';
    return `<div class="planner-notice-row ${isWarn ? 'warn' : ''}">${n.routeNo ? `<strong>${escapeHtml(n.routeNo)}</strong> · ` : ''}${escapeHtml(isZh ? n.tc : n.en)}${escapeHtml(fareMath)}</div>`;
  }).join('');
}

function renderWalkTimelineRowHtml(distM, walkSec, isBike, targetLabel, fromLat, fromLon, destLat, destLon, exitObj = null, exitDirection = 'to') {
  const minDist = exitObj?.ref ? 15 : 40;
  if (!distM || distM < minDist) return '';
  const isZh = (currentLang === 'zh');
  const mins = Math.max(1, Math.round((walkSec || Math.round(distM / (isBike ? 4.16 : 1.25))) / 60));
  const verb = isBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk');
  const exitPrefix = (exitObj?.ref && exitDirection === 'from')
    ? (isZh ? ` 經${exitObj.ref}出口` : ` via Exit ${exitObj.ref}`)
    : '';
  const exitSuffix = (exitObj?.ref && exitDirection !== 'from')
    ? (isZh ? ` (${exitObj.ref}出口)` : ` (Exit ${exitObj.ref})`)
    : '';
  const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${Number(destLat).toFixed(6)},${Number(destLon).toFixed(6)}&travelmode=${isBike ? 'bicycling' : 'walking'}`;
  const focusCall = (Number.isFinite(Number(fromLat)) && Number.isFinite(Number(fromLon)))
    ? `focusPlannerMapLeg(${Number(fromLat)}, ${Number(fromLon)}, ${Number(destLat)}, ${Number(destLon)})`
    : `focusPlannerMapLeg(${Number(destLat)}, ${Number(destLon)})`;
  return `
    <div class="planner-step-walk" onclick="event.stopPropagation(); ${focusCall};">
      <div class="planner-step-rail walk"></div>
      <div class="planner-step-content">
        <div class="planner-step-main">${isBike ? '🚲' : '🚶'} ${verb} ${mins}${t('minsUnit')} (${distM}m)${escapeHtml(exitPrefix)} → ${escapeHtml(targetLabel)}${escapeHtml(exitSuffix)}</div>
      </div>
      <a href="${mapUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="planner-step-link">${isZh ? '導航 ↗' : 'Walk ↗'}</a>
    </div>`;
}

function renderRouteChipHtml(group, fallbackLabel = '') {
  const badge = (group && window.getDisplayRouteBadge) ? window.getDisplayRouteBadge(group) : (group?.routeNo || fallbackLabel || '');
  const bg = group?.colorHex || (typeof window.__GET_ROUTE_COLOR_HEX__ === 'function' ? window.__GET_ROUTE_COLOR_HEX__(group?.mode, group?.company, group?.routeNo) : '#007AFF') || '#007AFF';
  return `<span class="planner-line-chip" style="background:${escapeHtml(bg)};">${escapeHtml(badge)}</span>`;
}

function renderPlannerEmptyStateHtml() {
  const isZh = (currentLang === 'zh');
  const quickHubs = [
    { id: 'MTR_CEN', en: 'Central', tc: '中環' },
    { id: 'MTR_TST', en: 'Tsim Sha Tsui', tc: '尖沙咀' },
    { id: 'MTR_MOK', en: 'Mong Kok', tc: '旺角' },
    { id: 'MTR_TUC', en: 'Tung Chung', tc: '東涌' },
    { id: 'FERRY_CC', en: 'Cheung Chau', tc: '長洲' },
    { id: 'MTR_AIR', en: 'Airport (HKG)', tc: '香港機場' }
  ];
  const hasFrom = Boolean(userCommuteProfile.home);
  const promptTitle = !hasFrom
    ? (isZh ? '輸入起點與目的地' : 'Where are you going?')
    : (isZh ? '選擇目的地即可查看實時路線' : 'Pick a destination for live routes');
  const promptSub = isZh
    ? '整合九巴、城巴、港鐵及渡輪實時到站時間，輸入車站、港鐵站或地址即時規劃。'
    : 'Real-time KMB, Citybus, MTR & Ferry ETAs combined — search any stop, station, pier, or HK address.';

  return `
    <div class="planner-empty-state">
      <div class="planner-empty-title">${promptTitle}</div>
      <div class="planner-empty-sub">${promptSub}</div>
      <div class="planner-quick-hubs">
        ${quickHubs.map(h => `
          <button type="button" class="planner-quick-hub-btn" onclick="quickPickPlannerHub('${h.id}')">
            ${escapeHtml(isZh ? h.tc : h.en)}
          </button>`).join('')}
      </div>
    </div>`;
}

function formatPlannerCardShareText(spec, card, isZh = false) {
  if (!spec || !card?.item) return '';
  const origName = (isZh && spec.fromMeta?.name_tc) ? spec.fromMeta.name_tc : (spec.fromMeta?.name_en || (isZh ? '起點' : 'Origin'));
  const destName = (isZh && spec.toMeta?.name_tc) ? spec.toMeta.name_tc : (spec.toMeta?.name_en || (isZh ? '目的地' : 'Destination'));
  const fmtClk = (ms) => ms ? formatHkArrivalClock(ms) : '';
  const fmtEx = (ex) => ex?.ref ? (isZh ? ` (${ex.ref}出口)` : ` (Exit ${ex.ref})`) : '';
  const lines = [];

  if (card.type === 'WALK_BIKE') {
    const wb = card.item;
    const mins = Math.max(1, Number(wb.totalMins) || 1);
    const fareNum = Number(wb.fareHkd) || 0;
    const fareStr = fareNum > 0 ? ` · ~$${fareNum.toFixed(1)}` : ' · $0';
    lines.push(`${origName} → ${destName}`);
    lines.push(`${mins}${isZh ? '分鐘' : 'm'}${fareStr}`);
    lines.push(`• ${wb.isBike ? (isZh ? '共享單車 (LocoBike)' : 'Bike Direct (LocoBike)') : (isZh ? '步行前往' : 'Walk Direct')} ${wb.distM}m → ${destName}`);
    return lines.join('\n');
  }

  if (card.type === 'DIRECT') {
    const dp = card.item;
    const badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(dp.group) : dp.group?.routeNo;
    const mins = Math.max(1, Number(dp.totalMins) || 1);
    const fareStr = dp.fareHkd > 0 ? ` · $${dp.fareHkd.toFixed(1)}` : '';
    const arrStr = dp.liveArrMs ? ` · ${isZh ? '抵達' : 'Arr'} ${fmtClk(dp.liveArrMs)}` : '';
    lines.push(`${origName} → ${destName}`);
    lines.push(`${mins}${isZh ? '分鐘' : 'm'}${fareStr}${arrStr}`);
    if (dp.accessWalkDistM >= 40) {
      lines.push(`• ${dp.accessByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${dp.accessWalkDistM}m → ${getLegStopDisplayName(dp.group, dp.boardStopObj)}${fmtEx(dp.accessExitObj)}`);
    }
    lines.push(`• ${dp.liveDepMs ? fmtClk(dp.liveDepMs) + ' ' : ''}${badge}: ${getLegStopDisplayName(dp.group, dp.boardStopObj)} → ${getLegStopDisplayName(dp.group, dp.alightStopObj)}`);
    if (dp.egressWalkDistM >= 40) {
      lines.push(`• ${dp.egressByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${dp.egressWalkDistM}m${fmtEx(dp.egressExitObj)} → ${destName}`);
    }
    return lines.join('\n');
  }

  if (card.type === 'XFER') {
    const cor = card.item;
    const node = cor.xferStopNodes?.[0];
    if (!node) return '';
    const b1 = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg1Group) : cor.leg1Group?.routeNo;
    const b2 = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg2Group) : cor.leg2Group?.routeNo;
    const mins = Math.max(1, Number(cor.totalMins) || 1);
    const fareStr = cor.fareHkd > 0 ? ` · $${cor.fareHkd.toFixed(1)}` : '';
    const arrStr = cor.liveArrMs ? ` · ${isZh ? '抵達' : 'Arr'} ${fmtClk(cor.liveArrMs)}` : '';
    lines.push(`${origName} → ${destName}`);
    lines.push(`${mins}${isZh ? '分鐘' : 'm'}${fareStr}${arrStr}`);
    if (cor.accessWalkDistM >= 40) {
      lines.push(`• ${cor.accessByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${cor.accessWalkDistM}m → ${getLegStopDisplayName(cor.leg1Group, cor.board1StopObj)}${fmtEx(cor.accessExitObj)}`);
    }
    lines.push(`• ${cor.liveDep1Ms ? fmtClk(cor.liveDep1Ms) + ' ' : ''}${b1}: ${getLegStopDisplayName(cor.leg1Group, cor.board1StopObj)} → ${getLegStopDisplayName(cor.leg1Group, node.alight1StopObj)}`);
    if (node.walkDistM >= 40 || node.xferExitObj?.ref) {
      lines.push(`• ${isZh ? '轉乘步行' : 'Transfer walk'} ${node.walkDistM || 0}m${fmtEx(node.xferExitObj)} → ${getLegStopDisplayName(cor.leg2Group, node.board2StopObj)}`);
    }
    const leg2Alight = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
    lines.push(`• ${cor.liveDep2Ms ? fmtClk(cor.liveDep2Ms) + ' ' : ''}${b2}: ${getLegStopDisplayName(cor.leg2Group, node.board2StopObj)} → ${getLegStopDisplayName(cor.leg2Group, leg2Alight)}`);
    (cor.leg3Options || []).forEach(l3 => {
      const b3 = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(l3.group) : l3.routeNo;
      if (l3.walkDistM >= 40 || l3.xferExitObj?.ref) {
        lines.push(`• ${isZh ? '轉乘步行' : 'Transfer walk'} ${l3.walkDistM || 0}m${fmtEx(l3.xferExitObj)} → ${getLegStopDisplayName(l3.group, l3.boardStopObj)}`);
      }
      lines.push(`• ${l3.liveDepMs ? fmtClk(l3.liveDepMs) + ' ' : ''}${b3}: ${getLegStopDisplayName(l3.group, l3.boardStopObj)} → ${getLegStopDisplayName(l3.group, l3.alightStopObj)}`);
    });
    if (cor.egressWalkDistM >= 40 || cor.egressExitObj?.ref) {
      lines.push(`• ${cor.egressByBike ? (isZh ? '單車' : 'Bike') : (isZh ? '步行' : 'Walk')} ${cor.egressWalkDistM || 0}m${fmtEx(cor.egressExitObj)} → ${destName}`);
    }
    return lines.join('\n');
  }
  return '';
}

window.formatPlannerCardShareText = formatPlannerCardShareText;

async function shareUnifiedPlannerCard(cardKey, btnEl = null) {
  triggerHaptic(10);
  const isZh = (currentLang === 'zh');
  const card = lastXferSolvedSpec?._unifiedCards?.find(c => c.key === cardKey);
  if (!card) return;
  const text = formatPlannerCardShareText(lastXferSolvedSpec, card, isZh);
  if (!text) return;

  const markCopied = () => {
    if (!btnEl) return;
    const orig = btnEl.getAttribute('data-orig-label') || btnEl.textContent;
    btnEl.setAttribute('data-orig-label', orig);
    btnEl.classList.add('copied');
    btnEl.textContent = isZh ? '✓ 已複製路線' : '✓ Copied';
    setTimeout(() => {
      btnEl.classList.remove('copied');
      btnEl.textContent = orig;
    }, 1800);
  };

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ title: 'Transit HK Route', text });
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      markCopied();
      return;
    }
  } catch (e) {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    markCopied();
  } catch (e) {}
}

window.shareUnifiedPlannerCard = shareUnifiedPlannerCard;

function selectUnifiedPlannerCard(cardKey, corIdx = 0) {
  triggerHaptic(10);
  activeUnifiedCardKey = cardKey;
  if (corIdx >= 0) activeXferCorridorIdx = corIdx;
  document.querySelectorAll('#xferResultsContainer .xfer-decision-card').forEach(el => {
    const isMatch = el.getAttribute('data-card-key') === cardKey;
    el.classList.toggle('selected', isMatch);
  });
  if (lastXferSolvedSpec && Array.isArray(lastXferSolvedSpec._unifiedCards)) {
    const picked = lastXferSolvedSpec._unifiedCards.find(c => c.key === cardKey) || lastXferSolvedSpec._unifiedCards[0];
    if (picked) {
      drawTransferCorridorOnMap(lastXferSolvedSpec, picked);
      syncPlannerAlertBannerUI(picked);
    }
  }
}

async function renderTransferPlannerView() {
  const container = document.getElementById('xferResultsContainer');
  if (!container) return;
  updateCommuteBarUI();
  if (typeof ensureXferMapInitialized === 'function') ensureXferMapInitialized();

  if (!userCommuteProfile.home || !userCommuteProfile.work) {
    if (typeof window.clearTransferPlannerMapLayers === 'function') {
      window.clearTransferPlannerMapLayers();
    }
    syncPlannerAlertBannerUI(null);
    container.innerHTML = renderPlannerEmptyStateHtml();
    return;
  }

  const myToken = ++xferRenderToken;
  const isZh = (currentLang === 'zh');

  let refStartMs = Date.now();
  let targetArriveMs = null;

  if ((xferTimeMode === 'PLAN' || xferTimeMode === 'ARRIVE') && xferPlannedHHMM) {
    const [hh, mm] = xferPlannedHHMM.split(':').map(Number);
    if (Number.isFinite(hh) && Number.isFinite(mm)) {
      const hkNow = getHongKongNow();
      const targetToday = new Date(hkNow.getFullYear(), hkNow.getMonth(), hkNow.getDate(), hh, mm, 0);
      let diffMs = targetToday.getTime() - hkNow.getTime();
      if (diffMs < -1800000) diffMs += 86400000;
      const targetEpochMs = Date.now() + diffMs;
      if (xferTimeMode === 'ARRIVE') {
        targetArriveMs = targetEpochMs;
        refStartMs = targetEpochMs - 60 * 60000;
      } else {
        refStartMs = targetEpochMs;
      }
    }
  }

  const queryDateObj = getHongKongNow(refStartMs);
  const isHolQuery = isHongKongHolidayFareDay(queryDateObj);
  const spec = buildFromToEdgeRequestSpec(queryDateObj);
  if (!spec) {
    container.innerHTML = `<div class="text-center">${t('noRoutesFound')}</div>`;
    return;
  }
  lastXferSolvedSpec = spec;

  const paintUnifiedCards = (isFinalPass = false) => {
    const unified = [];
    if (spec.walkBikeDirectCard) {
      unified.push({
        type: 'WALK_BIKE',
        idx: -1,
        score: spec.walkBikeDirectCard.disruptionScore,
        item: spec.walkBikeDirectCard,
        key: 'WALK_BIKE_0',
        isRailOrFerry: false
      });
    }
    spec.directRoutes.forEach((dp, i) => {
      if (dp.isDeadGhost) return;
      const isRF = dp.group?.mode === 'FERRY' || (dp.group?.mode === 'MTR' && dp.group?.company === 'MTR');
      unified.push({ type: 'DIRECT', idx: i, score: dp.disruptionScore, item: dp, key: `DIRECT_${i}`, isRailOrFerry: isRF });
    });
    spec.transferCorridors.forEach((cor, i) => {
      if (cor.isDeadGhost) return;
      unified.push({ type: 'XFER', idx: i, score: cor.disruptionScore, item: cor, key: `XFER_${i}`, isRailOrFerry: corridorHasRailOrFerryTrunk(cor) });
    });

    applyCpmsFilterToUnifiedCards(unified);
    const topCards = pruneDominatedPlannerCards(unified, xferSortPref, refStartMs);
    spec._unifiedCards = topCards;

    if (!topCards.length) {
      container.innerHTML = `<div class="text-center">${t('noRoutesFound')}</div>`;
      return;
    }

    if (!activeUnifiedCardKey || !topCards.some(c => c.key === activeUnifiedCardKey)) {
      activeUnifiedCardKey = topCards[0].key;
    }

    const metricsList = topCards.map(c => extractCardMetrics(c, refStartMs));
    const minMins = Math.min(...metricsList.map(m => m.mins));
    const pricedMetrics = metricsList.filter(m => (!m.isWalkBike || (m.modes?.[0] === 'BIKE')) && m.fareHkd > 0);
    const minFare = pricedMetrics.length ? Math.min(...pricedMetrics.map(m => m.fareHkd)) : Infinity;
    const winnerFare = metricsList[0]?.fareHkd || 0;

    const toDispName = stripPlatformCodeFromDisplay(isZh && spec.toMeta.name_tc ? spec.toMeta.name_tc : spec.toMeta.name_en);
    const mtrClosedBanner = spec.mtrClosedNow
      ? `<div class="planner-notice-row warn">🌙 ${isZh ? '港鐵深夜收車時段 (01:00–05:50) — 已切換通宵巴士／小巴路線' : 'MTR closed (01:00–05:50 HKT) — Showing overnight buses & GMBs'}</div>`
      : '';

    const getCardTag = (c, m, rankIdx) => {
      if (rankIdx === 0) {
        if (xferSortPref === 'FASTEST') return isZh ? '最快' : 'Fastest';
        if (xferSortPref === 'CHEAPEST') return isZh ? '最抵' : 'Cheapest';
        if (xferSortPref === 'EASY') return isZh ? '少步行' : 'Less Walk';
        return isZh ? '最佳路線' : 'Best';
      }
      if ((!m.isWalkBike || m.modes?.[0] === 'BIKE') && m.fareHkd > 0 && m.fareHkd <= minFare + 0.1 && (winnerFare - m.fareHkd) >= 2.0) {
        const diff = (winnerFare - m.fareHkd).toFixed(1);
        return isZh ? `較平 · 慳$${diff}` : `Cheaper · Save $${diff}`;
      }
      if (m.mins <= minMins && rankIdx > 0) return isZh ? '最快' : 'Fastest';
      if (c.type === 'DIRECT') return isZh ? '直達免轉車' : 'Direct';
      if (m.walkM + 200 < (metricsList[0]?.walkM || 0)) return isZh ? '少步行' : 'Less Walk';
      return '';
    };

    const statusLine = !isFinalPass
      ? `<div class="planner-sync-note">${isZh ? '正在核對實時班次...' : 'Checking live departures...'}</div>`
      : '';

    container.innerHTML = mtrClosedBanner + statusLine + topCards.map((c, rankIdx) => {
      const m = metricsList[rankIdx];
      const isWinner = (rankIdx === 0);
      const isSelected = (c.key === activeUnifiedCardKey);
      const isOpen = isSelected || isWinner;
      const cardTag = getCardTag(c, m, rankIdx);

      if (c.type === 'WALK_BIKE') {
        const wb = c.item;
        const wbArrMs = targetArriveMs ? targetArriveMs : (refStartMs + wb.totalMins * 60000);
        const wbDepMs = wbArrMs - wb.totalMins * 60000;
        const arrClk = formatHkArrivalClock(wbArrMs);
        const depClk = formatHkArrivalClock(wbDepMs);
        const modeTitle = wb.isBike ? (isZh ? '單車直達' : 'Bike Direct') : (isZh ? '步行前往' : 'Walk Direct');
        const wbFare = Number(wb.fareHkd || 0);
        const wbFareStr = wbFare > 0 ? `~$${wbFare.toFixed(1)}` : '$0';
        const wbBikeNotice = wb.isBike
          ? `<div class="planner-notice-row">🚲 ${isZh ? '含 LocoBike 共享單車約 $5.0/30分鐘（錢包標準價）' : 'Includes LocoBike ~$5.0/30m (standard wallet rate)'}</div>`
          : '';
        const mapUrl = `https://www.google.com/maps/dir/?api=1&origin=${Number(spec.fromMeta.lat).toFixed(6)},${Number(spec.fromMeta.lon).toFixed(6)}&destination=${Number(spec.toMeta.lat).toFixed(6)},${Number(spec.toMeta.lon).toFixed(6)}&travelmode=${wb.isBike ? 'bicycling' : 'walking'}`;
        return `
          <details class="xfer-decision-card ${isWinner ? 'winner' : ''} ${isSelected ? 'selected' : ''}" data-card-key="${c.key}" ${isOpen ? 'open' : ''}>
            <summary class="xfer-card-header" onclick="selectUnifiedPlannerCard('${c.key}', -1)">
              <div class="planner-card-left">
                ${cardTag ? `<div class="xfer-badge-title">${escapeHtml(cardTag)}</div>` : ''}
                <div class="planner-route-chain">${wb.isBike ? '🚲' : '🚶'} <strong>${modeTitle}</strong></div>
                <div class="planner-meta-line">${wb.distM}m · ${depClk} → ${arrClk} · ${escapeHtml(wbFareStr)}</div>
              </div>
              <div class="planner-card-right">
                <div class="planner-dur-big">${wb.totalMins}<span class="planner-dur-unit">${t('minsUnit')}</span></div>
                <div class="planner-fare-sub">${escapeHtml(wbFareStr)}</div>
              </div>
            </summary>
            <div class="xfer-timeline">
              ${wbBikeNotice}
              <div class="planner-step-walk" onclick="event.stopPropagation(); focusPlannerMapLeg(${spec.fromMeta.lat}, ${spec.fromMeta.lon}, ${spec.toMeta.lat}, ${spec.toMeta.lon});">
                <div class="planner-step-rail walk"></div>
                <div class="planner-step-content">
                  <div class="planner-step-main">${modeTitle} (${wb.distM}m) → ${escapeHtml(toDispName)}</div>
                </div>
                <a href="${mapUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="planner-step-link">${isZh ? '導航 ↗' : 'Directions ↗'}</a>
              </div>
            </div>
          </details>`;
      }

      if (c.type === 'DIRECT') {
        const dp = c.item;
        const badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(dp.group) : dp.group.routeNo;
        const parallelHtml = dp.parallelRoutes?.length
          ? `<span class="planner-parallel-alt">/ ${dp.parallelRoutes.map(escapeHtml).join(' / ')}</span>`
          : '';
        const depMs = dp.liveDepMs || (refStartMs + dp.accessWalkSec * 1000);
        const arrMs = dp.liveArrMs || (refStartMs + dp.totalMins * 60000);
        const leaveOriginMs = depMs - dp.accessWalkSec * 1000;
        const displayMins = m.mins;
        const waitMins = (xferTimeMode === 'NOW') ? Math.max(0, Math.round((leaveOriginMs - refStartMs) / 60000)) : 0;

        const arrClk = formatHkArrivalClock(arrMs);
        const depClk = formatHkArrivalClock(depMs);
        const rideMins = Math.max(1, Math.round((dp.driveSec || 180) / 60));
        const walkTotalMins = Math.round(((dp.accessWalkSec || 0) + (dp.egressWalkSec || 0)) / 60);
        const cutoff1 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(dp.group, depMs, isZh) : null;
        const sigText = formatLegSignalTagHtml(dp.sigType1, dp.hw1, false, dp.load1, cutoff1);
        const allNotices = [...(dp.fareNotices || []), ...collectLoadNoticesFromList([dp.load1])];
        const noticesHtml = renderSectionalNoticesHtml(allNotices);

        const metaParts = [
          waitMins >= 1 ? (isZh ? `${waitMins}分鐘後出發` : `Leave in ${waitMins}m`) : (isZh ? '立即出發' : 'Leave now'),
          `${isZh ? '抵達' : 'Arr'} ${arrClk}`,
          walkTotalMins >= 1 ? (isZh ? `步行${walkTotalMins}分` : `${walkTotalMins}m walk`) : null,
          dp.sigType1 === 'LIVE' ? (isZh ? '實時' : 'Live') : null
        ].filter(Boolean).join(' · ');

        const boardDisp = getLegStopDisplayName(dp.group, dp.boardStopObj);
        const alightDisp = getLegStopDisplayName(dp.group, dp.alightStopObj);
        const accessWalkRow = renderWalkTimelineRowHtml(
          dp.accessWalkDistM, dp.accessWalkSec, dp.accessByBike,
          boardDisp,
          spec.fromMeta.lat, spec.fromMeta.lon,
          dp.accessExitObj?.lat || dp.boardStopObj.lat,
          dp.accessExitObj?.lon || dp.boardStopObj.lon,
          dp.accessExitObj,
          'to'
        );
        const egressWalkRow = renderWalkTimelineRowHtml(
          dp.egressWalkDistM, dp.egressWalkSec, dp.egressByBike,
          toDispName,
          dp.egressExitObj?.lat || dp.alightStopObj.lat,
          dp.egressExitObj?.lon || dp.alightStopObj.lon,
          spec.toMeta.lat, spec.toMeta.lon,
          dp.egressExitObj,
          'from'
        );
        const legCol = dp.group.colorHex || '#007AFF';

        const directEgressChip = ((dp.egressWalkDistM || 0) >= 150 || (dp.egressWalkSec || 0) >= 120)
          ? `<span class="planner-chain-sep">›</span><span class="planner-walk-chip">${dp.egressByBike ? '🚲' : '🚶'} ${Math.max(1, Math.round((dp.egressWalkSec || Math.round((dp.egressWalkDistM || 0) / 1.25)) / 60))}${t('minsUnit')}</span>`
          : '';

        return `
          <details class="xfer-decision-card ${isWinner ? 'winner' : ''} ${isSelected ? 'selected' : ''}" data-card-key="${c.key}" ${isOpen ? 'open' : ''}>
            <summary class="xfer-card-header" onclick="selectUnifiedPlannerCard('${c.key}', -1)">
              <div class="planner-card-left">
                ${cardTag ? `<div class="xfer-badge-title">${escapeHtml(cardTag)}</div>` : ''}
                <div class="planner-route-chain">${renderRouteChipHtml(dp.group)}${parallelHtml}${directEgressChip}</div>
                <div class="planner-meta-line">${escapeHtml(metaParts)}</div>
              </div>
              <div class="planner-card-right">
                <div class="planner-dur-big">${displayMins}<span class="planner-dur-unit">${t('minsUnit')}</span></div>
                <div class="planner-fare-sub">${dp.fareHkd > 0 ? `$${dp.fareHkd.toFixed(1)}` : ''}</div>
              </div>
            </summary>
            <div class="xfer-timeline">
              ${noticesHtml}
              ${accessWalkRow}
              <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${dp.boardStopObj.lat}, ${dp.boardStopObj.lon}, ${dp.alightStopObj.lat}, ${dp.alightStopObj.lon}, 0, this);">
                <div class="planner-step-rail" style="background:${escapeHtml(legCol)};"></div>
                <div class="planner-step-content">
                  <div class="planner-step-top">
                    <span class="planner-step-clock">${depClk}</span>
                    <span class="planner-step-main">${escapeHtml(boardDisp)}</span>
                  </div>
                  <div class="planner-step-sub">
                    <strong>${escapeHtml(badge)}</strong> → ${escapeHtml(alightDisp)} · ${rideMins}${t('minsUnit')} (${dp.stopsCount} ${isZh ? '站' : (dp.stopsCount === 1 ? 'stop' : 'stops')})${sigText ? ` · ${sigText}` : ''}
                  </div>
                </div>
                <button type="button" class="planner-live-btn" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(dp.group.key)}', '${escapeJsAttr(dp.boardStopKey)}');">${isZh ? '實時 ›' : 'Live ›'}</button>
              </div>
              ${egressWalkRow}
              <div class="planner-card-actions">
                <button type="button" class="planner-share-btn" onclick="event.stopPropagation(); shareUnifiedPlannerCard('${escapeJsAttr(c.key)}', this);">↗ ${isZh ? '分享行程' : 'Share Trip'}</button>
              </div>
            </div>
          </details>`;
      }

      // XFER card
      const cor = c.item;
      const node = cor.xferStopNodes[0];
      const b1Badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg1Group) : cor.leg1Group.routeNo;
      const b2Badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(cor.leg2Group) : cor.leg2Group.routeNo;
      const l3Chips = (cor.leg3Options || []).map(l3 => renderRouteChipHtml(l3.group, l3.routeNo));
      const xferEgressChip = ((cor.egressWalkDistM || 0) >= 150 || (cor.egressWalkSec || 0) >= 120)
        ? [`<span class="planner-walk-chip">${cor.egressByBike ? '🚲' : '🚶'} ${Math.max(1, Math.round((cor.egressWalkSec || Math.round((cor.egressWalkDistM || 0) / 1.25)) / 60))}${t('minsUnit')}</span>`]
        : [];
      const chainChipsHtml = [renderRouteChipHtml(cor.leg1Group), renderRouteChipHtml(cor.leg2Group), ...l3Chips, ...xferEgressChip]
        .join('<span class="planner-chain-sep">›</span>');

      const xferName = getStopName(node.board2StopObj);
      const dep1Ms = cor.liveDep1Ms || (refStartMs + cor.accessWalkSec * 1000);
      const dep2Ms = cor.liveDep2Ms || (dep1Ms + node.leg1DriveSec * 1000 + 180000);
      const arrMs  = cor.liveArrMs  || (refStartMs + cor.totalMins * 60000);
      const leaveOriginMs = dep1Ms - cor.accessWalkSec * 1000;
      const displayMins = m.mins;
      const waitMins = (xferTimeMode === 'NOW') ? Math.max(0, Math.round((leaveOriginMs - refStartMs) / 60000)) : 0;

      const arrClk = formatHkArrivalClock(arrMs);
      const dep1Clk = formatHkArrivalClock(dep1Ms);
      const dep2Clk = formatHkArrivalClock(dep2Ms);
      const isMultiBus = (cor.leg1Mode === 'BUS' && cor.leg2Mode === 'BUS');
      const fareLabel = cor.fareHkd > 0 ? `${isMultiBus ? '~' : ''}$${cor.fareHkd.toFixed(1)}` : '';
      const xferCount = 1 + (cor.leg3Options?.length || 0);
      const walkTotalMins = Math.round(((cor.accessWalkSec || 0) + (cor.egressWalkSec || 0) + (cor.totalTransferWalkSec || 0)) / 60);
      const anyLive = cor.sigType1 === 'LIVE' || cor.sigType2 === 'LIVE';

      const metaParts = [
        waitMins >= 1 ? (isZh ? `${waitMins}分鐘後出發` : `Leave in ${waitMins}m`) : (isZh ? '立即出發' : 'Leave now'),
        `${isZh ? '抵達' : 'Arr'} ${arrClk}`,
        isZh ? `${xferCount}次轉乘` : `${xferCount} ${xferCount === 1 ? 'transfer' : 'transfers'}`,
        walkTotalMins >= 1 ? (isZh ? `步行${walkTotalMins}分` : `${walkTotalMins}m walk`) : null,
        anyLive ? (isZh ? '實時' : 'Live') : null
      ].filter(Boolean).join(' · ');

      const cutoff1 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(cor.leg1Group, dep1Ms, isZh) : null;
      const cutoff2 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(cor.leg2Group, dep2Ms, isZh) : null;
      const sig1Text = formatLegSignalTagHtml(cor.sigType1, cor.hw1, Boolean(cor.leg1FreeFeeder), cor.load1, cutoff1);
      const sig2Text = formatLegSignalTagHtml(cor.sigType2, cor.hw2, Boolean(cor.leg2FreeFeeder), cor.load2, cutoff2);
      const tight1MinsTxt = cor.tightTransfer1Mins > 0 ? (isZh ? ` ${cor.tightTransfer1Mins}分` : ` ${cor.tightTransfer1Mins}m`) : '';
      const tightText = cor.tightTransfer1 ? ` · <span class="planner-sig-warn">⚠ ${isZh ? '緊湊轉乘' : 'Tight xfer'}${tight1MinsTxt}</span>` : '';

      const allLoadList = [cor.load1, cor.load2, ...(cor.leg3Options || []).map(l3 => l3.loadEstimate)];
      const allNotices = [...(cor.fareNotices || []), ...collectLoadNoticesFromList(allLoadList)];
      const noticesHtml = renderSectionalNoticesHtml(allNotices);

      const board1Disp = getLegStopDisplayName(cor.leg1Group, cor.board1StopObj);
      const alight1Disp = getLegStopDisplayName(cor.leg1Group, node.alight1StopObj);
      const board2Disp = getLegStopDisplayName(cor.leg2Group, node.board2StopObj);
      const accessWalkRow = renderWalkTimelineRowHtml(
        cor.accessWalkDistM, cor.accessWalkSec, cor.accessByBike,
        board1Disp,
        spec.fromMeta.lat, spec.fromMeta.lon,
        cor.accessExitObj?.lat || cor.board1StopObj.lat,
        cor.accessExitObj?.lon || cor.board1StopObj.lon,
        cor.accessExitObj,
        'to'
      );
      const xfer1FromLat = (node.xferExitSide === 'alight' && node.xferExitObj?.lat) ? node.xferExitObj.lat : node.alight1StopObj.lat;
      const xfer1FromLon = (node.xferExitSide === 'alight' && node.xferExitObj?.lon) ? node.xferExitObj.lon : node.alight1StopObj.lon;
      const xfer1ToLat = (node.xferExitSide === 'board' && node.xferExitObj?.lat) ? node.xferExitObj.lat : node.board2StopObj.lat;
      const xfer1ToLon = (node.xferExitSide === 'board' && node.xferExitObj?.lon) ? node.xferExitObj.lon : node.board2StopObj.lon;
      const xfer1WalkRow = (node.walkDistM >= (node.xferExitObj?.ref ? 15 : 55))
        ? renderWalkTimelineRowHtml(
            node.walkDistM, node.walkSec, false, board2Disp,
            xfer1FromLat, xfer1FromLon, xfer1ToLat, xfer1ToLon,
            node.xferExitObj, node.xferExitSide === 'alight' ? 'from' : 'to'
          )
        : '';
      const egressWalkRow = renderWalkTimelineRowHtml(
        cor.egressWalkDistM, cor.egressWalkSec, cor.egressByBike,
        toDispName,
        cor.egressExitObj?.lat || cor.alight2StopObj.lat,
        cor.egressExitObj?.lon || cor.alight2StopObj.lon,
        spec.toMeta.lat, spec.toMeta.lon,
        cor.egressExitObj,
        'from'
      );

      const leg1Col = cor.leg1Group.colorHex || '#007AFF';
      const leg2Col = cor.leg2Group.colorHex || '#007AFF';
      const leg2AlightObj = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
      const leg2AlightDisp = getLegStopDisplayName(cor.leg2Group, leg2AlightObj);
      const leg1Mins = Math.max(1, Math.round((node.leg1DriveSec || 180) / 60));
      const leg2Mins = Math.max(1, Math.round((node.leg2DriveSec || 180) / 60));

      const leg3RowsHtml = (cor.leg3Options || []).map((l3, l3Idx) => {
        const l3Badge = window.getDisplayRouteBadge ? window.getDisplayRouteBadge(l3.group) : l3.routeNo;
        const l3DepMs = l3.liveDepMs || (arrMs - (cor.egressWalkSec + l3.driveSec) * 1000);
        const l3DepClk = formatHkArrivalClock(l3DepMs);
        const cutoff3 = (xferTimeMode === 'NOW') ? getLegServiceCutoffWarning(l3.group, l3DepMs, isZh) : null;
        const sig3Text = formatLegSignalTagHtml(l3.sigType, l3.hwMins, Boolean(l3.isFreeMtrFeeder), l3.loadEstimate, cutoff3);
        const l3TightMinsTxt = l3.tightTransferMins > 0 ? (isZh ? ` ${l3.tightTransferMins}分` : ` ${l3.tightTransferMins}m`) : '';
        const l3TightText = l3.tightTransfer ? ` · <span class="planner-sig-warn">⚠ ${isZh ? '緊湊轉乘' : 'Tight xfer'}${l3TightMinsTxt}</span>` : '';
        const l3Mins = Math.max(1, Math.round((l3.driveSec || 180) / 60));
        const l3Col = l3.group?.colorHex || '#007AFF';
        const l3BoardDisp = getLegStopDisplayName(l3.group, l3.boardStopObj);
        const l3AlightDisp = getLegStopDisplayName(l3.group, l3.alightStopObj);
        const l3FromLat = (l3.xferExitSide === 'alight' && l3.xferExitObj?.lat) ? l3.xferExitObj.lat : l3.prevAlightStopObj?.lat;
        const l3FromLon = (l3.xferExitSide === 'alight' && l3.xferExitObj?.lon) ? l3.xferExitObj.lon : l3.prevAlightStopObj?.lon;
        const l3ToLat = (l3.xferExitSide === 'board' && l3.xferExitObj?.lat) ? l3.xferExitObj.lat : l3.boardStopObj.lat;
        const l3ToLon = (l3.xferExitSide === 'board' && l3.xferExitObj?.lon) ? l3.xferExitObj.lon : l3.boardStopObj.lon;
        const l3WalkRow = (l3.walkDistM >= (l3.xferExitObj?.ref ? 15 : 55))
          ? renderWalkTimelineRowHtml(
              l3.walkDistM, l3.walkSec, false, l3BoardDisp,
              l3FromLat, l3FromLon, l3ToLat, l3ToLon,
              l3.xferExitObj, l3.xferExitSide === 'alight' ? 'from' : 'to'
            )
          : '';
        return `${l3WalkRow}
          <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${l3.boardStopObj.lat}, ${l3.boardStopObj.lon}, ${l3.alightStopObj.lat}, ${l3.alightStopObj.lon}, ${2 + l3Idx}, this);">
            <div class="planner-step-rail" style="background:${escapeHtml(l3Col)};"></div>
            <div class="planner-step-content">
              <div class="planner-step-top">
                <span class="planner-step-clock">${l3DepClk}</span>
                <span class="planner-step-main">${escapeHtml(l3BoardDisp)}</span>
              </div>
              <div class="planner-step-sub">
                <strong>${escapeHtml(l3Badge)}</strong> → ${escapeHtml(l3AlightDisp)} · ${l3Mins}${t('minsUnit')}${sig3Text ? ` · ${sig3Text}` : ''}${l3TightText}
              </div>
            </div>
            <button type="button" class="planner-live-btn" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(l3.group.key)}', '${escapeJsAttr(l3.boardStopKey)}');">${isZh ? '實時 ›' : 'Live ›'}</button>
          </div>`;
      }).join('');

      return `
        <details class="xfer-decision-card ${isWinner ? 'winner' : ''} ${isSelected ? 'selected' : ''}" data-card-key="${c.key}" ${isOpen ? 'open' : ''}>
          <summary class="xfer-card-header" onclick="selectUnifiedPlannerCard('${c.key}', ${c.idx})">
            <div class="planner-card-left">
              ${cardTag ? `<div class="xfer-badge-title">${escapeHtml(cardTag)}</div>` : ''}
              <div class="planner-route-chain">${chainChipsHtml}</div>
              <div class="planner-meta-line">${escapeHtml(metaParts)}</div>
            </div>
            <div class="planner-card-right">
              <div class="planner-dur-big">${displayMins}<span class="planner-dur-unit">${t('minsUnit')}</span></div>
              <div class="planner-fare-sub">${escapeHtml(fareLabel)}</div>
            </div>
          </summary>
          <div class="xfer-timeline">
            ${noticesHtml}
            ${accessWalkRow}
            <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${cor.board1StopObj.lat}, ${cor.board1StopObj.lon}, ${node.alight1StopObj.lat}, ${node.alight1StopObj.lon}, 0, this);">
              <div class="planner-step-rail" style="background:${escapeHtml(leg1Col)};"></div>
              <div class="planner-step-content">
                <div class="planner-step-top">
                  <span class="planner-step-clock">${dep1Clk}</span>
                  <span class="planner-step-main">${escapeHtml(board1Disp)}</span>
                </div>
                <div class="planner-step-sub">
                  <strong>${escapeHtml(b1Badge)}</strong> → ${escapeHtml(alight1Disp)} · ${leg1Mins}${t('minsUnit')}${sig1Text ? ` · ${sig1Text}` : ''}
                </div>
              </div>
              <button type="button" class="planner-live-btn" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(cor.leg1Group.key)}', '${escapeJsAttr(cor.board1StopKey)}');">${isZh ? '實時 ›' : 'Live ›'}</button>
            </div>
            ${xfer1WalkRow}
            <div class="planner-step-transit" onclick="event.stopPropagation(); focusPlannerMapLeg(${node.board2StopObj.lat}, ${node.board2StopObj.lon}, ${leg2AlightObj.lat}, ${leg2AlightObj.lon}, 1, this);">
              <div class="planner-step-rail" style="background:${escapeHtml(leg2Col)};"></div>
              <div class="planner-step-content">
                <div class="planner-step-top">
                  <span class="planner-step-clock">${dep2Clk}</span>
                  <span class="planner-step-main">${escapeHtml(board2Disp)}</span>
                </div>
                <div class="planner-step-sub">
                  <strong>${escapeHtml(b2Badge)}</strong> → ${escapeHtml(leg2AlightDisp)} · ${leg2Mins}${t('minsUnit')}${sig2Text ? ` · ${sig2Text}` : ''}${tightText}
                </div>
              </div>
              <button type="button" class="planner-live-btn" onclick="event.stopPropagation(); openRouteDetail('${escapeJsAttr(cor.leg2Group.key)}', '${escapeJsAttr(node.board2StopKey)}');">${isZh ? '實時 ›' : 'Live ›'}</button>
            </div>
            ${leg3RowsHtml}
            ${egressWalkRow}
            <div class="planner-card-actions">
              <button type="button" class="planner-share-btn" onclick="event.stopPropagation(); shareUnifiedPlannerCard('${escapeJsAttr(c.key)}', this);">↗ ${isZh ? '分享行程' : 'Share Trip'}</button>
            </div>
          </div>
        </details>`;
    }).join('') + renderMtrStyleReportFooterHtml();

    const activeCard = topCards.find(c => c.key === activeUnifiedCardKey) || topCards[0];
    if (activeCard) drawTransferCorridorOnMap(spec, activeCard);
    syncPlannerAlertBannerUI(activeCard || null);
  };

  paintUnifiedCards(false);

  const fleetCheckCache = new Map();
  let prunedGhosts = 0;

  const syncNlbStopFareOnLeg = async (group, stopObj) => {
    if (group?.company !== 'NLB' || !stopObj) return false;
    const updated = await ensureNlbHolidayFaresLoaded(group);
    const liveSt = getStopsForGroup(group).find(s =>
      s.stopId === stopObj.stopId ||
      getBaseStopNameKey(s.stopName_e) === getBaseStopNameKey(stopObj.stopName_e)
    );
    if (liveSt?.fareHol) stopObj.fareHol = liveSt.fareHol;
    if (liveSt?.fare) stopObj.fare = liveSt.fare;
    if (updated) _raptorGraph = null;
    return Boolean(updated || liveSt?.fareHol);
  };

  await Promise.all([
    ...spec.directRoutes.map(async (dp) => {
      if (dp.group.company === 'NLB') {
        await syncNlbStopFareOnLeg(dp.group, dp.boardStopObj);
      }
      const minValidStartMs = Date.now();
      let candStartMs = targetArriveMs
        ? Math.max(minValidStartMs, targetArriveMs - (dp.totalMins + 4) * 60000)
        : refStartMs;

      let w1 = await resolveLiveOrStaticLegWindow(dp.group, dp.boardStopKey, candStartMs + dp.accessWalkSec * 1000, dp.driveSec, dp.boardStopObj, true, dp.alightStopObj);
      if (w1.isDeadGhost) {
        dp.isDeadGhost = true;
        prunedGhosts++;
        return;
      }

      for (let pass = 0; targetArriveMs && pass < 2; pass++) {
        const estArrMs = w1.arrMs + dp.egressWalkSec * 1000;
        if (estArrMs <= targetArriveMs + 180000 || candStartMs <= minValidStartMs) break;
        const overshootMs = estArrMs - targetArriveMs;
        const stepBackMs = getPeriodHeadwaySecs(dp.group, candStartMs) * 1000;
        const nextStartMs = Math.max(minValidStartMs, candStartMs - Math.max(stepBackMs, overshootMs + 180000));
        if (nextStartMs === candStartMs) break;
        candStartMs = nextStartMs;
        w1 = await resolveLiveOrStaticLegWindow(dp.group, dp.boardStopKey, candStartMs + dp.accessWalkSec * 1000, dp.driveSec, dp.boardStopObj, true, dp.alightStopObj);
      }

      dp.sigType1 = w1.signalType;
      dp.hw1 = w1.headwayMins || 0;
      dp.load1 = w1.loadEstimate || dp.load1;
      const fareMeta = {};
      const legSpec = {
        group: dp.group,
        boardStopObj: dp.boardStopObj,
        alightStopObj: dp.alightStopObj,
        driveSec: dp.driveSec,
        stopsCount: dp.stopsCount,
        vesselClass: w1.vesselClass,
        loadEstimate: dp.load1
      };
      const directBikeSpec = (dp.accessByBike || dp.egressByBike)
        ? { accessByBike: dp.accessByBike, accessWalkDistM: dp.accessWalkDistM, egressByBike: dp.egressByBike, egressWalkDistM: dp.egressWalkDistM }
        : null;
      dp.fareHkd = computeLegChainFareHkd([legSpec], isHolQuery, fareMeta, spec.fromMeta.lat, spec.fromMeta.lon, directBikeSpec);
      dp.fareNotices = fareMeta.notices || [];
      dp.liveDepMs = w1.depMs;
      dp.liveArrMs = w1.arrMs + dp.egressWalkSec * 1000;
      const rankOriginMs = (xferTimeMode === 'NOW') ? refStartMs : (w1.depMs - dp.accessWalkSec * 1000);
      dp.totalMins = Math.max(2, Math.round((dp.liveArrMs - rankOriginMs) / 60000));
      dp.disruptionScore = computeDisruptionAdjustedScore(
        dp.totalMins,
        [legSpec],
        dp.accessWalkSec,
        dp.egressWalkSec,
        [],
        dp.fareHkd,
        [],
        0,
        { queryDate: queryDateObj, isLantauTrip: spec.isLantauTrip, fromMeta: spec.fromMeta, toMeta: spec.toMeta, egressByBike: dp.egressByBike, egressWalkDistM: dp.egressWalkDistM }
      );
    }),
    ...spec.transferCorridors.map(async (cor) => {
      const node = cor.xferStopNodes[0];
      await Promise.all([
        syncNlbStopFareOnLeg(cor.leg1Group, cor.board1StopObj),
        syncNlbStopFareOnLeg(cor.leg2Group, node.board2StopObj),
        ...(cor.leg3Options || []).map(l3 => syncNlbStopFareOnLeg(l3.group, l3.boardStopObj))
      ]);

      if (xferTimeMode === 'NOW') {
        const downstreamChecks = [
          checkDownstreamBusRouteHasLiveFleet(cor.leg2Group, node.board2StopObj, fleetCheckCache),
          ...(cor.leg3Options || []).map(l3 => checkDownstreamBusRouteHasLiveFleet(l3.group, l3.boardStopObj, fleetCheckCache))
        ];
        const aliveFlags = await Promise.all(downstreamChecks);
        if (aliveFlags.some(isAlive => !isAlive)) {
          cor.isDeadGhost = true;
          prunedGhosts++;
          return;
        }
      }

      const solveCorridorFrom = async (startMs) => {
        const w1 = await resolveLiveOrStaticLegWindow(cor.leg1Group, cor.board1StopKey, startMs + cor.accessWalkSec * 1000, node.leg1DriveSec, cor.board1StopObj, true, node.alight1StopObj);
        if (w1.isDeadGhost) return { w1, isDeadGhost: true };
        const xfer1BufSec = getInterchangeTransferSec(
          cor.leg1Group, cor.leg2Group,
          { mtrCode: cor.xferMtrCodes?.[0] || '', isGoldenHub: isStrategicInterchangeHub(node.board2StopObj) },
          node.walkSec || 0
        );
        const leg2AlightObj = cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj;
        const w2 = await resolveLiveOrStaticLegWindow(cor.leg2Group, node.board2StopKey, w1.arrMs + xfer1BufSec * 1000, node.leg2DriveSec, node.board2StopObj, false, leg2AlightObj);
        let curArrMs = w2.arrMs;
        const w3List = [];
        for (let lIdx = 0; lIdx < (cor.leg3Options || []).length; lIdx++) {
          const l3 = cor.leg3Options[lIdx];
          const prevG = lIdx === 0 ? cor.leg2Group : cor.leg3Options[lIdx - 1].group;
          const l3BufSec = getInterchangeTransferSec(
            prevG, l3.group,
            { mtrCode: cor.xferMtrCodes?.[lIdx + 1] || '', isGoldenHub: isStrategicInterchangeHub(l3.boardStopObj) },
            l3.walkSec || 0
          );
          const w3 = await resolveLiveOrStaticLegWindow(l3.group, l3.boardStopKey, curArrMs + l3BufSec * 1000, l3.driveSec, l3.boardStopObj, false, l3.alightStopObj);
          w3List.push(w3);
          curArrMs = w3.arrMs;
        }
        return { w1, w2, w3List, finalArrMs: curArrMs + cor.egressWalkSec * 1000, isDeadGhost: false };
      };

      const minValidStartMs = Date.now();
      let candStartMs = targetArriveMs
        ? Math.max(minValidStartMs, targetArriveMs - (cor.totalMins + 6) * 60000)
        : refStartMs;

      let solved = await solveCorridorFrom(candStartMs);
      if (solved.isDeadGhost) {
        cor.isDeadGhost = true;
        prunedGhosts++;
        return;
      }

      for (let pass = 0; targetArriveMs && pass < 2; pass++) {
        if (solved.finalArrMs <= targetArriveMs + 180000 || candStartMs <= minValidStartMs) break;
        const overshootMs = solved.finalArrMs - targetArriveMs;
        const nextStartMs = Math.max(minValidStartMs, candStartMs - (overshootMs + 300000));
        if (nextStartMs === candStartMs) break;
        candStartMs = nextStartMs;
        solved = await solveCorridorFrom(candStartMs);
        if (solved.isDeadGhost) {
          cor.isDeadGhost = true;
          prunedGhosts++;
          return;
        }
      }

      const { w1, w2, w3List, finalArrMs } = solved;

      cor.load1 = w1.loadEstimate || cor.load1;
      cor.load2 = w2.loadEstimate || cor.load2;

      const allLegs = [
        { group: cor.leg1Group, boardStopObj: cor.board1StopObj, alightStopObj: node.alight1StopObj, driveSec: node.leg1DriveSec, walkAfterSec: node.walkSec || 0, stopsCount: node.leg1StopsCount, vesselClass: w1.vesselClass, loadEstimate: cor.load1 },
        { group: cor.leg2Group, boardStopObj: node.board2StopObj, alightStopObj: cor.leg3Options?.length ? cor.leg3Options[0].prevAlightStopObj : cor.alight2StopObj, driveSec: node.leg2DriveSec, stopsCount: node.leg2StopsCount, vesselClass: w2.vesselClass, loadEstimate: cor.load2 }
      ];
      let prevLegArrMs = w2.arrMs;
      (cor.leg3Options || []).forEach((l3, idx) => {
        const w3 = w3List[idx];
        l3.liveDepMs = w3.depMs;
        l3.liveArrMs = w3.arrMs;
        l3.sigType = w3.signalType;
        l3.hwMins = w3.headwayMins || 0;
        l3.loadEstimate = w3.loadEstimate || l3.loadEstimate;
        const prevG = idx === 0 ? cor.leg2Group : cor.leg3Options[idx - 1].group;
        const isRailToRail = prevG?.mode === 'MTR' && prevG?.company === 'MTR' && l3.group?.mode === 'MTR' && l3.group?.company === 'MTR';
        const l3SlackMs = w3.depMs - prevLegArrMs - (Number(l3.walkSec) || 0) * 1000;
        l3.tightTransfer = !isRailToRail && l3SlackMs < 240000;
        l3.tightTransferMins = Math.max(1, Math.round(Math.max(0, l3SlackMs) / 60000));
        prevLegArrMs = w3.arrMs;
        allLegs.push({ group: l3.group, boardStopObj: l3.boardStopObj, alightStopObj: l3.alightStopObj, driveSec: l3.driveSec, walkAfterSec: l3.walkSec || 0, stopsCount: l3.stopsCount, vesselClass: w3.vesselClass, loadEstimate: l3.loadEstimate, _l3Ref: l3 });
      });

      const fareMeta = {};
      const corBikeSpec = (cor.accessByBike || cor.egressByBike)
        ? { accessByBike: cor.accessByBike, accessWalkDistM: cor.accessWalkDistM, egressByBike: cor.egressByBike, egressWalkDistM: cor.egressWalkDistM }
        : null;
      cor.fareHkd = computeLegChainFareHkd(allLegs, isHolQuery, fareMeta, spec.fromMeta.lat, spec.fromMeta.lon, corBikeSpec);
      cor.fareNotices = fareMeta.notices || [];
      cor.leg1FreeFeeder = Boolean(allLegs[0]?.isFreeMtrFeeder);
      cor.leg2FreeFeeder = Boolean(allLegs[1]?.isFreeMtrFeeder);
      allLegs.slice(2).forEach(al => {
        if (al._l3Ref) al._l3Ref.isFreeMtrFeeder = Boolean(al.isFreeMtrFeeder);
      });

      cor.sigType1 = w1.signalType;
      cor.hw1 = w1.headwayMins || 0;
      cor.sigType2 = w2.signalType;
      cor.hw2 = w2.headwayMins || 0;
      const isLeg12RailToRail = cor.leg1Group?.mode === 'MTR' && cor.leg1Group?.company === 'MTR' && cor.leg2Group?.mode === 'MTR' && cor.leg2Group?.company === 'MTR';
      const xfer1SlackMs = w2.depMs - w1.arrMs - (Number(node.walkSec) || 0) * 1000;
      cor.tightTransfer1 = !isLeg12RailToRail && xfer1SlackMs < 240000;
      cor.tightTransfer1Mins = Math.max(1, Math.round(Math.max(0, xfer1SlackMs) / 60000));
      cor.liveDep1Ms = w1.depMs;
      cor.liveDep2Ms = w2.depMs;
      cor.liveArrMs = finalArrMs;

      const rankOriginMs = (xferTimeMode === 'NOW') ? refStartMs : (w1.depMs - cor.accessWalkSec * 1000);
      cor.totalMins = Math.max(4, Math.round((cor.liveArrMs - rankOriginMs) / 60000));
      cor.disruptionScore = computeDisruptionAdjustedScore(
        cor.totalMins,
        allLegs,
        cor.accessWalkSec,
        cor.egressWalkSec,
        cor.xferMtrCodes,
        cor.fareHkd,
        cor.xferStopObjs,
        cor.totalTransferWalkSec || 0,
        { queryDate: queryDateObj, isLantauTrip: spec.isLantauTrip, fromMeta: spec.fromMeta, toMeta: spec.toMeta, egressByBike: cor.egressByBike, egressWalkDistM: cor.egressWalkDistM }
      );
    })
  ]);

  if (myToken !== xferRenderToken || currentView !== 'xfer') return;

  paintUnifiedCards(true);
}
