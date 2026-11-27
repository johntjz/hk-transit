// ============================================================================
// File: commute-hubs.js (johntjz/Hk-Fleet — Smart Return, Saved Hubs & Hub Picker Helpers)
// ============================================================================

var userCommuteProfile = (typeof userCommuteProfile !== 'undefined') ? userCommuteProfile : { home: null, work: null };
try {
  const savedCommute = JSON.parse(localStorage.getItem('transit_commute_profile_v1') || 'null');
  if (savedCommute && typeof savedCommute === 'object') userCommuteProfile = savedCommute;
} catch (e) {}

var activeCommutePickerSlot = (typeof activeCommutePickerSlot !== 'undefined') ? activeCommutePickerSlot : 'home'; // 'home' | 'work' | 'hub_home' | 'hub_work'
var alsAddressSearchResults = (typeof alsAddressSearchResults !== 'undefined') ? alsAddressSearchResults : [];
var alsSearchDebounceTimer = (typeof alsSearchDebounceTimer !== 'undefined') ? alsSearchDebounceTimer : null;
var alsReqSeq = (typeof alsReqSeq !== 'undefined') ? alsReqSeq : 0;

var recentCommutePlaces = (typeof recentCommutePlaces !== 'undefined') ? recentCommutePlaces : [];
try {
  const savedRecPlaces = JSON.parse(localStorage.getItem('transit_recent_commute_places_v1') || '[]');
  if (Array.isArray(savedRecPlaces)) recentCommutePlaces = savedRecPlaces;
} catch (e) { recentCommutePlaces = []; }

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
  historyStorageKey: 'transit_return_trip_history_v1',
  prefStorageKey: 'transit_quick_return_pref_v1',
  MIN_REPEAT_TRIPS: 3,
  TIME_WINDOW_MINS: 120,
  DEDUP_SESSION_MS: 30 * 60000,
  MAX_WAIT_WITH_IMMINENT_LOCAL_MINS: 20,
  IMMINENT_LOCAL_THRESHOLD_MINS: 5,
  ACTIVE_GROUP_DIST_TOLERANCE_M: 15,
  dismissedTs: 0,

  _getHkMinuteOfDay(tsMs = Date.now()) {
    const d = new Date(Number(tsMs) + 8 * 3600000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  },

  _circularMinuteDiff(minA, minB) {
    const diff = Math.abs(Number(minA) - Number(minB)) % 1440;
    return Math.min(diff, 1440 - diff);
  },

  _getBookmarkedStops() {
    try {
      if (typeof bookmarkedStops !== 'undefined' && Array.isArray(bookmarkedStops)) {
        return bookmarkedStops;
      }
    } catch (e) {}
    try {
      const raw = SafeStorage.getItem('transit_stop_bookmarks_v1');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  },

  hasSavedHomeAnchor() {
    try {
      if (typeof SavedHubsManager !== 'undefined' && SavedHubsManager.getHubs) {
        const hubs = SavedHubsManager.getHubs();
        if (hubs && hubs.home && hubs.home.stopKey) return true;
      }
    } catch (e) {}
    return false;
  },

  getPref() {
    try {
      const v = String(SafeStorage.getItem(this.prefStorageKey) || '').trim().toLowerCase();
      if (v === 'on' || v === 'off') return v;
    } catch (e) {}
    return '';
  },

  isEnabled() {
    const pref = this.getPref();
    if (pref === 'off') return false;
    if (pref === 'on') return true;
    // Clean Plate Default: OFF unless a Home stop/route is explicitly saved
    return this.hasSavedHomeAnchor();
  },

  setEnabled(enabled) {
    SafeStorage.setItem(this.prefStorageKey, enabled ? 'on' : 'off');
    return Boolean(enabled);
  },

  getTripHistory(nowMs = Date.now()) {
    try {
      const raw = SafeStorage.getItem(this.historyStorageKey);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const cutoff = nowMs - 90 * 24 * 3600000;
      return arr.filter(e => e && e.groupKey && Number(e.timestamp) >= cutoff && Number(e.timestamp) <= nowMs + 60000);
    } catch (e) {
      return [];
    }
  },

  recordInboundTrip(group, boardStop, stopsList = [], nowMs = Date.now()) {
    if (!group || !boardStop) return;
    const bLat = parseFloat(boardStop.lat ?? boardStop.latitude);
    const bLon = parseFloat(boardStop.lon ?? boardStop.longitude);
    if (!isValidRailOrFerryCoord(bLat, bLon)) return;

    const stops = (Array.isArray(stopsList) && stopsList.length) ? stopsList : getStopsForGroup(group, boardStop.stopKey);
    const destStop = stops.length ? stops[stops.length - 1] : null;
    const dLat = parseFloat(destStop?.lat ?? destStop?.latitude ?? bLat);
    const dLon = parseFloat(destStop?.lon ?? destStop?.longitude ?? bLon);
    const ts = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const bound = extractRouteBoundCode(group);

    const trip = {
      routeNo: String(group.routeNo || ''),
      company: String(group.company || ''),
      mode: String(group.mode || 'BUS'),
      groupKey: String(group.key || ''),
      bound,
      originStopKey: boardStop.stopKey || getGlobalStopKey(boardStop),
      originNameEn: stripPlatformCodeFromDisplay(boardStop.stopName_e || ''),
      originNameTc: stripPlatformCodeFromDisplay(boardStop.name_tc || boardStop.stopName_e || ''),
      originLat: Number(bLat.toFixed(6)),
      originLon: Number(bLon.toFixed(6)),
      destNameEn: stripPlatformCodeFromDisplay(destStop?.stopName_e || group.dest_e || ''),
      destNameTc: stripPlatformCodeFromDisplay(destStop?.name_tc || group.dest_tc || group.dest_e || ''),
      destLat: Number(dLat.toFixed(6)),
      destLon: Number(dLon.toFixed(6)),
      timestamp: ts
    };
    SafeStorage.setItem(this.storageKey, JSON.stringify(trip));

    // Append to repeat-trip history (deduplicated within 30 mins per route direction so a single session never counts multiple times)
    try {
      const history = this.getTripHistory(ts);
      const recentSame = history.find(e =>
        e.groupKey === trip.groupKey && Math.abs(ts - Number(e.timestamp)) < this.DEDUP_SESSION_MS
      );
      if (!recentSame) {
        history.push({
          groupKey: trip.groupKey,
          routeNo: trip.routeNo,
          company: trip.company,
          mode: trip.mode,
          bound: trip.bound,
          originStopKey: trip.originStopKey,
          timestamp: ts,
          hkMinuteOfDay: this._getHkMinuteOfDay(ts)
        });
        SafeStorage.setItem(this.historyStorageKey, JSON.stringify(history.slice(-80)));
      }
    } catch (e) {}
  },

  countTripsInTimeWindow(returnGroup, nowMs = Date.now(), windowMins = this.TIME_WINDOW_MINS) {
    if (!returnGroup) return 0;
    const targetKey = String(returnGroup.key || '');
    const targetRouteNo = String(returnGroup.routeNo || '');
    const targetCompany = String(returnGroup.company || '');
    const targetMode = String(returnGroup.mode || 'BUS');
    const targetBound = extractRouteBoundCode(returnGroup);
    const nowMin = this._getHkMinuteOfDay(nowMs);
    const history = this.getTripHistory(nowMs);

    return history.filter(e => {
      const routeMatch = (targetKey && e.groupKey === targetKey) || (
        e.routeNo === targetRouteNo &&
        e.company === targetCompany &&
        (e.mode || 'BUS') === targetMode &&
        e.bound === targetBound
      );
      if (!routeMatch) return false;
      const entryMin = Number.isFinite(Number(e.hkMinuteOfDay))
        ? Number(e.hkMinuteOfDay)
        : this._getHkMinuteOfDay(e.timestamp);
      return this._circularMinuteDiff(nowMin, entryMin) <= windowMins;
    }).length;
  },

  matchesExplicitHomeAnchor(trip, returnGroup, returnStops = []) {
    if (!returnGroup) return false;
    // 1. Pinned Home stop via SavedHubsManager that this return trip actually serves
    try {
      const hubs = (typeof SavedHubsManager !== 'undefined' && SavedHubsManager.getHubs)
        ? SavedHubsManager.getHubs()
        : null;
      const home = hubs?.home || null;
      if (home && home.stopKey) {
        if (trip && trip.originStopKey === home.stopKey) return true;
        if (trip && isValidRailOrFerryCoord(home.lat, home.lon) && isValidRailOrFerryCoord(trip.originLat, trip.originLon)) {
          if (calculateDistanceKm(trip.originLat, trip.originLon, home.lat, home.lon) <= 0.65) return true;
        }
        const homeBase = home.nameEn ? getBaseStopNameKey(home.nameEn) : '';
        if (Array.isArray(returnStops) && returnStops.length) {
          const servesHome = returnStops.some(s => {
            if (!s) return false;
            const sk = s.stopKey || getGlobalStopKey(s);
            if (sk === home.stopKey) return true;
            if (homeBase && s.stopName_e && getBaseStopNameKey(s.stopName_e) === homeBase) return true;
            const sLat = parseFloat(s.latitude ?? s.lat), sLon = parseFloat(s.longitude ?? s.lon);
            if (isValidRailOrFerryCoord(sLat, sLon) && isValidRailOrFerryCoord(home.lat, home.lon)) {
              return calculateDistanceKm(sLat, sLon, home.lat, home.lon) <= 0.65;
            }
            return false;
          });
          if (servesHome) return true;
        }
      }
    } catch (e) {}

    // 2. Explicitly bookmarked exact return route
    const bookmarks = this._getBookmarkedStops();
    if (bookmarks.some(bm => bm && bm.groupKey && bm.groupKey === returnGroup.key)) {
      return true;
    }
    return false;
  },

  isBoardingStopFartherThanActiveGroup(returnStop, userPos, activeStopContext) {
    if (!activeStopContext || !returnStop || !userPos) return false;
    const bLat = parseFloat(returnStop.latitude ?? returnStop.lat);
    const bLon = parseFloat(returnStop.longitude ?? returnStop.lon);
    if (!isValidRailOrFerryCoord(bLat, bLon)) return false;
    const boardDistM = calculateDistanceKm(userPos.lat, userPos.lon, bLat, bLon) * 1000;

    let activeAnchorDistM = Number.isFinite(Number(activeStopContext.activeGroupDistM))
      ? Number(activeStopContext.activeGroupDistM)
      : NaN;
    const anchorStop = activeStopContext.centerStop || null;
    if (!Number.isFinite(activeAnchorDistM) && anchorStop) {
      const aLat = parseFloat(anchorStop.latitude ?? anchorStop.lat);
      const aLon = parseFloat(anchorStop.longitude ?? anchorStop.lon);
      if (isValidRailOrFerryCoord(aLat, aLon)) {
        activeAnchorDistM = calculateDistanceKm(userPos.lat, userPos.lon, aLat, aLon) * 1000;
      }
    }
    if (!Number.isFinite(activeAnchorDistM)) return false;

    // Allow if the boarding stop is the exact same stop / stop base name as the user's primary active stop (within bay-pole jitter)
    if (anchorStop) {
      const rKey = returnStop.stopKey || getGlobalStopKey(returnStop);
      const aKey = anchorStop.stopKey || getGlobalStopKey(anchorStop);
      const sameStop = (rKey && aKey && rKey === aKey) ||
        (returnStop.stopName_e && anchorStop.stopName_e && getBaseStopNameKey(returnStop.stopName_e) === getBaseStopNameKey(anchorStop.stopName_e));
      if (sameStop && boardDistM <= activeAnchorDistM + 25) return false;
    }

    return boardDistM > (activeAnchorDistM + this.ACTIVE_GROUP_DIST_TOLERANCE_M);
  },

  shouldSuppressByWaitTime(srFirstArrival, nearbyArrivals = [], srRawDistM = null, nowMs = Date.now()) {
    if (!srFirstArrival || !Number.isFinite(Number(srFirstArrival.targetMs))) {
      return { suppress: false, reason: 'NO_SR_ETA', srWaitMins: null };
    }
    const srWaitMins = (Number(srFirstArrival.targetMs) - nowMs) / 60000;
    if (srWaitMins <= this.MAX_WAIT_WITH_IMMINENT_LOCAL_MINS) {
      return { suppress: false, reason: 'WITHIN_20M', srWaitMins };
    }

    const srKey = srFirstArrival.groupKey || '';
    const hasImminentCloserRoute = (nearbyArrivals || []).some(item => {
      if (!item || !Number.isFinite(Number(item.targetMs))) return false;
      if (srKey && item.groupKey === srKey) return false;
      const waitMins = (Number(item.targetMs) - nowMs) / 60000;
      if (waitMins < -1 || waitMins > this.IMMINENT_LOCAL_THRESHOLD_MINS) return false;
      if (Number.isFinite(Number(item.distM)) && Number.isFinite(Number(srRawDistM))) {
        return Number(item.distM) <= Number(srRawDistM) + this.ACTIVE_GROUP_DIST_TOLERANCE_M;
      }
      return true;
    });

    if (hasImminentCloserRoute) {
      return { suppress: true, reason: 'WAIT_OVER_20M_WITH_IMMINENT_LOCAL', srWaitMins };
    }
    return { suppress: false, reason: 'NO_IMMINENT_LOCAL_ALTERNATIVE', srWaitMins };
  },

  getLastTrip(nowMs = Date.now()) {
    try {
      const raw = SafeStorage.getItem(this.storageKey);
      if (!raw) return null;
      const trip = JSON.parse(raw);
      if (!trip || !trip.timestamp || !trip.routeNo) return null;
      const ageMs = nowMs - Number(trip.timestamp);
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

  evaluateCandidate(userPos, activeStopContext = null, nowMs = Date.now()) {
    if (!this.isEnabled()) return null;
    if (!userPos || !userPos.hasLiveFix || Number(userPos.acc) > 450) return null;
    const trip = this.getLastTrip(nowMs);
    if (!trip || trip.timestamp === this.dismissedTs) return null;

    const elapsedMs = nowMs - trip.timestamp;
    if (elapsedMs < 45 * 60000 || elapsedMs > 12 * 3600000) return null;

    const distFromOriginKm = calculateDistanceKm(userPos.lat, userPos.lon, trip.originLat, trip.originLon);
    const distFromDestKm   = calculateDistanceKm(userPos.lat, userPos.lon, trip.destLat, trip.destLon);

    if (distFromOriginKm < 0.70) return null;
    if (distFromDestKm > 1.20 && distFromOriginKm < 1.20) return null;

    const curTripGroup = groupedRoutes.find(g => g.key === trip.groupKey) || {
      key: trip.groupKey,
      routeNo: trip.routeNo,
      company: trip.company,
      mode: trip.mode,
      routeIds: trip.bound === 'I' ? ['_I'] : []
    };
    let returnGroup = null;
    if (typeof findOppositeDirectionGroup === 'function') {
      returnGroup = findOppositeDirectionGroup(curTripGroup, groupedRoutes);
    } else {
      const oppGroups = groupedRoutes.filter(g =>
        g.routeNo === trip.routeNo &&
        g.company === trip.company &&
        (g.mode || 'BUS') === trip.mode &&
        g.key !== trip.groupKey &&
        extractRouteBoundCode(g) !== trip.bound
      );
      returnGroup = oppGroups.find(g => /_1$/.test(g.routeIds?.[0] || '')) || oppGroups[0];
    }
    if (!returnGroup) return null;

    const rStops = getStopsForGroup(returnGroup);
    if (rStops.length < 2) return null;

    // High-Confidence Gate: require explicit Home stop/route anchor OR 3+ repeat trips on this exact return route in similar time window
    const isHomeAnchored = this.matchesExplicitHomeAnchor(trip, returnGroup, rStops);
    const repeatTripCount = this.countTripsInTimeWindow(returnGroup, nowMs, this.TIME_WINDOW_MINS);
    if (!isHomeAnchored && repeatTripCount < this.MIN_REPEAT_TRIPS) return null;

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

    // Distance Guardrail: suppress if boarding stop is farther away than the user's active stop group
    if (this.isBoardingStopFartherThanActiveGroup(bestStop, userPos, activeStopContext)) {
      return null;
    }

    const rawDistM = Math.round(bestDistKm * 1000);
    const walkDistM = Math.max(20, Math.round(bestDistKm * 1000 * 1.18));
    const walkMins = Math.max(1, Math.round(walkDistM / 75));
    return {
      trip,
      returnGroup,
      returnStop: bestStop,
      returnStopIdx: bestIdx,
      returnStopKey: bestStop.stopKey || getGlobalStopKey(bestStop),
      rawDistM,
      walkDistM,
      walkMins,
      confidenceReason: isHomeAnchored ? 'HOME_ANCHOR' : 'REPEAT_HISTORY',
      repeatTripCount
    };
  }
};

const SavedHubsManager = {
  storageKey: 'transit_saved_hubs_v1',
  cookieName: 'transit_hw_hubs_v1',
  manualOverrideMode: 'AUTO', // 'AUTO' | 'HOME' | 'WORK' | 'NEARBY'

  _readHubsCookie() {
    try {
      if (typeof document === 'undefined' || !document.cookie) return null;
      const prefix = `${this.cookieName}=`;
      const hit = String(document.cookie).split(';').map(c => c.trim()).find(c => c.startsWith(prefix));
      if (!hit) return null;
      const raw = decodeURIComponent(hit.slice(prefix.length));
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const unpack = (x) => {
          if (!x || typeof x !== 'object') return null;
          if (x.stopKey) return x;
          if (x.k) {
            return {
              stopKey: x.k,
              mode: x.m || 'BUS',
              nameEn: x.e || '',
              nameTc: x.t || x.e || '',
              lat: Number(x.a),
              lon: Number(x.o)
            };
          }
          return null;
        };
        return { home: unpack(parsed.h || parsed.home), work: unpack(parsed.w || parsed.work) };
      }
    } catch (e) {}
    return null;
  },

  _writeHubsCookie(hubs) {
    try {
      if (typeof document === 'undefined') return;
      const pack = (x) => x ? ({
        k: x.stopKey,
        m: x.mode || 'BUS',
        e: x.nameEn || '',
        t: x.nameTc || x.nameEn || '',
        a: Number(x.lat),
        o: Number(x.lon)
      }) : null;
      if (!hubs?.home && !hubs?.work) {
        document.cookie = `${this.cookieName}=; max-age=0; path=/; SameSite=Lax`;
        return;
      }
      const payload = encodeURIComponent(JSON.stringify({ h: pack(hubs.home), w: pack(hubs.work) }));
      const maxAgeSec = 60 * 60 * 24 * 365 * 10; // 10 years — survives PWA & web link updates
      document.cookie = `${this.cookieName}=${payload}; max-age=${maxAgeSec}; path=/; SameSite=Lax`;
    } catch (e) {}
  },

  getHubs() {
    try {
      const raw = JSON.parse(SafeStorage.getItem(this.storageKey) || 'null');
      if (raw && typeof raw === 'object' && (raw.home || raw.work)) {
        return { home: raw.home || null, work: raw.work || null };
      }
    } catch (e) {}
    const fromCookie = this._readHubsCookie();
    if (fromCookie && (fromCookie.home || fromCookie.work)) {
      try { SafeStorage.setItem(this.storageKey, JSON.stringify(fromCookie)); } catch (e) {}
      return fromCookie;
    }
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
    this._writeHubsCookie(hubs);
    if (typeof window !== 'undefined' && window.__TRANSIT_IDB__?.set) {
      window.__TRANSIT_IDB__.set(this.storageKey, hubs).catch(() => {});
    }
    return hubs;
  },

  clearHub(slot) {
    const key = slot === 'work' ? 'work' : 'home';
    const hubs = this.getHubs();
    hubs[key] = null;
    SafeStorage.setItem(this.storageKey, JSON.stringify(hubs));
    this._writeHubsCookie(hubs);
    if (typeof window !== 'undefined' && window.__TRANSIT_IDB__?.set) {
      window.__TRANSIT_IDB__.set(this.storageKey, hubs).catch(() => {});
    }
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

if (typeof window !== 'undefined') {
  window.getNormalizedVillageOrStopKey = getNormalizedVillageOrStopKey;
  window.savePlaceToRecentCommuteHistory = savePlaceToRecentCommuteHistory;
  window.cleanAlsAddressLabel = cleanAlsAddressLabel;
  window.SmartReturnManager = SmartReturnManager;
  window.SavedHubsManager = SavedHubsManager;
  window.openSavedHubPickerFromSettings = openSavedHubPickerFromSettings;
  window.clearSavedHubFromSettings = clearSavedHubFromSettings;
  window.getPlannerHubDirectory = getPlannerHubDirectory;
  window.quickPickPlannerHub = quickPickPlannerHub;
  window.openCommuteStopPicker = openCommuteStopPicker;
  window.closeCommuteStopPicker = closeCommuteStopPicker;
  window.onCommutePickerInput = onCommutePickerInput;
  window.selectCurrentGpsForCommutePicker = selectCurrentGpsForCommutePicker;
  window.selectCommuteStopOption = selectCommuteStopOption;
  window.renderCommutePickerList = renderCommutePickerList;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getNormalizedVillageOrStopKey,
    savePlaceToRecentCommuteHistory,
    cleanAlsAddressLabel,
    SmartReturnManager,
    SavedHubsManager,
    openSavedHubPickerFromSettings,
    clearSavedHubFromSettings,
    getPlannerHubDirectory,
    quickPickPlannerHub,
    openCommuteStopPicker,
    closeCommuteStopPicker,
    onCommutePickerInput,
    selectCurrentGpsForCommutePicker,
    selectCommuteStopOption,
    renderCommutePickerList
  };
}
